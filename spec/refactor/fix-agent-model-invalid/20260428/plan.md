# 修复 "Agent 绑定模型已不可用" 报错 — 实施记录（最终版）

**前置文档:** [audit.md](./audit.md)（排查报告） | [spec.md](./spec.md)（验收规格）

---

## 实施总结

共 6 个 commit，修改 9 个核心文件。从初始方案（B1 onChange 修正 + B4 UI 优化）演变为更全面的重构，核心思路从"修复死循环"变为"每个 session 有自己独立的模型"。

---

## Step 1: 核心模型选择逻辑重构

**commit**: `7153cd2`

### 1.1 agentModelSelection.ts — Agent.model 失效改为静默 fallback

**变更**: Agent.model 解析失败时，`hasInvalidExplicitModel` 从 `true` 改为 `false`。

```typescript
// agent model 失效 → 静默 fallback（不阻塞用户）
return { selectedModel: fallbackModel, usesFallback: true, hasInvalidExplicitModel: false };
```

**设计决策**: 原方案（plan.md v1）保持报错，通过 Step 1 的 onChange 修正解除死循环。在讨论中改为静默 fallback，原因：
- Agent.model 是全局共享的，一个对话的操作可能导致所有对话报错
- 报错对用户来说不直观（"我什么都没做，怎么就不可用了？"）
- Session.modelOverride 是用户显式选择的，失效时报错合理；Agent.model 不是

### 1.2 agentModelSelection.test.ts — 更新测试

- `silently falls back when agent model is invalid` — 验证 agent 级别 `hasInvalidExplicitModel: false`
- `silently falls back when agent model is an ambiguous bare id` — 同上
- `marks invalid session model override as error` — 新增：验证 session 级别仍报错

### 1.3 openclawModelRef.ts — Provider ID fallback

```typescript
// 精确匹配失败后，按 modelId 在所有 availableModels 中查找唯一匹配
const idMatches = availableModels.filter((model) => model.id === modelId);
if (idMatches.length === 1) {
  return idMatches[0];
}
```

**设计决策**: 原 plan.md 中 B3 标记为"不实施"（歧义是防御性设计）。实施时增加了有条件的 fallback——仅在 modelId **唯一**时才 fallback，歧义时仍返回 null。这保留了防御性同时兼容 provider 迁移。

### 1.4 CoworkPromptInput.tsx — onChange 修正 Agent.model + UI 改进

```typescript
if (sessionId) {
  await coworkService.patchSession(sessionId, { model: modelRef });
  // Agent.model 无效时同步修正
  if (currentAgent && agentModelIsInvalid) {
    agentService.updateAgent(currentAgent.id, { model: modelRef });
  }
  return;
}
```

ModelSelector value：invalid 时显示失效模型名（从 session.modelOverride 提取）。

### 1.5 i18n — 文案精简

- `'当前模型已不可用，请重新选择'` / `'Model unavailable. Please select another'`
- 原方案是在红字中附加失效模型名，最终改为在 ModelSelector 本身显示失效模型名

---

## Step 2: 合并冲突解决

**commit**: `6144ff1`

release 分支合并了 OpenAI → OpenAI Codex provider 迁移兼容逻辑（与 Step 1.3 的 provider fallback 冲突），两者保留。

---

## Step 3: 新建 session 时持久化 modelOverride

**commit**: `18a33b5`

**新增需求**（不在原 plan 中）：用户反馈"每个会话应该有自己固定的模型"。

### 改动链路

1. **`src/renderer/types/cowork.ts`** — `CoworkStartOptions` 增加 `modelOverride?: string`
2. **`src/main/coworkStore.ts`** — `createSession()` 接受 `modelOverride` 参数，写入 SQL
3. **`src/main/main.ts`** — IPC handler 传递 `options.modelOverride` 到 `createSession()`
4. **`src/renderer/components/cowork/CoworkView.tsx`** — `startSession()` 调用时传入 `globalSelectedModel` 生成的 modelOverride

**设计决策**: 之前 session 创建时 modelOverride 始终为空（`''`），用户的模型选择实际来自 Agent.model 继承。改为创建时即固化到 session，实现真正的 per-session 模型隔离。

---

## Step 4: 阻止 session.modelOverride 被 normalization 改写

