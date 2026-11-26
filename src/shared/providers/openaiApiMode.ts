import { ApiFormat, OpenAIApiMode, ProviderAuthType, ProviderName } from './constants';
import { isCustomProviderKey } from './customProviders';

type OpenAIApiModeContext = {
  apiFormat?: unknown;
  openaiApiMode?: unknown;
  codingPlanEnabled?: unknown;
  authType?: unknown;
};

/**
 * Whether this provider can offer the Chat Completions / Responses choice.
 * Supported on custom providers and built-in OpenAI (API Key mode). Other
 * built-in providers stay on Chat Completions by default.
 */
export const supportsOpenAIApiModeSelection = (providerName: string): boolean => (
  isCustomProviderKey(providerName) || providerName === ProviderName.OpenAI
);

/**
 * Default OpenAI wire mode when `openaiApiMode` is not explicitly persisted.
 * Official OpenAI models default to Responses (matching pi-ai's OpenAI catalog
 * and OpenAI API Key connection tests), while custom relays default to Chat
 * Completions.
 */
export const getDefaultOpenAIApiMode = (providerName: string): OpenAIApiMode => (
  providerName === ProviderName.OpenAI
    ? OpenAIApiMode.Responses
    : OpenAIApiMode.ChatCompletions
);

/**
 * Whether the choice applies to the provider's current setup. Coding plan and
 * OAuth routes use dedicated endpoints with fixed transport.
 */
export const isOpenAIApiModeAvailable = (
  providerName: string,
  config: Pick<OpenAIApiModeContext, 'codingPlanEnabled' | 'authType'> | undefined,
): boolean => (
  supportsOpenAIApiModeSelection(providerName)
  && config?.codingPlanEnabled !== true
  && config?.authType !== ProviderAuthType.OAuth
);

export const normalizeOpenAIApiMode = (
  value: unknown,
  fallback: OpenAIApiMode = OpenAIApiMode.ChatCompletions,
): OpenAIApiMode => {
  if (value === OpenAIApiMode.Responses) return OpenAIApiMode.Responses;
  if (value === OpenAIApiMode.ChatCompletions) return OpenAIApiMode.ChatCompletions;
  return fallback;
};

/**
 * Resolve the OpenAI endpoint family a provider should use. Returns undefined
 * when the provider is not OpenAI-compatible or the choice does not apply, so
 * callers keep their existing per-provider defaults.
 */
export const resolveProviderOpenAIApiMode = (
  providerName: string,
  config: OpenAIApiModeContext | undefined,
): OpenAIApiMode | undefined => {
  if (!config || config.apiFormat !== ApiFormat.OpenAI) return undefined;
  if (!isOpenAIApiModeAvailable(providerName, config)) return undefined;
  return normalizeOpenAIApiMode(config.openaiApiMode, getDefaultOpenAIApiMode(providerName));
};
