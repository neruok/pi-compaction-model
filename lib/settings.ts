import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';

export const REASONING_LEVELS = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Reasoning = typeof REASONING_LEVELS[number];
export type Selection = { provider: string; model: string; reasoning?: Reasoning };
const MAX_BYTES = 16384;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseSelection(value: unknown): Selection {
  if (!object(value) || Object.keys(value).some(key => !['provider', 'model', 'reasoning'].includes(key)) ||
      typeof value.provider !== 'string' || !/^\S+$/u.test(value.provider) ||
      typeof value.model !== 'string' || !/^\S+$/u.test(value.model) ||
      (value.reasoning !== undefined && !REASONING_LEVELS.includes(value.reasoning as Reasoning))) {
    throw new Error('Invalid compaction model settings.');
  }
  return { provider: value.provider, model: value.model,
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning as Reasoning }) };
}

export async function loadSelection(path: string): Promise<Selection | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Invalid settings file.');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    // A bounded read also catches a file that grows after stat().
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > MAX_BYTES) throw new Error('Settings file is too large.');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    if (!object(value)) throw new Error('Invalid settings object.');
    const keys = Object.keys(value);
    if (!keys.length) return undefined;
    if (keys.length !== 1 || keys[0] !== 'model') throw new Error('Invalid settings fields.');
    return parseSelection(value.model);
  } finally {
    await file.close();
  }
}

async function requireRegularOrMissing(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error('Settings path is not a regular file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function saveSelection(path: string, selection?: Selection): Promise<void> {
  const data = JSON.stringify(selection ? { model: parseSelection(selection) } : {}, null, 2) + '\n';
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Settings file is too large.');
  await withFileMutationQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    await requireRegularOrMissing(path);
    const temp = path + '.' + randomUUID() + '.tmp';
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(data);
      await file.close();
      await requireRegularOrMissing(path);
      await rename(temp, path);
    } finally {
      await file.close();
      await unlink(temp).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  });
}
