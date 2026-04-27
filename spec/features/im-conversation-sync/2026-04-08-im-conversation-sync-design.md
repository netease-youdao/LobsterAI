# IM 会话同步设计文档（2026-04-08 更新）

## 1. 概述

本文档描述 OpenClaw 升级后 IM 会话同步机制的变更。主要目标：

1. **消息准确性** — 本地会话数据与 OpenClaw Dashboard（`chat.history`）完全一致
2. **用户消息实时显示** — 新用户消息在 assistant 流式输出前出现在 UI 中
3. **Turn 完成可靠性** — 即使 `chat state=final` 事件缺失，会话也能正确标记为完成
4. **平台文本清洁** — 各 IM 平台注入的元数据不出现在同步后的用户消息中

### 与 v2026.3.19 设计的关系

本次更新继承 `2026-03-19-im-conversation-sync-design.md` 的核心架构（history-first、`reconcileWithHistory` 全量对账），变更集中在三个方面：

| 方面 | 旧方案 | 新方案 |
|------|--------|--------|
| Prefetch 同步 | `syncChannelUserMessages`（增量、启发式匹配） | `reconcileWithHistory`（全量对账） |
| Turn 完成信号 | 仅依赖 `chat state=final` 事件 | 增加 `agent lifecycle phase=end` 延迟补偿 |
| 平台文本清洁 | Discord mention、QQ 系统提示、POPO `<br />` | 新增飞书 System header、Discord 渲染态 @mention |

---

## 2. 变更一：Prefetch 改用 `reconcileWithHistory`

### 2.1 问题

旧 `prefetchChannelUserMessages` 调用 `syncChannelUserMessages` 做增量同步，存在以下问题：

1. **重复文本去重失败** — 使用 `Set<string>` 去重，当用户发送相同文本（如两次 "你好"）时，第二条消息被误判为重复
2. **游标漂移** — `channelSyncCursor` 在多个同步路径中更新，可能不同步
3. **匹配策略脆弱** — `computeChannelHistoryFirstNewIndex` 有 4 种回退策略，在滑动历史窗口场景下可能误判

### 2.2 方案

将 prefetch 的同步逻辑从增量替换为全量：

```
旧流程:
  prefetchChannelUserMessages()
    → syncChannelUserMessages()        // 增量，~150 行启发式逻辑
      → collectChannelHistoryEntries()
      → computeChannelHistoryFirstNewIndex()
      → 逐条添加新用户消息

新流程:
  prefetchChannelUserMessages()
    → reconcileWithHistory()            // 全量，~30 行位置比较
      → chat.history 获取权威消息
      → 逐条比较 role + text
      → 不一致则 replaceConversationMessages()
    → emit('message') 通知渲染进程       // 新增：实时通知
```

### 2.3 关键设计决策

**为什么全量替换是安全的**：Turn 开始时 assistant 尚未流式输出，本地只有历史消息。`replaceConversationMessages` 仅替换 `user/assistant` 类型，保留 `tool_use/tool_result/system`。

**渲染进程实时通知**：`reconcileWithHistory` 通过 `replaceConversationMessages` 批量写入 SQLite，仅发送 `cowork:sessions:changed`（刷新会话列表）。渲染进程的活跃会话消息列表不会自动更新。因此 prefetch 在对账后对比前后用户消息数量，对新增消息 emit `message` 事件，走原有 `cowork:stream:message` IPC 通道。

```typescript
// prefetchChannelUserMessages 关键逻辑
const beforeCount = this.getUserMessageCount(sessionId);
await this.reconcileWithHistory(sessionId, sessionKey);
const afterCount = this.getUserMessageCount(sessionId);

if (afterCount > beforeCount) {
  const session = this.store.getSession(sessionId);
  const userMessages = session.messages.filter(m => m.type === 'user');
  const newMsgs = userMessages.slice(-newUserMessages);
  for (const msg of newMsgs) {
    this.emit('message', sessionId, msg);  // → renderer addMessage
  }
}
```

### 2.4 `syncChannelUserMessages` 保留

`syncChannelUserMessages` 仍被 `syncFinalAssistantWithHistory`（turn 结束时）调用。其去重逻辑也做了修正：

