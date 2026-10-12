import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('CC-AC-1 declares the common behavior library without bundling host SDKs', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dependencies?.['@neruok/pi-common'], 'the shared behavior library must be a declared dependency');
  for (const name of Object.keys(pkg.peerDependencies)) assert.equal(pkg.dependencies?.[name], undefined);
});

import { mkdtemp, writeFile, readFile as read, symlink, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSelection, saveSelection } from '../lib/settings.ts';
const pair = { provider: 'cheap', model: 'summary' };
test('CC-AC-3 compaction respects foreign locks and never reclaims them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'compaction-common-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json');
  await writeFile(path, JSON.stringify({ model: pair }));
  await writeFile(path + '.lock', 'OTHER');
  await assert.rejects(saveSelection(path, { provider: 'new', model: 'new' }));
  assert.deepEqual(await loadSelection(path), pair);
  assert.equal(await read(path + '.lock', 'utf8'), 'OTHER');
});
test('CC-AC-3 compaction rejects immediate-parent symlinks for read, save and reset', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'compaction-common-parent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'target'), alias = join(dir, 'alias');
  await mkdir(target); await symlink(target, alias);
  const path = join(alias, 'settings.json'), actual = join(target, 'settings.json');
  await writeFile(actual, JSON.stringify({ model: pair }));
  const before = await read(actual);
  await assert.rejects(loadSelection(path));
  await assert.rejects(saveSelection(path, pair));
  await assert.rejects(saveSelection(path));
  assert.deepEqual(await read(actual), before);
});
test('CC-AC-3 preserved reset repairs invalid UTF-8 and oversized regular files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'compaction-common-repair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json');
  for (const bytes of [Buffer.from([0xff]), Buffer.alloc(70000, 0xff)]) {
    await writeFile(path, bytes);
    await saveSelection(path);
    assert.equal(await loadSelection(path), undefined);
  }
});
