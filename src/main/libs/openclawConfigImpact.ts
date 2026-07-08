import { ProviderName } from '../../shared/providers';

export const OpenClawConfigImpact = {
  None: 'none',
  Sync: 'sync',
  Restart: 'restart',
} as const;

export type OpenClawConfigImpact =
  typeof OpenClawConfigImpact[keyof typeof OpenClawConfigImpact];

export const OpenClawConfigImpactReason = {
  AppUseSystemProxy: 'app.useSystemProxy',
  AppModelConfig: 'app.model',
  AppProviderConfig: 'app.providers.config',
  AppProviderSecret: 'app.providers.secret',
  CoworkRuntimeConfig: 'cowork.runtime',
  CoworkOpenClawConfig: 'cowork.openclaw',
  CoworkDreamingConfig: 'cowork.dreaming',
  ImConfig: 'im.config',
  ImForceRestart: 'im.forceRestart',
  PluginInstall: 'plugin.install',
  PluginUninstall: 'plugin.uninstall',
  PluginToggle: 'plugin.toggle',
  PluginConfig: 'plugin.config',
  McpConfig: 'mcp.config',
} as const;

export type OpenClawConfigImpactReason =
  typeof OpenClawConfigImpactReason[keyof typeof OpenClawConfigImpactReason];

export const OpenClawPluginChangeAction = {
  Install: 'install',
  Uninstall: 'uninstall',
  Toggle: 'toggle',
  Config: 'config',
} as const;

export type OpenClawPluginChangeAction =
  typeof OpenClawPluginChangeAction[keyof typeof OpenClawPluginChangeAction];

export interface ImpactDecision {
  impact: OpenClawConfigImpact;
  reasons: OpenClawConfigImpactReason[];
}

type JsonLikeObject = Record<string, unknown>;

const IMPACT_ORDER: Record<OpenClawConfigImpact, number> = {
  [OpenClawConfigImpact.None]: 0,
  [OpenClawConfigImpact.Sync]: 1,
  [OpenClawConfigImpact.Restart]: 2,
};

const PROVIDER_SECRET_FIELDS = new Set([
  'apiKey',
  'oauthAccessToken',
  'oauthRefreshToken',
]);

const COWORK_SYNC_FIELDS = new Set([
  'executionMode',
  'agentEngine',
  'workingDirectory',
  'skipMissedJobs',
  'openClawHeartbeatEnabled',
  'embeddingEnabled',
  'embeddingProvider',
  'embeddingModel',
  'embeddingLocalModelPath',
  'embeddingVectorWeight',
  'embeddingRemoteBaseUrl',
  'embeddingRemoteApiKey',
]);

const COWORK_RESTART_FIELDS = new Set([
  'dreamingEnabled',
  'dreamingFrequency',
  'dreamingModel',
  'dreamingTimezone',
]);

const noImpact = (): ImpactDecision => ({
  impact: OpenClawConfigImpact.None,
  reasons: [],
});

const decision = (
  impact: OpenClawConfigImpact,
  reason: OpenClawConfigImpactReason,
): ImpactDecision => ({
  impact,
  reasons: [reason],
});

const isPlainObject = (value: unknown): value is JsonLikeObject => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const normalizeStable = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeStable);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const sorted: JsonLikeObject = {};
  for (const key of Object.keys(value).sort()) {
    const nextValue = value[key];
    if (nextValue !== undefined) {
      sorted[key] = normalizeStable(nextValue);
    }
  }
  return sorted;
};

export const createStableConfigFingerprint = (value: unknown): string => {
  return JSON.stringify(normalizeStable(value));
};

export const mergeImpactDecision = (...decisions: ImpactDecision[]): ImpactDecision => {
  let mergedImpact: OpenClawConfigImpact = OpenClawConfigImpact.None;
  const mergedReasons: OpenClawConfigImpactReason[] = [];

  for (const nextDecision of decisions) {
    if (IMPACT_ORDER[nextDecision.impact] > IMPACT_ORDER[mergedImpact]) {
      mergedImpact = nextDecision.impact;
    }
    for (const reason of nextDecision.reasons) {
      if (!mergedReasons.includes(reason)) {
        mergedReasons.push(reason);
      }
    }
  }

  return {
    impact: mergedReasons.length > 0 ? mergedImpact : OpenClawConfigImpact.None,
    reasons: mergedReasons,
  };
};

export const removeImpactDecisionReasons = (
  source: ImpactDecision,
  reasonsToRemove: readonly OpenClawConfigImpactReason[],
): ImpactDecision => {
  const remainingReasons = source.reasons.filter(reason => !reasonsToRemove.includes(reason));
  if (remainingReasons.length === source.reasons.length) {
    return source;
  }

  const decisions = remainingReasons.map(reason => {
    if (
      reason === OpenClawConfigImpactReason.AppUseSystemProxy
      || reason === OpenClawConfigImpactReason.AppProviderSecret
      || reason === OpenClawConfigImpactReason.CoworkDreamingConfig
      || reason === OpenClawConfigImpactReason.ImConfig
      || reason === OpenClawConfigImpactReason.ImForceRestart
      || reason === OpenClawConfigImpactReason.PluginInstall
      || reason === OpenClawConfigImpactReason.PluginUninstall
      || reason === OpenClawConfigImpactReason.PluginToggle
      || reason === OpenClawConfigImpactReason.PluginConfig
      || reason === OpenClawConfigImpactReason.McpConfig
    ) {
      return decision(OpenClawConfigImpact.Restart, reason);
    }
    return decision(OpenClawConfigImpact.Sync, reason);
  });

  return mergeImpactDecision(...decisions);
};

