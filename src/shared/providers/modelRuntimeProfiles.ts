import { OpenClawApi, OpenClawProviderId } from './constants';
import { CONTEXT_WINDOW_SELECTION_CAPABILITY } from './modelContextWindow';

export const ModelRuntimeProfile = {
  MoonshotKimiK3: 'moonshot-kimi-k3',
} as const;
export type ModelRuntimeProfile =
  typeof ModelRuntimeProfile[keyof typeof ModelRuntimeProfile];

export const ModelRuntimeProfileSource = {
  BuiltIn: 'built-in',
  Custom: 'custom',
  Server: 'server',
} as const;
export type ModelRuntimeProfileSource =
  typeof ModelRuntimeProfileSource[keyof typeof ModelRuntimeProfileSource];

export const LOBSTERAI_CLIENT_CAPABILITIES_HEADER = 'X-LobsterAI-Client-Capabilities';
export const LOBSTERAI_CLIENT_VERSION_HEADER = 'X-LobsterAI-Client-Version';
export const KIMI_K3_AGENTIC_CAPABILITY = 'kimi-k3-agentic-v1';
export const THINKING_LEVEL_CONTROL_CAPABILITY = 'thinking-level-control-v1';
export const UPSTREAM_ERROR_DETAILS_CAPABILITY = 'upstream-error-details-v1';
export const LOBSTERAI_CLIENT_CAPABILITIES = [
  'virtual-models-v1',
  KIMI_K3_AGENTIC_CAPABILITY,
  THINKING_LEVEL_CONTROL_CAPABILITY,
  UPSTREAM_ERROR_DETAILS_CAPABILITY,
  CONTEXT_WINDOW_SELECTION_CAPABILITY,
].join(',');

const KIMI_K3_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export const KIMI_K3_RUNTIME_PROFILE = {
  reasoning: true,
  input: ['text', 'image', 'video'],
  contextWindow: 1_048_576,
  maxTokens: 1_048_576,
  thinkingLevelMap: {
    off: null as null,
    minimal: 'max',
    low: 'max',
    medium: 'max',
    high: 'max',
    xhigh: 'max',
    max: 'max',
  },
  compat: {
    maxTokensField: 'max_tokens',
    supportsUsageInStreaming: false,
    requiresStringContent: true,
    supportsReasoningEffort: true,
    supportedReasoningEfforts: KIMI_K3_REASONING_EFFORTS,
  },
} as const;

export const MODEL_RUNTIME_PROFILES = {
  [ModelRuntimeProfile.MoonshotKimiK3]: KIMI_K3_RUNTIME_PROFILE,
} as const;

export type ModelRuntimeProfileDefinition =
  typeof MODEL_RUNTIME_PROFILES[ModelRuntimeProfile];

