/**
 * Renderer service and pure helpers for fetching available models from a
 * provider's live endpoint and merging selected candidates into provider config.
 */

import {
  applyModelRuntimeProfileDefaults,
  type DiscoveredModel,
  ModelDiscoveryErrorCode,
  ModelDiscoveryModality,
  ModelRuntimeProfileSource,
  OpenClawApi,
  ProviderDiscoveryProtocol,
  type ProviderModelDiscoveryRequest,
  type ProviderModelDiscoveryResult,
  ProviderName,
  ProviderRegistry,
  resolveCodingPlanBaseUrl,
  resolveModelRuntimeProfile,
  supportsGeminiApiFormatSelection,
} from '../../shared/providers';
import {
  getEffectiveApiFormat,
  type Model,
  type ProviderConfig,
  providerRequiresApiKey,
  type ProviderType,
  resolveBaseUrl,
  shouldUseOpenAIResponsesForProvider,
} from '../components/settings/modelProviderUtils';
import { isCustomProvider } from '../config';

const AUTO_SELECT_ALL_EMPTY_MAX_CANDIDATES = 10;

const COPILOT_DISCOVERY_HEADERS: Readonly<Record<string, string>> = {
  'Copilot-Integration-Id': 'vscode-chat',
  'Editor-Version': 'vscode/1.96.2',
  'Editor-Plugin-Version': 'copilot-chat/0.26.7',
  'User-Agent': 'GitHubCopilotChat/0.26.7',
  'Openai-Intent': 'conversation-panel',
};

export interface ProviderDiscoveryAuthState {
  minimaxIsOAuthMode: boolean;
  openaiIsOAuthMode: boolean;
  xaiIsOAuthMode: boolean;
  copilotSignedIn: boolean;
}

export type ProviderDiscoveryAvailability =
  | { available: true }
  | { available: false; reasonKey: string };

