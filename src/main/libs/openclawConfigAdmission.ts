import { isDeepStrictEqual } from 'node:util';

import { OPENCLAW_MODEL_COMPAT_PLUGIN_ID } from '../../shared/openclawEngine/constants';
import { OpenClawProviderId } from '../../shared/providers/constants';
import { collectReferencedEnvVarNames } from './openclawSecretEnv';

/**
 * What differs for one model between the config the running gateway applied
 * and the pending target. The runtime pins a task's model before every turn,
 * so other pending changes (agent defaults, channels, bindings, MCP, skills)
 * do not change how that task runs.
 */
export const OpenClawModelRuntimeChange = {
  None: 'none',
  /** No applied baseline, an unreadable config, or no explicit model to compare. */
  Unknown: 'unknown',
  /** Endpoint, API, auth or request settings shared by the provider's models. */
  Provider: 'provider',
  /** The model's own entry: limits, input types, compat flags, thinking map. */
  Model: 'model',
  /** Per-model agent defaults, such as request params. */
  ModelDefaults: 'model_defaults',
  /** Model or thinking profiles of the compatibility plugin. */
  Compatibility: 'compatibility',
  /** Secret values the provider references; only a new gateway process sees them. */
  Credentials: 'credentials',
} as const;

export type OpenClawModelRuntimeChange =
  typeof OpenClawModelRuntimeChange[keyof typeof OpenClawModelRuntimeChange];

export type OpenClawModelRuntimeChangeInput = {
  /** `provider/model` that the task pins before its turn. */
  modelRef: string;
  /** Config the running gateway generation runs on: the target it confirmed applying, or the file it spawned with. */
  appliedRaw: string | null;
  /** Latest staged target the running gateway has not applied yet. */
  pendingRaw: string | null;
  /** Secret env values the running gateway process was spawned with. */
  appliedSecretEnv: Record<string, string> | null;
  /** Secret env values the next gateway process would be spawned with. */
  pendingSecretEnv: Record<string, string>;
};

type ConfigRecord = Record<string, unknown>;

const COMPAT_PLUGIN_ENTRY_PATH = ['plugins', 'entries', OPENCLAW_MODEL_COMPAT_PLUGIN_ID] as const;
const COMPAT_PROFILE_KEYS = ['modelProfiles', 'thinkingProfiles'] as const;
const AGENT_MODEL_DEFAULTS_PATH = ['agents', 'defaults', 'models'] as const;
// The compatibility plugin hooks the plan provider by alias even when it does not own its API.
const COMPAT_HOOKED_PROVIDER_IDS: ReadonlySet<string> = new Set([OpenClawProviderId.LobsteraiServer]);

