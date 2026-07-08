/**
 * Provider Constants & Registry — Single Source of Truth
 *
 * All LLM provider identifiers, default configurations, and metadata are
 * defined here as a unified registry. Both main and renderer processes
 * import from this module.
 *
 * When adding a new provider:
 * 1. Add the provider key to ProviderName
 * 2. Add the OpenClaw provider ID to OpenClawProviderId (if different)
 * 3. Add one record to the PROVIDER_DEFINITIONS array
 *    — that's it, types and lookups are derived automatically.
 *
 * Follows the same pattern as PlatformRegistry in src/shared/platform/.
 * String literal constants follow AGENTS.md "String Literal Constants" spec,
 * modeled after src/scheduledTask/constants.ts.
 */

// ═══════════════════════════════════════════════════════
// 1. String Literal Constants
// ═══════════════════════════════════════════════════════

// ─── Provider Name ──────────────────────────────────────────────────────
// providerName identifies the LobsterAI internal provider (config key).
export const ProviderName = {
  OpenAI: 'openai',
  Gemini: 'gemini',
  Xai: 'xai',
  Anthropic: 'anthropic',
  DeepSeek: 'deepseek',
  Moonshot: 'moonshot',
  Zhipu: 'zhipu',
  Minimax: 'minimax',
  Youdaozhiyun: 'youdaozhiyun',
  Qwen: 'qwen',
  Qianfan: 'qianfan',
  Xiaomi: 'xiaomi',
  StepFun: 'stepfun',
  Volcengine: 'volcengine',
  OpenRouter: 'openrouter',
  Ollama: 'ollama',
  LmStudio: 'lm-studio',
  Custom: 'custom',
  LobsteraiServer: 'lobsterai-server',
  Copilot: 'github-copilot',
} as const;
export type ProviderName = typeof ProviderName[keyof typeof ProviderName];

// ─── OpenClaw Provider ID ───────────────────────────────────────────────
// OpenClaw gateway provider identifiers. May differ from ProviderName.
export const OpenClawProviderId = {
  LobsteraiServer: 'lobsterai-server',
  Moonshot: 'moonshot',
  Google: 'google',
  Xai: 'xai',
  Anthropic: 'anthropic',
  OpenAI: 'openai',
  OpenAICodex: 'openai-codex',
  DeepSeek: 'deepseek',
  Qianfan: 'qianfan',
  Qwen: 'qwen',
  Zai: 'zai', // OpenClaw official provider ID for Zhipu/GLM
  Volcengine: 'volcengine',
  Minimax: 'minimax',
  MinimaxPortal: 'minimax-portal',
  Youdaozhiyun: 'youdaozhiyun',
  StepFun: 'stepfun',
  Xiaomi: 'xiaomi',
  OpenRouter: 'openrouter',
  Copilot: 'github-copilot',
  LobsteraiCopilot: 'lobsterai-copilot',
  Ollama: 'ollama',
  LmStudio: 'lm-studio',
  Lobster: 'lobster',
} as const;
export type OpenClawProviderId = typeof OpenClawProviderId[keyof typeof OpenClawProviderId];

// ─── OpenClaw API Protocol ──────────────────────────────────────────────
export const OpenClawApi = {
  AnthropicMessages: 'anthropic-messages',
  OpenAICompletions: 'openai-completions',
  OpenAIResponses: 'openai-responses',
  OpenAICodexResponses: 'openai-codex-responses',
  OpenAIChatGPTResponses: 'openai-chatgpt-responses',
  GoogleGenerativeAI: 'google-generative-ai',
} as const;
export type OpenClawApi = typeof OpenClawApi[keyof typeof OpenClawApi];

// ─── API Format (provider default protocol format) ──────────────────────
export const ApiFormat = {
  OpenAI: 'openai',
  Anthropic: 'anthropic',
  Gemini: 'gemini',
} as const;
export type ApiFormat = typeof ApiFormat[keyof typeof ApiFormat];

// ─── Auth Type ──────────────────────────────────────────────────────────
export const AuthType = {
  ApiKey: 'api-key',
  OAuth: 'oauth',
} as const;
export type AuthType = typeof AuthType[keyof typeof AuthType];

export const ProviderAuthType = {
  ApiKey: 'apikey',
  OAuth: 'oauth',
} as const;
export type ProviderAuthType = typeof ProviderAuthType[keyof typeof ProviderAuthType];