export function isLoopbackBaseUrl(rawBaseUrl: string): boolean {
  const trimmed = rawBaseUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export function resolveEffectiveDiscoveryEndpoint(
  provider: ProviderType,
  config: ProviderConfig,
  authState: ProviderDiscoveryAuthState,
): {
  baseUrl: string;
  effectiveApiFormat: 'anthropic' | 'openai' | 'gemini';
  apiProtocol: ProviderDiscoveryProtocol;
} {
  if (provider === ProviderName.Minimax && authState.minimaxIsOAuthMode) {
    const oauthBaseUrl = config.oauthBaseUrl?.trim()
      || resolveBaseUrl(provider, config.baseUrl, 'anthropic');
    return {
      baseUrl: oauthBaseUrl,
      effectiveApiFormat: 'anthropic',
      apiProtocol: ProviderDiscoveryProtocol.AnthropicMessages,
    };
  }

  let effectiveApiFormat = getEffectiveApiFormat(provider, config.apiFormat);
  let effectiveBaseUrl = resolveBaseUrl(provider, config.baseUrl, effectiveApiFormat);

  if (
    config.codingPlanEnabled
    && (effectiveApiFormat === 'anthropic' || effectiveApiFormat === 'openai')
  ) {
    const resolved = resolveCodingPlanBaseUrl(
      provider,
      true,
      effectiveApiFormat,
      effectiveBaseUrl,
    );
    effectiveBaseUrl = resolved.baseUrl;
    effectiveApiFormat = resolved.effectiveFormat;
  }

  const useGemini = effectiveApiFormat === 'gemini'
    && (provider === ProviderName.Gemini || supportsGeminiApiFormatSelection(provider));

  let apiProtocol: ProviderDiscoveryProtocol;
  if (useGemini) {
    apiProtocol = ProviderDiscoveryProtocol.GoogleGenerativeAI;
  } else if (effectiveApiFormat === 'anthropic') {
    apiProtocol = ProviderDiscoveryProtocol.AnthropicMessages;
  } else if (shouldUseOpenAIResponsesForProvider(provider, { ...config, apiFormat: effectiveApiFormat })) {
    apiProtocol = ProviderDiscoveryProtocol.OpenAIResponses;
  } else {
    apiProtocol = ProviderDiscoveryProtocol.OpenAICompletions;
  }

  return {
    baseUrl: effectiveBaseUrl.trim(),
    effectiveApiFormat,
    apiProtocol,
  };
}

export function resolveProviderDiscoveryAvailability(
  provider: ProviderType,
  config: ProviderConfig,
  authState: ProviderDiscoveryAuthState,
): ProviderDiscoveryAvailability {
  if (provider === ProviderName.OpenAI && authState.openaiIsOAuthMode) {
    return { available: false, reasonKey: 'fetchModelsUnsupportedInOAuth' };
  }
  if (provider === ProviderName.Xai && authState.xaiIsOAuthMode) {
    return { available: false, reasonKey: 'fetchModelsUnsupportedInOAuth' };
  }
  if (provider === ProviderName.Minimax && authState.minimaxIsOAuthMode) {
    if (!config.oauthAccessToken?.trim()) {
      return { available: false, reasonKey: 'fetchModelsRequiresLogin' };
    }
    const { baseUrl } = resolveEffectiveDiscoveryEndpoint(provider, config, authState);
    if (!baseUrl) {
      return { available: false, reasonKey: 'fetchModelsRequiresBaseUrl' };
    }
    return { available: true };
  }
  if (provider === ProviderName.Copilot) {
    if (!authState.copilotSignedIn) {
      return { available: false, reasonKey: 'fetchModelsRequiresLogin' };
    }
    return { available: true };
  }

  const { baseUrl } = resolveEffectiveDiscoveryEndpoint(provider, config, authState);
  if (!baseUrl) {
    return { available: false, reasonKey: 'fetchModelsRequiresBaseUrl' };
  }

  if (
    providerRequiresApiKey(provider)
    && !config.apiKey.trim()
    && !isLoopbackBaseUrl(baseUrl)
  ) {
    return { available: false, reasonKey: 'fetchModelsRequiresApiKey' };
  }

  return { available: true };
}

export function buildProviderDiscoveryRequest(params: {
  provider: ProviderType;
  config: ProviderConfig;
  authState: ProviderDiscoveryAuthState;
  copilotCredential?: { token: string; baseUrl?: string };
}): {
  request: ProviderModelDiscoveryRequest;
  effectiveApiFormat: 'anthropic' | 'openai' | 'gemini';
} {
  const { provider, config, authState, copilotCredential } = params;
  const resolved = resolveEffectiveDiscoveryEndpoint(provider, config, authState);

  if (provider === ProviderName.Copilot && copilotCredential) {
    return {
      effectiveApiFormat: 'openai',
      request: {
        provider,
        baseUrl: copilotCredential.baseUrl?.trim() || resolved.baseUrl,
        apiProtocol: ProviderDiscoveryProtocol.OpenAICompletions,
        apiKey: copilotCredential.token,
        headers: { ...COPILOT_DISCOVERY_HEADERS },
      },
    };
  }

  if (provider === ProviderName.Minimax && authState.minimaxIsOAuthMode) {
    return {
      effectiveApiFormat: 'anthropic',
      request: {
        provider,
        baseUrl: resolved.baseUrl,
        apiProtocol: ProviderDiscoveryProtocol.AnthropicMessages,
        ...(config.oauthAccessToken?.trim() ? { apiKey: config.oauthAccessToken.trim() } : {}),
      },
    };
  }

  const trimmedApiKey = config.apiKey.trim();
  return {
    effectiveApiFormat: resolved.effectiveApiFormat,
    request: {
      provider,
      baseUrl: resolved.baseUrl,
      apiProtocol: resolved.apiProtocol,
      ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
    },
  };
}

export function shouldAutoSelectAllDiscoveredModels(
  configuredCount: number,
  candidateCount: number,
): boolean {
  return configuredCount === 0
    && candidateCount > 0
    && candidateCount <= AUTO_SELECT_ALL_EMPTY_MAX_CANDIDATES;
}

export function computeDefaultSelectedModelIds(
  currentModels: readonly Pick<Model, 'id'>[],
  candidates: readonly Pick<DiscoveredModel, 'id'>[],
): Set<string> {
  const configuredIds = new Set(
    currentModels.map((model) => model.id.trim()).filter((id) => id.length > 0),
  );
  if (shouldAutoSelectAllDiscoveredModels(configuredIds.size, candidates.length)) {
    return new Set(candidates.map((candidate) => candidate.id));
  }
  const selected = new Set<string>();
  for (const candidate of candidates) {
    if (configuredIds.has(candidate.id)) {
      selected.add(candidate.id);
    }
  }
  return selected;
}

function mapEffectiveFormatToOpenClawApi(
  effectiveApiFormat: 'anthropic' | 'openai' | 'gemini',
): OpenClawApi {
  if (effectiveApiFormat === 'anthropic') return OpenClawApi.AnthropicMessages;
  if (effectiveApiFormat === 'gemini') return OpenClawApi.GoogleGenerativeAI;
  return OpenClawApi.OpenAICompletions;
}

const KNOWN_REASONING_MODEL_PATTERNS: readonly RegExp[] = [
  /(?:^|[/:-])deepseek-(?:r\d|reasoner|flash|v4(?:\.\d+)?(?:[-_]|$))/i,
  /(?:^|[/:-])o[134](?:[-_.]|$)/i,
  /(?:^|[/:-])qwq(?:[-_.]|$)/i,
  /(?:^|[-_.:/])thinking(?:[-_.]|$)/i,
];

function inferReasoningFromModelId(modelId: string): boolean | undefined {
  return KNOWN_REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(modelId))
    ? true
    : undefined;
}

