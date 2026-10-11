import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../compaction-model.ts';

export const selection = { provider: 'cheap', model: 'summary' };
export const model = { provider: 'cheap', id: 'summary', name: 'Cheap Summary', api: 'mock-api', reasoning: true, contextWindow: 100000, maxTokens: 8192 };
export const user = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
export const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
export function reply(text = '## Goal\nContinue the task') {
  return { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: structuredClone(usage), timestamp: 1 };
}
export const preparation = overrides => ({
  firstKeptEntryId: 'recent', messagesToSummarize: [user('OLD-CONTEXT')],
  turnPrefixMessages: [], isSplitTurn: false, previousSummary: 'PRIOR-SUMMARY',
  tokensBefore: 40000, fileOps: { read: new Set(['read.ts']), written: new Set(), edited: new Set(['edit.ts']) },
  settings: { enabled: true, reserveTokens: 4096, keepRecentTokens: 20000 }, ...overrides,
});
export async function fixture(t, configured = true) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-compaction-model-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => old === undefined ? delete process.env.PI_CODING_AGENT_DIR : process.env.PI_CODING_AGENT_DIR = old);
  const path = join(dir, 'compaction-model.json');
  if (configured) await writeFile(path, JSON.stringify({ model: selection }));
  const events = new Map(), commands = new Map(), notices = [], requests = [], messages = [];
  const pi = { registerCommand: (n, c) => commands.set(n, c), on: (n, h) => events.set(n, h),
    sendMessage: (message, options) => messages.push({ message, options }),
    setModel: () => assert.fail('must not change main model'), registerTool: () => assert.fail('user command only') };
  extension(pi);
  const ctx = { mode: 'print', hasUI: false, cwd: dir, model: { provider: 'expensive', id: 'main' }, waitForIdle: async () => {},
    sessionManager: { getBranch: () => [], getSessionId: () => 'test-session' },
    modelRegistry: { getAvailable: () => [model, { ...model, api: 'pi-virtual', id: 'router' }], find: (p, id) => p === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true, streamSimple: (m, c, o) => { requests.push({ model: m, context: c, options: o }); return { result: async () => reply() }; } },
    ui: { notify: (text, level) => notices.push({ text, level }), select: async () => undefined },
  };
  const command = () => { const c = commands.get('compaction-model'); assert.ok(c, 'AC-1 /compaction-model must register'); return c; };
  const hook = () => { const h = events.get('session_before_compact'); assert.ok(h, 'AC-2 compaction hook must register'); return h; };
  return { dir, path, pi, ctx, events, commands, notices, requests, messages, command,
    invoke: args => command().handler(args, ctx),
    compact: (overrides = {}, reason = 'manual', signal = new AbortController().signal) => hook()({ preparation: preparation(overrides), branchEntries: ctx.sessionManager.getBranch(), customInstructions: 'KEEP-FOCUS', signal, reason, willRetry: reason === 'overflow' }, ctx),
    settings: async () => JSON.parse(await readFile(path, 'utf8')),
  };
}
