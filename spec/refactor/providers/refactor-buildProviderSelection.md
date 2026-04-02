# Refactor: `buildProviderSelection` — 数据驱动的 Provider 映射

## 问题分析

### 现状

`buildProviderSelection`（`src/main/libs/openclawConfigSync.ts`，搜索 `const buildProviderSelection` 定位）负责将 LobsterAI 的 provider 配置映射为 OpenClaw 的 `OpenClawProviderSelection` 结构。当前存在三个核心问题：

**1. 覆盖不完整**

系统支持 15+ 个 provider（定义于 `src/renderer/config.ts` 的 `defaultConfig.providers` 对象），但 `buildProviderSelection` 只显式处理了 4 个：

| Provider | 处理方式 | 状态 |
|----------|----------|------|
| `lobsterai-server` | 专用分支（token proxy） | ✅ 已覆盖 |
| `moonshot` + codingPlan | 专用分支（kimi-coding） | ✅ 已覆盖 |
| `moonshot` | 专用分支 | ✅ 已覆盖 |
| `gemini` | 专用分支（google-generative-ai） | ✅ 已覆盖 |
| `anthropic` | 落入 default `lobster` | ⚠️ providerId 错误 |
| `openai` | 落入 default `lobster` | ⚠️ providerId 错误 |
| `deepseek` | 落入 default `lobster` | ⚠️ providerId 错误 |
| `qwen` | 落入 default `lobster` | ⚠️ 无 codingPlan URL 切换 |
| `zhipu` | 落入 default `lobster` | ⚠️ 无 codingPlan URL 切换 |
| `volcengine` | 落入 default `lobster` | ⚠️ 无 codingPlan URL 切换 |
| `minimax` | 落入 default `lobster` | ⚠️ providerId 错误 |
| `youdaozhiyun` | 落入 default `lobster` | ⚠️ providerId 错误 |
| `stepfun` | 落入 default `lobster` | ⚠️ providerId 错误 |
| `xiaomi` | 落入 default `lobster` | ⚠️ providerId 错误 |
| `openrouter` | 落入 default `lobster` | ⚠️ providerId 错误 |
| `ollama` | 落入 default `lobster` | ⚠️ providerId 错误 |
| `custom` | 落入 default `lobster` | ✅ 合理兜底 |

> **双重 baseURL 切换问题**：上游函数 `resolveMatchedProvider`（`src/main/libs/claudeSettings.ts`，搜索 `function resolveMatchedProvider` 定位）对 moonshot codingPlan 做了 baseURL 切换（`MOONSHOT_CODING_PLAN_OPENAI_BASE_URL` / `MOONSHOT_CODING_PLAN_ANTHROPIC_BASE_URL`）。这意味着传入 `buildProviderSelection` 的 `baseURL` 已经是切换后的值。但 `buildProviderSelection` 自身又独立调用 `normalizeKimiCodingBaseUrl` 做了第二次处理。两层不同的切换逻辑容易导致混淆和维护隐患。
>
> 同样的双重处理也存在于 `resolveAllEnabledProviderConfigs`（`src/main/libs/claudeSettings.ts`，搜索 `function resolveAllEnabledProviderConfigs` 定位）中对 moonshot codingPlan 的 baseURL 切换。该函数的输出直接传给 `buildProviderSelection`（在 `openclawConfigSync.ts` 的 `sync()` 方法中），形成第二条双重切换路径。

**2. 大量重复代码**

每个 `if` 分支都重复构造几乎相同的 `OpenClawProviderSelection` 对象，差异仅在于：
- `providerId` 名称
- `api` 类型
- `baseUrl` 规范化方式
- 模型元数据（`reasoning`、`cost`、`contextWindow`）

**3. 扩展成本高**

添加新 provider 需要：新增 `if` 分支 → 复制整块结构体 → 添加 baseURL 规范化函数 → 修改测试。侵入核心函数，违反开闭原则。

**4. 字符串字面量散落，缺乏约束**

当前代码中大量字符串字面量在多处重复使用且缺乏集中定义，违反项目既有的 String Literal Constants 规范（AGENTS.md）：

| 类别 | 散落的字符串 | 出现位置 |
|------|-------------|---------|
| Provider Name | `'lobsterai-server'`, `'moonshot'`, `'gemini'` 等 | `buildProviderSelection` 的 if 条件、`claudeSettings.ts` 的 `getEffectiveProviderApiFormat`、renderer `config.ts` 的 key |
| OpenClaw Provider ID | `'lobster'`, `'kimi-coding'`, `'google'` 等 | `buildProviderSelection` 返回值、`syncManagedSessionStore` 迁移逻辑 |
| OpenClaw API 协议 | `'anthropic-messages'`, `'openai-completions'`, `'openai-responses'`, `'google-generative-ai'` | `buildProviderSelection` 每个分支、`mapApiTypeToOpenClawApi` |
| API Format | `'openai'`, `'anthropic'`, `'gemini'` | `claudeSettings.ts`、renderer config、shared ProviderDef |
| 特殊值 | `'proxy-managed'`, `'api-key'`, `'k2p5'`, `'thinking'` | `buildProviderSelection` 内部 |

任何一处拼写错误（如 `'anthrpoic-messages'`）都不会被 TypeScript 捕获，只能在运行时发现。

---

## 设计约束：String Literal Constants

遵循项目既有规范（AGENTS.md「String Literal Constants」章节），参照 `src/scheduledTask/constants.ts` 的 canonical pattern。

### 常量定义位置

在 `src/shared/providers/constants.ts` 中集中定义（与 `ProviderRegistry` 同文件，共享模块的 Single Source of Truth）：

