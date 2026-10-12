import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const peers = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-tui'];

test('AC-7 CC-AC-1 manifest and README support public npm installation with supported Pi peers', async () => {
  assert.ok(!manifest.private, 'private must not block npm publication');
  assert.equal(manifest.publishConfig?.access, 'public');
  assert.deepEqual(Object.keys(manifest.peerDependencies).sort(), [...peers].sort());
  for (const peer of peers) {
    assert.equal(manifest.peerDependencies[peer], '^1.1.0');
    assert.equal(manifest.peerDependenciesMeta[peer].optional, true);
  }
  assert.deepEqual(Object.keys(manifest.dependencies), ['@neruok/pi-common'], 'CC-AC-1: only the common library is a runtime dependency, never host SDKs');
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('pi install npm:@neruok/pi-compaction-model'));
  assert.match(readme, /Tested with[^\n]*Pi 1\.1\.0/);
});

test('AC-8 prepublishOnly runs verification and propagates success and failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'compaction-release-gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Exercise the real lifecycle script with a small verify stand-in. Calling
  // this package\'s full verify here would recursively run this test.
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'compaction-release-gate-fixture',
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: { prepublishOnly: manifest.scripts.prepublishOnly, verify: 'node verify.mjs' },
  }));
  await writeFile(join(dir, 'verify.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('verified', process.env.VERIFY_EXIT); process.exit(Number(process.env.VERIFY_EXIT));\n");
  for (const code of [0, 1]) {
    await rm(join(dir, 'verified'), { force: true });
    const result = spawnSync('npm', ['run', 'prepublishOnly'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, VERIFY_EXIT: String(code), npm_config_offline: 'true', npm_config_update_notifier: 'false' },
    });
    assert.ifError(result.error);
    if (code === 0) assert.equal(result.status, 0, 'verification success must allow the lifecycle');
    else assert.notEqual(result.status, 0, 'verification failure must stop the lifecycle');
    assert.equal(await readFile(join(dir, 'verified'), 'utf8'), String(code), 'verify must actually run');
  }
  assert.equal(manifest.scripts.prepublishOnly, 'npm run verify');
});
