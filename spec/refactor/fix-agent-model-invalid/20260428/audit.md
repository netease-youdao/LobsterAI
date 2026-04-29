# "当前 Agent 绑定的模型已不可用" 报错问题排查报告

## 问题概述

输入框模型选择器下方出现红色报错："当前 Agent 绑定的模型已不可用，请先为该 Agent 重新选择有效模型"，同时发送按钮被禁用。在多种场景下出现，且存在"感染式"传播——一个对话的模型变更会导致所有新对话都报错。

---

## 数据模型与优先级

### 三层模型选择架构

```
┌─────────────────────────────────────────────────────────────┐
│  session.modelOverride   (对话级覆盖，持久化在 SQLite)         │
│  ↓ 空则跳过                                                   │
├─────────────────────────────────────────────────────────────┤
│  agent.model             (Agent 默认模型，持久化在 SQLite)      │
│  ↓ 空则跳过                                                   │
├─────────────────────────────────────────────────────────────┤
│  globalSelectedModel     (全局 fallback，Redux 内存态)         │
└─────────────────────────────────────────────────────────────┘
```

### 关键事实

1. **session.modelOverride 绝大多数为空**
   - 只有用户在对话中**手动点击模型下拉并切换**时，才会调用 `patchSession({ model: ... })` 写入 modelOverride
   - 新建 session 时 modelOverride 初始化为 `''`（`CoworkView.tsx:244`）
   - 仅仅是"对话时使用了某个模型"不会自动写 modelOverride

2. **Agent.model 是全局共享的**
   - 默认所有对话使用 `'main'` Agent（`agentSlice.ts:23`）
   - Agent.model 被修改后，所有 modelOverride 为空的 session 都受影响
   - Agent.model 持久化在 SQLite，重启后原样加载

3. **切换 session 不改变 currentAgentId**
   - `handleSelectSession()` 只调用 `coworkService.loadSession(sessionId)`（`Sidebar.tsx:86-89`）
   - 不调用 `setCurrentAgentId`，currentAgentId 保持不变
   - `CoworkPromptInput` 始终用全局 `currentAgentId` 的 Agent.model 做校验

4. **模型引用格式**
   - 正常流程中 `toOpenClawModelRef()` 总是生成 `provider/modelId` 格式（如 `lobsterai-server/kimi-k2.6`）
   - server 模型用 `OpenClawProviderId.LobsteraiServer` 前缀
   - 自定义模型用 `ProviderRegistry.getOpenClawProviderId(providerKey)` 前缀

5. **availableModels 更新时 server 模型被保留**
   - `setAvailableModels` reducer 先过滤出 `isServerModel=true` 的模型，再拼接新的 user 模型（`modelSlice.ts:78-81`）
   - 禁用自定义 provider 不影响 server 模型在列表中的存在

---

## 核心判定逻辑

**触发条件** (三个同时满足):
1. `coworkAgentEngine === 'openclaw'`
2. `resolveAgentModelSelection()` 返回 `hasInvalidExplicitModel: true`
3. 组件: `CoworkPromptInput.tsx:931`

**判定函数** (`src/renderer/components/cowork/agentModelSelection.ts:19-46`):

```
1. sessionModel (currentSession.modelOverride) 非空？
   ├─ 能在 availableModels 中解析到 → 正常
   └─ 解析失败 → hasInvalidExplicitModel = true

2. agentModel (currentAgent.model) 非空？
   ├─ 能在 availableModels 中解析到 → 正常
   └─ 解析失败 → hasInvalidExplicitModel = true

3. 两者都为空 → 正常，用 fallback 全局模型（不报错）
```

**模型解析函数** (`src/renderer/utils/openclawModelRef.ts:25-38`):

| 模型引用格式 | 解析逻辑 | 失败条件 |
|---|---|---|
| `provider/modelId` (含 `/`) | 精确匹配 `toOpenClawModelRef(model) === ref` | availableModels 中无匹配 |
| 裸 ID (不含 `/`) | `availableModels.filter(m => m.id === ref)` | 匹配数 = 0 或 >= 2 (歧义) |

---

## 用户反馈的 4 个场景

### 场景 1: 关闭自定义 kimi-k2.6 后，server/kimi-k2.6 的对话也报错

**现象**: 订阅模型中有 `lobsterai-server/kimi-k2.6`，设置中也有自定义模型 `kimi-k2.6`。关闭自定义后，使用 server 模型的历史对话也报错。

**根因**: 那些"使用 server 模型的对话"实际上 `modelOverride` 为空。它们并没有自己存储 `lobsterai-server/kimi-k2.6`，而是**从 Agent.model 继承**。如果 Agent.model 指向的是自定义 provider 的引用（如 `custom-deepseek/kimi-k2.6`），禁用该 provider 后 Agent.model 失效 → 所有 modelOverride 为空的 session 全部报错。

**server 模型本身的解析没有问题**——`setAvailableModels` reducer 保留 server 模型。问题在于那些 session 根本没有 modelOverride，它们依赖的是 Agent.model。

### 场景 2: 重启后报错不消失

**根因**: Agent.model 持久化在 SQLite，重启时原样加载。无自动清理/校验机制。

**启动顺序验证** (`App.tsx:136-179`):
```
1. await authService.init()  → loadServerModels() → dispatch(setServerModels(...))  ✓
2. getConfig() → 收集 enabled providers
3. dispatch(setAvailableModels(userModels))  // reducer 保留 step 1 的 server models  ✓
```

