# Provider Config Consolidation Plan

**Goal:** 消除所有与 provider 相关的重复定义，使 `src/shared/providers/constants.ts` 成为 provider 所有信息（技术配置 + 展示元数据）的唯一来源，未来新增 provider 只需修改最少位置。

---

## Current State: Where Duplication Lives

### What's Already Good ✅

- `src/shared/providers/constants.ts` — `ProviderRegistry` 已是技术元数据的单一数据源（defaultBaseUrl、defaultApiFormat、codingPlanSupported、region 等）
- `buildDefaultProviders()` 已从 ProviderRegistry 生成默认配置
- `CHINA_PROVIDERS` / `GLOBAL_PROVIDERS` / `getVisibleProviders` 已从 Registry 派生
- `src/main/libs/openclawConfigSync.ts` 的 `PROVIDER_REGISTRY` 映射已使用 `ProviderName` 常量

### 剩余的重复点（按优先级）

| # | 位置 | 问题 | 影响 |
|---|------|------|------|
| 1 | `src/renderer/config.ts` 第 21–248 行 | `AppConfig['providers']` 手动枚举了 15 个具名 key | 每次增删 provider 需同步修改，226 行纯样板代码 |
| 2 | `src/renderer/components/Settings.tsx` 第 150–185 行 | `providerMeta` 硬编码每个 provider 的 label（可迁移至 shared）和 icon | 加 provider 时需同步维护 |
| 3 | `src/renderer/components/Settings.tsx` 第 172–186 行 | `providerLinks` 硬编码每个 provider 的官网和 API Key 申请页 URL | 加 provider 时需同步维护 |
| 4 | `src/renderer/components/Settings.tsx` 第 77–90 行 | `providerKeys` 常量数组手动枚举所有 provider 顺序 | 加 provider 时需同步维护顺序 |
| 5 | `src/renderer/services/config.ts` 第 4–15 行 | `getFixedProviderApiFormat()` 用字符串硬编码 provider 名判断 API 格式 | 加 provider 时漏改导致格式不一致 |
| 6 | `src/main/libs/claudeSettings.ts` 第 14–35 行 | 本地 `ProviderConfig` / `AppConfig` 类型各自定义，与 renderer 重复 | 字段变更时两处均需同步 |

---

## 架构分层原则

`providerMeta` 同时包含 `label`（字符串）和 `icon`（React JSX 组件），二者属于不同层：

| 数据 | 能否入 shared | 原因 |
|------|-------------|------|
| `label` | ✅ 可以 | 纯字符串，main/renderer 均可使用 |
| `website` / `apiKeyUrl` | ✅ 可以 | 纯字符串 URL |
| `icon`（`<OpenAIIcon />`） | ❌ 不行 | React JSX 组件，main process 无 React/JSX 编译上下文 |

**解决方案：两层分离**

```
shared/providers/constants.ts      ← label + website + apiKeyUrl（字符串，两端可用）
renderer/providers/uiRegistry.ts   ← icon 映射（仅 renderer，极简 ~30 行）
```

---

## Proposed Changes

### Change 1: 扩展 `src/shared/providers/constants.ts` — label / website / apiKeyUrl 进入 ProviderDef

**Why:** `label` 和链接 URL 是 provider 的固有属性，与 defaultBaseUrl、region 同级，应统一在 registry 中管理；同时消除 `providerMeta`（label 部分）和 `providerLinks` 两处重复。

#### 1a. 扩展 `ProviderDefInput` 和 `ProviderDef` 接口

```typescript
// src/shared/providers/constants.ts — 在 ProviderDefInput 和 ProviderDef 中新增字段

interface ProviderDefInput {
  // ...现有字段保持不变...

  /** Human-readable display name shown in UI, e.g. 'OpenAI', 'GitHub Copilot' */
  readonly label: string;
  /** Provider console / product website URL */
  readonly website?: string;
  /** API key creation page URL. Omit for providers that don't use API keys (e.g. Ollama). */
  readonly apiKeyUrl?: string;
}
```

#### 1b. 在每条 PROVIDER_DEFINITIONS 记录中补充新字段

