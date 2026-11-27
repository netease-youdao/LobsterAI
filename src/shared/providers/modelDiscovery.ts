/**
 * Shared IPC channels, protocol discriminants, error codes, and payload types
 * for fetching available models from a provider's live model-listing endpoint.
 */

export const ProviderModelDiscoveryIpcChannel = {
  Discover: 'provider:discoverModels',
} as const;
export type ProviderModelDiscoveryIpcChannel =
  typeof ProviderModelDiscoveryIpcChannel[keyof typeof ProviderModelDiscoveryIpcChannel];

export const ProviderDiscoveryProtocol = {
  OpenAICompletions: 'openai-completions',
  OpenAIResponses: 'openai-responses',
  AnthropicMessages: 'anthropic-messages',
  GoogleGenerativeAI: 'google-generative-ai',
} as const;
export type ProviderDiscoveryProtocol =
  typeof ProviderDiscoveryProtocol[keyof typeof ProviderDiscoveryProtocol];

export const ModelDiscoveryErrorCode = {
  InvalidBaseUrl: 'invalid-base-url',
  InvalidApiKey: 'invalid-api-key',
  UnsupportedProtocol: 'unsupported-protocol',
  NetworkError: 'network-error',
  AuthError: 'auth-error',
  HttpError: 'http-error',
  ResponseTooLarge: 'response-too-large',
  InvalidJson: 'invalid-json',
  InvalidFormat: 'invalid-format',
  Aborted: 'aborted',
} as const;
export type ModelDiscoveryErrorCode =
  typeof ModelDiscoveryErrorCode[keyof typeof ModelDiscoveryErrorCode];

export const ModelDiscoveryModality = {
  Text: 'text',
  Image: 'image',
} as const;
export type ModelDiscoveryModality =
  typeof ModelDiscoveryModality[keyof typeof ModelDiscoveryModality];

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  inputModalities?: ModelDiscoveryModality[];
  reasoning?: boolean;
}

export interface ProviderModelDiscoveryRequest {
  provider?: string;
  baseUrl: string;
  apiProtocol: ProviderDiscoveryProtocol;
  apiKey?: string;
  headers?: Record<string, string>;
}

export type ProviderModelDiscoveryResult =
  | {
    ok: true;
    models: DiscoveredModel[];
  }
  | {
    ok: false;
    code: ModelDiscoveryErrorCode;
    status?: number;
    message: string;
    detail?: string;
  };