export function adoptDiscoveredModel(
  provider: ProviderType,
  candidate: DiscoveredModel,
  effectiveApiFormat: 'anthropic' | 'openai' | 'gemini',
): Model {
  const modelId = candidate.id.trim();
  const modelName = candidate.name?.trim() || modelId;

  const runtimeProfile = resolveModelRuntimeProfile({
    source: isCustomProvider(provider)
      ? ModelRuntimeProfileSource.Custom
      : ModelRuntimeProfileSource.BuiltIn,
    providerId: provider,
    modelId,
    api: mapEffectiveFormatToOpenClawApi(effectiveApiFormat),
  });

  const discoveredSupportsImage = candidate.inputModalities?.includes(ModelDiscoveryModality.Image);
  const discoveredSupportsThinking = candidate.reasoning ?? inferReasoningFromModelId(modelId);
  const resolvedMetadata = applyModelRuntimeProfileDefaults({
    supportsImage: ProviderRegistry.resolveModelSupportsImage(
      provider,
      modelId,
      discoveredSupportsImage,
    ),
    supportsVideo: ProviderRegistry.resolveModelSupportsVideo(provider, modelId),
    supportsThinking: ProviderRegistry.resolveModelSupportsThinking(
      provider,
      modelId,
      discoveredSupportsThinking,
    ),
    contextWindow: candidate.contextWindow ?? ProviderRegistry.resolveModelContextWindow(provider, modelId),
    maxTokens: candidate.maxTokens ?? ProviderRegistry.resolveModelMaxTokens(provider, modelId),
  }, runtimeProfile);

  return {
    id: modelId,
    name: modelName,
    supportsImage: resolvedMetadata.supportsImage ?? false,
    ...(resolvedMetadata.supportsThinking ? { supportsThinking: true } : {}),
    ...(resolvedMetadata.supportsVideo ? { supportsVideo: true } : {}),
    ...(resolvedMetadata.contextWindow !== undefined ? { contextWindow: resolvedMetadata.contextWindow } : {}),
    ...(resolvedMetadata.maxTokens !== undefined ? { maxTokens: resolvedMetadata.maxTokens } : {}),
  };
}

/**
 * Difference-preserving merge modeled after DSH's ModelListEditor:
 * - Existing rows not present in `candidates` are kept untouched.
 * - Existing rows present in `candidates` and checked are kept untouched so
 *   user-edited names, context windows, and custom params survive.
 * - Existing rows present in `candidates` and unchecked are removed.
 * - Newly checked candidates are appended with enriched metadata.
 */