**commit**: `2500d89`

**新增需求**（不在原 plan 中）：发现 `openclawRuntimeAdapter.ts` 的 `startTurn` 会对 modelOverride 做 normalization，导致 `lobsterai-server/qwen3.5-plus` 被改写为 `qwen-portal/qwen3.5-plus`（因为 `buildAvailableOpenClawProviders()` 跳过 lobsterai-server provider）。

```typescript
const currentModel = session.modelOverride
  ? rawCurrentModel  // 用户选的，不动
  : (rawCurrentModel ? this.normalizeModelRef(rawCurrentModel) : '');  // agent 的，可能需要迁移
```

**影响**: 仅 agent-level model ref 做 normalization（处理 provider 迁移），session.modelOverride 原样发送给 gateway。

---

## Step 5: Home 页模型选择解耦

**commit**: `0cb02d6`

**新增需求**（不在原 plan 中）：home 页选模型调用 `agentService.updateAgent` → 触发 `syncOpenClawConfig` → 影响 gateway primaryModel → 影响其他 session。

### 改动

1. **`CoworkView.tsx` header ModelSelector**: `agentService.updateAgent()` → `dispatch(setSelectedModel(nextModel))`
2. **`CoworkPromptInput.tsx` home page ModelSelector** (无 sessionId 时): 同上
3. 清理相关未使用的 import

**设计决策**: Home 页选模型只影响 Redux 内存态，创建 session 时才写入 modelOverride。不持久化 home 页的模型选择（重启后回到默认），这是可接受的 tradeoff。

---

## Step 6: 清理

**commit**: `0d96884`

移除 CoworkView.tsx 中未使用的 `headerSelectedModel`、`availableModels` selector、`resolveAgentModelSelection` import。

---

## 方案演变过程

| 阶段 | 核心思路 | 触发变化的原因 |
|------|----------|----------------|
| v1 (plan.md 初版) | B1 onChange 修正 + B4 UI | 初始分析 |
| v2 | + Agent.model 失效改为静默 fallback | 用户反馈：Agent.model 失效不应该阻塞 |
| v3 | + 新建时持久化 modelOverride | 用户要求：每个 session 应有自己的模型 |
| v4 | + 阻止 normalize 改写 session model | 调试发现：server 模型被错误改写 |
| v5 (最终) | + Home 页选模型解耦 | 发现：home 选模型触发 sync 影响运行中 session |

## 废弃的方案

### B2 Settings 禁用时主动清理 Agent.model

plan.md v1 列举了 4 个方案（A-D），最终选择了方案 D（不做主动清理）。后来 Agent.model 失效改为静默 fallback 后，这个问题完全消失——不需要清理，因为失效不再报错。

### B3 裸 ID 歧义优先 server

plan.md v1 标记为"不实施"。实际通过 Step 1.3 的有条件 provider ID fallback 部分解决（唯一匹配时 fallback，歧义时仍 null）。

---

## 涉及的文件

| 文件 | 改动内容 |
|------|----------|
| `src/renderer/components/cowork/agentModelSelection.ts` | Agent.model 失效改为静默 fallback |
| `src/renderer/components/cowork/agentModelSelection.test.ts` | 更新 2 个测试 + 新增 1 个测试 |
| `src/renderer/components/cowork/CoworkPromptInput.tsx` | onChange 修正 Agent.model + home 页解耦 + UI 显示失效模型名 |
| `src/renderer/components/cowork/CoworkView.tsx` | header 解耦 + 新建 session 传 modelOverride + 清理 |
| `src/renderer/utils/openclawModelRef.ts` | Provider ID fallback + OpenAI Codex 兼容 |
| `src/renderer/services/i18n.ts` | 文案精简 |
| `src/renderer/types/cowork.ts` | CoworkStartOptions 增加 modelOverride |
| `src/main/coworkStore.ts` | createSession 接受 modelOverride |
| `src/main/main.ts` | IPC handler 传递 modelOverride |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 跳过 session.modelOverride 的 normalization |

## 待清理

- 多个文件中有调试用的 `console.log` 语句（标记为 `[CoworkPromptInput]`、`[CoworkView]`、`[openclawModelRef]`），应在功能稳定后清理
