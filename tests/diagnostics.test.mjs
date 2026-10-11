import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { fixture, model, user, reply } from './helpers.mjs';

function reportText(f) {
  const report = f.ctx.hasUI ? f.notices.at(-1) : f.messages.at(-1)?.message;
  assert.ok(report, 'failure must report an error');
  assert.equal(f.ctx.hasUI ? report.level : report.details.level, 'error');
  if (!f.ctx.hasUI) assert.equal(f.messages.at(-1).options.triggerTurn, false);
  return f.ctx.hasUI ? report.text : report.content;
}

function assertReport(f, category, budget = {}) {
  const { input = 'unknown', output = 'unknown', window = 'unknown' } = budget;
  assert.equal(reportText(f), `Compaction stopped. Category: ${category}.\nEstimated input: ${input} tokens. Output allowance: ${output} tokens. Context window: ${window} tokens.\nNo default-model fallback.`);
  assert.doesNotMatch(JSON.stringify(f.notices) + JSON.stringify(f.messages), /PRIVATE-/);
}

function requestBudget(request) {
  return {
    input: request.context.messages.reduce((sum, message) => sum + estimateTokens(message), 0),
    output: request.options.maxTokens,
    window: request.model.contextWindow,
  };
}

const categories = [
  { category: 'settings', setup: f => writeFile(f.path, 'PRIVATE-INVALID-JSON') },
  { category: 'model-unavailable', setup: f => { f.ctx.modelRegistry.find = () => undefined; } },
  { category: 'authentication-unavailable', setup: f => { f.ctx.modelRegistry.hasConfiguredAuth = () => false; } },
  { category: 'context-window', setup: f => { f.ctx.modelRegistry.find = () => ({ ...model, contextWindow: 1 }); }, budget: true, calls: 0 },
  { category: 'provider-error', response: { ...reply('PRIVATE-SUMMARY'), stopReason: 'error', errorMessage: 'PRIVATE-PROVIDER-ERROR' } },
  { category: 'output-limit', response: { ...reply('PRIVATE-INCOMPLETE-SUMMARY'), stopReason: 'length' } },
  { category: 'aborted', response: { ...reply('PRIVATE-SUMMARY'), stopReason: 'aborted' } },
  { category: 'unexpected-stop', response: { ...reply('PRIVATE-SUMMARY'), stopReason: 'PRIVATE-STOP' } },
  { category: 'tool-call', response: { ...reply(), content: [{ type: 'toolCall', id: '1', name: 'PRIVATE-TOOL', arguments: { text: 'PRIVATE-ARGS' } }] } },
  { category: 'empty-summary', response: reply('  ') },
  { category: 'summary-error', overrides: { fileOps: undefined } },
];

test('AC-9 each safe category reaches UI and non-UI reports without private content', async t => {
  for (const hasUI of [false, true]) {
    for (const c of categories) {
      await t.test(`${hasUI ? 'UI' : 'non-UI'} ${c.category}`, async t => {
        const f = await fixture(t); f.ctx.hasUI = hasUI;
        await c.setup?.(f);
        if (c.response) {
          const stream = f.ctx.modelRegistry.streamSimple;
          f.ctx.modelRegistry.find = () => ({ ...model, id: 'PRIVATE-MODEL' });
          f.ctx.modelRegistry.streamSimple = (m, context, options) => {
            stream(m, context, options);
            return { result: async () => c.response };
          };
        }
        // Capture the native prompt for the overflow case without dispatching it.
        let expected;
        if (c.budget) {
          f.ctx.modelRegistry.find = () => model;
          await f.compact({ messagesToSummarize: [user('PRIVATE-PROMPT')] });
          expected = { ...requestBudget(f.requests.at(-1)), window: 1 };
          f.requests.length = 0;
          await c.setup(f);
        }
        assert.deepEqual(await f.compact({ messagesToSummarize: [user('PRIVATE-PROMPT')], ...c.overrides }), { cancel: true });
        if (c.response) expected = requestBudget(f.requests.at(-1));
        assertReport(f, c.category, expected);
        assert.equal(f.requests.length, c.response ? 1 : 0);
      });
    }
  }
});