- **正常范围**（`firstNewIdx` 之后）：移除文本去重，这些消息由对账算法确定为新消息
- **修复范围**（`firstNewIdx` 之前）：从 `Set<string>` 改为 `Map<string, number>` 计数匹配，正确处理重复文本

---

## 3. 变更二：Turn 完成延迟补偿

### 3.1 问题

Turn 完成依赖网关发送 `chat state=final` 事件触发 `handleChatFinal()`。OpenClaw 升级后，该事件对 IM channel 会话可能不可靠（`server-chat.ts` 中 `finalizeLifecycleEvent` 有多个提前返回路径）。会话卡在 "执行中" 状态。

### 3.2 方案

`agent lifecycle phase=end` 事件可靠到达。在 `handleAgentLifecycleEvent` 中增加 `phase=end` 处理，延迟 3 秒后检查 turn 是否仍然活跃：

```
agent lifecycle phase=end 到达
    |
    v
setTimeout(3000ms)
    |
    v
activeTurns.has(sessionId)?
    ├─ No  → handleChatFinal 已处理，无操作
    └─ Yes → chat final 未到达，执行补偿:
              → reconcileWithHistory()
              → store.updateSession(status: 'completed')
              → emit('complete')
              → cleanupSessionTurn()
              → resolveTurn()
```

### 3.3 防重复完成

- `completeChannelTurnFallback` 在 async `reconcileWithHistory` 前后各检查一次 `activeTurns.has(sessionId)`
- 如果 `handleChatFinal` 在延迟期间运行，它会清理 turn，补偿回调发现 turn 已清理，直接返回

---

## 4. 变更三：平台文本清洁扩展

### 4.1 飞书（Feishu）

飞书插件在用户消息前注入系统头部行，格式：

```
System: [2026-04-09 15:55:28 GMT+8] Feishu[755f282a] DM | userId [msg:messageId]

你会做什么？
```

OpenClaw 的 `stripEnvelopeFromMessages` 会移除 "Conversation info" 和 "Sender" 元数据块，但不移除 `System:` 头部行。

**新增 `stripFeishuSystemHeader`**：匹配 `^System:\s*\[.*?\]\s+Feishu\[.*$` 并移除该行及后续空行。

```typescript
const stripFeishuSystemHeader = (text: string): string => {
  const match = text.match(/^System:\s*\[.*?\]\s+Feishu\[.*$/m);
  if (!match) return text;
  return text.slice(match.index! + match[0].length).replace(/^\n+/, '').trim();
};
```

应用于 `role === 'user'` 且 `sessionKey.includes(':feishu:')` 的消息，在 `reconcileWithHistory` 和 `collectChannelHistoryEntries` 两个路径中均生效。

### 4.2 Discord

原 `stripDiscordMentions` 仅处理原始 Discord mention 标记（`<@userId>` 等）。OpenClaw 升级后 `chat.history` 返回渲染态 mention（如 `@OctoBot`），原函数不匹配。

**扩展**：增加 `^(?:@\S+\s*)+` 正则，剥离消息开头的渲染态 @mention。

```typescript
const stripDiscordMentions = (text: string): string =>
  text
    .replace(/<@!?\d+>/g, '')       // raw: <@123456>
    .replace(/<#\d+>/g, '')         // raw: <#123456>
    .replace(/<@&\d+>/g, '')        // raw: <@&123456>
    .replace(/^(?:@\S+\s*)+/, '')   // rendered: @OctoBot
    .trim();
```

### 4.3 各平台文本清洁总览

| 平台 | 检测条件 | 清洁操作 | 适用角色 |
|------|----------|----------|----------|
| Discord | `sessionKey.includes(':discord:')` | 移除原始 `<@id>` 标记 + 渲染态 `@Username` 前缀 | user + assistant |
| QQ Bot | `sessionKey.includes(':qqbot:')` | 移除系统提示词 `【...】` 块 | user only |
| POPO | `sessionKey.includes(':moltbot-popo:')` | `<br />` → `\n` | user + assistant |
| 飞书 | `sessionKey.includes(':feishu:')` | 移除 `System: [timestamp] Feishu[...]` 头部行 | user only |
| 钉钉 | 无特殊处理 | OpenClaw 的 `stripEnvelopeFromMessages` 已处理 | — |

---

## 5. 完整同步流程（更新后）

