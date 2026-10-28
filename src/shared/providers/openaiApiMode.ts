import { ApiFormat, OpenAIApiMode, ProviderAuthType } from './constants';
import { isCustomProviderKey } from './customProviders';

type OpenAIApiModeContext = {
  apiFormat?: unknown;
  openaiApiMode?: unknown;
  codingPlanEnabled?: unknown;
  authType?: unknown;
};

/**
 * Whether this provider can offer the Chat Completions / Responses choice.
 * Custom providers only: built-in providers' OpenClaw plugins and runtime
 * profiles are tuned for Chat Completions (e.g. DeepSeek V4 and Xiaomi MiMo
 * thinking wrappers inject Chat Completions fields regardless of transport).
 */
export const supportsOpenAIApiModeSelection = isCustomProviderKey;

/**
 * Whether the choice applies to the provider's current setup. Coding plan and
 * OAuth routes use dedicated endpoints with no Responses support.
 */
export const isOpenAIApiModeAvailable = (
  providerName: string,
  config: Pick<OpenAIApiModeContext, 'codingPlanEnabled' | 'authType'> | undefined,
): boolean => (
  supportsOpenAIApiModeSelection(providerName)
  && config?.codingPlanEnabled !== true
  && config?.authType !== ProviderAuthType.OAuth
);

export const normalizeOpenAIApiMode = (value: unknown): OpenAIApiMode => (
  value === OpenAIApiMode.Responses ? OpenAIApiMode.Responses : OpenAIApiMode.ChatCompletions
);

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
  return normalizeOpenAIApiMode(config.openaiApiMode);
};
