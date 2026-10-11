import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import extension from '../compaction-model.ts';
import { fixture, model, reply, user, selection } from './helpers.mjs';

async function sessionFixture(t, configured = true) {
  const f = await fixture(t, configured);
  const main = { ...model, provider: 'expensive', id: 'main' };
  const calls = [];
  let response = () => reply();
  const runtime = {
    getModel: (p, id) => [model, main].find(m => m.provider === p && m.id === id),
    getPhysicalModel: (p, id) => [model, main].find(m => m.provider === p && m.id === id),
    getModels: () => [model, main], getAvailableSnapshot: () => [model, main],
    hasConfiguredAuth: () => true, getAuth: async () => undefined,
    getProvider: () => undefined, getProviders: () => [], getError: () => undefined,
    isUsingOAuth: () => false,
    streamSimple: (m, context, options) => {
      calls.push({ model: m, context, options });
      const stream = createAssistantMessageEventStream();
      stream.end(response()); return stream;
    },
  };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 100 }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: f.dir, agentDir: f.dir, settingsManager: settings, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension] });
  await loader.reload();
  const manager = SessionManager.create(f.dir, join(f.dir, 'sessions'));
  manager.appendMessage(user('old '.repeat(1000)));
  manager.appendMessage(reply('old assistant response'));
  const recent = manager.appendMessage(user('RECENT '.repeat(100)));
  const { session } = await createAgentSession({ cwd: f.dir, agentDir: f.dir, model: main, thinkingLevel: 'high', modelRuntime: runtime, settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: 'all' });
  await session.bindExtensions({ mode: 'print' });
  t.after(() => session.dispose());
  return { ...f, calls, session, manager, recent, respond: next => { response = next; } };
}

test('AC-2 AC-3 installed AgentSession commits hooked summaries once and cancels failures without main-model fallback', async t => {
  const f = await sessionFixture(t);
  const first = await f.session.compact('NATIVE-INSTRUCTIONS');
  assert.equal(first.firstKeptEntryId, f.recent);
  assert.ok(f.calls.every(call => call.model.id === 'summary'));
  assert.equal(f.session.model.id, 'main');
  const saved = f.manager.getBranch().filter(entry => entry.type === 'compaction');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].fromHook, true);
  assert.equal(saved[0].details.source, 'pi-compaction-model');
  assert.deepEqual(saved[0].usage, first.usage);
  const reopened = SessionManager.open(f.manager.getSessionFile());
  assert.deepEqual(reopened.getBranch().findLast(entry => entry.type === 'compaction').details, first.details);
  assert.ok(reopened.buildSessionContext().messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('RECENT')));
  f.manager.appendMessage(user('additional '.repeat(300)));
  f.manager.appendMessage(user('latest '.repeat(100)));
  const count = f.calls.length;
  f.respond(() => ({ ...reply(), stopReason: 'error', errorMessage: 'PRIVATE-ERROR' }));
  await assert.rejects(f.session.compact(), /cancelled/i);
  assert.equal(f.calls.length, count + 1);
  assert.equal(f.calls.at(-1).model.id, 'summary');
  assert.equal(f.manager.getBranch().filter(entry => entry.type === 'compaction').length, 1);
  assert.equal(f.session.model.id, 'main');
});

test('AC-5 preserved: installed AgentSession defaults to conversation model when no selection exists', async t => {
  const f = await sessionFixture(t, false);
  await f.session.compact();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].model.id, 'main');
  assert.equal(f.manager.getBranch().findLast(entry => entry.type === 'compaction').fromHook, false);
  assert.equal(f.session.model.id, 'main');
});