export function mergeDiscoveredModels(params: {
  provider: ProviderType;
  effectiveApiFormat: 'anthropic' | 'openai' | 'gemini';
  currentModels: readonly Model[];
  candidates: readonly DiscoveredModel[];
  selectedIds: ReadonlySet<string>;
}): Model[] {
  const { provider, effectiveApiFormat, currentModels, candidates, selectedIds } = params;
  const listedIds = new Set(candidates.map((candidate) => candidate.id));

  const keptRows = currentModels.filter((model) => {
    const id = model.id.trim();
    if (!listedIds.has(id)) return true;
    return selectedIds.has(id);
  });

  const keptIds = new Set(keptRows.map((model) => model.id.trim()));
  const addedRows = candidates
    .filter((candidate) => selectedIds.has(candidate.id) && !keptIds.has(candidate.id))
    .map((candidate) => adoptDiscoveredModel(provider, candidate, effectiveApiFormat));

  return [...keptRows, ...addedRows];
}

export function formatModelDiscoveryError(
  result: Extract<ProviderModelDiscoveryResult, { ok: false }>,
  t: (key: string) => string,
): string {
  let base: string;
  switch (result.code) {
    case ModelDiscoveryErrorCode.AuthError:
      base = t('fetchModelsAuthError').replace('{status}', String(result.status ?? 401));
      break;
    case ModelDiscoveryErrorCode.InvalidApiKey:
      base = t('fetchModelsInvalidApiKey');
      break;
    case ModelDiscoveryErrorCode.InvalidBaseUrl:
      base = t('fetchModelsInvalidBaseUrl');
      break;
    case ModelDiscoveryErrorCode.InvalidFormat:
      base = t('fetchModelsInvalidFormat');
      break;
    case ModelDiscoveryErrorCode.InvalidJson:
      base = t('fetchModelsInvalidJson');
      break;
    case ModelDiscoveryErrorCode.ResponseTooLarge:
      base = t('fetchModelsResponseTooLarge');
      break;
    case ModelDiscoveryErrorCode.Aborted:
      base = t('fetchModelsTimeout');
      break;
    case ModelDiscoveryErrorCode.HttpError:
      base = t('fetchModelsHttpError').replace('{status}', String(result.status ?? ''));
      break;
    case ModelDiscoveryErrorCode.UnsupportedProtocol:
      base = t('fetchModelsUnsupportedProtocol');
      break;
    case ModelDiscoveryErrorCode.NetworkError:
    default:
      base = t('fetchModelsNetworkError');
      break;
  }

  return result.detail ? `${base} (${result.detail})` : base;
}

export async function discoverModelsForProvider(params: {
  provider: ProviderType;
  config: ProviderConfig;
  authState: ProviderDiscoveryAuthState;
}): Promise<{
  result: ProviderModelDiscoveryResult;
  effectiveApiFormat: 'anthropic' | 'openai' | 'gemini';
}> {
  const { provider, config, authState } = params;

  let copilotCredential: { token: string; baseUrl?: string } | undefined;
  if (provider === ProviderName.Copilot) {
    const refreshed = await window.electron.githubCopilot.refreshToken();
    if (!refreshed.success || !refreshed.token) {
      return {
        effectiveApiFormat: 'openai',
        result: {
          ok: false,
          code: ModelDiscoveryErrorCode.AuthError,
          status: 401,
          message: refreshed.error || 'GitHub Copilot authentication required',
        },
      };
    }
    copilotCredential = {
      token: refreshed.token,
      ...(refreshed.baseUrl ? { baseUrl: refreshed.baseUrl } : {}),
    };
  }

  const { request, effectiveApiFormat } = buildProviderDiscoveryRequest({
    provider,
    config,
    authState,
    copilotCredential,
  });

  const result = await window.electron.providerModels.discover(request);
  return { result, effectiveApiFormat };
}