```typescript
const PROVIDER_DEFINITIONS = [
  // ── China ──
  {
    id: ProviderName.DeepSeek,
    label: 'DeepSeek',
    website: 'https://platform.deepseek.com',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    // ...其余字段不变...
  },
  {
    id: ProviderName.Moonshot,
    label: 'Moonshot',
    website: 'https://platform.moonshot.cn',
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    // ...
  },
  {
    id: ProviderName.Qwen,
    label: 'Qwen',
    website: 'https://dashscope.console.aliyun.com',
    apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    // ...
  },
  {
    id: ProviderName.Zhipu,
    label: 'Zhipu',
    website: 'https://open.bigmodel.cn',
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    // ...
  },
  {
    id: ProviderName.Minimax,
    label: 'MiniMax',
    website: 'https://platform.minimaxi.com',
    apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    // ...
  },
  {
    id: ProviderName.Volcengine,
    label: 'Volcengine',
    website: 'https://console.volcengine.com/ark',
    apiKeyUrl: 'https://console.volcengine.com/ark',
    // ...
  },
  {
    id: ProviderName.Youdaozhiyun,
    label: 'Youdao',
    website: 'https://ai.youdao.com',
    apiKeyUrl: 'https://ai.youdao.com/console',
    // ...
  },
  {
    id: ProviderName.StepFun,
    label: 'StepFun',
    website: 'https://platform.stepfun.com',
    apiKeyUrl: 'https://platform.stepfun.com/interface-key',
    // ...
  },
  {
    id: ProviderName.Xiaomi,
    label: 'Xiaomi',
    website: 'https://dev.mi.com/platform',
    apiKeyUrl: 'https://dev.mi.com/platform',
    // ...
  },
  {
    id: ProviderName.Ollama,
    label: 'Ollama',
    website: 'https://ollama.com',
    // apiKeyUrl 省略（Ollama 不需要 API Key）
    // ...
  },
  // ── Global ──
  {
    id: ProviderName.Copilot,
    label: 'GitHub Copilot',
    // website / apiKeyUrl 省略（Copilot 走 OAuth，无独立 API Key 申请页）
    // ...
  },
  {
    id: ProviderName.OpenAI,
    label: 'OpenAI',
    website: 'https://platform.openai.com',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    // ...
  },
  {
    id: ProviderName.Gemini,
    label: 'Gemini',
    website: 'https://aistudio.google.com',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    // ...
  },
  {
    id: ProviderName.Anthropic,
    label: 'Anthropic',
    website: 'https://console.anthropic.com',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    // ...
  },
  {
    id: ProviderName.OpenRouter,
    label: 'OpenRouter',
    website: 'https://openrouter.ai',
    apiKeyUrl: 'https://openrouter.ai/keys',
    // ...
  },
] as const satisfies readonly ProviderDefInput[];
```

---

### Change 2: 新建 `src/shared/providers/types.ts` — ProviderConfig 类型设计

**Why:** renderer 和 main 各自定义 `ProviderConfig` 类型，将其移入 shared 作为两端的共同合约。

**设计原则：** 字段是否入接口，看它是否是**可复用的通用概念**，而不是看「现在有几个 provider 在用」：

- `codingPlanEnabled` — Coding Plan 是通用的模式切换概念，未来可扩展 → 直接放进来
- `authType` — 鉴权方式选择器，和 `apiFormat` 同一量级的通用概念 → 直接放进来
- `oauthRefreshToken` / `oauthTokenExpiresAt` — 任何走 OAuth 的 provider 都会用到的通用凭证字段 → 直接放进来

结论：**单一 interface，无 extension，无交叉类型。** 用 JSDoc 注明各字段的当前适用范围。

**⚠️ 已移除的字段：** Qwen OAuth 相关字段（`oauthCredentials`、`oauthBaseUrl`、`useOAuth`）不纳入新类型——对应功能已移除，现有代码通过 `as any` 访问，应随 `qwenOAuth.ts` 一并清理。

