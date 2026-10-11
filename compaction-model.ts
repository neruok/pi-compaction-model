import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import {
  compact, estimateTokens, getAgentDir,
  type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import { loadSelection, saveSelection, type Selection } from './lib/settings.ts';
import { selectModel } from './lib/model-picker.ts';

const SOURCE = 'pi-compaction-model';
const USAGE = 'Usage: /compaction-model [show | reset | <provider> <model>]. Bare command opens the picker. Saves globally.';
const settingsPath = () => join(getAgentDir(), 'compaction-model.json');

function resolveModel(ctx: ExtensionContext, pair: Selection) {
  const model = ctx.modelRegistry.find(pair.provider, pair.model);
  if (!model || model.api === 'pi-virtual' || !ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error('Model unavailable.');
  }
  return model;
}

function requireSummary(response: AssistantMessage, signal: AbortSignal): void {
  if (signal.aborted || response.stopReason !== 'stop' ||
      response.content.some(block => block.type === 'toolCall') ||
      !response.content.some(block => block.type === 'text' && block.text.trim())) {
    throw new Error('Summary unavailable.');
  }
}

function cumulativePreparation(event: SessionBeforeCompactEvent) {
  const prepared = event.preparation;
  const fileOps = {
    read: new Set(prepared.fileOps.read),
    written: new Set(prepared.fileOps.written),
    edited: new Set(prepared.fileOps.edited),
  };
  // Pi skips cumulative details from fromHook entries. Carry only our own format.
  const previous = event.branchEntries.findLast(entry => entry.type === 'compaction');
  const details = previous?.type === 'compaction' ? previous.details : undefined;
  if (details && typeof details === 'object' && 'source' in details && details.source === SOURCE) {
    const lists = details as Record<string, unknown>;
    for (const [field, target] of [['readFiles', fileOps.read], ['modifiedFiles', fileOps.edited]] as const) {
      const paths = lists[field];
      if (Array.isArray(paths)) {
        for (const path of paths) if (typeof path === 'string') target.add(path);
      }
    }
  }
  return { ...prepared, fileOps };
}

export default function (pi: ExtensionAPI): void {
  const report = (ctx: ExtensionContext, content: string, level: 'info' | 'error') => {
    try {
      if (ctx.hasUI) ctx.ui.notify(content, level);
      else pi.sendMessage({ customType: SOURCE, content, display: true, details: { level } }, { triggerTurn: false });
    } catch {
      // Reporting must not turn explicit cancellation into hook fallthrough.
      console.error('pi-compaction-model: could not report the result.');
    }
  };

  pi.registerCommand('compaction-model', {
    description: 'Choose a separate compaction model. Picker, show, reset, or <provider> <model>. Saves globally.',
    async handler(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (tokens.length > 2 || (tokens.length === 1 && !['show', 'reset'].includes(tokens[0]))) {
        report(ctx, USAGE, 'error');
        return;
      }
      try {
        const path = settingsPath();
        if (tokens.length === 1 && tokens[0] === 'reset') {
          await ctx.waitForIdle();
          await saveSelection(path);
          report(ctx, 'Compaction model reset. Pi will use its default compaction model.', 'info');
          return;
        }
        const current = await loadSelection(path);
        if (tokens[0] === 'show' || (!tokens.length && !ctx.hasUI)) {
          report(ctx, `Compaction model: ${current ? current.provider + '/' + current.model : 'Pi default (conversation model)'}.\n${USAGE}\nSettings: ${path}`, 'info');
          return;
        }
        await ctx.waitForIdle();
        const models = ctx.modelRegistry.getAvailable().filter(model => model.api !== 'pi-virtual');
        const pair = tokens.length === 2 ? { provider: tokens[0], model: tokens[1] }
          : models.length ? await selectModel(ctx, 'Compaction model', models, current) : undefined;
        if (!pair) {
          report(ctx, models.length ? 'Selection cancelled. Settings unchanged.' : 'No available compaction models. Settings unchanged.', 'info');
          return;
        }
        resolveModel(ctx, pair);
        await saveSelection(path, pair);
        report(ctx, `Compaction model: ${pair.provider}/${pair.model}. Saved globally. Conversation model unchanged.`, 'info');
      } catch {
        report(ctx, 'Cannot configure the compaction model. Inspect /compaction-model show before retrying.', 'error');
      }
    },
  });

  pi.on('session_before_compact', async (event, ctx) => {
    try {
      const pair = await loadSelection(settingsPath());
      if (!pair) return;
      if (event.signal.aborted) throw new Error('Compaction cancelled.');
      const model = resolveModel(ctx, pair);
      const result = await compact(
        cumulativePreparation(event), model, undefined, undefined, event.customInstructions, event.signal,
        undefined,
        async (_model, context, options) => {
          if (event.signal.aborted) throw new Error('Compaction cancelled.');
          const inputTokens = context.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
          if (!(model.contextWindow > 0) || inputTokens + (options?.maxTokens ?? 0) > model.contextWindow) {
            throw new Error('Compaction context exceeds the selected model window.');
          }
          const response = await ctx.modelRegistry.streamSimple(model, context, { ...options, maxRetries: 0 }).result();
          requireSummary(response, event.signal);
          // compact() only needs the validated final result, not live stream events.
          const checked = createAssistantMessageEventStream();
          checked.end(response);
          return checked;
        },
      );
      if (event.signal.aborted) throw new Error('Compaction cancelled.');
      return { compaction: { ...result, details: { ...result.details as object, source: SOURCE } } };
    } catch {
      // Throwing here can let Pi fall through to its expensive default model.
      report(ctx, 'Compaction stopped. Check the selected model, authentication, settings, and context window. No default-model fallback.', 'error');
      return { cancel: true };
    }
  });
}
