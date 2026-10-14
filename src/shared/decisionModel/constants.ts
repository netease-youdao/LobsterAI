// Experimental decision model (TypeSafe Jev). A decision model returns typed
// answers with probabilities instead of text, so it reaches the agent as a
// tool rather than as a chat model. Shared by main, preload, and renderer.

export const DecisionModelProvider = {
  TypeSafe: 'typesafe',
  OpenRouter: 'openrouter',
  // Any endpoint that speaks TypeSafe's System One wire format, e.g. a
  // new-api relay's /typesafe/v1/systemone route.
  Compatible: 'compatible',
} as const;
export type DecisionModelProvider = typeof DecisionModelProvider[keyof typeof DecisionModelProvider];

export const DecisionModelIpcChannel = {
  GetConfig: 'decisionModel:getConfig',
  SaveConfig: 'decisionModel:saveConfig',
  TestConnection: 'decisionModel:testConnection',
} as const;
export type DecisionModelIpcChannel = typeof DecisionModelIpcChannel[keyof typeof DecisionModelIpcChannel];

// Travels to the renderer so failures can be localized.
export const DecisionModelErrorCode = {
  MissingApiKey: 'missing_api_key',
  InvalidEndpoint: 'invalid_endpoint',
  InvalidInput: 'invalid_input',
  Unauthorized: 'unauthorized',
  InsufficientCredits: 'insufficient_credits',
  RateLimited: 'rate_limited',
  Timeout: 'timeout',
  Cancelled: 'cancelled',
  Network: 'network',
  UpstreamError: 'upstream_error',
  InvalidResponse: 'invalid_response',
} as const;
export type DecisionModelErrorCode = typeof DecisionModelErrorCode[keyof typeof DecisionModelErrorCode];

// kv store key holding the experimental decision model settings.
export const DECISION_MODEL_CONFIG_STORE_KEY = 'decision_model_config';

// Local OpenClaw extension (openclaw-extensions/lobster-decision) that
// registers the decision_evaluate tool.
export const DECISION_MODEL_PLUGIN_ID = 'lobster-decision';

/** Settings as the settings card shows them, key included like provider keys. */
export interface DecisionModelConfigView {
  enabled: boolean;
  provider: DecisionModelProvider;
  endpoint: string;
  apiKey: string;
  /** Enabled and fully configured, so the agent has the tool. */
  active: boolean;
}

export interface DecisionModelConfigUpdate {
  enabled?: boolean;
  provider?: DecisionModelProvider;
  endpoint?: string;
  /** Omitted keeps the saved key; an empty string clears it. */
  apiKey?: string;
}

export interface DecisionModelTestResult {
  ok: boolean;
  model?: string;
  elapsedMs?: number;
  errorCode?: DecisionModelErrorCode;
  error?: string;
}