```typescript
// ─── Provider Name ──────────────────────────────────────────────────────
// providerName 用于标识 LobsterAI 内部的 provider（对应 config key）
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
// OpenClaw gateway 识别的 provider 标识，与 ProviderName 不一定相同
export const OpenClawProviderId = {
  LobsteraiServer: 'lobsterai-server',
  KimiCoding: 'kimi-coding',
  Moonshot: 'moonshot',
  Google: 'google',
  Anthropic: 'anthropic',
  OpenAI: 'openai',
  DeepSeek: 'deepseek',
  Qwen: 'qwen',
  Zhipu: 'zhipu',
  Volcengine: 'volcengine',
  Minimax: 'minimax',
  Youdaozhiyun: 'youdaozhiyun',
  StepFun: 'stepfun',
  Xiaomi: 'xiaomi',
  OpenRouter: 'openrouter',
  Ollama: 'ollama',
  Lobster: 'lobster',  // 兜底 ID
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

// ─── API Format (provider 默认协议格式) ─────────────────────────────────
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
```

### 使用方式（替代裸字符串）

**Before:**
```typescript
if (providerName === 'moonshot' && codingPlanEnabled) {
  return { providerId: 'kimi-coding', api: 'anthropic-messages', ... };
}
if (providerName === 'gemini') {
  return { providerId: 'google', api: 'google-generative-ai', ... };
}
```

**After:**
```typescript
import { ProviderName, OpenClawProviderId, OpenClawApi } from '@shared/providers';

if (providerName === ProviderName.Moonshot && codingPlanEnabled) {
  return { providerId: OpenClawProviderId.KimiCoding, api: OpenClawApi.AnthropicMessages, ... };
}
if (providerName === ProviderName.Gemini) {
  return { providerId: OpenClawProviderId.Google, api: OpenClawApi.GoogleGenerativeAI, ... };
}
```

### 哪些字符串**不**常量化

遵循 AGENTS.md 规范中的「What NOT to constantize」：
- 一次性字符串：log tag `'[OpenClawConfigSync]'`、error message 等
- 用户输入透传值：`modelId`、`modelName` 等来自用户配置的动态值
- URL 字面量：`'http://127.0.0.1:${proxyPort}/v1'` 等动态拼接的 URL

### 对 PROVIDER_REGISTRY 的影响

`PROVIDER_REGISTRY` 的 key 和 value 都使用常量：

```typescript
const PROVIDER_REGISTRY: Record<string, ProviderDescriptor> = {
  [ProviderName.LobsteraiServer]: {
    providerId: OpenClawProviderId.LobsteraiServer,
    resolveApi: () => OpenClawApi.OpenAICompletions,
    // ...
  },
  [ProviderName.Gemini]: {
    providerId: OpenClawProviderId.Google,
    resolveApi: () => OpenClawApi.GoogleGenerativeAI,
    // ...
  },
  // ...
};
```

### 对 `claudeSettings.ts` 的影响

`getEffectiveProviderApiFormat` 中的硬编码字符串替换为常量：

```typescript
import { ProviderName, ApiFormat } from '@shared/providers';

function getEffectiveProviderApiFormat(providerName: string, apiFormat: unknown): AnthropicApiFormat {
  const def = ProviderRegistry.get(providerName);
  if (def) return def.defaultApiFormat as AnthropicApiFormat;
  return normalizeProviderApiFormat(apiFormat);
}
```

### 对测试的影响

遵循 AGENTS.md 规范：「Tests use constants too.」测试中所有 provider name、API 协议的断言都使用常量：

```typescript
import { ProviderName, OpenClawProviderId, OpenClawApi } from '@shared/providers';

// 场景 5: anthropic
const result = buildProviderSelection({ providerName: ProviderName.Anthropic, ... });
expect(result.providerId).toBe(OpenClawProviderId.Anthropic);
expect(result.providerConfig.api).toBe(OpenClawApi.AnthropicMessages);
```

---

## 设计方案：Provider Descriptor Registry

### 核心思路

将 `buildProviderSelection` 从 **过程式 if-else 链** 重构为 **数据驱动的 descriptor 查表**。每个 provider 的差异化行为被封装为一个 `ProviderDescriptor` 对象，核心函数只负责查表 + 组装，不再包含任何 provider 特定逻辑。

### 架构

```
buildProviderSelection(options)
    │
    ├── 1. resolveDescriptor(providerName, codingPlanEnabled)
    │       → 从 PROVIDER_REGISTRY 查找匹配的 ProviderDescriptor
    │       → 未找到则使用 DEFAULT_DESCRIPTOR
    │
    ├── 2. descriptor.normalizeBaseUrl(rawBaseUrl)
    │       → 调用 descriptor 上声明的 URL 规范化函数
    │
    ├── 3. descriptor.resolveApi(options)
    │       → 确定 OpenClawProviderApi 类型
    │
    └── 4. assembleProviderSelection(descriptor, options)
            → 用 descriptor 中的 providerId、api、modelDefaults 等
            → 组装出标准 OpenClawProviderSelection 对象
```

### 类型定义