启动时序无竞态。**问题是 Agent.model 脏数据没有自动清理机制。**

### 场景 3: A 对话正常，B 对话做 PPT，回到 A 对话后报错

**根因**: 所有对话共享同一个 Agent ('main')。

流程：
1. 用户在 home 界面或 B 对话创建前选了 deepseek-v4 → `agentService.updateAgent('main', { model: 'deepseek/...' })` → Agent.model 被全局设置
2. B 对话开始后有了 sessionId，后续在 B 中切换模型只 patch B 的 session.modelOverride
3. deepseek 因代理断开/provider 禁用变得不可用
4. 回到 A 对话 → A 的 modelOverride 为空 → 回退到 Agent.model → `deepseek/...` 解析失败 → 报错
5. **A 对话并不是"自己的模型出了问题"，而是继承的 Agent.model 失效了**

### 场景 4: 禁用模型后，新对话也全部报错 (P0)

**根因**: onChange 在有 sessionId 时只 patch session，用户无法通过 UI 修复 Agent.model。

**问题代码** (`CoworkPromptInput.tsx:920-928`):
```typescript
onChange={coworkAgentEngine === 'openclaw'
  ? async (nextModel) => {
      if (sessionId) {
        if (!nextModel) return;
        await coworkService.patchSession(sessionId, { model: toOpenClawModelRef(nextModel) });
        return; // ← RETURN! Agent.model 永远不被更新
      }
      if (!currentAgent || !nextModel) return;
      await agentService.updateAgent(currentAgent.id, { model: toOpenClawModelRef(nextModel) });
    }
  : undefined}
```

**死循环路径**:
1. Agent.model = `deepseek/deepseek-v4-flash` (由早期操作设置)
2. 用户禁用 deepseek provider → availableModels 不再包含 deepseek
3. 进入任何对话 → Agent.model 解析失败 → 报错
4. 用户在模型下拉选了新模型 → 但因 sessionId 存在，只 patch 了该 session 的 modelOverride
5. 新建对话 → 新 session 的 modelOverride 为空 → 回退到 Agent.model → 仍然无效 → 继续报错
6. 用户无法通过正常 UI 操作解除报错（除非回到无 session 的 home 页重新选模型，但这不直观）

---

## 根因总结

**核心问题是 Agent.model 的"不可达"性**：

1. Agent.model 一旦变成无效值，影响的是所有 modelOverride 为空的 session（即绝大多数 session）
2. 用户在 session 中切换模型只写 session.modelOverride，不修正 Agent.model
3. 没有任何自动校验/清理机制在 provider 禁用时修正 Agent.model
4. 报错是合理的（模型确实不可用），但用户无法通过直觉操作解除报错

**"感染式"传播的本质**：不是 session 之间互相传染，而是它们共享同一个 Agent.model，一旦 Agent.model 失效，所有依赖它的 session 同时出问题。

---

## 已识别的问题清单

| # | 问题 | 严重性 | 影响 |
|---|------|--------|------|
| **B1** | 用户在 session 中选模型无法修正 Agent.model，导致"死循环" | P0 | 场景 3、4 |
| **B2** | provider 禁用时不校验/清理受影响的 Agent.model | P1 | 场景 1、2 |
| **B3** | 裸 ID 歧义导致误判（server + custom 同 ID） | P2 | 边缘场景 |
| **B4** | UI 误导：invalid 时 ModelSelector 显示 fallback 模型名但发送禁用 | P2 | UX |

---

## 涉及的关键文件

| 文件 | 行号 | 职责 |
|------|------|------|
| `src/renderer/components/cowork/CoworkPromptInput.tsx` | 141, 188-198, 748, 920-935 | currentAgentId 获取 + 判定调用 + UI + onChange |
| `src/renderer/components/cowork/agentModelSelection.ts` | 19-46 | 核心判定函数 |
| `src/renderer/utils/openclawModelRef.ts` | 25-38 | 模型引用解析 |
| `src/renderer/store/slices/agentSlice.ts` | 17-65 | Agent 状态（currentAgentId 默认 'main'） |
| `src/renderer/services/agent.ts` | 72-103, 156-165 | Agent CRUD + switchAgent |
| `src/renderer/store/slices/modelSlice.ts` | 78-117 | availableModels 管理（server 模型保留逻辑） |
| `src/renderer/components/Settings.tsx` | 1826-1841 | Provider 禁用后 dispatch setAvailableModels |
| `src/renderer/components/Sidebar.tsx` | 86-89 | session 选择（不改 currentAgentId） |
| `src/renderer/components/cowork/CoworkView.tsx` | 244, 247 | session 创建（modelOverride 初始为空） |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 1353-1362 | OpenClaw gateway 实际使用模型的逻辑 |

---

## 日志分析 (用户日志 2026-04-25)

**时间窗口**: 17:21

**关键发现**:
- 代理 (127.0.0.1:7897 Clash) 连接中断 → 所有 LLM 调用 `Connection error`
- `qwen3.5-plus-YoudaoInner` (lobsterai-server): 401 auth error
- `qwen3.6-plus` (qwen-portal): Connection error

**注意**: 日志中的错误是**运行时 LLM 调用错误**（网络不通），与前端红字 "模型已不可用" 是**两种不同机制**：
- 红字 = `hasInvalidExplicitModel` = 模型引用在 availableModels 列表中找不到（前端静态校验）
- Connection error = 模型在列表中存在但网络不通（后端运行时错误，通过 error event 展示）

用户可能同时遇到了两类问题。
