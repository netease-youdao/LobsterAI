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
  Anthropic: 'anthropic',
  DeepSeek: 'deepseek',
  Moonshot: 'moonshot',
  Zhipu: 'zhipu',
  Minimax: 'minimax',
  Youdaozhiyun: 'youdaozhiyun',
  Qwen: 'qwen',
  Xiaomi: 'xiaomi',
  StepFun: 'stepfun',
  Volcengine: 'volcengine',
  OpenRouter: 'openrouter',
  Ollama: 'ollama',
  Custom: 'custom',
  LobsteraiServer: 'lobsterai-server',
} as const;
export type ProviderName = typeof ProviderName[keyof typeof ProviderName];

// ─── OpenClaw Provider ID ───────────────────────────────────────────────
// OpenClaw gateway provider identifiers. May differ from ProviderName.
export const OpenClawProviderId = {
  LobsteraiServer: 'lobsterai-server',
  KimiCoding: 'kimi-coding',
  Moonshot: 'moonshot',
  Google: 'google',
  Anthropic: 'anthropic',
  OpenAI: 'openai',
  DeepSeek: 'deepseek',
  Qwen: 'qwen-portal', // OpenClaw normalizes 'qwen' → 'qwen-portal'; use canonical ID to avoid config diff loop
  Zai: 'zai', // OpenClaw official provider ID for Zhipu/GLM
  Volcengine: 'volcengine',
  VolcenginePlan: 'volcengine-plan', // OpenClaw coding plan provider for Volcengine
  Minimax: 'minimax',
  Youdaozhiyun: 'youdaozhiyun',
  StepFun: 'stepfun',
  Xiaomi: 'xiaomi',
  OpenRouter: 'openrouter',
  Ollama: 'ollama',
  Lobster: 'lobster', // Fallback ID for unknown providers
} as const;
export type OpenClawProviderId = typeof OpenClawProviderId[keyof typeof OpenClawProviderId];

// ─── OpenClaw API Protocol ──────────────────────────────────────────────
export const OpenClawApi = {
  AnthropicMessages: 'anthropic-messages',
  OpenAICompletions: 'openai-completions',
  OpenAIResponses: 'openai-responses',
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
} as const;
export type AuthType = typeof AuthType[keyof typeof AuthType];

// ═══════════════════════════════════════════════════════
// 2. Provider Definition Shape
// ═══════════════════════════════════════════════════════

interface ProviderDefInput {
  /** Provider identifier (e.g. 'openai', 'moonshot') */
  readonly id: string;
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
   */
  readonly codingPlanUrls?: {
    readonly openai: string;
    readonly anthropic: string;
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
  }[];
}

// ═══════════════════════════════════════════════════════
// 3. Provider Definitions — the single source of truth
//    Array order = Chinese UI display order
//    (CHINA first, then GLOBAL, matching existing config.ts order).
// ═══════════════════════════════════════════════════════

