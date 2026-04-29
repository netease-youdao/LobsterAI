# 修复 "Agent 绑定模型已不可用" 报错 — 验收规格（最终版）

## Overview

修复 Agent 模型绑定失效后的系列问题：报错无法通过 UI 解除（死循环）、禁用 provider 后大面积 session 报错、重启不恢复、home 页选模型影响正在运行的 session。

## 设计原则

1. **每个 session 有自己的模型** — 创建时即固定，不被其他 session 的操作修改
2. **Agent.model 失效时静默 fallback** — 不阻塞发送，使用全局 fallback 模型
3. **Session.modelOverride 失效时报错** — 要求用户手动选择（这是用户显式选择的模型，值得告知）
4. **Home 页选模型不触发 gateway 配置变更** — 避免影响其他正在运行的 session
5. **Session modelOverride 不被 normalization 改写** — 用户选定的模型引用原样发送给 gateway

---

## 终态行为

### 1. Agent.model 失效时静默 fallback（原 B1 + B2）

**修改文件**: `agentModelSelection.ts`

**行为**:
- Agent.model 解析失败 → `hasInvalidExplicitModel: false`，使用 `fallbackModel`（globalSelectedModel）
- 不阻塞发送，不显示红字
- 用户在 session 中切换模型时，若 Agent.model 处于无效状态，**同时修正 Agent.model**

**验证**:
1. Agent 绑定 deepseek-v4 → 禁用 deepseek → 进入对话 → 不报错，使用全局模型
2. 在对话中选 qwen → Agent.model 被更新为 qwen → 新建对话不报错
3. Agent.model 有效时，session 中切换模型 → Agent.model 不变，仅 session.modelOverride 变化

### 2. Session.modelOverride 失效时报错

**修改文件**: `agentModelSelection.ts`

**行为**:
- session.modelOverride 非空但解析失败 → `hasInvalidExplicitModel: true`
- 显示红字："当前模型已不可用，请重新选择"
- 发送按钮禁用
- ModelSelector 显示失效模型名称（从 modelOverride 中提取 modelId 部分）

**验证**:
1. 手动 patch session.modelOverride 为无效值 → 红字提示 + 发送禁用
2. 在模型选择器中选新模型 → 红字消失 → 可正常发送

### 3. 新建 session 时持久化 modelOverride

**修改文件**: `CoworkView.tsx`, `cowork.ts (types)`, `coworkStore.ts`, `main.ts`

**行为**:
- 新建 session 时，使用 `globalSelectedModel` 生成 `modelOverride` 写入 SQLite
- 后续该 session 的模型独立于 Agent.model 和其他 session
- 创建链路：`CoworkView → IPC(cowork:session:start) → coworkStore.createSession(modelOverride)`

**验证**:
1. 选模型 X → 新建 session A → 切换到模型 Y → 新建 session B → session A 保持模型 X
2. 重启后 session A 仍使用模型 X

### 4. Home 页模型选择解耦（不触发 syncOpenClawConfig）

**修改文件**: `CoworkView.tsx` (header), `CoworkPromptInput.tsx` (home page)

**行为**:
- Header 和 Input 的模型选择器都改为 `dispatch(setSelectedModel(nextModel))`
- **不再** 调用 `agentService.updateAgent()` → 不写 SQLite → 不触发 `syncOpenClawConfig`
- Gateway 的 `primaryModel` 不受 home 页操作影响
- 模型选择仅存在于 Redux 内存态（`globalSelectedModel`），创建 session 时写入 `modelOverride`

**验证**:
1. Home 页选模型 → 不触发 `[reason=agent-updated] syncOpenClawConfig`
2. 正在运行的 session 不受影响
3. 重启后 home 页显示默认模型（不持久化 home 页选择）

### 5. Session modelOverride 不被 normalization 改写

**修改文件**: `openclawRuntimeAdapter.ts`

**行为**:
- `startTurn` 时，若 session 有 modelOverride，**跳过 normalization**，原样发送给 gateway
- 仅对 agent-level model ref 做 normalization（处理 provider 迁移）
- 解决：`lobsterai-server/qwen3.5-plus` 被错误改写为 `qwen-portal/qwen3.5-plus` 的问题

**验证**:
1. 使用 server 模型创建对话 → startTurn 日志显示 `source: 'sessionOverride'` + 原始模型引用
2. 使用 custom 模型创建对话 → 同样不被改写

### 6. Provider ID fallback（openclawModelRef）

**修改文件**: `openclawModelRef.ts`

**行为**:
- `provider/modelId` 精确匹配失败时，提取 modelId 部分在所有 availableModels 中查找
- 若 modelId 唯一匹配到一个模型 → 返回该模型（兼容 provider 迁移）
- 若匹配到 0 个或多个 → 返回 null（保持原有行为）
- OpenAI → OpenAI Codex provider 迁移的特殊兼容逻辑保留

**验证**:
1. 模型引用为旧 provider 格式（如 `old-provider/model-x`）但 model-x 在新 provider 下唯一存在 → 正常解析
2. model-x 在多个 provider 下存在 → 返回 null（不猜测）

### 7. i18n 文案

**修改文件**: `i18n.ts`

- 中文：`'当前模型已不可用，请重新选择'`
- 英文：`'Model unavailable. Please select another'`

---

## 构建验证

| 验收项 | 命令 |
|--------|------|
| TypeScript 编译通过 | `npx tsc --noEmit` |
| 单元测试通过 | `npm test` |
| 生产构建成功 | `npm run build` |

## 功能验证

| 验收项 | 验证方法 |
|--------|----------|
| Agent.model 失效 → 静默 fallback | 禁用 provider → 对话正常 → 使用 fallback 模型 |
| Session.modelOverride 失效 → 报错 | 手动构造无效 override → 红字 + 禁用发送 |
| Session 模型独立性 | session A 用 X，session B 用 Y → 互不影响 |
| Home 页选模型不触发 sync | 选模型后日志无 `syncOpenClawConfig` |
| Server 模型不被 normalize 改写 | 使用 lobsterai-server 模型 → sessions.patch 发送原始引用 |
| 多 Agent/IM 不受影响 | IM 渠道对话正常使用 Agent 设置中的模型 |
| 重启一致性 | 重启后各 session 保持自己的 modelOverride |

## 不在范围内

- ~~B2 Settings 禁用 provider 时主动清理 Agent.model~~ → Agent.model 失效已改为静默 fallback，无需主动清理
- ~~B3 裸 ID 歧义优先 server~~ → 通过 provider ID fallback 部分解决，歧义仍返回 null
- 运行时 LLM 调用错误的 UI 展示改进（网络错误、auth 错误等）
- 模型列表服务端接口的可靠性
- `isSameModelIdentity` 的 providerKey 缺失时 fallback 行为

## 提交记录

| commit | 说明 |
|--------|------|
| `7153cd2` | 核心修复：agent fallback + session error + provider ID fallback + i18n + 测试 |
| `6144ff1` | 合并冲突解决（openclawModelRef OpenAI Codex 兼容） |
| `18a33b5` | 新建 session 时持久化 modelOverride（types → IPC → SQLite 全链路） |
| `2500d89` | 阻止 normalizeModelRef 改写 session.modelOverride |
| `0cb02d6` | home 页模型选择解耦（不触发 agent update / syncOpenClawConfig） |
| `0d96884` | 清理未使用的代码 |