```typescript
// src/shared/providers/types.ts  (NEW FILE)

import type { ApiFormat } from './constants';

/**
 * Runtime configuration for a single provider as stored in AppConfig / SQLite.
 *
 * Optional fields that currently apply to a subset of providers are noted
 * in their JSDoc. They are designed as general capabilities — if a new
 * provider needs the same feature, it reuses the same field without any
 * type changes.
 */
export interface ProviderConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  /** API protocol. Defaults to ProviderDef.defaultApiFormat when undefined. */
  apiFormat?: ApiFormat;
  models?: Array<{
    id: string;
    name: string;
    supportsImage?: boolean;
  }>;
  /** User-visible name. Currently only used by custom_N providers. */
  displayName?: string;

  /**
   * Coding Plan mode toggle.
   * Currently applicable: moonshot, zhipu, qwen, volcengine
   * (ProviderDef.codingPlanSupported === true).
   */
  codingPlanEnabled?: boolean;

  /**
   * Authentication method selector. Defaults to 'apikey'.
   * Currently applicable: minimax ('apikey' | 'oauth').
   * General capability — any provider adding OAuth reuses this field.
   */
  authType?: 'apikey' | 'oauth';

  /**
   * Long-lived OAuth refresh token for automatic access token renewal.
   * Currently applicable: minimax (OAuth mode).
   */
  oauthRefreshToken?: string;

  /**
   * OAuth access token expiry as Unix timestamp (ms).
   * Currently applicable: minimax (OAuth mode).
   */
  oauthTokenExpiresAt?: number;
}
```

**向后兼容性：** 纯类型定义，零运行时改动，不影响存储的 JSON 结构。

---

### Change 3: 更新 `src/shared/providers/index.ts` — 导出新类型

```diff
 export type { ProviderDef } from './constants';
 export {
   ProviderName,
   OpenClawProviderId,
   OpenClawApi,
   ApiFormat,
   AuthType,
   ProviderRegistry,
 } from './constants';
 export { resolveCodingPlanBaseUrl } from './codingPlan';
+export type { ProviderConfig } from './types';
```

---

### Change 4: 新建 `src/renderer/providers/uiRegistry.ts` — renderer 侧 icon 注册表

**Why:** icon 是 React JSX 组件，无法进入 shared 模块（main process 无 React），但可以从 Settings.tsx 中提取为独立的 renderer 侧薄层，供未来其他组件复用。

```typescript
// src/renderer/providers/uiRegistry.ts  (NEW FILE)

import React from 'react';
import { ProviderName } from '@shared/providers';
import {
  OpenAIIcon, DeepSeekIcon, GeminiIcon, AnthropicIcon,
  MoonshotIcon, ZhipuIcon, MiniMaxIcon, YouDaoZhiYunIcon,
  QwenIcon, XiaomiIcon, StepfunIcon, VolcengineIcon,
  OpenRouterIcon, OllamaIcon, GitHubCopilotIcon, CustomProviderIcon,
} from '../components/icons/providers';

/**
 * Maps provider ID to its React icon element.
 * Unknown / custom provider IDs fall back to CustomProviderIcon.
 *
 * NOTE: icon lives here (renderer-only) rather than in @shared/providers
 * because React JSX cannot be used in the Electron main process.
 */
const PROVIDER_ICON_MAP: Record<string, React.ReactNode> = {
  [ProviderName.OpenAI]:        <OpenAIIcon />,
  [ProviderName.DeepSeek]:      <DeepSeekIcon />,
  [ProviderName.Gemini]:        <GeminiIcon />,
  [ProviderName.Anthropic]:     <AnthropicIcon />,
  [ProviderName.Moonshot]:      <MoonshotIcon />,
  [ProviderName.Zhipu]:         <ZhipuIcon />,
  [ProviderName.Minimax]:       <MiniMaxIcon />,
  [ProviderName.Youdaozhiyun]:  <YouDaoZhiYunIcon />,
  [ProviderName.Qwen]:          <QwenIcon />,
  [ProviderName.Xiaomi]:        <XiaomiIcon />,
  [ProviderName.StepFun]:       <StepfunIcon />,
  [ProviderName.Volcengine]:    <VolcengineIcon />,
  [ProviderName.OpenRouter]:    <OpenRouterIcon />,
  [ProviderName.Copilot]:       <GitHubCopilotIcon />,
  [ProviderName.Ollama]:        <OllamaIcon />,
};

/** Returns the icon for a provider. Falls back to CustomProviderIcon for unknown IDs. */
export function getProviderIcon(id: string): React.ReactNode {
  return PROVIDER_ICON_MAP[id] ?? <CustomProviderIcon />;
}
```

---

### Change 5: 简化 `src/renderer/config.ts` 的 `AppConfig['providers']` — 删除 226 行样板

**After：**

