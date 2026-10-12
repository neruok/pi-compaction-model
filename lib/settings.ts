import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { REASONING_LEVELS, type Reasoning, type ModelSelection as Selection } from '@neruok/pi-common/model-types';
import { readSettingsBytes, decodeSettings, replaceJsonSettings } from '@neruok/pi-common/settings';
export { REASONING_LEVELS };
export type { Reasoning, Selection };

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
  const value = decodeSettings(await readSettingsBytes(path, MAX_BYTES));
  if (!object(value)) throw new Error('Invalid settings object.');
  const keys = Object.keys(value);
  if (!keys.length) return undefined;
  if (keys.length !== 1 || keys[0] !== 'model') throw new Error('Invalid settings fields.');
  return parseSelection(value.model);
}
export async function saveSelection(path: string, selection?: Selection): Promise<void> {
  const value = selection ? { model: parseSelection(selection) } : {};
  await withFileMutationQueue(path, () => replaceJsonSettings(path, value, MAX_BYTES));
}