// ═══════════════════════════════════════════════════════
// 2. Provider Definition Shape
// ═══════════════════════════════════════════════════════

interface ProviderDefInput {
  /** Provider identifier (e.g. 'openai', 'moonshot') */
  readonly id: string;
  /** Human-readable display name shown in UI, e.g. 'OpenAI', 'GitHub Copilot' */
  readonly label: string;
  /** Provider console / product website URL */
  readonly website?: string;
  /** API key creation page URL. Omit for providers that don't use API keys (e.g. Ollama). */
  readonly apiKeyUrl?: string;
  /** Default base URL */
  readonly defaultBaseUrl: string;
  /** Default API format */
  readonly defaultApiFormat: ApiFormat;
  /** Whether this provider supports codingPlan mode */
  readonly codingPlanSupported: boolean;
  /**
   * Coding Plan dedicated endpoints (only for codingPlanSupported=true providers).
   * openai: OpenAI-compatible format endpoint
   * anthropic: Anthropic-compatible format endpoint
   * Either field may be omitted for providers that only support one protocol.
   */
  readonly codingPlanUrls?: {
    readonly openai?: string;
    readonly anthropic?: string;
  };
  /**
   * When set, resolveCodingPlanBaseUrl will use this format (and its URL) regardless
   * of the caller's current apiFormat. Use for providers whose coding plan endpoint
   * only supports a single protocol (e.g. Zhipu coding plan is openai-only).
   */
  readonly preferredCodingPlanFormat?: 'openai' | 'anthropic';
  /**
   * Default baseUrl when switching apiFormat.
   * Used by Settings UI to auto-switch baseUrl when toggling anthropic/openai format.
   * If omitted, both formats use defaultBaseUrl.
   */
  readonly switchableBaseUrls?: {
    readonly anthropic: string;
    readonly openai: string;
  };
  /** Region grouping for UI visibility */
  readonly region: 'china' | 'global';
  /** Priority ordering for English locale display (lower = higher priority, 0 = no special priority) */
  readonly enPriority: number;
  /** Default model list */
  readonly defaultModels: readonly {
    readonly id: string;
    readonly name: string;
    readonly supportsImage: boolean;
    readonly supportsThinking?: boolean;
    readonly contextWindow?: number;
  }[];
  /**
   * Coding Plan dedicated model list (only meaningful when codingPlanSupported=true).
   * When the user toggles codingPlanEnabled in Settings, the model list is replaced
   * with this list. When unset, coding plan mode keeps the same models as defaultModels.
   */
  readonly codingPlanModels?: readonly {
    readonly id: string;
    readonly name: string;
    readonly supportsImage: boolean;
    readonly supportsThinking?: boolean;
    readonly contextWindow?: number;
  }[];
  /**
   * The OpenClaw gateway provider ID used when building model refs (e.g. "provider/modelId").
   * Most providers share the same value as `id`, but some differ
   * (e.g. zhipu → zai, gemini → google).
   * Used by renderer to construct scheduled-task model references without
   * importing main-process-only openclawConfigSync.
   */
  readonly openClawProviderId: OpenClawProviderId;
}

// ═══════════════════════════════════════════════════════
// 3. Provider Definitions — the single source of truth
//    Array order = Chinese UI display order
//    (CHINA first, then GLOBAL, matching existing config.ts order).
// ═══════════════════════════════════════════════════════

const DEEPSEEK_V4_CONTEXT_WINDOW = 1_000_000;

