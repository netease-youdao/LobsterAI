# 统一 Provider Base URL 出处重构方案

**日期**: 2025-03-31
**范围**: `src/shared/providers/`, `src/main/libs/`, `src/renderer/`

---

## 1. 问题概述

Coding Plan 相关 Base URL 在 **3 个文件**中各自独立定义，且 `Settings.tsx` 的 `providerSwitchableDefaultBaseUrls` 与 `src/shared/providers/constants.ts` 中 `PROVIDER_DEFINITIONS.defaultBaseUrl` 大量重复。合计 **~40+ 处硬编码 URL**，涉及 **12 个文件**，违反 AGENTS.md 中 "String Literal Constants" 单一出处原则。

## 2. 重复现状清单

### 2.1 Coding Plan URL（最严重）

4 家支持 Coding Plan 的厂商，每家各有 anthropic/openai 两个端点，同一组 URL 在 3 个文件中各出现一次：

| 厂商 | URL（openai 格式） | `claudeSettings.ts` | `api.ts` (renderer) | `Settings.tsx` |
|------|---------------------|---------------------|---------------------|----------------|
| Zhipu | `open.bigmodel.cn/api/coding/paas/v4` | L14 | L5 | L1656, L2870 |
| Qwen | `coding.dashscope.aliyuncs.com/v1` | L16 | L8 | L1665, L2874 |
| Volcengine | `ark.cn-beijing.volces.com/api/coding/v3` | L19 | L11 | L1674, L2878 |
| Moonshot | `api.kimi.com/coding/v1` | L22 | L14 | L1683, L2882 |
| *（每家的 anthropic 变体同样重复 3 次）* ||||

**共 24 处重复**（4 厂商 × 2 格式 × 3 文件），任意端点变更需同步修改 3 处。

### 2.2 Provider 默认 Base URL

`Settings.tsx` L151-192 的 `providerSwitchableDefaultBaseUrls` 对象与 `src/shared/providers/constants.ts` 中 `PROVIDER_DEFINITIONS` 的 `defaultBaseUrl` 字段**完全重复**，覆盖 DeepSeek、Moonshot、Zhipu、MiniMax、Qwen、Xiaomi、Volcengine、OpenRouter、Ollama、Custom 共 10 家：

```typescript
// Settings.tsx L151 — 独立定义
const providerSwitchableDefaultBaseUrls = {
  zhipu: {
    anthropic: 'https://open.bigmodel.cn/api/anthropic',    // 与 constants.ts L161 重复
    openai: 'https://open.bigmodel.cn/api/paas/v4',
  },
  // ... 10 个厂商
};
```

**共 20 处重复**（10 厂商 × 2 格式）。

### 2.3 其他散落的硬编码 URL

| 文件 | 内容 | 行号 |
|------|------|------|
| `Settings.tsx` | `MINIMAX_BASE_URL_CN/GLOBAL` OAuth 常量 | L207-212 |
| `coworkModelApi.ts` | Gemini 默认 URL fallback | L61, L78 |
| `openclawConfigSync.ts` | Gemini 默认 URL 硬编码 | L358 |
| `api.ts` (renderer) | Gemini 默认 URL 硬编码 | L639 |
| `seedance/generate_video.js` | Volcengine Base URL | L17 |
| `seedream/generate_image.js` | Volcengine Base URL | L17 |

## 3. 改造方案

### 3.1 核心原则

- **扩展现有 `src/shared/providers/constants.ts` 中的 `PROVIDER_DEFINITIONS`**，不新建常量文件
- `PROVIDER_DEFINITIONS` 已有 `defaultBaseUrl` 和 `defaultApiFormat` 字段，新增 Coding Plan URL 和可切换 URL 字段即可
- Main / Renderer 进程统一从 `src/shared/providers` 导入，零运行时开销（`as const` 编译期内联）

### 3.2 详细设计

**步骤 1：在 `ProviderDefInput` 接口中新增字段**

```typescript
// src/shared/providers/constants.ts

interface ProviderDefInput {
  // ... 现有字段 ...

  /**
   * Coding Plan 专属端点（仅 codingPlanSupported=true 的厂商需填写）
   * openai: OpenAI 兼容格式端点
   * anthropic: Anthropic 兼容格式端点
   */
  readonly codingPlanUrls?: {
    readonly openai: string;
    readonly anthropic: string;
  };

  /**
   * 切换 apiFormat 时对应的默认 baseUrl
   * 用于 Settings.tsx 中切换 anthropic/openai 格式时自动变更 baseUrl
   * 不填写则两种格式都使用 defaultBaseUrl
   */
  readonly switchableBaseUrls?: {
    readonly anthropic: string;
    readonly openai: string;
  };
}
```

