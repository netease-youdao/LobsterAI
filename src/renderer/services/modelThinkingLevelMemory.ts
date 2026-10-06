import { supportsLobsterAIRequestOptionsV1 } from '@shared/providers/lobsterAIRequestOptions';
import {
  getModelThinkingLevels,
  type ModelThinkingLevel,
  parseModelThinkingLevel,
} from '@shared/providers/modelThinking';

import { getModelIdentityKey, type Model } from '../store/slices/modelSlice';

/**
 * Remembers the thinking level the user last picked for each model.
 *
 * An agent (or a session) stores a single `thinkingLevel`: the level of the
 * model it currently runs. Without a per-model memory, switching models resets
 * the other model back to its built-in default, so two models could never hold
 * different levels at the same time. This map is picker-only state; the agent
 * and session records stay the source of truth for what actually runs.
 */
const STORAGE_KEY = 'lobsterai.model-thinking-levels';

type ModelThinkingLevelMemory = Record<string, ModelThinkingLevel>;

let cachedMemory: ModelThinkingLevelMemory | null = null;

function readMemory(): ModelThinkingLevelMemory {
  if (cachedMemory) return cachedMemory;

  const memory: ModelThinkingLevelMemory = {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [modelKey, rawLevel] of Object.entries(parsed as Record<string, unknown>)) {
        const level = parseModelThinkingLevel(rawLevel);
        if (modelKey && level) memory[modelKey] = level;
      }
    }
  } catch {
    // Best-effort memory: unreadable storage just falls back to model defaults.
  }
  cachedMemory = memory;
  return memory;
}

export function readRememberedModelThinkingLevel(
  modelKey: string,
): ModelThinkingLevel | undefined {
  if (!modelKey || typeof window === 'undefined') return undefined;
  return readMemory()[modelKey];
}

export function rememberModelThinkingLevel(
  modelKey: string,
  level: ModelThinkingLevel,
): void {
  if (!modelKey || typeof window === 'undefined') return;

  const memory = readMemory();
  if (memory[modelKey] === level) return;
  memory[modelKey] = level;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Keeping the value in memory is still better than dropping the choice.
  }
}

/**
 * Level to store for a model when no agent/session value applies — after a
 * model switch, for instance. Prefers the level the user last picked for that
 * model over the model default, so switching models in one surface does not
 * discard what was chosen for it in another. Models without a thinking config
 * resolve to `''`, the "not applicable" value agent records store.
 */
export function resolveThinkingLevelForModel(
  model: Pick<
    Model,
    'id' | 'providerKey' | 'isServerModel' | 'requestCapabilities' | 'thinkingConfig'
  > | null | undefined,
): ModelThinkingLevel | '' {
  const config = model?.thinkingConfig;
  if (!config || !supportsLobsterAIRequestOptionsV1(model.requestCapabilities)) return '';

  const remembered = readRememberedModelThinkingLevel(getModelIdentityKey(model));
  return remembered && getModelThinkingLevels(config).includes(remembered)
    ? remembered
    : config.defaultLevel;
}

/** Test-only: drop the cached map so the next read re-parses storage. */
export function resetModelThinkingLevelMemoryCache(): void {
  cachedMemory = null;
}
