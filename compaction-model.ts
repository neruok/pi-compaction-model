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

type FailureCategory = 'settings' | 'model-unavailable' | 'authentication-unavailable' |
  'context-window' | 'provider-error' | 'output-limit' | 'aborted' | 'unexpected-stop' |
  'tool-call' | 'empty-summary' | 'summary-error';
type TokenBudget = { input: number; output: number; window: number };

class CompactionFailure extends Error {
  readonly category: FailureCategory;
  constructor(category: FailureCategory) {
    super(category);
    this.category = category;
  }
}

function failureReport(category: FailureCategory, budget?: TokenBudget): string {
  const tokens = (value: number | undefined) =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 'unknown';
  return `Compaction stopped. Category: ${category}.\n` +
    `Estimated input: ${tokens(budget?.input)} tokens. Output allowance: ${tokens(budget?.output)} tokens. Context window: ${tokens(budget?.window)} tokens.\n` +
    'No default-model fallback.';
}

function resolveModel(ctx: ExtensionContext, pair: Selection) {
  const model = ctx.modelRegistry.find(pair.provider, pair.model);
  if (!model || model.api === 'pi-virtual') throw new CompactionFailure('model-unavailable');
  try {
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new CompactionFailure('authentication-unavailable');
  } catch {
    throw new CompactionFailure('authentication-unavailable');
  }
  return model;
}

function requireSummary(response: AssistantMessage, signal: AbortSignal): void {
  if (signal.aborted || response.stopReason === 'aborted') throw new CompactionFailure('aborted');
  if (response.stopReason === 'error') throw new CompactionFailure('provider-error');
  if (response.stopReason === 'length') throw new CompactionFailure('output-limit');
  if (response.stopReason !== 'stop') throw new CompactionFailure('unexpected-stop');
  if (response.content.some(block => block.type === 'toolCall')) throw new CompactionFailure('tool-call');
  if (!response.content.some(block => block.type === 'text' && block.text.trim())) {
    throw new CompactionFailure('empty-summary');
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
    let category: FailureCategory = 'settings';
    let budget: TokenBudget | undefined;
    let configured = false;
    try {
      const pair = await loadSelection(settingsPath());
      if (!pair) return;
      configured = true;
      if (event.signal.aborted) throw new CompactionFailure('aborted');
      category = 'model-unavailable';
      const model = resolveModel(ctx, pair);
      category = 'summary-error';
      const result = await compact(
        cumulativePreparation(event), model, undefined, undefined, event.customInstructions, event.signal,
        undefined,
        async (_model, context, options) => {
          category = 'summary-error';
          budget = undefined;
          if (event.signal.aborted) throw new CompactionFailure('aborted');
          const inputTokens = context.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
          budget = { input: inputTokens, output: options?.maxTokens ?? 0, window: model.contextWindow };
          if (!(model.contextWindow > 0) || inputTokens + budget.output > model.contextWindow) {
            throw new CompactionFailure('context-window');
          }
          category = 'provider-error';
          const response = await ctx.modelRegistry.streamSimple(model, context, { ...options, maxRetries: 0 }).result();
          requireSummary(response, event.signal);
          category = 'summary-error';
          // compact() only needs the validated final result, not live stream events.
          const checked = createAssistantMessageEventStream();
          checked.end(response);
          return checked;
        },
      );
      if (event.signal.aborted) throw new CompactionFailure('aborted');
      return { compaction: { ...result, details: { ...result.details as object, source: SOURCE } } };
    } catch (error) {
      // Use only local categories. Never print exception or provider text.
      const failure = configured && event.signal.aborted ? 'aborted'
        : error instanceof CompactionFailure ? error.category : category;
      // Throwing here can let Pi fall through to its expensive default model.
      report(ctx, failureReport(failure, budget), 'error');
      return { cancel: true };
    }
  });
}