const PROVIDER_DEFINITIONS = [
  // ── China ──
  {
    id: ProviderName.DeepSeek,
    defaultBaseUrl: 'https://api.deepseek.com/anthropic',
    defaultApiFormat: ApiFormat.Anthropic,
    codingPlanSupported: false,
    switchableBaseUrls: {
      anthropic: 'https://api.deepseek.com/anthropic',
      openai: 'https://api.deepseek.com',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
    ],
  },
  {
    id: ProviderName.Moonshot,
    defaultBaseUrl: 'https://api.moonshot.cn/anthropic',
    defaultApiFormat: ApiFormat.Anthropic,
    codingPlanSupported: true,
    codingPlanUrls: {
      openai: 'https://api.kimi.com/coding/v1',
      anthropic: 'https://api.kimi.com/coding',
    },
    switchableBaseUrls: {
      anthropic: 'https://api.moonshot.cn/anthropic',
      openai: 'https://api.moonshot.cn/v1',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5', supportsImage: true },
    ],
  },
  {
    id: ProviderName.Qwen,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    defaultApiFormat: ApiFormat.Anthropic,
    codingPlanSupported: true,
    codingPlanUrls: {
      openai: 'https://coding.dashscope.aliyuncs.com/v1',
      anthropic: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    },
    switchableBaseUrls: {
      anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
      openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', supportsImage: true },
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', supportsImage: false },
    ],
  },
  {
    id: ProviderName.Zhipu,
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
      { id: 'glm-5', name: 'GLM 5', supportsImage: false },
      { id: 'glm-4.7', name: 'GLM 4.7', supportsImage: false },
    ],
  },
  {
    id: ProviderName.Minimax,
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
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', supportsImage: false },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', supportsImage: false },
    ],
  },
  {
    id: ProviderName.Volcengine,
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
      { id: 'ark-code-latest', name: 'Auto', supportsImage: false },
      { id: 'doubao-seed-2-0-pro-260215', name: 'Doubao-Seed-2.0-pro', supportsImage: false },
      { id: 'doubao-seed-2-0-lite-260215', name: 'Doubao-Seed-2.0-lite', supportsImage: false },
      { id: 'doubao-seed-2-0-mini-260215', name: 'Doubao-Seed-2.0-mini', supportsImage: false },
    ],
  },
  {
    id: ProviderName.Youdaozhiyun,
    defaultBaseUrl: 'https://openapi.youdao.com/llmgateway/api/v1/chat/completions',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: false,
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', supportsImage: false },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
      { id: 'deepseek-inhouse-chat', name: 'DeepSeek Chat (\u5b89\u5168)', supportsImage: false },
      { id: 'deepseek-inhouse-reasoner', name: 'DeepSeek Reasoner (\u5b89\u5168)', supportsImage: false },
    ],
  },
  {
    id: ProviderName.StepFun,
    defaultBaseUrl: 'https://api.stepfun.com/v1',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: false,
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'step-3.5-flash', name: 'Step 3.5 Flash', supportsImage: false },
    ],
  },
  {
    id: ProviderName.Xiaomi,
    defaultBaseUrl: 'https://api.xiaomimimo.com/anthropic',
    defaultApiFormat: ApiFormat.Anthropic,
    codingPlanSupported: false,
    switchableBaseUrls: {
      anthropic: 'https://api.xiaomimimo.com/anthropic',
      openai: 'https://api.xiaomimimo.com/v1/chat/completions',
    },
    region: 'china',
    enPriority: 0,
    defaultModels: [
      { id: 'mimo-v2-flash', name: 'MiMo V2 Flash', supportsImage: false },
    ],
  },
  {
    id: ProviderName.Ollama,
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
  // ── Global ──
  {
    id: ProviderName.OpenAI,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultApiFormat: ApiFormat.OpenAI,
    codingPlanSupported: false,
    region: 'global',
    enPriority: 1,
    defaultModels: [
      { id: 'gpt-5.4', name: 'GPT-5.4', supportsImage: true },
      { id: 'gpt-5.2', name: 'GPT-5.2', supportsImage: true },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', supportsImage: true },
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', supportsImage: true },
    ],
  },
  {
    id: ProviderName.Gemini,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultApiFormat: ApiFormat.Gemini,
    codingPlanSupported: false,
    region: 'global',
    enPriority: 3,
    defaultModels: [
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', supportsImage: true },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', supportsImage: true },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', supportsImage: true },
    ],
  },
  {
    id: ProviderName.Anthropic,
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultApiFormat: ApiFormat.Anthropic,
    codingPlanSupported: false,
    region: 'global',
    enPriority: 2,
    defaultModels: [
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', supportsImage: true },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsImage: true },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', supportsImage: true },
    ],
  },
  {
    id: ProviderName.OpenRouter,
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
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', supportsImage: true },
      { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', supportsImage: true },
      { id: 'openai/gpt-5.2-codex', name: 'GPT 5.2 Codex', supportsImage: true },
      { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro', supportsImage: true },
    ],
  },
] as const satisfies readonly ProviderDefInput[];

// ═══════════════════════════════════════════════════════
// 4. Provider Definition Interface (public)
// ═══════════════════════════════════════════════════════

export interface ProviderDef {
  /** Provider identifier (e.g. 'openai', 'moonshot') */
  readonly id: string;
  /** Default base URL */
  readonly defaultBaseUrl: string;
  /** Default API format */
  readonly defaultApiFormat: ApiFormat;
  /** Whether this provider supports codingPlan mode */
  readonly codingPlanSupported: boolean;
  /** Coding Plan dedicated endpoints */
  readonly codingPlanUrls?: {
    readonly openai: string;
    readonly anthropic: string;
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
  }[];
}

// ═══════════════════════════════════════════════════════
// 5. Registry Implementation
// ═══════════════════════════════════════════════════════

class ProviderRegistryImpl {
  private readonly defs: readonly ProviderDef[];
  private readonly idIndex: ReadonlyMap<string, ProviderDef>;

  constructor(definitions: readonly ProviderDef[]) {
    this.defs = definitions;
    const idx = new Map<string, ProviderDef>();
    for (const def of definitions) {
      idx.set(def.id, def);
    }
    this.idIndex = idx;
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

    // Move ollama to the end (custom providers are appended dynamically by Settings)
    const ollamaIdx = unique.indexOf(ProviderName.Ollama);
    if (ollamaIdx !== -1) {
      unique.splice(ollamaIdx, 1);
    }
    unique.push(ProviderName.Ollama);
    return unique;
  }
}

export const ProviderRegistry = new ProviderRegistryImpl(PROVIDER_DEFINITIONS);