**步骤 2：在 `PROVIDER_DEFINITIONS` 中填充数据**

```typescript
{
  id: ProviderName.Zhipu,
  defaultBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
  defaultApiFormat: ApiFormat.Anthropic,
  codingPlanSupported: true,
  codingPlanUrls: {
    openai: 'https://open.bigmodel.cn/api/coding/paas/v4',
    anthropic: 'https://open.bigmodel.cn/api/anthropic',
  },
  switchableBaseUrls: {
    anthropic: 'https://open.bigmodel.cn/api/anthropic',
    openai: 'https://open.bigmodel.cn/api/paas/v4',
  },
  // ...
},
{
  id: ProviderName.Moonshot,
  defaultBaseUrl: 'https://api.moonshot.cn/anthropic',
  codingPlanSupported: true,
  codingPlanUrls: {
    openai: 'https://api.kimi.com/coding/v1',
    anthropic: 'https://api.kimi.com/coding',
  },
  switchableBaseUrls: {
    anthropic: 'https://api.moonshot.cn/anthropic',
    openai: 'https://api.moonshot.cn/v1',
  },
  // ...
},
// Qwen、Volcengine 同理
```

**步骤 3：在 `ProviderRegistryImpl` 中新增查询方法**

```typescript
class ProviderRegistryImpl {
  // ... 现有方法 ...

  /** 获取 Coding Plan 端点，返回 undefined 表示该厂商不支持 */
  getCodingPlanUrl(id: string, format: 'openai' | 'anthropic'): string | undefined {
    const def = this.idIndex.get(id);
    if (!def?.codingPlanSupported || !def.codingPlanUrls) return undefined;
    return def.codingPlanUrls[format];
  }

  /** 获取 apiFormat 切换时对应的默认 baseUrl */
  getSwitchableBaseUrl(id: string, format: 'openai' | 'anthropic'): string | undefined {
    const def = this.idIndex.get(id);
    return def?.switchableBaseUrls?.[format];
  }
}
```

**步骤 4：清理消费侧文件**

| 文件 | 当前写法 | 改造后 |
|------|---------|--------|
| `claudeSettings.ts` L14-23 | 6 个独立 `const` | 删除，改用 `ProviderRegistry.getCodingPlanUrl(name, format)` |
| `claudeSettings.ts` L253-289 | 4 段 if-else 硬编码 URL | 统一为 `if (codingPlanEnabled) baseURL = ProviderRegistry.getCodingPlanUrl(...)` |
| `api.ts` L5-15 (renderer) | 8 个独立 `const` | 删除，改用 `ProviderRegistry.getCodingPlanUrl(...)` |
| `Settings.tsx` L151-192 | `providerSwitchableDefaultBaseUrls` 对象 | 删除，改用 `ProviderRegistry.getSwitchableBaseUrl(provider, format)` |
| `Settings.tsx` L1652-1686 | 4 段 if-else 硬编码 URL | 统一为 `const url = ProviderRegistry.getCodingPlanUrl(provider, format); if (url) effectiveBaseUrl = url;` |
| `Settings.tsx` L2867-2883 | 嵌套三元表达式 | 同上，使用 `getCodingPlanUrl` |
| `coworkModelApi.ts` L61,78 | Gemini 默认 URL fallback | 改用 `ProviderRegistry.get('gemini')?.defaultBaseUrl` |
| `openclawConfigSync.ts` L358 | Gemini URL 硬编码 | 同上 |
| `api.ts` L639 (renderer) | Gemini URL 硬编码 | 同上 |

**步骤 5（可选）：提取共享的 Coding Plan 解析函数**

`claudeSettings.ts` 和 `Settings.tsx` 中各有一套近乎相同的 Coding Plan 端点切换 if-else 链（4 段重复逻辑）。可提取为共享函数：