const PROVIDER_DEFINITIONS = [
  // ── China ──
  {
    id: ProviderName.DeepSeek,
    label: 'DeepSeek',
    website: 'https://platform.deepseek.com',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    openClawProviderId: OpenClawProviderId.DeepSeek,
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: false,
    switchableBaseUrls: {
      anthropic: 'https://api.deepseek.com/anthropic',
      openai: 'https://api.deepseek.com',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, supportsThinking: true, contextWindow: DEEPSEEK_V4_CONTEXT_WINDOW },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false, supportsThinking: true, contextWindow: DEEPSEEK_V4_CONTEXT_WINDOW },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false, supportsThinking: true },
    ],
  },
  {
    id: ProviderName.Moonshot,
    label: 'Moonshot',
    website: 'https://platform.moonshot.cn',
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    openClawProviderId: OpenClawProviderId.Moonshot,
    // Moonshot's /anthropic endpoint does not fully implement the Anthropic Messages spec
    // (no tool use, incomplete streaming, etc.). API connectivity tests pass, but actual
    // cowork sessions fail to send/receive messages. Force OpenAI-compatible format instead.
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: true,
    codingPlanUrls: {
      openai: 'https://api.kimi.com/coding/v1',
      anthropic: 'https://api.kimi.com/coding',
    },
    preferredCodingPlanFormat: 'anthropic',
    switchableBaseUrls: {
      anthropic: 'https://api.moonshot.cn/anthropic',
      openai: 'https://api.moonshot.cn/v1',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'kimi-k2.6', name: 'Kimi K2.6', supportsImage: true, supportsThinking: true, contextWindow: 262_144 },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', supportsImage: true, supportsThinking: true, contextWindow: 262_144 },
    ],
    codingPlanModels: [{ id: 'kimi-for-coding', name: 'Kimi K2.5', supportsImage: true, supportsThinking: true, contextWindow: 256_000 }],
  },
  {
    id: ProviderName.Qwen,
    label: 'Qwen',
    website: 'https://dashscope.console.aliyun.com',
    apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    openClawProviderId: OpenClawProviderId.Qwen,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    defaultApiFormat: ApiFormat.Anthropic,
    codingPlanSupported: true,
    codingPlanUrls: {
      openai: 'https://coding.dashscope.aliyuncs.com/v1',
      anthropic: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    },
    preferredCodingPlanFormat: 'openai',
    switchableBaseUrls: {
      anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
      openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', supportsImage: true, contextWindow: 1_000_000 },
      { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', supportsImage: true, contextWindow: 1_000_000 },
    ],
  },
  {
    id: ProviderName.Zhipu,
    label: 'Zhipu',
    website: 'https://open.bigmodel.cn',
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    openClawProviderId: OpenClawProviderId.Zai,
    defaultBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    defaultApiFormat: ApiFormat.Anthropic,
    codingPlanSupported: true,
    codingPlanUrls: {
      openai: 'https://open.bigmodel.cn/api/coding/paas/v4',
      anthropic: 'https://open.bigmodel.cn/api/anthropic',
    },
    preferredCodingPlanFormat: 'openai',
    switchableBaseUrls: {
      anthropic: 'https://open.bigmodel.cn/api/anthropic',
      openai: 'https://open.bigmodel.cn/api/paas/v4',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'glm-5.1', name: 'GLM 5.1', supportsImage: false, supportsThinking: true, contextWindow: 202_800 },
      { id: 'glm-5', name: 'GLM 5', supportsImage: false, supportsThinking: true, contextWindow: 202_800 },
      { id: 'glm-4.7', name: 'GLM 4.7', supportsImage: false, supportsThinking: true, contextWindow: 204_800 },
    ],
  },
  {
    id: ProviderName.Minimax,
    label: 'MiniMax',
    website: 'https://platform.minimaxi.com',
    apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    openClawProviderId: OpenClawProviderId.Minimax,
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic',
    defaultApiFormat: ApiFormat.Anthropic,
    codingPlanSupported: false,
    switchableBaseUrls: {
      anthropic: 'https://api.minimaxi.com/anthropic',
      openai: 'https://api.minimaxi.com/v1',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'MiniMax-M3', name: 'MiniMax M3', supportsImage: true, supportsThinking: true, contextWindow: 1_000_000 },
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', supportsImage: false, contextWindow: 204_800 },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', supportsImage: false, contextWindow: 204_800 },
    ],
  },
  {
    id: ProviderName.Volcengine,
    label: 'Volcengine',
    website: 'https://console.volcengine.com/ark',
    apiKeyUrl: 'https://console.volcengine.com/ark',
    openClawProviderId: OpenClawProviderId.Volcengine,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
    defaultApiFormat: ApiFormat.Anthropic,
    codingPlanSupported: true,
    codingPlanUrls: {
      openai: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      anthropic: 'https://ark.cn-beijing.volces.com/api/coding',
    },
    switchableBaseUrls: {
      anthropic: 'https://ark.cn-beijing.volces.com/api/compatible',
      openai: 'https://ark.cn-beijing.volces.com/api/v3',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'doubao-seed-2-0-pro-260215', name: 'Doubao-Seed-2.0-pro', supportsImage: true, supportsThinking: true },
      { id: 'ark-code-latest', name: 'Auto', supportsImage: true, supportsThinking: true },
      { id: 'doubao-seed-2-0-lite-260215', name: 'Doubao-Seed-2.0-lite', supportsImage: true, supportsThinking: true },
      { id: 'doubao-seed-2-0-mini-260215', name: 'Doubao-Seed-2.0-mini', supportsImage: true, supportsThinking: true },
    ],
  },
  {
    id: ProviderName.Youdaozhiyun,
    label: 'Youdao',
    website: 'https://ai.youdao.com',
    apiKeyUrl: 'https://ai.youdao.com/console',
    openClawProviderId: OpenClawProviderId.Youdaozhiyun,
    defaultBaseUrl: 'https://openapi.youdao.com/llmgateway/api/v1/chat/completions',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: false,
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false, supportsThinking: true },
      {
        id: 'deepseek-inhouse-reasoner',
        name: 'DeepSeek Reasoner (\u5b89\u5168)',
        supportsImage: false,
        supportsThinking: true,
      },
    ],
  },
  {
    id: ProviderName.Qianfan,
    label: 'Qianfan',
    apiKeyUrl: 'https://console.bce.baidu.com/qianfan/ais/console/apiKey',
    openClawProviderId: OpenClawProviderId.Qianfan,
    defaultBaseUrl: 'https://qianfan.baidubce.com/v2',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: true,
    codingPlanUrls: {
      openai: 'https://qianfan.baidubce.com/v2/coding/chat/completions',
    },
    preferredCodingPlanFormat: 'openai',
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5', supportsImage: false },
      { id: 'glm-5.1', name: 'GLM 5.1', supportsImage: false, supportsThinking: true },
      { id: 'minimax-m2.5', name: 'MiniMax M2.5', supportsImage: false },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, supportsThinking: true, contextWindow: DEEPSEEK_V4_CONTEXT_WINDOW },
      { id: 'ernie-4.5-turbo-20260402', name: 'ERNIE 4.5 Turbo', supportsImage: false },
    ],
  },
  {
    id: ProviderName.StepFun,
    label: 'StepFun',
    website: 'https://platform.stepfun.com',
    apiKeyUrl: 'https://platform.stepfun.com/interface-key',
    openClawProviderId: OpenClawProviderId.StepFun,
    defaultBaseUrl: 'https://api.stepfun.com/v1',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: false,
    region: 'china',
    enPriority: 0,
    defaultModels: [{ id: 'step-3.5-flash', name: 'Step 3.5 Flash', supportsImage: false }],
  },
  {
    id: ProviderName.Xiaomi,
    label: 'Xiaomi',
    website: 'https://dev.mi.com/platform',
    apiKeyUrl: 'https://dev.mi.com/platform',
    openClawProviderId: OpenClawProviderId.Xiaomi,
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: true,
    codingPlanUrls: {
      openai: 'https://token-plan-cn.xiaomimimo.com/v1',
      anthropic: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    },
    switchableBaseUrls: {
      anthropic: 'https://api.xiaomimimo.com/anthropic',
      openai: 'https://api.xiaomimimo.com/v1/chat/completions',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', supportsImage: false, supportsThinking: true, contextWindow: 1_000_000 },
      { id: 'mimo-v2.5', name: 'MiMo V2.5', supportsImage: true, supportsThinking: true, contextWindow: 1_000_000 },
    ],
  },
  {
    id: ProviderName.Ollama,
    label: 'Ollama',
    website: 'https://ollama.com',
    openClawProviderId: OpenClawProviderId.Ollama,
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: false,
    switchableBaseUrls: {
      anthropic: 'http://localhost:11434',
      openai: 'http://localhost:11434/v1',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'qwen3-coder-next', name: 'Qwen3-Coder-Next', supportsImage: false },
      { id: 'glm-4.7-flash', name: 'GLM 4.7 Flash', supportsImage: false },
    ],
  },
  {
    id: ProviderName.LmStudio,
    label: 'LM Studio',
    website: 'https://lmstudio.ai',
    openClawProviderId: OpenClawProviderId.LmStudio,
    defaultBaseUrl: 'http://localhost:1234/v1',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: false,
    switchableBaseUrls: {
      anthropic: 'http://localhost:1234',
      openai: 'http://localhost:1234/v1',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [],
  },
  // ── Global ──
  {
    id: ProviderName.Copilot,
    label: 'GitHub Copilot',
    openClawProviderId: OpenClawProviderId.LobsteraiCopilot,
    defaultBaseUrl: 'https://api.individual.githubcopilot.com',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: false,
    region: 'global',
    enPriority: 0,
    defaultModels: [
      { id: 'gpt-5-mini', name: 'GPT-5 mini', supportsImage: true },
      { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', supportsImage: true },
      { id: 'gpt-4.1', name: 'GPT-4.1', supportsImage: true },
      { id: 'gpt-4o', name: 'GPT-4o', supportsImage: true },
    ],
  },
  {
    id: ProviderName.OpenAI,
    label: 'OpenAI',
    website: 'https://platform.openai.com',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    openClawProviderId: OpenClawProviderId.OpenAI,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: false,
    region: 'global',
    enPriority: 1,
    defaultModels: [
      { id: 'gpt-5.4', name: 'GPT-5.4', supportsImage: true, supportsThinking: true },
      { id: 'gpt-5.5', name: 'GPT-5.5', supportsImage: true, supportsThinking: true },
    ],
  },
  {
    id: ProviderName.Gemini,
    label: 'Gemini',
    website: 'https://aistudio.google.com',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    openClawProviderId: OpenClawProviderId.Google,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultApiFormat: ApiFormat.Gemini,
    codingPlanSupported: false,
    region: 'global',
    enPriority: 3,
    defaultModels: [
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', supportsImage: true, supportsThinking: true },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', supportsImage: true, supportsThinking: true },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', supportsImage: true, supportsThinking: true },
    ],
  },
  {
    id: ProviderName.Xai,
    label: 'xAI (Grok)',
    website: 'https://console.x.ai',
    apiKeyUrl: 'https://console.x.ai',
    openClawProviderId: OpenClawProviderId.Xai,
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: false,
    region: 'global',
    enPriority: 4,
    // Model IDs must stay within the pinned OpenClaw xai extension's selectable
    // catalog (extensions/xai/model-definitions.ts); retired IDs are pruned by
    // the runtime on config sync.
    defaultModels: [
      { id: 'grok-4.3', name: 'Grok 4.3', supportsImage: true, supportsThinking: true, contextWindow: 1_000_000 },
      { id: 'grok-build-0.1', name: 'Grok Build 0.1', supportsImage: true, supportsThinking: true, contextWindow: 256_000 },
    ],
  },
  {
    id: ProviderName.Anthropic,
    label: 'Anthropic',
    website: 'https://console.anthropic.com',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    openClawProviderId: OpenClawProviderId.Anthropic,
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultApiFormat: ApiFormat.Anthropic,
    codingPlanSupported: false,
    region: 'global',
    enPriority: 2,
    defaultModels: [
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', supportsImage: true, supportsThinking: true, contextWindow: 1_048_576 },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', supportsImage: true, supportsThinking: true, contextWindow: 1_048_576 },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsImage: true, supportsThinking: true, contextWindow: 1_048_576 },
    ],
  },
  {
    id: ProviderName.OpenRouter,
    label: 'OpenRouter',
    website: 'https://openrouter.ai',
    apiKeyUrl: 'https://openrouter.ai/keys',
    openClawProviderId: OpenClawProviderId.OpenRouter,
    defaultBaseUrl: 'https://openrouter.ai/api',
    defaultApiFormat: ApiFormat.Anthropic,
    codingPlanSupported: false,
    switchableBaseUrls: {
      anthropic: 'https://openrouter.ai/api',
      openai: 'https://openrouter.ai/api/v1',
    },
    region: 'global',
    enPriority: 0,
    defaultModels: [
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', supportsImage: true, supportsThinking: true },
      { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7', supportsImage: true, supportsThinking: true },
      { id: 'openai/gpt-5.5', name: 'GPT 5.5', supportsImage: true, supportsThinking: true },
      { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', supportsImage: true, supportsThinking: true },
    ],
  },
] as const satisfies readonly ProviderDefInput[];

// ═══════════════════════════════════════════════════════
// 4. Provider Definition Interface (public)
// ═══════════════════════════════════════════════════════

export interface ProviderDef {
  /** Provider identifier (e.g. 'openai', 'moonshot') */
  readonly id: string;
  /** Human-readable display name shown in UI */
  readonly label: string;
  /** Provider console / product website URL */
  readonly website?: string;
  /** API key creation page URL */
  readonly apiKeyUrl?: string;
  /** Default base URL */
  readonly defaultBaseUrl: string;
  /** Default API format */
  readonly defaultApiFormat: ApiFormat;
  /** Whether this provider supports codingPlan mode */
  readonly codingPlanSupported: boolean;
  /** Coding Plan dedicated endpoints */
  readonly codingPlanUrls?: {
    readonly openai?: string;
    readonly anthropic?: string;
  };
  /** When set, overrides caller's apiFormat for coding plan URL resolution. */
  readonly preferredCodingPlanFormat?: 'openai' | 'anthropic';
  /** Default baseUrl per apiFormat for UI switching */
  readonly switchableBaseUrls?: {
    readonly anthropic: string;
    readonly openai: string;
  };
  /** Region grouping for UI visibility */
  readonly region: 'china' | 'global';
  /** Priority ordering for English locale display (lower = higher priority, 0 = no special priority) */
  readonly enPriority: number;
  /** Default model list */
  readonly defaultModels: readonly {
    readonly id: string;
    readonly name: string;
    readonly supportsImage: boolean;
    readonly supportsThinking?: boolean;
    readonly contextWindow?: number;
  }[];
  readonly codingPlanModels?: readonly {
    readonly id: string;
    readonly name: string;
    readonly supportsImage: boolean;
    readonly supportsThinking?: boolean;
    readonly contextWindow?: number;
  }[];
  readonly openClawProviderId: OpenClawProviderId;
}

// ═══════════════════════════════════════════════════════
// 5. Registry Implementation
// ═══════════════════════════════════════════════════════

const isValidContextWindow = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

class ProviderRegistryImpl {
  private readonly defs: readonly ProviderDef[];
  private readonly idIndex: ReadonlyMap<string, ProviderDef>;
  private readonly modelCapabilityIndex: ReadonlyMap<string, boolean>;
  private readonly modelContextWindowIndex: ReadonlyMap<string, number>;

  constructor(definitions: readonly ProviderDef[]) {
    this.defs = definitions;
    const idx = new Map<string, ProviderDef>();
    const modelIdx = new Map<string, boolean>();
    const contextWindowIdx = new Map<string, number>();
    for (const def of definitions) {
      idx.set(def.id, def);
      for (const model of [...def.defaultModels, ...(def.codingPlanModels ?? [])]) {
        const existing = modelIdx.get(model.id);
        modelIdx.set(model.id, existing === true || model.supportsImage);
        if (isValidContextWindow(model.contextWindow)) {
          const existingContextWindow = contextWindowIdx.get(model.id);
          if (existingContextWindow === undefined || model.contextWindow > existingContextWindow) {
            contextWindowIdx.set(model.id, model.contextWindow);
          }
        }
      }
    }
    this.idIndex = idx;
    this.modelCapabilityIndex = modelIdx;
    this.modelContextWindowIndex = contextWindowIdx;
  }

  /** All provider IDs in definition order. */
  get providerIds(): readonly string[] {
    return this.defs.map(d => d.id);
  }

  /** Get full definition for a provider. Returns undefined for unknown IDs. */
  get(id: string): ProviderDef | undefined {
    return this.idIndex.get(id);
  }

  /** Whether a provider supports codingPlan. */
  supportsCodingPlan(id: string): boolean {
    return this.idIndex.get(id)?.codingPlanSupported ?? false;
  }

  /** Providers filtered by region, preserving definition order. */
  byRegion(region: 'china' | 'global'): readonly ProviderDef[] {
    return this.defs.filter(d => d.region === region);
  }

  getCodingPlanUrl(id: string, format: 'openai' | 'anthropic'): string | undefined {
    const def = this.idIndex.get(id);
    if (!def?.codingPlanSupported || !def.codingPlanUrls) return undefined;
    return def.codingPlanUrls[format];
  }

  getSwitchableBaseUrl(id: string, format: 'openai' | 'anthropic'): string | undefined {
    return this.idIndex.get(id)?.switchableBaseUrls?.[format];
  }

  getOpenClawProviderId(providerName: string): string {
    return this.idIndex.get(providerName)?.openClawProviderId ?? providerName ?? OpenClawProviderId.Lobster;
  }

  getOpenClawProviderIdForConfig(
    providerName: string,
    providerConfig: { authType?: ProviderAuthType },
  ): string {
    if (providerName === ProviderName.Minimax && providerConfig.authType === ProviderAuthType.OAuth) {
      return OpenClawProviderId.MinimaxPortal;
    }
    return this.getOpenClawProviderId(providerName);
  }

  getProviderModelSupportsImage(providerName: string, modelId: string): boolean | undefined {
    const def = this.idIndex.get(providerName);
    if (!def) return undefined;
    const model = [...def.defaultModels, ...(def.codingPlanModels ?? [])]
      .find(candidate => candidate.id === modelId);
    return model?.supportsImage;
  }

  getKnownModelSupportsImage(modelId: string): boolean | undefined {
    return this.modelCapabilityIndex.get(modelId);
  }

  getProviderModelSupportsThinking(providerName: string, modelId: string): boolean | undefined {
    const def = this.idIndex.get(providerName);
    if (!def) return undefined;
    const model = [...def.defaultModels, ...(def.codingPlanModels ?? [])]
      .find(candidate => candidate.id === modelId);
    return model?.supportsThinking;
  }

  getProviderModelContextWindow(providerName: string, modelId: string): number | undefined {
    const def = this.idIndex.get(providerName);
    if (!def) return undefined;
    const model = [...def.defaultModels, ...(def.codingPlanModels ?? [])]
      .find(candidate => candidate.id === modelId);
    return model?.contextWindow;
  }

  getKnownModelContextWindow(modelId: string): number | undefined {
    return this.modelContextWindowIndex.get(modelId);
  }

  resolveModelSupportsImage(
    providerName: string,
    modelId: string,
    configuredSupportsImage?: boolean,
  ): boolean {
    const providerModelSupportsImage = this.getProviderModelSupportsImage(providerName, modelId);
    if (providerModelSupportsImage !== undefined) {
      return providerModelSupportsImage;
    }
    if (configuredSupportsImage === true) {
      return true;
    }
    const knownModelSupportsImage = this.getKnownModelSupportsImage(modelId);
    if (knownModelSupportsImage === true) {
      return true;
    }
    return configuredSupportsImage ?? false;
  }

  resolveModelSupportsThinking(
    providerName: string,
    modelId: string,
    configuredSupportsThinking?: boolean,
  ): boolean {
    const providerModelSupportsThinking = this.getProviderModelSupportsThinking(providerName, modelId);
    if (providerModelSupportsThinking !== undefined) {
      return providerModelSupportsThinking;
    }
    if (configuredSupportsThinking === true) {
      return true;
    }
    return configuredSupportsThinking ?? false;
  }

  resolveModelContextWindow(
    providerName: string,
    modelId: string,
    configuredContextWindow?: number,
  ): number | undefined {
    if (isValidContextWindow(configuredContextWindow)) {
      return configuredContextWindow;
    }
    return this.getProviderModelContextWindow(providerName, modelId)
      ?? this.getKnownModelContextWindow(modelId);
  }

  /** Provider IDs filtered by region. */
  idsByRegion(region: 'china' | 'global'): readonly string[] {
    return this.defs.filter(d => d.region === region).map(d => d.id);
  }

  /**
   * Provider IDs for English locale display:
   * EN_PRIORITY providers first (sorted by enPriority), then CHINA, then remaining GLOBAL.
   * ollama and custom are always pushed to the end, with custom last.
   */
  idsForEnLocale(): readonly string[] {
    const priority = this.defs
      .filter(d => d.enPriority > 0)
      .sort((a, b) => a.enPriority - b.enPriority)
      .map(d => d.id);
    const china = this.idsByRegion('china');
    const global = this.idsByRegion('global');

    const orderedProviders = [...priority, ...china, ...global];
    const unique = [...new Set(orderedProviders)];

    // Move local providers (ollama, lm-studio) to the end
    const ollamaIdx = unique.indexOf(ProviderName.Ollama);
    if (ollamaIdx !== -1) {
      unique.splice(ollamaIdx, 1);
    }
    const lmStudioIdx = unique.indexOf(ProviderName.LmStudio);
    if (lmStudioIdx !== -1) {
      unique.splice(lmStudioIdx, 1);
    }
    unique.push(ProviderName.Ollama);
    unique.push(ProviderName.LmStudio);
    return unique;
  }
}

export const ProviderRegistry = new ProviderRegistryImpl(PROVIDER_DEFINITIONS);
