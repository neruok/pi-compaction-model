import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import extension from '../compaction-model.ts';
import { loadSelection, saveSelection } from '../lib/settings.ts';
import { fixture, selection, model, user } from './helpers.mjs';

const levels = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const extendedModel = { ...model, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } };
function useModel(f, selected = extendedModel) {
  f.ctx.modelRegistry.find = (provider, id) => provider === selected.provider && id === selected.id ? selected : undefined;
  f.pi.setThinkingLevel = () => assert.fail('must not change conversation thinking');
  extension(f.pi);
}
async function configure(f, reasoning) {
  await writeFile(f.path, JSON.stringify({ model: { ...selection, reasoning } }));
}
const report = f => f.ctx.hasUI ? f.notices.at(-1)?.text : f.messages.at(-1)?.message.content;
function nativeOptions(request, routingIds) {
  const { signal, sessionId, ...options } = request.options;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  // Pi generates a fresh UUIDv7 routing ID for each uncached summary request.
  assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(routingIds.has(sessionId), false);
  routingIds.add(sessionId);
  return options;
}

for (const reasoning of levels) {
  test(`AC-10 settings round-trip ${reasoning}`, async t => {
    const f = await fixture(t);
    const pair = { ...selection, reasoning };
    await saveSelection(f.path, pair);
    assert.deepEqual(await f.settings(), { model: pair });
    assert.deepEqual(await loadSelection(f.path), pair);
  });
}

test('AC-10 settings reject invalid reasoning on read and write without replacing valid bytes', async t => {
  const f = await fixture(t);
  for (const reasoning of [null, '', 'HIGH', 'bogus', 1, false, {}, []]) {
    const before = await readFile(f.path, 'utf8');
    await assert.rejects(saveSelection(f.path, { ...selection, reasoning }));
    assert.equal(await readFile(f.path, 'utf8'), before);
    await configure(f, reasoning);
    await assert.rejects(loadSelection(f.path));
    await writeFile(f.path, before);
  }
});

test('AC-10 direct command saves every supported level, show and reload retain it, no generation', async t => {
  const f = await fixture(t); useModel(f);
  for (const reasoning of levels) {
    await f.invoke(`reasoning ${reasoning}`);
    assert.deepEqual(await f.settings(), { model: { ...selection, reasoning } });
    extension(f.pi);
    await f.invoke('show');
    assert.match(report(f), new RegExp(`Reasoning: ${reasoning}`));
  }
  assert.equal(f.requests.length, 0);
});

for (const mode of ['tui', 'rpc']) {
  test(`AC-10 ${mode} reasoning picker shows current, supports cancellation and rejects unexpected selection`, async t => {
    const f = await fixture(t); useModel(f);
    await configure(f, 'high');
    f.ctx.mode = mode; f.ctx.hasUI = true;
    const before = await readFile(f.path, 'utf8');
    f.ctx.ui.select = async (title, choices) => {
      assert.match(title, /Compaction reasoning/);
      assert.match(title, /current: high/);
      assert.deepEqual(choices, levels);
      return undefined;
    };
    await f.invoke('reasoning');
    assert.match(report(f), /cancelled/);
    assert.equal(await readFile(f.path, 'utf8'), before);
    f.ctx.ui.select = async () => 'unexpected';
    await f.invoke('reasoning');
    assert.equal(await readFile(f.path, 'utf8'), before);
    f.ctx.ui.select = async () => 'low';
    await f.invoke('reasoning');
    assert.deepEqual(await f.settings(), { model: { ...selection, reasoning: 'low' } });
    assert.equal(f.requests.length, 0);
  });
}

test('AC-10 no-UI reasoning query lists model-supported choices without writing', async t => {
  const f = await fixture(t); useModel(f, { ...model, reasoning: false });
  const before = await readFile(f.path, 'utf8');
  f.ctx.ui.select = async () => assert.fail('no-UI query must not open a dialog');
  await f.invoke('reasoning');
  assert.match(report(f), /Supported compaction reasoning: default, off\./);
  assert.match(report(f), /Reasoning: default/);
  assert.equal(await readFile(f.path, 'utf8'), before);
  for (const level of ['default', 'off']) {
    await f.invoke(`reasoning ${level}`);
    assert.equal((await f.settings()).model.reasoning, level);
  }
  assert.equal(f.requests.length, 0);
});

test('AC-10 invalid and unsupported commands preserve bytes; no selection cannot set reasoning', async t => {
  const f = await fixture(t); useModel(f, { ...model, thinkingLevelMap: { off: null, low: null } });
  const before = await readFile(f.path, 'utf8');
  for (const args of ['reasoning bogus', 'reasoning high extra', 'reasoning off', 'reasoning low', 'reasoning xhigh', 'reasoning max']) {
    await f.invoke(args);
    assert.equal(await readFile(f.path, 'utf8'), before, args);
    assert.equal(f.messages.at(-1).message.details.level, 'error');
  }
  await f.invoke('reset');
  await f.invoke('reasoning high');
  assert.deepEqual(await f.settings(), {});
  assert.match(report(f), /Select a compaction model first/);
  assert.equal(f.requests.length, 0);
  const empty = await fixture(t, false);
  await empty.invoke('reasoning');
  assert.match(report(empty), /Select a compaction model first/);
  await assert.rejects(readFile(empty.path), { code: 'ENOENT' });
});