const isRecord = (value: unknown): value is ConfigRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const parseConfig = (raw: string): ConfigRecord | null => {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

const readPath = (root: unknown, keys: readonly string[]): unknown => {
  let value = root;
  for (const key of keys) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
};

const readRecord = (root: unknown, keys: readonly string[]): ConfigRecord => {
  const value = readPath(root, keys);
  return isRecord(value) ? value : {};
};

/** `provider/model`, where the model ID itself may contain slashes. */
const splitModelRef = (modelRef: string): { providerId: string; modelId: string } | null => {
  const ref = modelRef.trim();
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
};

/** Provider fields shared by all of its models. */
const providerSettings = (provider: unknown): ConfigRecord | null => {
  if (!isRecord(provider)) return null;
  const settings = { ...provider };
  delete settings.models;
  return settings;
};

const findModelEntry = (provider: unknown, modelId: string): ConfigRecord | null => {
  const models = readPath(provider, ['models']);
  if (!Array.isArray(models)) return null;
  for (const model of models) {
    if (isRecord(model) && typeof model.id === 'string' && model.id.trim() === modelId) return model;
  }
  return null;
};

/** The ref's own entry, or every entry of its provider when the ref matched no model. */
const selectRefEntries = (
  entries: ConfigRecord,
  modelRef: string,
  providerPrefix: string | null,
): ConfigRecord => {
  if (providerPrefix === null) {
    return Object.hasOwn(entries, modelRef) ? { [modelRef]: entries[modelRef] } : {};
  }
  return Object.fromEntries(Object.entries(entries).filter(([key]) => key.startsWith(providerPrefix)));
};

/**
 * Compare what one model runs on in the applied config and in the pending
 * target. A ref that matches no model entry on either side (an alias the
 * runtime normalizes later) is compared against its whole provider instead.
 */
export function resolveOpenClawModelRuntimeChange(
  input: OpenClawModelRuntimeChangeInput,
): OpenClawModelRuntimeChange {
  const ref = splitModelRef(input.modelRef);
  if (!ref || input.appliedRaw === null || input.pendingRaw === null) return OpenClawModelRuntimeChange.Unknown;
  const applied = parseConfig(input.appliedRaw);
  const pending = parseConfig(input.pendingRaw);
  if (!applied || !pending) return OpenClawModelRuntimeChange.Unknown;

  const providerPath = ['models', 'providers', ref.providerId];
  const appliedProvider = readPath(applied, providerPath);
  const pendingProvider = readPath(pending, providerPath);
  if (!isDeepStrictEqual(providerSettings(appliedProvider), providerSettings(pendingProvider))) {
    return OpenClawModelRuntimeChange.Provider;
  }

  const appliedModel = findModelEntry(appliedProvider, ref.modelId);
  const pendingModel = findModelEntry(pendingProvider, ref.modelId);
  const matched = appliedModel !== null || pendingModel !== null;
  const modelChanged = matched
    ? !isDeepStrictEqual(appliedModel, pendingModel)
    : !isDeepStrictEqual(readPath(appliedProvider, ['models']) ?? null, readPath(pendingProvider, ['models']) ?? null);
  if (modelChanged) return OpenClawModelRuntimeChange.Model;

  const modelRef = `${ref.providerId}/${ref.modelId}`;
  const providerPrefix = matched ? null : `${ref.providerId}/`;
  const refEntriesChanged = (keys: readonly string[]): boolean => !isDeepStrictEqual(
    selectRefEntries(readRecord(applied, keys), modelRef, providerPrefix),
    selectRefEntries(readRecord(pending, keys), modelRef, providerPrefix),
  );
  if (refEntriesChanged(AGENT_MODEL_DEFAULTS_PATH)) return OpenClawModelRuntimeChange.ModelDefaults;

  if (COMPAT_PROFILE_KEYS.some(key => refEntriesChanged([...COMPAT_PLUGIN_ENTRY_PATH, 'config', key]))) {
    return OpenClawModelRuntimeChange.Compatibility;
  }
  const compatHooked = COMPAT_HOOKED_PROVIDER_IDS.has(ref.providerId)
    || readPath(appliedProvider, ['api']) === OPENCLAW_MODEL_COMPAT_PLUGIN_ID
    || readPath(pendingProvider, ['api']) === OPENCLAW_MODEL_COMPAT_PLUGIN_ID;
  const compatEnabledPath = [...COMPAT_PLUGIN_ENTRY_PATH, 'enabled'];
  if (compatHooked && readPath(applied, compatEnabledPath) !== readPath(pending, compatEnabledPath)) {
    return OpenClawModelRuntimeChange.Compatibility;
  }

  const envNames = new Set([
    ...collectReferencedEnvVarNames(appliedProvider),
    ...collectReferencedEnvVarNames(pendingProvider),
  ]);
  if (envNames.size > 0) {
    const appliedSecretEnv = input.appliedSecretEnv;
    if (!appliedSecretEnv) return OpenClawModelRuntimeChange.Unknown;
    for (const name of envNames) {
      if (appliedSecretEnv[name] !== input.pendingSecretEnv[name]) return OpenClawModelRuntimeChange.Credentials;
    }
  }
  return OpenClawModelRuntimeChange.None;
}