```typescript
/**
 * Descriptor for a single provider's OpenClaw mapping behavior.
 * Each descriptor fully defines how a provider maps to OpenClaw config,
 * eliminating provider-specific if/else branches from the core function.
 */
type ProviderDescriptor = {
  /** OpenClaw provider ID (e.g. 'google', 'moonshot', 'anthropic') */
  providerId: string;

  /**
   * Resolve the OpenClaw API protocol for this provider.
   * Simple providers return a static value; complex providers (e.g. openai)
   * may inspect baseURL to choose between responses/completions APIs.
   */
  resolveApi: (options: {
    apiType: 'anthropic' | 'openai' | undefined;
    baseURL: string;
  }) => OpenClawProviderApi;

  /**
   * Normalize the raw base URL for OpenClaw consumption.
   * Each provider may have its own URL format requirements.
   * Default: strip /chat/completions suffix.
   */
  normalizeBaseUrl: (rawBaseUrl: string) => string;

  /**
   * Resolve the API key placeholder or literal value.
   * Most providers use env var placeholders; lobsterai-server may use 'proxy-managed'.
   * Default: returns '${LOBSTER_APIKEY_<PROVIDER>}'.
   */
  resolveApiKey?: (options: { apiKey: string; providerName: string }) => string;

  /**
   * Override sessionModelId when it differs from the input modelId.
   * Only needed for special cases like kimi-coding (modelId → 'k2p5').
   * Default: returns the input modelId.
   */
  resolveSessionModelId?: (modelId: string) => string;

  /**
   * Default model metadata applied to every model entry for this provider.
   * These are merged with per-model overrides. Useful for providers where
   * all models share common traits (e.g. all Gemini models support reasoning).
   */
  modelDefaults?: Partial<{
    reasoning: boolean;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }>;
};
```

### Provider Registry