```typescript
// src/shared/providers/codingPlan.ts
import { ProviderRegistry } from './constants';

export function resolveCodingPlanBaseUrl(
  providerName: string,
  codingPlanEnabled: boolean,
  apiFormat: 'openai' | 'anthropic',
  currentBaseUrl: string,
): { baseUrl: string; effectiveFormat: 'openai' | 'anthropic' } {
  if (!codingPlanEnabled) {
    return { baseUrl: currentBaseUrl, effectiveFormat: apiFormat };
  }
  const url = ProviderRegistry.getCodingPlanUrl(providerName, apiFormat);
  if (!url) {
    return { baseUrl: currentBaseUrl, effectiveFormat: apiFormat };
  }
  const effectiveFormat = apiFormat === 'anthropic' ? 'anthropic' : 'openai';
  return { baseUrl: url, effectiveFormat };
}
```

此函数替代 `claudeSettings.ts` L253-289、`resolveAllEnabledProviderConfigs()` L509-530、`Settings.tsx` L1652-1686、`Settings.tsx` L2867-2883 共 4 处重复逻辑。

## 4. SKILLs 脚本中的 URL

`seedance/generate_video.js` 和 `seedream/generate_image.js` 中的 Volcengine URL（`https://ark.cn-beijing.volces.com/api/v3`）是 **Volcengine 视觉 API 专用端点**（视频/图片生成），与 LLM 模型的 Base URL 语义不同。**不纳入本次重构**，保持 SKILLs 脚本的独立性。

## 5. 影响范围与风险评估

| 维度 | 评估 |
|------|------|
| **改动文件数** | 约 7 个 TS 文件（`constants.ts` + 6 个消费侧） |
| **破坏性风险** | 低 — 纯重构，无行为变更，所有 URL 值不变 |
| **类型安全** | 高 — `as const satisfies` 保证编译期类型推导 |
| **跨进程兼容性** | 无风险 — `src/shared/` 本就被 main 和 renderer 共享引用 |
| **测试策略** | 1) `constants.test.ts` 验证 Registry 新方法 2) 手动验证 4 家 Coding Plan 厂商的端点切换 3) Settings 面板中 apiFormat 切换时 baseUrl 自动变更 |

## 6. 重构前后对比

**重构前** — `claudeSettings.ts` 中的典型代码：
```typescript
const ZHIPU_CODING_PLAN_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const QWEN_CODING_PLAN_OPENAI_BASE_URL = 'https://coding.dashscope.aliyuncs.com/v1';
const QWEN_CODING_PLAN_ANTHROPIC_BASE_URL = 'https://coding.dashscope.aliyuncs.com/apps/anthropic';
// ... 还有 6 个常量

if (providerName === ProviderName.Zhipu && providerConfig.codingPlanEnabled) {
  baseURL = ZHIPU_CODING_PLAN_BASE_URL;
  apiFormat = 'openai';
}
if (providerName === ProviderName.Qwen && providerConfig.codingPlanEnabled) {
  if (apiFormat === 'anthropic') {
    baseURL = QWEN_CODING_PLAN_ANTHROPIC_BASE_URL;
  } else {
    baseURL = QWEN_CODING_PLAN_OPENAI_BASE_URL;
    apiFormat = 'openai';
  }
}
// ... 还有 2 段相同结构的 if-else
```

**重构后**：
```typescript
import { resolveCodingPlanBaseUrl } from '../../shared/providers/codingPlan';

// 6 个常量删除，4 段 if-else 合并为：
if (providerConfig.codingPlanEnabled) {
  const resolved = resolveCodingPlanBaseUrl(providerName, true, apiFormat, baseURL);
  baseURL = resolved.baseUrl;
  apiFormat = resolved.effectiveFormat;
}
```

## 7. 实施顺序

1. **`src/shared/providers/constants.ts`** — 扩展 `ProviderDefInput` 接口，填充 `codingPlanUrls` 和 `switchableBaseUrls` 数据，新增 Registry 查询方法
2. **`src/shared/providers/codingPlan.ts`** — 新增 `resolveCodingPlanBaseUrl()` 共享函数
3. **`src/shared/providers/index.ts`** — 导出新增内容
4. **`src/main/libs/claudeSettings.ts`** — 删除本地常量，替换为 Registry 调用
5. **`src/renderer/services/api.ts`** — 删除本地 Coding Plan 常量，替换为 Registry 调用
6. **`src/renderer/components/Settings.tsx`** — 删除 `providerSwitchableDefaultBaseUrls`，替换为 Registry 调用
7. **`src/main/libs/coworkModelApi.ts`、`openclawConfigSync.ts`** — Gemini URL 改用 Registry
8. **补充单元测试** — `constants.test.ts` 验证新方法
9. **手动验证** — 4 家 Coding Plan 厂商切换 + Settings 面板 apiFormat 切换
