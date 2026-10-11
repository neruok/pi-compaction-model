import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { estimateTokens, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import extension from '../compaction-model.ts';
import { fixture, selection, model, user, reply, usage, preparation } from './helpers.mjs';

test('AC-1 direct selection persists across reload, show/reset and invalid input do not call a model', async t => {
  const f = await fixture(t, false);
  await f.invoke('cheap summary');
  assert.deepEqual(await f.settings(), { model: selection });
  extension({ ...f.pi, registerCommand: (n, c) => f.commands.set(n, c), on: (n, h) => f.events.set(n, h) });
  await f.invoke('show');
  assert.match(f.messages.at(-1).message.content, /cheap\/summary/);
  assert.equal(f.messages.at(-1).options.triggerTurn, false);
  const before = await readFile(f.path, 'utf8');
  for (const args of ['bogus', 'cheap unknown', '--project cheap summary', 'a b c']) await f.invoke(args);
  assert.equal(await readFile(f.path, 'utf8'), before);
  await f.invoke('');
  assert.equal(await readFile(f.path, 'utf8'), before);
  await f.invoke('reset');
  assert.deepEqual(await f.settings(), {});
  assert.equal(await f.compact(), undefined);
  assert.equal(f.requests.length, 0);
});

test('AC-1 RPC picker lists physical models, cancellation does not write, choice saves globally', async t => {
  const f = await fixture(t); f.ctx.mode = 'rpc'; f.ctx.hasUI = true;
  const before = await readFile(f.path, 'utf8');
  f.ctx.ui.select = async (title, choices) => { assert.match(title, /compaction/i); assert.deepEqual(choices, ['cheap/summary']); return undefined; };
  await f.invoke('');
  assert.equal(await readFile(f.path, 'utf8'), before);
  f.ctx.ui.select = async () => 'cheap/summary';
  await f.invoke('');
  assert.deepEqual(await f.settings(), { model: selection });
  assert.equal(f.requests.length, 0);
});

test('AC-2 all compaction reasons use native prompts, keep boundaries, instructions, usage and pin model', async t => {
  const f = await fixture(t);
  for (const reason of ['manual', 'threshold', 'overflow']) {
    const result = await f.compact({}, reason);
    assert.ok(result?.compaction, 'must supply native compaction result');
    assert.equal(result.compaction.firstKeptEntryId, 'recent');
    assert.equal(result.compaction.tokensBefore, 40000);
    assert.deepEqual(result.compaction.usage, usage);
    assert.deepEqual(result.compaction.details.readFiles, ['read.ts']);
    assert.deepEqual(result.compaction.details.modifiedFiles, ['edit.ts']);
    const request = f.requests.at(-1);
    assert.equal(request.model.id, 'summary');
    const prompt = JSON.stringify(request.context);
    for (const text of ['OLD-CONTEXT', 'PRIOR-SUMMARY', 'KEEP-FOCUS', '## Goal', '## Critical Context']) assert.ok(prompt.includes(text), text);
    assert.equal(request.options.reasoning, undefined);
    assert.equal(request.options.maxRetries, 0);
    assert.equal(request.options.cacheRetention, 'none');
  }
  assert.equal(f.requests.length, 3);
  const stream = f.ctx.modelRegistry.streamSimple;
  f.ctx.modelRegistry.streamSimple = (m, c, o) => {
    const result = stream(m, c, o);
    return { result: async () => { await writeFile(f.path, '{}'); return result.result(); } };
  };
  const result = await f.compact({ isSplitTurn: true, turnPrefixMessages: [user('TURN-PREFIX')] });
  assert.match(result.compaction.summary, /Turn Context \(split turn\)/);
  assert.equal(f.requests.length, 5);
  assert.ok(JSON.stringify(f.requests.at(-1).context).includes('TURN-PREFIX'));
  assert.ok(f.requests.slice(-2).every(r => r.model.id === 'summary'));
  assert.equal(result.compaction.usage.input, usage.input * 2);
});

test('AC-2 file lists stay cumulative across hooked compactions without mutating preparation', async t => {
  const f = await fixture(t);
  const first = (await f.compact()).compaction;
  f.ctx.sessionManager.getBranch = () => [{ type: 'compaction', fromHook: true, details: first.details }];
  const ops = { read: new Set(['new.ts']), written: new Set(['read.ts']), edited: new Set() };
  const result = (await f.compact({ fileOps: ops })).compaction;
  assert.deepEqual(result.details.readFiles, ['new.ts']);
  assert.deepEqual(result.details.modifiedFiles, ['edit.ts', 'read.ts']);
  assert.deepEqual([...ops.read], ['new.ts']);
  assert.deepEqual([...ops.written], ['read.ts']);
  f.ctx.sessionManager.getBranch = () => [{ type: 'compaction', fromHook: true, details: result.details }];
  const third = (await f.compact({ fileOps: { read: new Set(['third.ts']), written: new Set(), edited: new Set() } })).compaction;
  assert.deepEqual(third.details.readFiles, ['new.ts', 'third.ts']);
  assert.deepEqual(third.details.modifiedFiles, ['edit.ts', 'read.ts']);
});

test('AC-2 context window equality passes and one token above is cancelled before dispatch', async t => {
  const f = await fixture(t); const messages = [user('probe')];
  // First capture Pi's actual normalized summary prompt and per-call output allowance.
  await f.compact({ messagesToSummarize: messages });
  const request = f.requests.at(-1);
  const boundary = request.context.messages.reduce((sum, message) => sum + estimateTokens(message), 0) + request.options.maxTokens;
  f.ctx.modelRegistry.find = () => ({ ...model, contextWindow: boundary });
  assert.ok((await f.compact({ messagesToSummarize: messages })).compaction);
  f.ctx.modelRegistry.find = () => ({ ...model, contextWindow: boundary - 1 });
  const count = f.requests.length;
  assert.equal((await f.compact({ messagesToSummarize: messages })).cancel, true);
  assert.equal(f.requests.length, count);
});

test('AC-3 configuration/model/auth failures cancel with no default dispatch', async t => {
  const f = await fixture(t);
  for (const value of ['broken-json', '{"model":null}', '{"extra":true}']) {
    await writeFile(f.path, value);
    assert.deepEqual(await f.compact(), { cancel: true });
  }
  await writeFile(f.path, JSON.stringify({ model: selection }));
  f.ctx.modelRegistry.find = () => undefined;
  assert.deepEqual(await f.compact(), { cancel: true });
  f.ctx.modelRegistry.find = () => ({ ...model, api: 'pi-virtual' });
  assert.deepEqual(await f.compact(), { cancel: true });
  f.ctx.modelRegistry.find = () => model;
  f.ctx.modelRegistry.hasConfiguredAuth = () => false;
  assert.deepEqual(await f.compact(), { cancel: true });
  assert.equal(f.requests.length, 0);
});

test('AC-3 provider errors, abnormal/empty/tool replies never retry or leak private text', async t => {
  const f = await fixture(t);
  const responses = [
    { ...reply('private-summary'), stopReason: 'error', errorMessage: 'PRIVATE-ERROR' },
    { ...reply('private-summary'), stopReason: 'length' },
    { ...reply('private-summary'), stopReason: 'aborted' },
    reply('  '), { ...reply(), content: [{ type: 'toolCall', id: '1', name: 'bash', arguments: {} }] },
  ];
  let calls = 0;
  for (const response of responses) {
    f.ctx.modelRegistry.streamSimple = () => { calls++; return { result: async () => response }; };
    assert.deepEqual(await f.compact(), { cancel: true });
  }
  f.ctx.modelRegistry.streamSimple = () => { calls++; throw new Error('PRIVATE-EXCEPTION'); };
  assert.deepEqual(await f.compact(), { cancel: true });
  assert.equal(calls, responses.length + 1);
  assert.doesNotMatch(JSON.stringify(f.notices) + JSON.stringify(f.messages), /PRIVATE-|private-summary/);
});

test('AC-3 abort signal reaches provider and late successful response cannot become compaction', async t => {
  const f = await fixture(t), controller = new AbortController();
  let calls = 0;
  f.ctx.modelRegistry.streamSimple = (_m, _c, options) => {
    calls++; assert.equal(options.signal, controller.signal);
    return { result: async () => { controller.abort(); return reply(); } };
  };
  assert.deepEqual(await f.compact({}, 'manual', controller.signal), { cancel: true });
  assert.equal(calls, 1);
  assert.deepEqual(await f.compact({}, 'manual', controller.signal), { cancel: true });
  assert.equal(calls, 1);
});

test('AC-3 reporting failure still cancels compaction without leaking raw errors', async t => {
  const f = await fixture(t); f.ctx.hasUI = true;
  f.ctx.modelRegistry.find = () => undefined;
  f.ctx.ui.notify = () => { throw new Error('PRIVATE-UI-ERROR'); };
  const stderr = [];
  t.mock.method(console, 'error', text => stderr.push(text));
  assert.deepEqual(await f.compact(), { cancel: true });
  assert.equal(f.requests.length, 0);
  assert.equal(stderr.length, 1);
  assert.doesNotMatch(stderr.join(' '), /PRIVATE-/);
});

test('AC-5 preserved: no selection leaves Pi default compaction untouched', async t => {
  const f = await fixture(t, false);
  const hook = f.events.get('session_before_compact');
  assert.equal(await hook?.({ preparation: preparation(), branchEntries: [], signal: new AbortController().signal }, f.ctx), undefined);
  assert.equal(f.requests.length, 0);
});

test('AC-6 installed Pi loads package and discovers command/hook without generation', async t => {
  const f = await fixture(t, false);
  assert.ok(f.commands.has('compaction-model'), 'package must expose its command');
  const loader = new DefaultResourceLoader({ cwd: f.dir, agentDir: f.dir, settingsManager: SettingsManager.inMemory(), noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [new URL('../', import.meta.url).pathname] });
  await loader.reload();
  const result = loader.getExtensions();
  assert.equal(result.errors.length, 0);
  assert.equal(result.extensions.length, 1);
  assert.deepEqual([...result.extensions[0].commands.keys()], ['compaction-model']);
  assert.ok(result.extensions[0].handlers.has('session_before_compact'));
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.peerDependencies['@earendil-works/pi-coding-agent'], '^1.1.0');
  assert.equal(f.requests.length, 0);
});