const providerConfigWithoutSecrets = (provider: unknown): unknown => {
  if (!isPlainObject(provider)) {
    return provider;
  }

  const sanitized: JsonLikeObject = {};
  for (const [key, value] of Object.entries(provider)) {
    if (!PROVIDER_SECRET_FIELDS.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
};

const providersWithoutSecrets = (providers: unknown): unknown => {
  if (!isPlainObject(providers)) {
    return providers;
  }

  const sanitized: JsonLikeObject = {};
  for (const [providerName, provider] of Object.entries(providers)) {
    sanitized[providerName] = providerConfigWithoutSecrets(provider);
  }
  return sanitized;
};

const providerSecretsOnly = (providers: unknown): unknown => {
  if (!isPlainObject(providers)) {
    return providers;
  }

  const secrets: JsonLikeObject = {};
  for (const [providerName, provider] of Object.entries(providers)) {
    if (providerName === ProviderName.Copilot) {
      continue;
    }
    if (!isPlainObject(provider)) {
      continue;
    }
    const providerSecrets: JsonLikeObject = {};
    for (const field of PROVIDER_SECRET_FIELDS) {
      const secretValue = provider[field];
      if (typeof secretValue === 'string' && secretValue.trim().length === 0) {
        continue;
      }
      if (secretValue !== undefined && secretValue !== null) {
        providerSecrets[field] = secretValue;
      }
    }
    if (Object.keys(providerSecrets).length > 0) {
      secrets[providerName] = providerSecrets;
    }
  }
  return secrets;
};

const changed = (previous: unknown, next: unknown): boolean => {
  return createStableConfigFingerprint(previous) !== createStableConfigFingerprint(next);
};

export const classifyAppConfigChange = (
  previousConfig: unknown,
  nextConfig: unknown,
): ImpactDecision => {
  const previous = isPlainObject(previousConfig) ? previousConfig : {};
  const next = isPlainObject(nextConfig) ? nextConfig : {};
  const decisions: ImpactDecision[] = [];

  if ((previous.useSystemProxy === true) !== (next.useSystemProxy === true)) {
    decisions.push(decision(OpenClawConfigImpact.Restart, OpenClawConfigImpactReason.AppUseSystemProxy));
  }

  if (changed(previous.model, next.model)) {
    decisions.push(decision(OpenClawConfigImpact.Sync, OpenClawConfigImpactReason.AppModelConfig));
  }

  if (changed(providerSecretsOnly(previous.providers), providerSecretsOnly(next.providers))) {
    decisions.push(decision(OpenClawConfigImpact.Restart, OpenClawConfigImpactReason.AppProviderSecret));
  }

  if (changed(providersWithoutSecrets(previous.providers), providersWithoutSecrets(next.providers))) {
    decisions.push(decision(OpenClawConfigImpact.Sync, OpenClawConfigImpactReason.AppProviderConfig));
  }

  return mergeImpactDecision(...decisions);
};

export const classifyCoworkConfigChange = (
  previousConfig: unknown,
  nextConfig: unknown,
): ImpactDecision => {
  const previous = isPlainObject(previousConfig) ? previousConfig : {};
  const next = isPlainObject(nextConfig) ? nextConfig : {};
  const decisions: ImpactDecision[] = [];

  for (const field of COWORK_SYNC_FIELDS) {
    if (changed(previous[field], next[field])) {
      decisions.push(decision(OpenClawConfigImpact.Sync, OpenClawConfigImpactReason.CoworkOpenClawConfig));
      break;
    }
  }

  for (const field of COWORK_RESTART_FIELDS) {
    if (changed(previous[field], next[field])) {
      decisions.push(decision(OpenClawConfigImpact.Restart, OpenClawConfigImpactReason.CoworkDreamingConfig));
      break;
    }
  }

  return mergeImpactDecision(...decisions);
};

export const classifyImOpenClawConfigChange = (
  previousFingerprint: string | null,
  nextFingerprint: string,
  options: { forceRestart?: boolean } = {},
): ImpactDecision => {
  if (options.forceRestart) {
    return decision(OpenClawConfigImpact.Restart, OpenClawConfigImpactReason.ImForceRestart);
  }
  if (previousFingerprint === null || previousFingerprint === nextFingerprint) {
    return noImpact();
  }
  return decision(OpenClawConfigImpact.Restart, OpenClawConfigImpactReason.ImConfig);
};

export const classifyPluginConfigChange = (
  action: OpenClawPluginChangeAction,
): ImpactDecision => {
  switch (action) {
    case OpenClawPluginChangeAction.Install:
      return decision(OpenClawConfigImpact.Restart, OpenClawConfigImpactReason.PluginInstall);
    case OpenClawPluginChangeAction.Uninstall:
      return decision(OpenClawConfigImpact.Restart, OpenClawConfigImpactReason.PluginUninstall);
    case OpenClawPluginChangeAction.Toggle:
      return decision(OpenClawConfigImpact.Restart, OpenClawConfigImpactReason.PluginToggle);
    case OpenClawPluginChangeAction.Config:
      return decision(OpenClawConfigImpact.Restart, OpenClawConfigImpactReason.PluginConfig);
  }
};