export interface ModelRuntimeProfileMetadata {
  supportsImage?: boolean;
  supportsVideo?: boolean;
  supportsThinking?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ModelRuntimeProfileMetadataOverrides {
  supportsImage?: boolean;
  supportsThinking?: boolean;
}

export const getModelRuntimeProfileDefinition = (
  profile: ModelRuntimeProfile,
): ModelRuntimeProfileDefinition => MODEL_RUNTIME_PROFILES[profile];

/**
 * Strict profile enforcement for server/package models where untrusted remote
 * metadata must not override the client-controlled K3 capability contract.
 */
export const applyModelRuntimeProfileMetadata = (
  metadata: ModelRuntimeProfileMetadata,
  profile: ModelRuntimeProfile | undefined,
): ModelRuntimeProfileMetadata => {
  if (!profile) {
    return metadata;
  }

  const definition = getModelRuntimeProfileDefinition(profile);
  return {
    ...metadata,
    supportsImage: definition.input.includes('image'),
    supportsVideo: definition.input.includes('video'),
    supportsThinking: definition.reasoning,
    contextWindow: definition.contextWindow,
    maxTokens: definition.maxTokens,
  };
};

/**
 * User-respectful profile defaults for built-in and custom models: fills in
 * missing profile limits and repairs unoverridden capability defaults while
 * preserving explicit user choices (contextWindow, maxTokens, and overrides).
 */
export const applyModelRuntimeProfileDefaults = (
  metadata: ModelRuntimeProfileMetadata,
  profile: ModelRuntimeProfile | undefined,
  overrides?: ModelRuntimeProfileMetadataOverrides,
): ModelRuntimeProfileMetadata => {
  if (!profile) {
    return metadata;
  }

  const definition = getModelRuntimeProfileDefinition(profile);
  return {
    ...metadata,
    supportsImage: typeof overrides?.supportsImage === 'boolean'
      ? overrides.supportsImage
      : (metadata.supportsImage || definition.input.includes('image')),
    supportsVideo: metadata.supportsVideo || definition.input.includes('video'),
    supportsThinking: typeof overrides?.supportsThinking === 'boolean'
      ? overrides.supportsThinking
      : (metadata.supportsThinking || definition.reasoning),
    contextWindow: metadata.contextWindow ?? definition.contextWindow,
    maxTokens: metadata.maxTokens ?? definition.maxTokens,
  };
};

const MODEL_RUNTIME_PROFILE_VALUES = new Set<string>(
  Object.values(ModelRuntimeProfile),
);

export const parseModelRuntimeProfile = (
  value: unknown,
): ModelRuntimeProfile | undefined => (
  typeof value === 'string' && MODEL_RUNTIME_PROFILE_VALUES.has(value)
    ? value as ModelRuntimeProfile
    : undefined
);

export const normalizeModelIdForComparison = (modelId: string): string =>
  modelId.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

export interface ResolveModelRuntimeProfileInput {
  source: ModelRuntimeProfileSource;
  providerId: string;
  modelId: string;
  api: string;
  serverRuntimeProfile?: unknown;
}

const isKimiK3ModelId = (modelId: string): boolean =>
  normalizeModelIdForComparison(modelId) === 'kimik3';

export const resolveModelRuntimeProfile = ({
  source,
  providerId,
  modelId,
  api,
  serverRuntimeProfile,
}: ResolveModelRuntimeProfileInput): ModelRuntimeProfile | undefined => {
  if (api !== OpenClawApi.OpenAICompletions) {
    return undefined;
  }

  if (source === ModelRuntimeProfileSource.Server) {
    if (providerId !== OpenClawProviderId.LobsteraiServer) {
      return undefined;
    }
    return parseModelRuntimeProfile(serverRuntimeProfile);
  }

  if (
    source !== ModelRuntimeProfileSource.BuiltIn
    && source !== ModelRuntimeProfileSource.Custom
  ) {
    return undefined;
  }

  return isKimiK3ModelId(modelId)
    ? ModelRuntimeProfile.MoonshotKimiK3
    : undefined;
};

export const KIMI_K3_RESERVED_CUSTOM_PARAM_KEYS = [
  'compat',
  'frequencyPenalty',
  'frequency_penalty',
  'maxCompletionTokens',
  'maxTokens',
  'max_completion_tokens',
  'max_tokens',
  'n',
  'presencePenalty',
  'presence_penalty',
  'reasoning',
  'reasoningEffort',
  'reasoning_effort',
  'requiresStringContent',
  'streamOptions',
  'stream_options',
  'supportedReasoningEfforts',
  'supportsReasoningEffort',
  'supportsUsageInStreaming',
  'temperature',
  'thinking',
  'thinkingLevelMap',
  'topP',
  'top_p',
] as const;

const KIMI_K3_RESERVED_CUSTOM_PARAM_KEY_SET = new Set<string>(
  KIMI_K3_RESERVED_CUSTOM_PARAM_KEYS,
);

export const findKimiK3ReservedCustomParamKeys = (
  customParams: Record<string, unknown> | undefined,
): string[] => {
  if (!customParams) {
    return [];
  }
  return Object.keys(customParams)
    .filter(key => KIMI_K3_RESERVED_CUSTOM_PARAM_KEY_SET.has(key))
    .sort();
};

const KIMI_K3_LEGACY_DEFAULT_MAX_TOKENS = 8_192;
const KIMI_K3_LEGACY_MAX_TOKENS_PARAM_KEYS = [
  'max_tokens',
  'max_completion_tokens',
  'maxTokens',
  'maxCompletionTokens',
] as const;

export interface MigrateKimiK3CustomParamsOptions {
  /**
   * When true (default, used for stored-config hydration), a valid legacy
   * `max_tokens` in `customParams` overrides the stock K3 default (`1_048_576`)
   * or legacy OpenClaw default (`8_192`) so OpenClaw-era workarounds carry over
   * cleanly into the structured `maxTokens` field. When false (used when saving
   * the Model Editor form), any explicit `maxTokens` entered by the user wins.
   */
  promoteOverDefaultMaxTokens?: boolean;
}

export interface MigrateKimiK3CustomParamsResult {
  customParams: Record<string, unknown> | undefined;
  migratedMaxTokens: number | undefined;
  strippedKeys: string[];
}

const extractValidLegacyKimiK3MaxTokens = (
  customParams: Record<string, unknown>,
): number | undefined => {
  for (const key of KIMI_K3_LEGACY_MAX_TOKENS_PARAM_KEYS) {
    const raw = customParams[key];
    if (
      typeof raw === 'number'
      && Number.isInteger(raw)
      && raw >= 1
      && raw <= KIMI_K3_RUNTIME_PROFILE.maxTokens
    ) {
      return raw;
    }
  }
  return undefined;
};

/**
 * Clean up OpenClaw-era / runtime-managed keys from a Kimi K3 model's
 * `customParams` and promote any valid legacy `max_tokens` workaround into the
 * structured `maxTokens` field. Non-reserved custom params are preserved as-is.
 */
export const migrateKimiK3LegacyCustomParams = (
  customParams: Record<string, unknown> | undefined,
  currentMaxTokens?: number,
  options?: MigrateKimiK3CustomParamsOptions,
): MigrateKimiK3CustomParamsResult => {
  if (!customParams || typeof customParams !== 'object' || Array.isArray(customParams)) {
    return {
      customParams: undefined,
      migratedMaxTokens: undefined,
      strippedKeys: [],
    };
  }

  const strippedKeys = findKimiK3ReservedCustomParamKeys(customParams);
  if (strippedKeys.length === 0) {
    return {
      customParams: Object.keys(customParams).length > 0 ? customParams : undefined,
      migratedMaxTokens: undefined,
      strippedKeys: [],
    };
  }

  const promoteOverDefault = options?.promoteOverDefaultMaxTokens ?? true;
  const legacyMaxTokens = extractValidLegacyKimiK3MaxTokens(customParams);
  const canPromote = currentMaxTokens === undefined
    || (
      promoteOverDefault
      && (
        currentMaxTokens === KIMI_K3_RUNTIME_PROFILE.maxTokens
        || currentMaxTokens === KIMI_K3_LEGACY_DEFAULT_MAX_TOKENS
      )
    );
  const migratedMaxTokens = legacyMaxTokens !== undefined && canPromote
    ? legacyMaxTokens
    : undefined;

  const cleanedEntries = Object.entries(customParams).filter(
    ([key]) => !KIMI_K3_RESERVED_CUSTOM_PARAM_KEY_SET.has(key),
  );

  return {
    customParams: cleanedEntries.length > 0 ? Object.fromEntries(cleanedEntries) : undefined,
    migratedMaxTokens,
    strippedKeys,
  };
};