```diff
-import { ProviderRegistry } from '@shared/providers';
+import { ProviderRegistry, type ProviderConfig } from '@shared/providers';

 export interface AppConfig {
   api: { key: string; baseUrl: string };
   model: { ... };
-  providers?: {
-    openai: { enabled: boolean; apiKey: string; baseUrl: string; ... };
-    deepseek: { ... };
-    moonshot: { ...; codingPlanEnabled?: boolean; };
-    // ... 12 more providers, ~200 lines ...
-    [key: string]: { enabled: boolean; apiKey: string; ... };
-  };
+  /**
+   * Per-provider runtime configuration.
+   * Keys: ProviderName values + custom_N dynamic keys.
+   * Shape: ProviderConfig defined in @shared/providers/types.
+   * Default values populated by buildDefaultProviders() via ProviderRegistry.
+   */
+  providers?: Record<string, ProviderConfig>;
   // ...
 }
```

**影响分析：**
- `buildDefaultProviders()` — 无需改动（已使用 ProviderRegistry）
- Settings.tsx 中 `type ProvidersConfig = NonNullable<AppConfig['providers']>` → 自动变为 `Record<string, ProviderConfig>` ✅
- `providers.minimax.authType`、`providers.zhipu.codingPlanEnabled` 等直接属性访问 — 字段在 `ProviderConfig` 上，类型安全 ✅（`strict: true` 不含 `noUncheckedIndexedAccess`）
---

### Change 6: 修复 `src/renderer/services/config.ts` — 消除硬编码 provider 字符串

**Before（第 4–15 行）：**
```typescript
const getFixedProviderApiFormat = (providerKey: string): 'anthropic' | 'openai' | 'gemini' | null => {
  if (providerKey === 'openai' || providerKey === 'stepfun' || providerKey === 'youdaozhiyun' || providerKey === 'github-copilot') {
    return 'openai';
  }
  if (providerKey === 'anthropic') { return 'anthropic'; }
  if (providerKey === 'gemini') { return 'gemini'; }
  return null;
};
```

**After：**
```typescript
import { ProviderRegistry, ApiFormat } from '@shared/providers';

/**
 * Returns the fixed API format for providers where the format is non-switchable
 * (no switchableBaseUrls in ProviderRegistry). Returns null for switchable providers.
 */
const getFixedProviderApiFormat = (providerKey: string): ApiFormat | null => {
  const def = ProviderRegistry.get(providerKey);
  if (def && !def.switchableBaseUrls) {
    return def.defaultApiFormat;
  }
  return null;
};
```

**验证（所有现有 provider 的映射不变）：**

| Provider | switchableBaseUrls? | defaultApiFormat | 结果 |
|---|---|---|---|
| openai | ❌ 无 | openai | `'openai'` ✅ |
| stepfun | ❌ 无 | openai | `'openai'` ✅ |
| youdaozhiyun | ❌ 无 | openai | `'openai'` ✅ |
| github-copilot | ❌ 无 | openai | `'openai'` ✅ |
| anthropic | ❌ 无 | anthropic | `'anthropic'` ✅ |
| gemini | ❌ 无 | gemini | `'gemini'` ✅ |
| moonshot | ✅ 有 | openai | `null`（可切换）✅ |
| deepseek | ✅ 有 | anthropic | `null`（可切换）✅ |
| qwen / zhipu / ollama… | ✅ 有 | — | `null`（可切换）✅ |

未知/自定义 provider（`def === undefined`）→ 返回 `null`，继续使用用户保存的 `apiFormat`，行为不变。

---

### Change 7: 重构 `src/renderer/components/Settings.tsx` — 三处合并为 Registry 查询

此 Change 合并三个独立改动，统一在 Settings.tsx 中完成。

#### 7a. 替换 `providerKeys` 数组

**Before（第 77–90 行）：**
```typescript
const providerKeys = [
  'openai', 'gemini', 'anthropic', 'deepseek', 'moonshot',
  'zhipu', 'minimax', 'volcengine', 'qwen', 'youdaozhiyun',
  'stepfun', 'xiaomi', 'openrouter', 'github-copilot', 'ollama',
  ...CUSTOM_PROVIDER_KEYS,
] as const;
type ProviderType = (typeof providerKeys)[number];
```

