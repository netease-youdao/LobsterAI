import type { ProviderConfig } from '../../shared/providers';
import { ApiFormat, ProviderName } from '../../shared/providers';

export type OllamaOpenClawAppConfig = {
  model?: {
    defaultModel?: string;
    defaultModelProvider?: string;
  };
  providers?: Record<string, ProviderConfig>;
};

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export function buildOllamaOpenClawAppConfig(
  current: OllamaOpenClawAppConfig,
  modelName: string,
): OllamaOpenClawAppConfig {
  const trimmedModelName = modelName.trim();
  if (!trimmedModelName) {
    throw new Error('Model name is required');
  }

  const providers = { ...(current.providers ?? {}) };
  const existingOllama = providers[ProviderName.Ollama] ?? {
    enabled: false,
    apiKey: '',
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
    apiFormat: ApiFormat.OpenAI,
    models: [],
  };
  const existingModels = existingOllama.models ?? [];
  const hasModel = existingModels.some((model) => model.id === trimmedModelName);
  const models = hasModel
    ? existingModels
    : [
      ...existingModels,
      { id: trimmedModelName, name: trimmedModelName, supportsImage: false },
    ];

  providers[ProviderName.Ollama] = {
    ...existingOllama,
    enabled: true,
    apiKey: existingOllama.apiKey ?? '',
    baseUrl: existingOllama.baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL,
    apiFormat: ApiFormat.OpenAI,
    models,
  };

  return {
    ...current,
    providers,
    model: {
      ...(current.model ?? {}),
      defaultModel: trimmedModelName,
      defaultModelProvider: ProviderName.Ollama,
    },
  };
}
