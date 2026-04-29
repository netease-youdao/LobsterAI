# IM Channel History Tail Alignment 修复 Spec

## 问题描述

用户在 LobsterAI 任务列表中观察到：飞书和微信会话没有新消息，但执行任务期间会周期性跳到任务列表第一位。

实际现象：

1. 任务列表按 `updatedAt` 降序展示，`updatedAt` 被刷新后会话会上浮
2. OpenClaw 底层 channel 数据没有新消息
3. `main` 日志中飞书和微信每 10 秒都会触发一次 `tail replace`
4. 其他 channel 会话（wecom、qq、popo）稳定进入 `already in sync`
5. 飞书和微信的 `preserved` 与 `total` 每轮递增 1，但 `auth` 数量保持不变

这说明问题不是 IM 侧真的收到新消息，而是本地 Cowork SQLite 会话在周期性对账时被无意义重写，进而刷新 `cowork_sessions.updated_at`。

## 核心结论

**根因是 `reconcileWithHistory()` 的 tail 对齐算法只使用 user 消息做锚点，无法正确处理 `chat.history` tail window 以 assistant 消息开头的情况。**

OpenClaw 的 `chat.history` 是受限窗口，返回的历史不一定从 user 消息开始。飞书和微信会话的 history window 可能形如：

```text
assistant: previous answer
user: current question
assistant: current answer
```

旧逻辑只用第一个 user 作为锚点，于是认为本地尾部从 `current question` 开始，但写回时把 authoritative window 中锚点前的 `previous answer` 也拼进去：

```text
local prefix + previous answer + current question + current answer
```

下一轮对账时，这条 `previous answer` 已经被重复插入，新的本地尾部再次错位，于是 `preserved` 每 10 秒增加 1，形成无限 tail replace。

| 项 | 旧行为 | 新行为 |
|---|---|---|
| fast path | 完整数组相同则跳过 | 保留 |
| tail 对齐优先级 | 只按 user 文本锚定 | 先做完整 role/text 重叠匹配 |
| assistant-leading window | user 锚点前 assistant 被重复插入 | 已存在则跳过，不存在或陈旧则纳入替换窗口 |
| `updated_at` | 每轮 `replaceConversationMessages()` 刷新 | 真有内容变化才替换 |
| UI 上浮 | 飞书/微信周期性上浮 | 稳定不动 |

---

## 相关文件

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
  - `reconcileWithHistory()`
  - `findTailAlignment()`
  - `isSameHistoryEntry()`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`
  - assistant-leading tail window 回归测试
- `src/main/coworkStore.ts`
  - `replaceConversationMessages()` 会刷新 `cowork_sessions.updated_at`
- `src/renderer/components/cowork/CoworkSessionList.tsx`
  - 任务列表按 `updatedAt` 降序排序

## 详细流程分析

### 周期性发现与对账

```text
OpenClawRuntimeAdapter.startChannelPolling()
  → every 10s pollChannelSessions()
  → sessions.list
  → already-known channel session
  → incrementalChannelSync()
  → reconcileWithHistory()
  → chat.history
  → compare localEntries with authoritativeEntries
```

当 `localEntries` 与 `authoritativeEntries` 完全一致时，对账直接返回，不写 SQLite：

```text
localEntries === authoritativeEntries
  → already in sync
  → no replace
  → no updated_at change
```

### 旧 tail replace 问题

```text
local:
  user: First question
  assistant: First answer
  user: Second question
  assistant: Streaming partial

chat.history tail:
  assistant: First answer
  user: Second question
  assistant: Final answer
```

旧逻辑找到 user 锚点 `Second question`，但没有记录 authoritative 中锚点前的 assistant offset：

```text
preserve local before Second question
append full authoritative tail
```

结果：

```text
user: First question
assistant: First answer
assistant: First answer
user: Second question
assistant: Final answer
```

下一轮又会因为尾部错位继续 replace。

### 新 tail alignment 流程

```text
reconcileWithHistory()
  → normalize localEntries and authoritativeEntries
  → if full entries match: return
  → findTailAlignment(localEntries, authoritativeEntries)
       1. Try full role/text overlap:
          local tail N entries == auth head N entries
       2. Fallback to user-message anchors:
          local user tail K == auth user head K
       3. When auth has leading entries before first user:
          - If leading entries already exist immediately before local anchor, skip them
          - Otherwise widen replacement window to include them
  → if tail already matches: return
  → replace only the computed tail
