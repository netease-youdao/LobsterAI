import { OPENCLAW_MODEL_COMPAT_PLUGIN_ID } from '../../shared/openclawEngine/constants';
import { createStableConfigFingerprint } from './openclawConfigImpact';
import { collectReferencedEnvVarNames } from './openclawSecretEnv';

const asConfigRecord = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
);

export const buildModelCompatRestartFingerprint = (config: unknown): string => {
  const root = asConfigRecord(config);
  const models = asConfigRecord(root?.models);
  const providers = asConfigRecord(models?.providers);
  const ownerProviderIds = Object.entries(providers ?? {})
    .filter(([, value]) => (
      asConfigRecord(value)?.api === OPENCLAW_MODEL_COMPAT_PLUGIN_ID
    ))
    .map(([providerId]) => providerId)
    .sort();

  const plugins = asConfigRecord(root?.plugins);
  const entries = asConfigRecord(plugins?.entries);
  const compatEntry = asConfigRecord(entries?.[OPENCLAW_MODEL_COMPAT_PLUGIN_ID]);
  const compatConfig = asConfigRecord(compatEntry?.config);
  const modelProfiles = asConfigRecord(compatConfig?.modelProfiles);
  const sortedModelProfiles = Object.fromEntries(
    Object.entries(modelProfiles ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  const thinkingProfiles = asConfigRecord(compatConfig?.thinkingProfiles);
  const sortedThinkingProfiles = Object.fromEntries(
    Object.entries(thinkingProfiles ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );

  return JSON.stringify({
    ownerProviderIds,
    pluginEnabled: compatEntry?.enabled === true,
    modelProfiles: sortedModelProfiles,
    thinkingProfiles: sortedThinkingProfiles,
  });
};

/** Only inputs that must be inherited by a process; model-list changes remain hot. */
export type OpenClawConfigStartupInputs = {
  secretEnv: Record<string, string>;
  referencedEnvNames: string[];
  bindings: string;
  modelCompatibility: string;
};

export function createOpenClawConfigStartupInputs(
  raw: string,
  secretEnv: Record<string, string>,
): OpenClawConfigStartupInputs {
  let config: Record<string, unknown> = {};
  try { config = asConfigRecord(JSON.parse(raw)) ?? {}; } catch { /* No trusted baseline. */ }
  return {
    secretEnv: { ...secretEnv },
    referencedEnvNames: [...collectReferencedEnvVarNames(raw)].sort(),
    bindings: createStableConfigFingerprint(config.bindings ?? []),
    modelCompatibility: buildModelCompatRestartFingerprint(config),
  };
}

/** Compare desired inputs, never the still-old on-disk file on each retry. */
export function hasOpenClawStartupInputChange(
  previous: OpenClawConfigStartupInputs,
  next: OpenClawConfigStartupInputs,
  spawned?: OpenClawConfigStartupInputs | null,
): boolean {
  return previous.bindings !== next.bindings
    || previous.modelCompatibility !== next.modelCompatibility
    || next.referencedEnvNames.some(name => previous.secretEnv[name] !== next.secretEnv[name]
      // A newly referenced key may have changed while unused since the last spawn.
      || (spawned !== null && spawned !== undefined && !previous.referencedEnvNames.includes(name)
        && spawned.secretEnv[name] !== next.secretEnv[name]));
}

export function matchesOpenClawStartupInputs(
  required: OpenClawConfigStartupInputs,
  spawned: OpenClawConfigStartupInputs,
): boolean {
  return required.bindings === spawned.bindings
    && required.modelCompatibility === spawned.modelCompatibility
    && required.referencedEnvNames.every(name => required.secretEnv[name] === spawned.secretEnv[name]);
}