```
Turn 开始（IM 用户发消息）
    |
    v
ensureActiveTurn()
    ├─ pendingUserSync = true（缓冲所有流式事件）
    └─ prefetchChannelUserMessages() [async]
         |
         ├─ reconcileWithHistory()          ← 全量对账（替代旧增量同步）
         │    ├─ chat.history 获取权威消息
         │    ├─ 平台文本清洁（Discord/QQ/POPO/飞书）
         │    ├─ 逐条比较 role + text
         │    └─ 不一致 → replaceConversationMessages()
         │
         ├─ emit('message') 通知新用户消息    ← 新增：实时 UI 更新
         │
         ├─ pendingUserSync = false
         └─ 回放缓冲的 chat + agent 事件
              |
              v
流式阶段
    ├─ handleChatDelta → assistant 文本更新
    ├─ handleAgentEvent → tool_use / tool_result
    └─ handleAgentLifecycleEvent
         ├─ phase=start → status: running
         └─ phase=end → 启动 3s 延迟补偿         ← 新增
              |
              v
Turn 完成（两条路径，先到先赢）
    |
    ├─ 路径 A: handleChatFinal()              ← 正常路径（chat state=final）
    │    ├─ reconcileWithHistory()
    │    ├─ status: completed
    │    ├─ emit('complete')
    │    └─ cleanupSessionTurn()
    │
    └─ 路径 B: completeChannelTurnFallback()  ← 补偿路径（3s 后 turn 仍活跃）
         ├─ reconcileWithHistory()
         ├─ status: completed
         ├─ emit('complete')
         └─ cleanupSessionTurn()
```

---

## 6. 修改文件清单

| 文件 | 变更内容 |
|------|----------|
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | prefetch 改用 reconcileWithHistory；emit message 通知渲染进程；增加 phase=end 补偿；syncChannelUserMessages 去重修正；新增 stripFeishuSystemHeader；扩展 stripDiscordMentions |
| `src/main/libs/openclawConfigSync.ts` | 移除 `_agentBinding` 哨兵（与本文档无关，解决 schema 校验问题） |
| `src/main/main.ts` | bindingsChanged 触发网关硬重启 |
| `tests/openclawRuntimeAdapter.history.test.mjs` | mock store 增加 replaceConversationMessages |

---

## 7. 验证方案

### 7.1 自动化测试

```bash
npm run compile:electron
node --test tests/openclawReconcile.test.mjs
node --test tests/openclawRuntimeAdapter.history.test.mjs
node --test tests/openclawHistory.test.mjs
```

### 7.2 手动测试矩阵

| 测试项 | 步骤 | 预期结果 |
|--------|------|----------|
| 用户消息实时显示 | 通过 IM 发送消息 | 用户消息在 assistant 回复前出现在 UI 中，无需切换会话 |
| 重复文本同步 | 连续发送两次 "你好" | 两条消息均显示，无丢失 |
| 消息与 Dashboard 一致 | 多轮对话后对比 LobsterAI UI 和 OpenClaw Dashboard | 用户/助手消息数量和内容完全一致 |
| Turn 完成状态 | 发送消息等待回复 | 回复后会话状态从 "执行中" 变为 "已完成"，不超过 5 秒 |
| 飞书文本清洁 | 通过飞书发送消息 | UI 中不显示 `System: [timestamp] Feishu[...]` 头部 |
| Discord 文本清洁 | 通过 Discord @mention bot | UI 中不显示 `@BotName` 前缀 |
| QQ 文本清洁 | 通过 QQ 发送消息 | UI 中不显示 `【...】` 系统提示词 |
| 钉钉文本清洁 | 通过钉钉发送消息 | UI 中不显示 Conversation info / Sender 元数据 |

### 7.3 关键日志

```
# Prefetch 全量对账
[Debug:prefetch] reconciled (attempt 0) synced user messages: 1 (before: 3 after: 4)

# 正常完成（chat final 到达）
[OpenClawRuntime] handleChatFinal: sessionId=xxx

# 补偿完成（chat final 未到达）
[OpenClawRuntime] agent lifecycle end fallback: completing turn that missed chat final, sessionId: xxx

# 对账结果
[Reconcile] already in sync — sessionId: xxx entries: 8
[Reconcile] replacing messages — sessionId: xxx local: 6 → authoritative: 8
```