```

## 实现细节

### 完整 role/text 重叠优先

先尝试匹配完整消息序列，而不是直接进入 user-only 锚点：

```typescript
local tail: [assistant A, user B, assistant C]
auth head:  [assistant A, user B, assistant C]
```

这种情况下说明 authoritative window 已经是本地尾部子集，对账应直接判定 `tail in sync`，避免任何写入。

### user anchor fallback 带 auth offset

当 assistant 内容存在 streaming partial 或最终文本差异时，完整 role/text overlap 可能失败。此时仍使用 user 文本作为稳定锚点，但返回两个位置：

```typescript
{
  localIdx: first matching user index in localEntries,
  authIdx: first matching user index in authoritativeEntries,
}
```

写回时只追加 `authoritativeEntries.slice(authIdx)`，不会重复插入 user 锚点前已经存在的 assistant。

### leading assistant 安全检查

如果 `authIdx > 0`，说明 authoritative window 在第一个 user 前有 assistant。跳过这些 leading entries 前，必须确认它们已经存在于本地锚点前：

```text
local[localIdx - authIdx ... localIdx) == auth[0 ... authIdx)
```

如果匹配：

```text
preserve local prefix including existing leading assistant
append auth from first user
```

如果不匹配：

```text
widen replacement window backward
append full authoritative window
```

这样既避免重复插入，也能修复本地缺失或陈旧的 previous assistant。

## 不采用的方案

### UI 排序层过滤

不推荐只在任务列表排序里忽略 channel sync 造成的 `updatedAt` 变化。

原因：

1. 本地 `cowork_messages` 仍会被重复写入
2. 会话内容仍可能无限增长
3. 只掩盖 UI 上浮，不修复数据一致性

### `replaceConversationMessages()` 前做值比对

这是可作为第二道防线的方案，但不是根因修复。

原因：

1. 当前异常不是 entries 完全相同，而是重复插入导致 entries 实际变长
2. 值比对会发现不同，然后仍然 replace
3. 需要先修正对齐窗口，才能让值比对发挥作用

### 只调整平台 normalize

日志更符合 tail window 边界错位，而不是单个平台 normalize 非幂等。

原因：

1. `auth` 数量稳定不变
2. `preserved` 与 `total` 每轮精准 +1
3. 现象发生在两个平台，而不是单一 normalize 分支

## 测试计划

### 单元测试

新增覆盖：

1. `chat.history` 以 assistant 开头且本地已同步时，不调用 `replaceConversationMessages()`
2. `chat.history` 以 assistant 开头且当前 assistant 需要更新时，只替换尾部，不重复 previous assistant
3. `chat.history` 以 assistant 开头且本地 previous assistant 陈旧时，向前扩展替换窗口并修复陈旧内容

运行：

```bash
npm test -- openclawRuntimeAdapter
```

预期：

```text
Test Files  1 passed
Tests       23 passed
```

### 构建验证

运行：

```bash
npm run build
```

预期：TypeScript 与 Vite 构建通过。

### 手动验证

1. 启动 LobsterAI
2. 等待 channel polling 至少 3 个周期
3. 观察飞书和微信会话不再无新消息上浮
4. 检查 main 日志：
   - 预期出现 `tail in sync` 或 `already in sync`
   - 不应持续出现同一 session 的 `tail replace` 且 `preserved` 每轮 +1

## 风险与边界

1. 本次修复阻止后续重复写入，不主动清理历史中已经重复插入的消息。
2. 如果 authoritative window 与本地完全无重叠，仍保留 full replace 行为，以保证 dashboard 一致性。
3. 如果 authoritative window leading assistant 与本地锚点前内容不一致，会扩大替换范围。这会更偏向修正本地陈旧数据，而不是盲目保留本地内容。
4. `replaceConversationMessages()` 仍会刷新 `updated_at`。这是有真实内容变化时的正确行为。

## 验收标准

1. 飞书、微信无新消息时不会周期性排到任务列表顶部。
2. channel session 对账不会让 `cowork_messages` 每 10 秒增长一条重复 assistant。
3. 当前 turn 的 assistant final 文本仍能覆盖 streaming partial。
4. 已有 wecom、qq、popo 的 `already in sync` 行为不回退。
5. `openclawRuntimeAdapter` 单元测试通过，生产构建通过。