**After：**
```typescript
import { ProviderName } from '@shared/providers';

// ProviderName 的值顺序与 PROVIDER_DEFINITIONS 定义顺序一致（China first, then Global）
const providerKeys = [
  ...Object.values(ProviderName).filter(id => id !== ProviderName.Custom && id !== ProviderName.LobsteraiServer),
  ...CUSTOM_PROVIDER_KEYS,
] as const;

// 保持字面量类型安全：ProviderName 是 as const 对象，派生的联合类型包含所有已知 provider
type BuiltinProviderType = ProviderName;
type CustomProviderType = (typeof CUSTOM_PROVIDER_KEYS)[number];
type ProviderType = BuiltinProviderType | CustomProviderType;
```

> **注：** `ProviderName.Custom`（`'custom'`）是遗留占位符，实际使用 `custom_0`…`custom_9`，需过滤掉。`LobsteraiServer` 是后端内部 provider，不在 UI 中展示，同样过滤。

#### 7b. 删除 `providerMeta`，改为 Registry 查询 + `getProviderIcon()`

**Before（第 148–170 行）：**
```typescript
const providerMeta: Record<ProviderType, { label: string; icon: React.ReactNode }> = {
  openai:       { label: 'OpenAI',         icon: <OpenAIIcon /> },
  deepseek:     { label: 'DeepSeek',       icon: <DeepSeekIcon /> },
  // ... 13 more lines ...
  ...Object.fromEntries(
    CUSTOM_PROVIDER_KEYS.map(key => [key, { label: getCustomProviderDefaultName(key), icon: <CustomProviderIcon /> }])
  ),
};
```

**After：**
```typescript
import { getProviderIcon } from '../providers/uiRegistry';

// label 从 ProviderRegistry 取（已在 Change 1 中入库）
// icon  从 uiRegistry 取（renderer 侧，支持 React JSX）
// providerMeta 整体删除

// 原 providerMeta[id].label 的调用点替换为：
//   ProviderRegistry.get(id)?.label ?? getCustomProviderDefaultName(id)

// 原 providerMeta[id].icon 的调用点替换为：
//   getProviderIcon(id)
```

#### 7c. 删除 `providerLinks`，改为 Registry 查询

**Before（第 172–186 行）：**
```typescript
const providerLinks: Partial<Record<ProviderType, { website: string; apiKey?: string }>> = {
  openai: { website: 'https://platform.openai.com', apiKey: 'https://platform.openai.com/api-keys' },
  // ... 13 more lines ...
};
```

**After：**
```typescript
// providerLinks 整体删除

// 原 providerLinks[id]?.website 的调用点替换为：
//   ProviderRegistry.get(id)?.website

// 原 providerLinks[id]?.apiKey 的调用点替换为：
//   ProviderRegistry.get(id)?.apiKeyUrl
```

---

### Change 8: 对齐 `src/main/libs/claudeSettings.ts` 本地类型

**Before（第 14–35 行）：** 本地自定义 `ProviderModel`、`ProviderConfig`、`AppConfig` 三个类型。

**After：**
```typescript
import type { ProviderConfig } from '../../shared/providers';

// 使用 shared 的规范类型；本地 ProviderModel / ProviderConfig 定义全部删除。

type AppConfig = {
  model?: { defaultModel?: string; defaultModelProvider?: string };
  providers?: Record<string, ProviderConfig>;
};
```

**⚠️ 遗留值 `apiFormat: 'native'`：** `claudeSettings.ts` 中存在遗留的 `'native'` 值（不在 `ApiFormat` 常量中）。运行时已通过 `normalizeProviderApiFormat()` 处理，不会有功能问题。若 TypeScript 严格报错，在本地做最小扩展：
```typescript
import type { ProviderConfig, ApiFormat } from '../../shared/providers';
type LocalProviderConfig = Omit<ProviderConfig, 'apiFormat'> & { apiFormat?: ApiFormat | 'native' };
type AppConfig = {
  model?: { defaultModel?: string; defaultModelProvider?: string };
  providers?: Record<string, LocalProviderConfig>;
};
```

---

## 不需要改动的地方