test('AC-10 model selection and reset clear reasoning', async t => {
  const f = await fixture(t); useModel(f);
  await configure(f, 'high');
  await f.invoke('cheap summary');
  assert.deepEqual(await f.settings(), { model: selection });
  await configure(f, 'high');
  f.ctx.mode = 'rpc'; f.ctx.hasUI = true;
  f.ctx.ui.select = async () => 'cheap/summary';
  await f.invoke('');
  assert.deepEqual(await f.settings(), { model: selection });
  await configure(f, 'high');
  await f.invoke('reset');
  assert.deepEqual(await f.settings(), {});
  assert.equal(f.requests.length, 0);
});

for (const reasoning of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
  test(`AC-10 ${reasoning} reaches native helper for every compaction reason with unchanged allowance`, async t => {
    const f = await fixture(t); useModel(f);
    await f.compact();
    const routingIds = new Set();
    const legacyOptions = nativeOptions(f.requests.at(-1), routingIds);
    const allowance = legacyOptions.maxTokens;
    await f.invoke(`reasoning ${reasoning}`);
    for (const reason of ['manual', 'threshold', 'overflow']) {
      assert.ok((await f.compact({}, reason))?.compaction);
      assert.equal(f.requests.at(-1).options.reasoning, reasoning);
      assert.deepEqual(nativeOptions(f.requests.at(-1), routingIds), { ...legacyOptions, reasoning });
      assert.equal(f.requests.at(-1).options.maxTokens, allowance);
      assert.equal(f.requests.at(-1).options.maxRetries, 0);
      assert.equal(f.requests.at(-1).options.cacheRetention, 'none');
    }
  });
}

test('AC-10 split compaction pins configured reasoning even after settings change', async t => {
  const f = await fixture(t); useModel(f);
  await f.invoke('reasoning high');
  const stream = f.ctx.modelRegistry.streamSimple;
  f.ctx.modelRegistry.streamSimple = (m, c, o) => {
    const result = stream(m, c, o);
    return { result: async () => { await configure(f, 'low'); return result.result(); } };
  };
  assert.ok((await f.compact({ isSplitTurn: true, turnPrefixMessages: [user('prefix')] }))?.compaction);
  assert.deepEqual(f.requests.map(r => r.options.reasoning), ['high', 'high']);
  assert.deepEqual(f.requests.map(r => r.options.maxTokens), [3276, 2048]);
  await f.compact();
  assert.equal(f.requests.at(-1).options.reasoning, 'low');
});

test('AC-10 omitted/default/off keep native legacy options, never inherit session thinking', async t => {
  const f = await fixture(t); useModel(f);
  f.pi.getThinkingLevel = () => assert.fail('must not inherit conversation thinking');
  await f.compact();
  const routingIds = new Set();
  const legacyOptions = nativeOptions(f.requests.at(-1), routingIds);
  for (const reasoning of [undefined, 'default', 'off']) {
    await configure(f, reasoning);
    assert.ok((await f.compact())?.compaction);
    assert.equal(f.requests.at(-1).options.reasoning, undefined);
    assert.deepEqual(nativeOptions(f.requests.at(-1), routingIds), legacyOptions);
  }
});

test('AC-10 unsupported persisted level cancels safely before dispatch, with abort precedence', async t => {
  const f = await fixture(t); useModel(f);
  await f.invoke('reasoning high');
  useModel(f, { ...model, reasoning: false });
  assert.deepEqual(await f.compact(), { cancel: true });
  assert.match(report(f), /Category: settings/);
  assert.match(report(f), /Estimated input: unknown/);
  assert.equal(f.requests.length, 0);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await f.compact({}, 'manual', controller.signal), { cancel: true });
  assert.match(report(f), /Category: aborted/);
  await f.invoke('reasoning default');
  assert.equal((await f.settings()).model.reasoning, 'default');
  assert.ok((await f.compact())?.compaction, 'supported default repairs stale effort');
});

test('AC-10 supported-choice list respects partial maps and null entries in every UI mode', async t => {
  const f = await fixture(t);
  useModel(f, { ...model, thinkingLevelMap: { off: null, minimal: null, high: null, xhigh: 'native-extra', max: null } });
  const expected = ['default', 'low', 'medium', 'xhigh'];
  const before = await readFile(f.path, 'utf8');
  for (const mode of ['tui', 'rpc', 'print']) {
    f.ctx.mode = mode; f.ctx.hasUI = mode !== 'print';
    f.ctx.ui.select = async (_title, choices) => {
      assert.notEqual(mode, 'print');
      assert.deepEqual(choices, expected);
      return undefined;
    };
    await f.invoke('reasoning');
    if (mode === 'print') assert.match(report(f), /Supported compaction reasoning: default, low, medium, xhigh\./);
    assert.equal(await readFile(f.path, 'utf8'), before);
  }
  await f.invoke('reasoning high');
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal(f.requests.length, 0);
});
