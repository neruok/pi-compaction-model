import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSelection, saveSelection } from '../lib/settings.ts';

const pair = { provider: 'cheap', model: 'summary' };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'compaction-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'compaction-model.json') };
}

test('AC-4 strict settings read and inclusive byte limit', async t => {
  const f = await fixture(t);
  assert.equal(await loadSelection(f.path), undefined);
  await writeFile(f.path, JSON.stringify({ model: pair }));
  assert.deepEqual(await loadSelection(f.path), pair);
  for (const value of ['null', '[]', 'oops', '{"extra":1}', '{"model":null}', '{"model":{"provider":"cheap","model":""}}', '{"model":{"provider":"cheap","model":"summary","extra":true}}']) {
    await writeFile(f.path, value);
    await assert.rejects(loadSelection(f.path));
  }
  await writeFile(f.path, '{}'.padEnd(16384));
  assert.equal(await loadSelection(f.path), undefined);
  await writeFile(f.path, '{}'.padEnd(16385));
  await assert.rejects(loadSelection(f.path));
});

test('AC-4 atomic save/reset, concurrent writes, regular-file refusal and owned cleanup', async t => {
  const f = await fixture(t);
  await saveSelection(f.path, pair);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { model: pair });
  await writeFile(f.path, 'malformed');
  await saveSelection(f.path);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), {});
  await Promise.all([saveSelection(f.path, pair), saveSelection(f.path, { provider: 'other', model: 'other' })]);
  assert.deepEqual(await loadSelection(f.path), { provider: 'other', model: 'other' });
  assert.deepEqual(await readdir(f.dir), ['compaction-model.json']);
  const before = await readFile(f.path, 'utf8');
  await assert.rejects(saveSelection(f.path, { provider: '', model: 'invalid' }));
  assert.equal(await readFile(f.path, 'utf8'), before);
  const directory = join(f.dir, 'directory');
  await mkdir(directory);
  await assert.rejects(loadSelection(directory));
  await assert.rejects(saveSelection(directory, pair));
  assert.deepEqual(await readdir(directory), []);
});

test('AC-4 symlink reads, writes and resets refuse without changing target', async t => {
  const f = await fixture(t), target = join(f.dir, 'target.json');
  const bytes = JSON.stringify({ model: pair });
  await writeFile(target, bytes);
  await symlink(target, f.path);
  await assert.rejects(loadSelection(f.path));
  await assert.rejects(saveSelection(f.path, pair));
  await assert.rejects(saveSelection(f.path));
  assert.equal(await readFile(target, 'utf8'), bytes);
});