| 文件 | 保持不变的原因 |
|------|--------------|
| `src/renderer/config.ts` 的 `buildDefaultProviders()` | 已使用 ProviderRegistry ✅ |
| `src/renderer/config.ts` 的 `CHINA_PROVIDERS` / `GLOBAL_PROVIDERS` | 已使用 ProviderRegistry ✅ |
| `src/renderer/services/config.ts` 的 `REMOVED_PROVIDER_MODELS` / `ADDED_PROVIDER_MODELS` | 迁移专用数据，不是 provider 定义 |
| `src/main/libs/openclawConfigSync.ts` 的 `PROVIDER_REGISTRY` | OpenClaw 协议特定映射，已使用 `ProviderName` 常量 |
| SQLite 存储格式 | 纯 JSON，类型重构零影响 |
| `src/shared/providers/codingPlan.ts` | 无需改动 |
| 所有已有测试 | `constants.test.ts`、`codingPlan.test.ts` 不涉及 AppConfig / providerMeta |

## 范围外（本次不处理，单独跟进）

| 内容 | 说明 |
|------|------|
| Qwen OAuth 残留代码 | `src/main/libs/qwenOAuth.ts`、`main.ts` 中的 `startQwenOAuth` / `refreshQwenOAuthToken` 调用、`claudeSettings.ts` 中的 `as any` oauthCredentials 访问、Settings.tsx 中相关 UI 和 i18n keys——这些应作为独立任务整体清理，不纳入本次重构 |

---

## 实施顺序

按依赖关系排列，每步独立可编译：

```
Step 1  src/shared/providers/constants.ts       扩展 ProviderDef：加 label / website / apiKeyUrl
Step 2  src/shared/providers/types.ts           新建 ProviderConfig 类型
Step 3  src/shared/providers/index.ts           导出 ProviderConfig
Step 4  src/renderer/providers/uiRegistry.ts    新建 icon 注册表
Step 5  src/renderer/config.ts                  AppConfig['providers'] 简化为 Record（删除 226 行）
Step 6  src/renderer/services/config.ts         getFixedProviderApiFormat() 改为 Registry 派生
Step 7  src/renderer/components/Settings.tsx    删除 providerKeys / providerMeta / providerLinks，改用 Registry + uiRegistry
Step 8  src/main/libs/claudeSettings.ts         本地类型改为 import ProviderConfig
```

Step 5 完成后 `npm run lint` 可能报 Settings.tsx 类型警告，Step 7/8 同步修复。

---

## 历史兼容性保障

1. **SQLite 存储：** AppConfig 以 JSON 保存，类型重构对持久化数据零影响
2. **运行时行为：** 所有 provider 访问均为动态字符串索引（`providers[key]`），不依赖命名 key 的静态类型
3. **自定义 provider（custom_0...custom_9）：** `Record<string, ProviderConfig>` 天然支持任意字符串 key；icon 通过 `getProviderIcon()` 的 fallback 机制提供 `<CustomProviderIcon />`
4. **provider 展示顺序：** `Object.values(ProviderName)` 的枚举顺序与 `PROVIDER_DEFINITIONS` 数组顺序一致（由 `as const` 保证），UI 展示顺序不变
5. **导入/导出功能：** Settings 中的 provider 导入导出以 JSON 字符串操作，不受类型影响

---

## 未来迭代中新增 provider 的步骤（目标状态）

完成本次重构后，新增一个 provider 的完整操作缩减为 **3 处**：

| 步骤 | 文件 | 操作 |
|------|------|------|
| 1 | `src/shared/providers/constants.ts` | 在 `ProviderName` 加常量；在 `PROVIDER_DEFINITIONS` 加一条记录（含 label、website、apiKeyUrl、技术配置） |
| 2 | `src/main/libs/openclawConfigSync.ts` | 在 `PROVIDER_REGISTRY` 加一条 `ProviderDescriptor`（OpenClaw 协议映射）|
| 3 | `src/renderer/providers/uiRegistry.ts` | 在 `PROVIDER_ICON_MAP` 加 `[ProviderName.NewProvider]: <NewProviderIcon />` |

若新 provider 有特殊配置字段，根据字段性质决定：

| 情况 | 做法 |
|------|------|
| 通用概念（未来其他 provider 可能复用，如新的鉴权方式） | 直接加进 `ProviderConfig`，JSDoc 注明当前适用范围 |
| 完全专属单一 provider 且字段较多（目前无此情况） | 新建 `XxxExtension` interface，加入 `ProviderConfig` 交叉类型 |

**不再需要修改：** `AppConfig` 类型 / `providerKeys` 数组 / `providerMeta` / `providerLinks` / `getFixedProviderApiFormat()` 硬编码列表。