test('AC-9 lookup and authentication exceptions stay classified without their raw text', async t => {
  const f = await fixture(t);
  f.ctx.modelRegistry.find = () => { throw new Error('PRIVATE-LOOKUP'); };
  assert.deepEqual(await f.compact(), { cancel: true });
  assertReport(f, 'model-unavailable');
  f.ctx.modelRegistry.find = () => ({ ...model, api: 'pi-virtual' });
  assert.deepEqual(await f.compact(), { cancel: true });
  assertReport(f, 'model-unavailable');
  f.ctx.modelRegistry.find = () => model;
  f.ctx.modelRegistry.hasConfiguredAuth = () => { throw new Error('PRIVATE-AUTH'); };
  assert.deepEqual(await f.compact(), { cancel: true });
  assertReport(f, 'authentication-unavailable');
  assert.equal(f.requests.length, 0);
});

test('AC-9 provider exceptions do not infer categories from names or messages', async t => {
  const f = await fixture(t), stream = f.ctx.modelRegistry.streamSimple;
  for (const asyncFailure of [false, true]) {
    f.ctx.modelRegistry.streamSimple = (m, context, options) => {
      stream(m, context, options);
      const error = new Error('PRIVATE-context overflow authentication aborted');
      error.name = 'AbortError';
      if (asyncFailure) return { result: async () => { throw error; } };
      throw error;
    };
    const before = f.requests.length;
    assert.deepEqual(await f.compact(), { cancel: true });
    assertReport(f, 'provider-error', requestBudget(f.requests.at(-1)));
    assert.equal(f.requests.length, before + 1);
  }
});

test('AC-9 signal abort takes precedence over responses and exceptions, with no late summary', async t => {
  const f = await fixture(t), stream = f.ctx.modelRegistry.streamSimple;
  const early = new AbortController(); early.abort();
  assert.deepEqual(await f.compact({}, 'manual', early.signal), { cancel: true });
  assertReport(f, 'aborted');
  assert.equal(f.requests.length, 0);
  for (const throws of [false, true]) {
    const controller = new AbortController();
    f.ctx.modelRegistry.streamSimple = (m, context, options) => {
      stream(m, context, options);
      return { result: async () => {
        controller.abort();
        if (throws) throw new Error('PRIVATE-PROVIDER-FAILURE');
        return reply('PRIVATE-LATE-SUMMARY');
      } };
    };
    assert.deepEqual(await f.compact({}, 'manual', controller.signal), { cancel: true });
    assertReport(f, 'aborted', requestBudget(f.requests.at(-1)));
  }
});

test('AC-9 split-turn failure reports the second request budget and later attempts reset it', async t => {
  const f = await fixture(t), stream = f.ctx.modelRegistry.streamSimple;
  f.ctx.modelRegistry.streamSimple = (m, context, options) => {
    const checked = stream(m, context, options);
    return f.requests.length === 1 ? checked : { result: async () => ({ ...reply('PRIVATE-PREFIX'), stopReason: 'length' }) };
  };
  assert.deepEqual(await f.compact({ isSplitTurn: true, turnPrefixMessages: [user('PRIVATE-PREFIX '.repeat(100))] }), { cancel: true });
  assert.equal(f.requests.length, 2);
  const first = requestBudget(f.requests[0]), second = requestBudget(f.requests[1]);
  assert.notEqual(first.input, second.input);
  assert.notEqual(first.output, second.output);
  assertReport(f, 'output-limit', second);
  await writeFile(f.path, 'PRIVATE-INVALID-JSON');
  assert.deepEqual(await f.compact(), { cancel: true });
  assertReport(f, 'settings');
  assert.equal(f.requests.length, 2);
});

test('AC-9 invalid numeric budgets display unknown without printing raw metadata', async t => {
  const f = await fixture(t), stream = f.ctx.modelRegistry.streamSimple;
  await f.compact();
  const budget = requestBudget(f.requests.at(-1));
  f.requests.length = 0;
  f.ctx.modelRegistry.streamSimple = (m, context, options) => {
    stream(m, context, options);
    return { result: async () => ({ ...reply(), stopReason: 'error' }) };
  };
  for (const contextWindow of [NaN, Infinity, -1, 100000.5]) {
    f.ctx.modelRegistry.find = () => ({ ...model, contextWindow });
    assert.deepEqual(await f.compact(), { cancel: true });
    // Invalid non-positive windows fail locally; positive windows reach the mock.
    assertReport(f, contextWindow > 0 ? 'provider-error' : 'context-window', { ...budget, window: 'unknown' });
  }
  f.ctx.modelRegistry.find = () => model;
  assert.deepEqual(await f.compact({ settings: { enabled: true, reserveTokens: NaN, keepRecentTokens: 20000 } }), { cancel: true });
  assertReport(f, 'provider-error', { ...requestBudget(f.requests.at(-1)), output: 'unknown' });
});