```typescript
/**
 * Central registry of all provider descriptors.
 * Key = providerName (from src/main/libs/claudeSettings.ts).
 * Adding a new provider = adding one entry here. No other code changes needed.
 */
const PROVIDER_REGISTRY: Record<string, ProviderDescriptor> = {
  // === Special providers with unique routing logic ===

  'lobsterai-server': {
    providerId: 'lobsterai-server',
    resolveApi: () => 'openai-completions',
    normalizeBaseUrl: (url) => {
      const proxyPort = getOpenClawTokenProxyPort();
      return proxyPort
        ? `http://127.0.0.1:${proxyPort}/v1`
        : stripChatCompletionsSuffix(url);
    },
    resolveApiKey: () => {
      const proxyPort = getOpenClawTokenProxyPort();
      return proxyPort ? 'proxy-managed' : `\${${providerApiKeyEnvVar('server')}}`;
    },
  },

  // moonshot + codingPlanEnabled 的情况通过组合键 'moonshot:codingPlan' 处理
  'moonshot:codingPlan': {
    providerId: 'kimi-coding',
    resolveApi: () => 'anthropic-messages',
    normalizeBaseUrl: normalizeKimiCodingBaseUrl,
    resolveSessionModelId: () => 'k2p5',
    modelDefaults: {
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256000,
      maxTokens: 8192,
    },
  },

  'moonshot': {
    providerId: 'moonshot',
    resolveApi: () => 'openai-completions',
    normalizeBaseUrl: normalizeMoonshotBaseUrl,
    // reasoning 由 modelId 中是否包含 'thinking' 动态决定，不放在 modelDefaults
    modelDefaults: {
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256000,
      maxTokens: 8192,
    },
  },

  // === Google Gemini — 独立 API 协议 ===

  'gemini': {
    providerId: 'google',
    resolveApi: () => 'google-generative-ai',
    normalizeBaseUrl: normalizeGeminiBaseUrl,
    modelDefaults: {
      reasoning: true,
    },
  },

  // === Standard providers — 使用自身 providerName 作为 providerId ===

  'anthropic': {
    providerId: 'anthropic',
    resolveApi: () => 'anthropic-messages',
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  'openai': {
    providerId: 'openai',
    resolveApi: ({ baseURL }) =>
      shouldUseOpenAIResponsesApi('openai', baseURL)
        ? 'openai-responses'
        : 'openai-completions',
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  'deepseek': {
    providerId: 'deepseek',
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  'qwen': {
    providerId: 'qwen',
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  'zhipu': {
    providerId: 'zhipu',
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  'volcengine': {
    providerId: 'volcengine',
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  'minimax': {
    providerId: 'minimax',
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  'youdaozhiyun': {
    providerId: 'youdaozhiyun',
    resolveApi: () => 'openai-completions',
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  'stepfun': {
    providerId: 'stepfun',
    resolveApi: () => 'openai-completions',
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  'xiaomi': {
    providerId: 'xiaomi',
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  'openrouter': {
    providerId: 'openrouter',
    resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },

  'ollama': {
    providerId: 'ollama',
    resolveApi: () => 'openai-completions',
    normalizeBaseUrl: stripChatCompletionsSuffix,
  },
};

/**
 * Default descriptor for unknown/custom providers.
 * Falls back to generic behavior: uses providerName as providerId,
 * maps API type normally, strips /chat/completions from baseUrl.
 */
const DEFAULT_DESCRIPTOR: ProviderDescriptor = {
  providerId: '', // 会被运行时动态设置为 providerName 或 'lobster'
  resolveApi: ({ apiType }) => mapApiTypeToOpenClawApi(apiType),
  normalizeBaseUrl: stripChatCompletionsSuffix,
};
```

### 重构后的核心函数

```typescript
const resolveDescriptor = (
  providerName: string,
  codingPlanEnabled: boolean,
): ProviderDescriptor => {
  // 组合键：支持 provider + feature flag 的特殊路由
  if (codingPlanEnabled) {
    const compositeKey = `${providerName}:codingPlan`;
    if (compositeKey in PROVIDER_REGISTRY) {
      return PROVIDER_REGISTRY[compositeKey];
    }
  }

  if (providerName in PROVIDER_REGISTRY) {
    return PROVIDER_REGISTRY[providerName];
  }

  // Unknown provider: use providerName as providerId,
  // or 'lobster' for empty names
  return {
    ...DEFAULT_DESCRIPTOR,
    providerId: providerName || 'lobster',
  };
};

const buildProviderSelection = (options: {
  apiKey: string;
  baseURL: string;
  modelId: string;
  apiType: 'anthropic' | 'openai' | undefined;
  providerName?: string;
  codingPlanEnabled?: boolean;
  supportsImage?: boolean;
  modelName?: string;
}): OpenClawProviderSelection => {
  const providerName = options.providerName ?? '';
  const descriptor = resolveDescriptor(providerName, !!options.codingPlanEnabled);

  const baseUrl = descriptor.normalizeBaseUrl(options.baseURL);
  const api = descriptor.resolveApi({
    apiType: options.apiType,
    baseURL: options.baseURL,
  });
  const apiKey = descriptor.resolveApiKey
    ? descriptor.resolveApiKey({ apiKey: options.apiKey, providerName })
    : `\${${providerApiKeyEnvVar(providerName)}}`;
  const sessionModelId = descriptor.resolveSessionModelId
    ? descriptor.resolveSessionModelId(options.modelId)
    : options.modelId;

  const providerModelName = resolveModelDisplayName(
    sessionModelId,
    options.modelName,
  );
  const modelInput: string[] = options.supportsImage
    ? ['text', 'image']
    : ['text'];

  // moonshot 的 reasoning 需要根据 modelId 动态判断
  const dynamicReasoning =
    providerName === 'moonshot' && !options.codingPlanEnabled
      ? options.modelId.includes('thinking')
      : undefined;

  return {
    providerId: descriptor.providerId,
    legacyModelId: options.modelId,
    sessionModelId,
    primaryModel: `${descriptor.providerId}/${sessionModelId}`,
    providerConfig: {
      baseUrl,
      api,
      apiKey,
      auth: 'api-key',
      models: [
        {
          id: sessionModelId,
          name: providerModelName,
          api,
          input: modelInput,
          ...(dynamicReasoning !== undefined
            ? { reasoning: dynamicReasoning }
            : descriptor.modelDefaults?.reasoning !== undefined
              ? { reasoning: descriptor.modelDefaults.reasoning }
              : {}),
          ...(descriptor.modelDefaults?.cost
            ? { cost: descriptor.modelDefaults.cost }
            : {}),
          ...(descriptor.modelDefaults?.contextWindow
            ? { contextWindow: descriptor.modelDefaults.contextWindow }
            : {}),
          ...(descriptor.modelDefaults?.maxTokens
            ? { maxTokens: descriptor.modelDefaults.maxTokens }
            : {}),
        },
      ],
    },
  };
};
```

---

## 对比：重构前 vs 重构后

| 维度 | 重构前 | 重构后 |
|------|--------|--------|
| Provider 覆盖 | 4 个显式 + 1 个兜底 | 15 个显式 + 1 个兜底 |
| 新增 provider | 复制整个 if 分支（~30 行） | 添加 1 个 registry 条目（~5 行） |
| 核心函数行数 | ~160 行（if-else 链） | ~50 行（查表 + 组装） |
| providerId 正确性 | 11 个 provider 被错误映射为 'lobster' | 所有 provider 使用正确的 ID |
| 测试难度 | 需要 mock 整个函数 | 可独立测试每个 descriptor |
| 耦合度 | 核心函数直接包含所有 provider 逻辑 | 核心函数不感知具体 provider |

---

## 实施步骤

### Phase 0: 提取 Shared Provider Data（前置）

详见下方「Phase 0（前置）: Shared Provider Data Source」章节中的设计方案、类型定义、消费方迁移示例和风险评估。

**Step 0.1**: 创建 `src/shared/providers/constants.ts` + `index.ts`
- 定义字符串常量对象：`ProviderName`、`OpenClawProviderId`、`OpenClawApi`、`ApiFormat`、`AuthType`（详见上方「设计约束：String Literal Constants」章节）
- 定义 `ProviderDefInput`、`ProviderDef`、`ProviderRegistryImpl`、`ProviderRegistry`
- 将 `src/renderer/config.ts` 中的 15 个 provider 定义迁移为 `PROVIDER_DEFINITIONS` 数组，数组中的 `id` 字段使用 `ProviderName.xxx` 常量
- **QA**: `npx tsc -p electron-tsconfig.json --noEmit` + `npx tsc --noEmit` 均通过

**Step 0.2**: 迁移 Renderer 消费方
- `src/renderer/config.ts`：`defaultConfig.providers` 改为从 `ProviderRegistry` 动态构建
- `CHINA_PROVIDERS` / `GLOBAL_PROVIDERS` 改为从 `ProviderRegistry.idsByRegion()` 获取
- Renderer 侧引用 `defaultConfig.providers` 的文件（共 5 个，需确认迁移后无破坏）：
  - `src/renderer/config.ts` — 定义处，改为从 shared 构建
  - `src/renderer/store/slices/modelSlice.ts` — import `defaultConfig`（搜索 `defaultConfig` 定位引用点）
  - `src/renderer/services/config.ts` — import `defaultConfig`
  - `src/renderer/components/Settings.tsx` — import `defaultConfig`（多处引用）
  - 已确认引用 `defaultConfig.providers` 的 renderer 文件（执行前可用 IDE 全局搜索 `defaultConfig.providers` 二次确认）
- **QA**:
  1. `npx tsc --noEmit` 通过
  2. 在 `src/shared/providers/constants.test.ts` 中新增回归测试。项目测试框架为 **Vitest**（`package.json` 中 `"test": "vitest run"`），支持 `npm test -- <pattern>` 按文件名过滤。测试内容：
     - 测试 `ProviderRegistry.providerIds` 返回正确的 15 个 provider ID（与迁移前 `Object.keys(defaultConfig.providers)` 一致）
     - 测试每个 provider 的 `defaultBaseUrl`、`defaultApiFormat`、`defaultModels.length` 与迁移前的硬编码值一致
     - 测试 `ProviderRegistry.idsByRegion('china')` 与迁移前的 `CHINA_PROVIDERS` 一致
     - 测试 `ProviderRegistry.idsByRegion('global')` 与迁移前的 `GLOBAL_PROVIDERS` 一致
     - **注意**：使用 `expect(...).toEqual(...)` 进行精确值比较，不使用 snapshot（避免 snapshot 更新/存储开销）
  3. 运行：`npm test -- providers/constants`（Vitest 文件名过滤），全部通过

**Step 0.3**: 迁移 Main 消费方
- `src/main/libs/claudeSettings.ts`：`getEffectiveProviderApiFormat` 改为查 `ProviderRegistry`
- **QA**: `npx tsc -p electron-tsconfig.json --noEmit` 通过；`npm test`（`vitest run`，运行所有测试）全通过

---

### Phase 1-4: 重构 buildProviderSelection

### Step 1: 定义类型和 Registry（不改变行为）

在 `src/main/libs/openclawConfigSync.ts` 中：
1. 将现有 `type OpenClawProviderApi` 联合类型改为从 `OpenClawApi` 常量派生：`type OpenClawProviderApi = OpenClawApi;`
2. 添加 `ProviderDescriptor` 类型定义
3. 添加 `PROVIDER_REGISTRY` 常量，key 和 value 全部使用 `ProviderName.*`、`OpenClawProviderId.*`、`OpenClawApi.*` 常量（不使用裸字符串）
4. 添加 `DEFAULT_DESCRIPTOR` 常量
5. 添加 `resolveDescriptor` 函数

此时不修改 `buildProviderSelection`，确保新增代码可独立编译。

**QA**:
1. `npx tsc -p electron-tsconfig.json --noEmit` 通过，无新增类型错误
2. 在 Step 4 的测试中同步新增 `describe('resolveDescriptor (via buildProviderSelection)')` 预留测试块（此步骤仅验证编译通过，断言在 Step 2 完成后补充）

### Step 2: 重写 `buildProviderSelection`

用查表逻辑替换 if-else 链。保持函数签名和返回类型完全不变。同时将 `const buildProviderSelection` 改为 `export const buildProviderSelection`。

**QA**:
1. `npx tsc -p electron-tsconfig.json --noEmit` 通过，无新增类型错误
2. 运行 `npm test -- openclawConfigSync`（Vitest），验证以下行为保持不变（这些测试在 Step 4 编写，但 Step 2 完成后即可运行）：
   - 场景 5: `buildProviderSelection({ providerName: 'anthropic', ... })` → `providerId === 'anthropic'`（不再是 `'lobster'`）
   - 场景 9: `buildProviderSelection({ providerName: 'ollama', ... })` → `providerId === 'ollama'`
   - 场景 11: `buildProviderSelection({ providerName: '', ... })` → `providerId === 'lobster'`（兜底行为保持）

### Step 3: 保留 `lobsterai-server` 的日志

原函数中 `lobsterai-server` 分支有 `console.log` 输出调试信息（搜索 `buildProviderSelection lobsterai-server` 定位），需在 descriptor 的 `normalizeBaseUrl` 或核心函数中保留。

**QA**（通过 Step 4 的测试验证，运行 `npm test -- openclawConfigSync`）:
1. 测试用例 `'lobsterai-server logs proxy info'`：使用 `vi.spyOn(console, 'log')` 断言当 `providerName === 'lobsterai-server'` 时，`console.log` 被调用且参数包含 `'[OpenClawConfigSync]'` 标签。
2. 测试用例 `'non-server provider does not log'`：调用 `buildProviderSelection({ providerName: 'openai', ... })` 后断言 `console.log` 未被调用（或不包含 `'[OpenClawConfigSync]'` 标签）。

### Step 4: 补充测试

**前置条件**：`buildProviderSelection` 当前是模块内部函数（`const buildProviderSelection = ...`，非 export）。为使测试可访问，需在 Step 2 重写时将其改为 `export const buildProviderSelection = ...`。

**Export 安全性验证**：`buildProviderSelection` 目前仅在 `openclawConfigSync.ts` 内部被调用（搜索 `buildProviderSelection(` 可确认 3 处调用均在同文件内），无外部模块导入。将其改为 export 不会引入循环依赖或影响现有调用方。`resolveDescriptor` 保持 internal（通过 `buildProviderSelection` 间接测试）。

**现有测试文件 `src/main/libs/openclawConfigSync.test.ts` 当前仅覆盖 `providerApiKeyEnvVar` 和 env var 稳定性测试**，不包含 `buildProviderSelection` 的任何测试。需新增独立的 `describe('buildProviderSelection', ...)` 测试块。

在 `src/main/libs/openclawConfigSync.test.ts` 中新增：

```typescript
import { buildProviderSelection } from './openclawConfigSync';
```

**Mock 策略**：`buildProviderSelection` 内部通过 `getOpenClawTokenProxyPort()`（来自 `./openclawTokenProxy`）获取 proxy port。测试中使用 Vitest 的模块 mock：

```typescript
import { vi } from 'vitest';

// Mock openclawTokenProxy 模块
vi.mock('./openclawTokenProxy', () => ({
  getOpenClawTokenProxyPort: vi.fn(),
}));

import { getOpenClawTokenProxyPort } from './openclawTokenProxy';
const mockGetProxyPort = vi.mocked(getOpenClawTokenProxyPort);

// 场景 1a: lobsterai-server with proxy port
mockGetProxyPort.mockReturnValue(12345);
// → 断言 apiKey === 'proxy-managed', baseUrl === 'http://127.0.0.1:12345/v1'

// 场景 1b: lobsterai-server without proxy port
mockGetProxyPort.mockReturnValue(undefined);
// → 断言 apiKey 使用 env var placeholder, baseUrl strip /chat/completions
```

**运行命令**: `npm test -- openclawConfigSync`（等价于 `vitest run openclawConfigSync`，Vitest 按文件名模式过滤）

**必须覆盖的测试场景**（每个场景验证 `providerId`、`baseUrl`、`api`、`sessionModelId`、`apiKey` 五个字段）：

```typescript
// 场景 1: lobsterai-server（token proxy 模式）
// 输入: providerName='lobsterai-server', baseURL='http://example.com/v1/chat/completions', apiType='openai'
// 断言:
//   providerId === 'lobsterai-server'
//   api === 'openai-completions'
//   apiKey === 'proxy-managed' (当 proxy port 存在时)
//   baseUrl 为 proxy URL 格式

// 场景 2: moonshot + codingPlanEnabled
// 输入: providerName='moonshot', codingPlanEnabled=true, modelId='kimi-k2.5', baseURL='https://api.moonshot.cn/anthropic'
// 断言:
//   providerId === 'kimi-coding'
//   sessionModelId === 'k2p5'
//   api === 'anthropic-messages'
//   baseUrl 包含 '/coding'
//   reasoning === true

// 场景 3: moonshot 普通模式
// 输入: providerName='moonshot', codingPlanEnabled=false, modelId='moonshot-v1-thinking', baseURL='https://api.moonshot.cn/v1'
// 断言:
//   providerId === 'moonshot'
//   api === 'openai-completions'
//   baseUrl 以 '/v1' 结尾
//   reasoning === true (因为 modelId 包含 'thinking')

// 场景 4: gemini
// 输入: providerName='gemini', modelId='gemini-3-pro-preview', baseURL='https://generativelanguage.googleapis.com/v1beta/openai'
// 断言:
//   providerId === 'google'
//   api === 'google-generative-ai'
//   baseUrl 不包含 '/openai' 后缀
//   reasoning === true

// 场景 5: anthropic (之前落入 lobster 兜底的 provider)
// 输入: providerName='anthropic', modelId='claude-sonnet-4-6', apiType='anthropic', baseURL='https://api.anthropic.com'
// 断言:
//   providerId === 'anthropic' (不再是 'lobster')
//   api === 'anthropic-messages'
//   apiKey === '${LOBSTER_APIKEY_ANTHROPIC}'

// 场景 6: openai (Responses API 路由)
// 输入: providerName='openai', modelId='gpt-5.2', apiType='openai', baseURL='https://api.openai.com/v1'
// 断言:
//   providerId === 'openai' (不再是 'lobster')
//   api === 'openai-responses' (因为是 api.openai.com)

// 场景 7: openai (非官方端点 → Completions API)
// 输入: providerName='openai', modelId='gpt-5.2', apiType='openai', baseURL='https://custom-proxy.com/v1'
// 断言:
//   api === 'openai-completions'

// 场景 8: deepseek (anthropic 兼容)
// 输入: providerName='deepseek', modelId='deepseek-reasoner', apiType='anthropic', baseURL='https://api.deepseek.com/anthropic'
// 断言:
//   providerId === 'deepseek'
//   api === 'anthropic-messages'

// 场景 9: ollama (本地)
// 输入: providerName='ollama', modelId='qwen3-coder-next', apiType='openai', baseURL='http://localhost:11434/v1'
// 断言:
//   providerId === 'ollama'
//   api === 'openai-completions'

// 场景 10: unknown/custom provider (兜底)
// 输入: providerName='my-custom-provider', modelId='some-model', apiType='openai', baseURL='https://example.com/v1'
// 断言:
//   providerId === 'my-custom-provider' (使用 providerName，不再是 'lobster')
//   api === 'openai-completions'

// 场景 11: 空 providerName (兜底)
// 输入: providerName='', modelId='some-model', apiType='openai', baseURL='https://example.com/v1'
// 断言:
//   providerId === 'lobster'

// 场景 12: baseUrl 带 /chat/completions 后缀的 strip 验证
// 输入: providerName='deepseek', baseURL='https://api.deepseek.com/v1/chat/completions'
// 断言:
//   baseUrl === 'https://api.deepseek.com/v1'
```

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| providerId 变更导致 session 迁移失效 | 已有 session 的 `modelProvider` 字段与新 providerId 不匹配 | `syncManagedSessionStore` 仅迁移 `lobster` → 新 ID 的 session，不影响已正确映射的 session |
| Registry 遗漏 provider | 落入 DEFAULT_DESCRIPTOR | DEFAULT_DESCRIPTOR 使用 providerName 作为 providerId，比原来的 'lobster' 更准确 |
| `moonshot:codingPlan` 组合键约定 | 未来其他 provider 的 codingPlan 需同样处理 | 已在 `resolveDescriptor` 中统一处理，添加新组合键即可 |
| OpenClaw gateway 不认识新的 providerId | gateway 可能拒绝配置 | OpenClaw 的 provider registry 是开放式的，自定义 ID 不会报错 |

---

## Phase 0（前置）: Shared Provider Data Source

### 动机

当前 provider 的配置数据散布在两个进程中，导致多处重复和潜在不一致：

| 数据 | Renderer (`src/renderer/config.ts`) | Main (`src/main/libs/claudeSettings.ts`) |
|------|------|------|
| Provider 名称列表 | `defaultConfig.providers` 的 key（15 个） | `getEffectiveProviderApiFormat` 硬编码 4 个特例 |
| 默认 apiFormat | 每个 provider 定义中的 `apiFormat` 字段 | `getEffectiveProviderApiFormat` 再次硬编码同样的映射 |
| 默认 baseUrl | 每个 provider 定义中的 `baseUrl` 字段 | 无（但 codingPlan URL 常量在文件顶部 `MOONSHOT_CODING_PLAN_*` 定义） |
| codingPlanEnabled | moonshot/zhipu/qwen/volcengine 的 `codingPlanEnabled: false` | 无显式标记 |
| 默认 models | 每个 provider 的 `models[]` | 无 |
| 区域分组 | `CHINA_PROVIDERS` / `GLOBAL_PROVIDERS` | 无 |

用户的核心诉求："**使数据始终保持一个出处，在未来迭代中减少代码改动范围。**"

### 可行性评估

**✅ 有利条件：**
1. `src/shared/` 目录已存在，且 `PlatformRegistry`（`src/shared/platform/constants.ts`）已建立了成熟的 Single Source of Truth 先例
2. 两个 tsconfig 都已包含 `src/shared` 且配置了 `@shared/*` 路径别名
3. 待共享数据全部是**纯数据**（字符串、布尔值、数组），不依赖 Electron API 或 DOM API
4. Vite 能天然处理 `src/shared` 下的 TypeScript 文件（无需额外 bundler 配置）

**⚠️ 影响范围：**
- Renderer 侧有 5 个文件引用 `defaultConfig.providers`，需改为从 shared 导入
- Main 侧 `getEffectiveProviderApiFormat` 需改为查表而非硬编码
- 需确保 shared 模块不引入任何进程特定依赖

### 设计方案：`src/shared/providers/`

#### 目录结构

```
src/shared/
├── platform/           # 已有：IM 平台 registry
│   ├── constants.ts
│   └── index.ts
└── providers/          # 新增：Provider registry (shared data)
    ├── constants.ts    # Provider 定义数组 + ProviderRegistry 类
    └── index.ts        # 公共导出
```

#### 类型定义

```typescript
// src/shared/providers/constants.ts

/**
 * Provider data definition — pure data, no process-specific dependencies.
 * Follows the same pattern as PlatformRegistry in src/shared/platform/.
 */
interface ProviderDefInput {
  /** Provider identifier (e.g. 'openai', 'moonshot') */
  readonly id: string;
  /** Default base URL */
  readonly defaultBaseUrl: string;
  /** Default API format */
  readonly defaultApiFormat: 'openai' | 'anthropic' | 'gemini';
  /** Whether this provider supports codingPlan mode */
  readonly codingPlanSupported: boolean;
  /** Region grouping for UI visibility */
  readonly region: 'china' | 'global';
  /** Default model list */
  readonly defaultModels: readonly {
    readonly id: string;
    readonly name: string;
    readonly supportsImage: boolean;
  }[];
}
```

#### 定义数组（Single Source of Truth）

```typescript
const PROVIDER_DEFINITIONS = [
  {
    id: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultApiFormat: 'openai',
    codingPlanSupported: false,
    region: 'global',
    defaultModels: [
      { id: 'gpt-5.4', name: 'GPT-5.4', supportsImage: true },
      { id: 'gpt-5.2', name: 'GPT-5.2', supportsImage: true },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', supportsImage: true },
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', supportsImage: true },
    ],
  },
  // ... 其余 14 个 provider 完整定义
  // 全部从 src/renderer/config.ts 的 defaultConfig.providers 迁移而来
] as const satisfies readonly ProviderDefInput[];
```

#### Registry 类（查询接口）

```typescript
export interface ProviderDef {
  readonly id: string;
  readonly defaultBaseUrl: string;
  readonly defaultApiFormat: 'openai' | 'anthropic' | 'gemini';
  readonly codingPlanSupported: boolean;
  readonly region: 'china' | 'global';
  readonly defaultModels: readonly {
    readonly id: string;
    readonly name: string;
    readonly supportsImage: boolean;
  }[];
}

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

  /** Get the effective API format for a provider (replaces getEffectiveProviderApiFormat). */
  effectiveApiFormat(id: string, userApiFormat?: string): 'openai' | 'anthropic' | 'gemini' {
    const def = this.idIndex.get(id);
    if (def) return def.defaultApiFormat;
    // Unknown provider: use user-provided format or default to 'openai'
    return (userApiFormat === 'anthropic' || userApiFormat === 'gemini')
      ? userApiFormat
      : 'openai';
  }

  /** Whether a provider supports codingPlan. */
  supportsCodingPlan(id: string): boolean {
    return this.idIndex.get(id)?.codingPlanSupported ?? false;
  }

  /** Providers filtered by region, preserving definition order. */
  byRegion(region: 'china' | 'global'): readonly ProviderDef[] {
    return this.defs.filter(d => d.region === region);
  }

  /** Provider IDs filtered by region. */
  idsByRegion(region: 'china' | 'global'): readonly string[] {
    return this.defs.filter(d => d.region === region).map(d => d.id);
  }
}

export const ProviderRegistry = new ProviderRegistryImpl(PROVIDER_DEFINITIONS);
```

### 消费方迁移

#### Renderer 侧（`src/renderer/config.ts`）

**Before:**
```typescript
// src/renderer/config.ts
export const defaultConfig = {
  providers: {
    openai: { enabled: false, apiKey: '', baseUrl: '...', apiFormat: 'openai', models: [...] },
    // ... 14 more
  },
};
export const CHINA_PROVIDERS = ['deepseek', 'moonshot', ...] as const;
export const GLOBAL_PROVIDERS = ['openai', 'gemini', ...] as const;
```

**After:**
```typescript
// src/renderer/config.ts
import { ProviderRegistry } from '@shared/providers';

// 动态构建 defaultConfig.providers，数据来自 shared registry
const buildDefaultProviders = () => {
  const providers: Record<string, ProviderConfig> = {};
  for (const id of ProviderRegistry.providerIds) {
    const def = ProviderRegistry.get(id)!;
    providers[id] = {
      enabled: false,
      apiKey: '',
      baseUrl: def.defaultBaseUrl,
      apiFormat: def.defaultApiFormat,
      ...(def.codingPlanSupported ? { codingPlanEnabled: false } : {}),
      models: [...def.defaultModels],
    };
  }
  // custom provider (not in registry)
  providers['custom'] = { enabled: false, apiKey: '', baseUrl: '', apiFormat: 'openai', models: [] };
  return providers;
};

export const defaultConfig = {
  providers: buildDefaultProviders(),
  // ... rest unchanged
};

// 区域分组直接从 registry 查询
export const CHINA_PROVIDERS = ProviderRegistry.idsByRegion('china');
export const GLOBAL_PROVIDERS = ProviderRegistry.idsByRegion('global');
```

#### Main 侧（`src/main/libs/claudeSettings.ts`）

**Before:**
```typescript
function getEffectiveProviderApiFormat(providerName: string, apiFormat: unknown): AnthropicApiFormat {
  if (providerName === 'openai' || providerName === 'gemini' || providerName === 'stepfun' || providerName === 'youdaozhiyun') {
    return 'openai';
  }
  if (providerName === 'anthropic') {
    return 'anthropic';
  }
  return normalizeProviderApiFormat(apiFormat);
}
```

**After:**
```typescript
import { ProviderRegistry } from '@shared/providers';

function getEffectiveProviderApiFormat(providerName: string, apiFormat: unknown): AnthropicApiFormat {
  const def = ProviderRegistry.get(providerName);
  if (def) return def.defaultApiFormat as AnthropicApiFormat;
  return normalizeProviderApiFormat(apiFormat);
}
```

### 与 Phase 1-4 的关系

Phase 0 是**前置步骤**，独立于 `buildProviderSelection` 的重构。执行顺序：

```
Phase 0: 提取 shared provider data
  ├── 创建 src/shared/providers/constants.ts + index.ts
  ├── 迁移 renderer config.ts → 从 shared 导入
  └── 迁移 main claudeSettings.ts → 从 shared 导入

Phase 1-4: 重构 buildProviderSelection（原方案中的 Step 1-4）
  ├── Step 1: 定义 ProviderDescriptor + PROVIDER_REGISTRY
  │   → PROVIDER_REGISTRY 可引用 ProviderRegistry 中的 apiFormat / codingPlan 数据
  ├── Step 2: 重写 buildProviderSelection
  ├── Step 3: 保留日志
  └── Step 4: 补充测试
```

Phase 0 完成后，Phase 1 中的 `PROVIDER_REGISTRY` 可直接引用 `ProviderRegistry` 的数据，进一步减少重复。例如：

```typescript
// PROVIDER_REGISTRY 中可查询 shared data
const def = ProviderRegistry.get('deepseek');
// def.defaultApiFormat === 'anthropic' → 可用于 resolveApi 的默认行为
```

### Phase 0 QA

1. **`npx tsc -p electron-tsconfig.json --noEmit`** — 无新增类型错误
2. **`npx tsc --noEmit`** （renderer tsconfig）— 无新增类型错误
3. **`npm test`** — 全部现有测试通过
4. **手动验证**：Settings 页面 provider 列表、默认值、区域分组与重构前完全一致

### Phase 0 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Renderer 打包后 shared 模块路径不对 | UI 白屏 | Vite 已配置 `@shared/*` alias，与 `@/*` 同等处理 |
| `custom` provider 无 registry 定义 | custom 配置丢失 | `custom` 在 `buildDefaultProviders` 中硬编码处理，不入 registry |
| `as const satisfies` 语法 TS 版本要求 | 编译失败 | 项目已使用 TS 5.x（`PlatformRegistry` 已用此语法），确认兼容 |
| 引入循环依赖 | 编译警告/错误 | shared 模块不 import 任何 main/renderer 模块，单向依赖 |

---

## 未来扩展

此设计天然支持以下扩展，无需修改核心函数：

1. **新增 provider**：在 `src/shared/providers/constants.ts` 添加 1 条定义 → renderer/main 自动获得新 provider（零侵入）
2. **Provider 特性变更**（如新增 codingPlan 支持）：修改 shared 定义的 `codingPlanSupported` + 添加 `providerName:codingPlan` 组合键条目
3. **自定义 model 元数据**：扩展 `ProviderDef` 字段
4. **动态 provider 注册**：Registry 可从配置文件加载（如需要）
5. **将 `PROVIDER_REGISTRY`（OpenClaw descriptor）提取为独立模块**：如果 provider 数量继续增长，可将 `PROVIDER_REGISTRY` 移到 `providerDescriptors.ts`
6. **Main 进程其他模块复用**：任何 main 侧需要 provider 元数据的地方，直接 `import { ProviderRegistry } from '@shared/providers'`
