# IM 会话同步设计文档

## 1. 概述

LobsterAI 的 IM 会话通过 OpenClaw 网关实现。用户从各 IM 平台（钉钉、飞书、Telegram、Discord、QQ、企业微信、POPO、云信等）发送消息后，LobsterAI 将消息路由到 OpenClaw 引擎执行，并将 AI 回复同步回 IM。

核心挑战在于：OpenClaw 引擎通过 WebSocket 实时推送流式事件，同时也提供 `chat.history` API 查询完整历史。本方案采用 **history-first** 架构，以 `chat.history` 作为唯一数据真相源（single source of truth），流式事件仅用于 UI 实时预览。

### 设计原则

1. **`chat.history` 是唯一真相源** — 流式事件仅用于实时预览，不作为最终持久化依据
2. **Turn 完成后全量对账** — 每次 turn 结束时调用 `reconcileWithHistory` 与网关历史对齐
3. **幂等对账** — 对账操作可重复执行，不产生副作用
4. **准确性优先于延迟** — 允许 turn 完成后的 HTTP 往返延迟

---

## 2. 两条 IM 路径

### 2.1 Managed IM Sessions（IMCoworkHandler 路径）

**适用场景**：用户通过 IM 平台直接与 LobsterAI 对话（钉钉、飞书、Telegram 等）。

**入口文件**：`src/main/im/imCoworkHandler.ts`

**流程**：

```
IM 消息 (platform:conversationId)
    |
    v
IMCoworkHandler.processMessage()
    |
    v
getOrCreateCoworkSession()
    |- 查询 im_session_mappings 是否存在映射
    |- 不存在则创建新 cowork session + 持久化映射
    |
    v
coworkRuntime.startSession() / continueSession()
    |
    v
流式事件:
    - message     -> handleMessage()     -> accumulator 收集
    - messageUpdate -> handleMessageUpdate() -> accumulator 更新
    - permissionRequest -> 向 IM 发送确认提示，等待用户回复
    |
    v
handleChatFinal() [openclawRuntimeAdapter.ts]
    |- await reconcileWithHistory()  <- 等待对账完成
    |- emit('complete')
    |
    v
handleComplete() [imCoworkHandler.ts]
    |- 从 coworkStore 读取对账后的消息（而非 accumulator）
    |- formatReply() 格式化回复
    |- resolve Promise，回复 IM 用户
```

**关键组件 — MessageAccumulator**：

```typescript
interface MessageAccumulator {
  messages: CoworkMessage[];      // 流式收集的消息
  resolve?: (text: string) => void;  // 完成后 resolve
  reject?: (error: Error) => void;   // 出错后 reject
  timeoutId?: NodeJS.Timeout;        // 超时保护
  backgroundDelivery?: {             // 定时任务后台投递
    conversationId: string;
    platform: IMPlatform;
  };
}
```

Accumulator 在流式期间收集消息，但 `handleComplete` 最终从 coworkStore 读取对账后的权威消息来构建回复：

```typescript
const session = this.coworkStore.getSession(sessionId);
const storeMessages = session?.messages ?? [];
const messages = storeMessages.length > 0 ? storeMessages : accumulator.messages;
```

### 2.2 Channel Sessions（OpenClaw 轮询路径）

**适用场景**：Telegram/Discord 等通过 OpenClaw 扩展直接接入的频道会话，LobsterAI 通过轮询发现新会话。

**入口文件**：`src/main/libs/agentEngine/openclawRuntimeAdapter.ts` + `src/main/libs/openclawChannelSessionSync.ts`

**流程**：

```
pollChannelSessions()
    |
    v
遍历 channelSessionKeys:
    channelSessionSync.resolveOrCreateSession(key)
        |- 解析 sessionKey 获取 platform + conversationId
        |- 查询/创建 im_session_mappings
        |- 创建 coworkStore session
    |
    v
gateway 推送 chat 事件
    |
    v
Turn 开始:
    prefetchChannelUserMessages(sessionId, sessionKey)
        |- 调用 chat.history 获取最新消息
        |- syncChannelUserMessages() 将用户消息同步到本地
        |- 回放缓冲的 chat/agent 事件
    |
    v
流式:
    handleChatDelta -> emit messageUpdate
    handleAgentEvent -> emit tool_use/tool_result
    |
    v
handleChatFinal()
    |- await reconcileWithHistory(sessionId, sessionKey)
    |- 发送 cowork:sessions:changed 通知渲染进程
```

### 2.3 Session Key 格式

| 类型 | 格式 | 示例 |
|------|------|------|
| Managed（LobsterAI 发起） | `agent:main:lobsterai:{sessionId}` | `agent:main:lobsterai:abc123` |
| Channel（平台发起） | `agent:{agentId}:{platform}:{subtype}:{conversationId}` | `agent:bot1:telegram:private:12345` |
| Cron（定时任务） | `cron:{jobId}` 或 `agent:{agentId}:cron:{jobId}` | `cron:task-001` |

---

## 3. 核心对账机制：`reconcileWithHistory`

### 3.1 方法签名

```typescript
// openclawRuntimeAdapter.ts
private async reconcileWithHistory(
  sessionId: string,
  sessionKey: string,
  options?: { isFullSync?: boolean },
): Promise<void>
```

### 3.2 算法步骤

```
1. 调用 chat.history 获取网关权威消息列表
      |
      v
2. 同步系统消息（定时提醒等）
      - 使用 gatewayHistoryCountBySession 游标跟踪
      - 仅处理游标之后的新系统消息
      |
      v
3. 提取权威 user/assistant 条目
      - 过滤 role 为 user 或 assistant 的消息
      - 文本规范化:
        - Discord: 移除 <@userId>、<#channelId> 等 mention 标记
        - QQ: 移除机器人系统提示词（【...】块）
      - Channel 会话: 追加文件发送路径为 markdown 链接
      |
      v
4. 提取本地 user/assistant 条目
      - 从 coworkStore.getSession().messages 中筛选
      |
      v
5. 比较
      - 逐条比较 role 和 text
      - 如果完全一致 → 跳过，仅更新游标
      |
      v
6. 不一致则替换
      - 调用 store.replaceConversationMessages()
      - 删除所有本地 user/assistant 消息
      - 按权威列表重新插入
      - 保留 tool_use/tool_result/system 类型消息
      - 通知渲染进程刷新 UI
```

### 3.3 调用时机

| 调用点 | 触发场景 | 等待方式 | 说明 |
|--------|----------|----------|------|
| `handleChatFinal` | Turn 正常完成 | `await` | 确保 IM 回复使用对账后的数据 |
| `handleChatAborted` | Turn 被中止 | `void` | 同步中止前已交付的消息 |
| `handleChatError` | Turn 出错 | `void` | 同步出错前已交付的消息 |
| `syncFullChannelHistory` | Channel 会话首次发现 | `await` | `isFullSync: true` |
| `incrementalChannelSync` | 轮询增量同步 | `await` | 已知 channel 的增量对账 |

### 3.4 `replaceConversationMessages` 实现

```typescript
// coworkStore.ts
replaceConversationMessages(
  sessionId: string,
  authoritative: Array<{ role: 'user' | 'assistant'; text: string }>,
): void {
  // 1. 删除所有现有 user/assistant 消息（保留 tool/system）
  db.run(
    "DELETE FROM cowork_messages WHERE session_id = ? AND type IN ('user', 'assistant')",
    [sessionId],
  );

  // 2. 获取剩余消息的最大 sequence
  let nextSeq = maxExistingSequence + 1;

  // 3. 按权威列表顺序重新插入
  for (const entry of authoritative) {
    db.run(`INSERT INTO cowork_messages (...) VALUES (...)`, [
      uuid(), sessionId, entry.role, entry.text,
      JSON.stringify({ isStreaming: false, isFinal: true }),
      now, nextSeq++,
    ]);
  }
}
```

---

## 4. 用户消息预取：`prefetchChannelUserMessages`

Channel 会话中，当 OpenClaw 开始一个新 turn 时，网关可能已经在推送 assistant 的流式事件。为了保证用户消息在 assistant 回复之前出现在 UI 中，系统会在 turn 开始时预取用户消息。

### 4.1 流程

1. 标记 `turn.pendingUserSync = true`，缓冲所有到达的流式事件
2. 调用 `chat.history` 获取最新消息
3. 通过 `syncChannelUserMessages` 将新的用户消息同步到本地
4. 如果未发现新用户消息但有缓冲事件，等待 500ms 后重试（最多 2 次）
5. 标记 `turn.pendingUserSync = false`
6. 按 sequence 顺序回放缓冲的 chat + agent 事件

### 4.2 事件缓冲与排序

```typescript
interface BufferedChatEvent {
  payload: unknown;
  seq?: number;         // 网关分配的序列号
  bufferedAt: number;   // 本地缓冲时间
}
```

排序优先级：
1. 有 `seq` 的事件按 `seq` 升序
2. 有 `seq` 的事件排在无 `seq` 的事件之前
3. 同类事件按 `bufferedAt` 时间排序
4. 最后按插入顺序（`idx`）排序

### 4.3 与 `reconcileWithHistory` 的关系

`prefetchChannelUserMessages` 负责 **turn 开始前** 的快速用户消息同步，确保 UI 显示顺序正确。即使预取不完整，`reconcileWithHistory` 在 **turn 结束后** 会做全量对账，保证最终一致性。因此预取的重试次数从 5 次减少到 2 次。

---

## 5. 系统消息与定时提醒同步

### 5.1 `syncSystemMessagesFromHistory`

```typescript
private syncSystemMessagesFromHistory(
  sessionId: string,
  historyMessages: unknown[],
  options: { previousCountKnown: boolean; previousCount: number },
): void
```

**游标追踪**：通过 `gatewayHistoryCountBySession` Map 记录上次同步时的历史消息数量。仅处理游标之后的新消息，避免重复添加老的系统消息。

**提醒检测**：`extractGatewayHistoryEntries`（`openclawHistory.ts`）会检测用户消息中的定时提醒格式，将其转换为 `role: 'system'` 类型的条目。

### 5.2 IM 回复守卫（Reminder Guard）

**文件**：`src/main/im/imReplyGuard.ts`

当 assistant 声称创建了定时提醒但实际 `cron.add` 工具调用失败时，守卫会拦截误导性回复：

- 检测模式：「我会...提醒」、「已...创建...定时任务」、"I'll set a reminder" 等
- 如果有未成功的 `cron.add` 调用 → 替换为错误提示
- 后台投递的定时提醒（`backgroundDelivery`）绕过此守卫

---

## 6. 关键常量与超时

### 6.1 消息限制

| 常量 | 值 | 用途 |
|------|-----|------|
| `FINAL_HISTORY_SYNC_LIMIT` | 50 | 对账时获取的历史消息数上限 |
| `FULL_HISTORY_SYNC_LIMIT` | 50 | 全量同步时获取的历史消息数上限 |
| `CHANNEL_SESSION_DISCOVERY_LIMIT` | 200 | 轮询时最大发现会话数 |
| `BRIDGE_MAX_MESSAGES` | 20 | agent prompt 中包含的最近消息数 |
| `BRIDGE_MAX_MESSAGE_CHARS` | 1200 | 单条消息最大字符数（截断） |

### 6.2 超时

| 常量 | 值 | 用途 |
|------|-----|------|
| `ACCUMULATOR_TIMEOUT_MS` | 5 分钟 | IM 等待流式响应的最大时间 |
| `PERMISSION_CONFIRM_TIMEOUT_MS` | 60 秒 | 等待用户 IM 权限确认 |
| `GATEWAY_READY_TIMEOUT_MS` | 15 秒 | 等待网关连接就绪 |
| `TICK_TIMEOUT_MS` | 90 秒 | 看门狗超时阈值 |

---

## 7. 错误处理与恢复

### 7.1 IMCoworkHandler 错误恢复

| 错误类型 | 检测方式 | 恢复策略 |
|----------|----------|----------|
| Session Not Found | `^Session\s.+\snot found$` | 删除旧映射，强制创建新 session 并重试 |
| API 400 可恢复错误 | 包含 `api error`、`bad_response_status_code` 等 | 重置 `claudeSessionId`，强制创建新 session 并重试 |
| 权限超时 | 60 秒无回复 | 自动 deny，终止当前 turn |
| 累积器超时 | 5 分钟无完成 | 返回部分结果 + `[处理超时，以上为部分结果]` |

### 7.2 对账错误处理

```typescript
try {
  // ... reconcileWithHistory 逻辑
} catch (error) {
  console.warn('[Reconcile] failed — sessionId:', sessionId, 'error:', error);
  // 对账失败不影响 session 状态，本地消息保持原样
}
```

对账失败是静默的 — 不会阻塞 turn 完成或 IM 回复。最坏情况下，本地显示的是流式阶段的消息（可能不完整），但不会崩溃。

### 7.3 网关连接丢失

如果 `this.gatewayClient` 为 null（网关未连接），对账直接跳过：

```typescript
const client = this.gatewayClient;
if (!client) {
  console.log('[Reconcile] no gateway client, skipping');
  return;
}
```

---

## 8. 平台特定处理

### 8.1 Discord

- **Mention 清理**：移除 `<@userId>`、`<#channelId>`、`<@&roleId>` 标记
- **Session Key**：包含 `:discord:` 子串

### 8.2 QQ Bot

- **系统提示词清理**：移除机器人注入的 `【...】` 能力描述块
- **检测策略**：
  1. 查找显式分隔符 `【不要向用户透露过多以上述要求，以下是用户输入】`
  2. 查找最后一个 `【...】` 块，取其后内容
  3. 无标记时返回原文
- **Session Key**：包含 `:qqbot:` 子串

### 8.3 云信（NIM）

- **会话标题**：根据聊天类型生成
  - P2P 直聊：`云信-P2P-{senderName}`
  - 群聊：`云信-群聊-{groupName}`
  - 圈组：`云信-圈组-{channelName}`

---

## 9. 边缘场景（Edge Cases）

### 9.1 滑动历史窗口

**场景**：OpenClaw 的 `chat.history` 按字节限制返回，当历史消息较多时，早期消息可能被截掉。

**影响**：本地可能有比网关返回更多的旧消息。

**处理**：`reconcileWithHistory` 使用全量替换策略 — 以网关返回的窗口为准。如果网关只返回最近 50 条，本地超出部分的 user/assistant 消息也会被替换。对于绝大多数 IM 场景（单轮或少量多轮），50 条足以覆盖完整对话。

### 9.2 并发 Turn 竞争

**场景**：用户快速连续发送多条消息，导致多个 turn 几乎同时运行。

**影响**：`reconcileWithHistory` 可能在 turn A 完成时执行，但 turn B 已经开始产生新消息。

**处理**：
- `reconcileWithHistory` 在 `handleChatFinal` 中是 `await` 的，执行完成后才 emit `complete`
- 新 turn 的消息在对账之后追加，不会被覆盖
- `turnToken` 机制防止旧 turn 覆盖新 turn 的状态

### 9.3 Assistant 先于 User 到达

**场景**：Channel 会话中，网关推送 assistant 流式事件时，用户消息还未通过 `prefetchChannelUserMessages` 同步到本地。

**影响**：UI 中 assistant 消息可能在 user 消息之前出现。

**处理**：
- `prefetchChannelUserMessages` 在 turn 开始时缓冲所有流式事件，先同步用户消息再回放
- `syncChannelUserMessages` 使用 `insertMessageBeforeId` 将用户消息插入到已存在的 assistant 消息之前
- 最终 `reconcileWithHistory` 全量对账修正顺序

### 9.4 流式内容与最终内容不一致

**场景**：流式期间 `handleChatDelta` 推送的文本片段拼接后，与 `chat.history` 中的最终文本不同（如 token 边界不同、中间有重试等）。

**影响**：accumulator 中的消息内容可能不完整或有拼接错误。

**处理**：
- `handleComplete` 使用 coworkStore 中对账后的消息，而非 accumulator
- `replaceConversationMessages` 将所有 user/assistant 消息替换为权威版本

### 9.5 对账期间网关超时

**场景**：`chat.history` 请求在网络不稳定时超时。

**影响**：对账失败，本地消息保持流式阶段的状态。

**处理**：
- 对账错误被 try-catch 捕获并静默记录日志
- 不影响 turn 完成状态和 IM 回复
- 下次 turn 完成时会再次对账，最终收敛到正确状态

### 9.6 Session 重建后的历史丢失

**场景**：由于 API 400 错误或 session not found，IMCoworkHandler 强制创建新 session（`forceNewSession=true`），新 session 没有历史消息。

**影响**：之前的对话上下文丢失。

**处理**：
- 这是预期行为 — 错误场景下优先保证可用性
- 旧 session 的数据仍在 SQLite 中（未删除 cowork_sessions 记录）
- IM 平台映射更新为新 session ID

### 9.7 Tool 消息的保留

**场景**：对账时网关历史仅包含 user/assistant 角色的消息，不包含 tool_use/tool_result。

**影响**：如果简单全量替换，tool 相关消息会丢失。

**处理**：
- `replaceConversationMessages` 仅删除 `type IN ('user', 'assistant')` 的消息
- `tool_use`、`tool_result`、`system` 类型的消息不受影响
- 新插入的 user/assistant 消息的 sequence 从现有最大值 +1 开始

### 9.8 空历史响应

**场景**：`chat.history` 返回空消息列表（新创建的 session 或网关异常）。

**影响**：不应删除本地已有的消息。

**处理**：
- 空历史时直接返回，仅将 `channelSyncCursor` 设为 0
- 不触发 `replaceConversationMessages`

### 9.9 定时任务后台投递

**场景**：Cron 触发的定时提醒需要通过 IM 发送，但此时没有用户主动请求。

**影响**：没有活跃的 accumulator 来收集消息。

**处理**：
- `ensureBackgroundAccumulator` 创建一个带 `backgroundDelivery` 标记的 accumulator
- `handleComplete` 检测到 `backgroundDelivery` 后使用 `sendAsyncReply` 异步发送
- 绕过 reminder guard（定时提醒本身就是合法的提醒内容）
- 通过 `isReminderSystemTurn` 验证 turn 确实是定时提醒触发的

---

## 10. 验证方案

### 10.1 自动化测试

**测试文件**：`tests/openclawReconcile.test.mjs`

| 测试用例 | 验证内容 |
|----------|----------|
| already in sync — skips replace | 本地与网关一致时不触发替换 |
| missing assistant message — triggers replace | 本地缺失消息时触发替换 |
| duplicate messages locally — triggers replace | 本地有重复消息时触发替换 |
| content mismatch — triggers replace | 流式内容与最终内容不同时触发替换 |
| preserves tool messages | tool_use/tool_result 消息不被对账影响 |
| empty history — sets cursor to 0 | 空历史不删除本地消息 |
| multi-turn conversation — correct order | 多轮对话顺序正确 |
| gateway error — does not crash | 网关错误不导致崩溃 |

**运行**：

```bash
npm run compile:electron && node --test tests/openclawReconcile.test.mjs
```

**其他相关测试**：

```bash
node --test tests/openclawRuntimeAdapter.history.test.mjs  # 历史同步测试
node --test tests/openclawHistory.test.mjs                 # 历史提取工具测试
node --test tests/imReplyGuard.test.mjs                    # IM 回复守卫测试
```

### 10.2 手动测试矩阵

#### 基础功能验证

| 测试项 | 步骤 | 预期结果 |
|--------|------|----------|
| 单轮对话 | 通过 IM 发送一条消息 | UI 显示用户消息和 AI 回复，内容与 OpenClaw Dashboard 一致 |
| 多轮对话 | 连续发送 3-5 条消息 | 所有消息按正确顺序显示，无丢失 |
| 带 tool 调用 | 发送需要工具调用的任务（如"创建一个文件"） | tool_use/tool_result 消息正确显示，最终回复完整 |
| 权限确认 | 触发需要权限的操作 | IM 收到确认提示，回复"允许"后继续执行 |
| 定时提醒 | 发送"5分钟后提醒我开会" | 创建成功，5 分钟后 IM 收到提醒消息 |

#### 同步准确性验证

| 测试项 | 步骤 | 预期结果 |
|--------|------|----------|
| 消息完整性 | 多轮对话后对比 LobsterAI UI 和 OpenClaw Dashboard | 消息数量和内容完全一致 |
| 消息顺序 | 快速连续发送 3 条消息 | user/assistant 交替出现，顺序正确 |
| 无重复 | 同一条消息不应出现两次 | 对比 UI 中无重复消息 |
| 流式→最终 | 观察流式过程和最终结果 | 流式完成后，消息内容与 Dashboard 一致 |

#### 边缘场景验证

| 测试项 | 步骤 | 预期结果 |
|--------|------|----------|
| 网络中断恢复 | 对话过程中断开网络，恢复后继续 | 下次 turn 完成时自动对账修正 |
| 超时处理 | 发送需要长时间处理的任务（超过 5 分钟） | 收到部分结果 + 超时提示 |
| 权限超时 | 触发权限确认但不回复 | 60 秒后自动拒绝，收到提示 |
| 快速连续消息 | 1 秒内连续发送 5 条消息 | 所有消息最终正确同步，无丢失或乱序 |

#### 多平台验证

| 平台 | 特殊验证点 |
|------|-----------|
| Discord | mention 标记 `<@userId>` 不出现在消息内容中 |
| QQ Bot | 系统提示词 `【...】` 被正确移除 |
| 云信（NIM） | 会话标题正确反映聊天类型（P2P/群聊/圈组） |
| Telegram | 基础消息收发正常 |
| 钉钉 | 基础消息收发正常 |

### 10.3 日志检查

对账执行时会输出以下日志，可用于排查问题：

```
[Reconcile] already in sync — sessionId: xxx entries: N
[Reconcile] replacing messages — sessionId: xxx local: N → authoritative: M
[Reconcile] empty history — sessionId: xxx
[Reconcile] no user/assistant entries in history — sessionId: xxx
[Reconcile] failed — sessionId: xxx error: ...
[Reconcile] no gateway client, skipping — sessionId: xxx
```

预取相关日志：

```
[Debug:prefetch] start — sessionId: xxx sessionKey: yyy
[Debug:prefetch] chat.history returned N messages (attempt X)
[Debug:prefetch] synced user messages: N (before: A after: B)
[Debug:prefetch] replay complete, sessionId: xxx
```

---

## 11. 文件清单

| 文件 | 角色 |
|------|------|
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 核心：`reconcileWithHistory`、`prefetchChannelUserMessages`、`handleChatFinal` |
| `src/main/im/imCoworkHandler.ts` | Managed IM 适配器：`handleComplete` 使用对账后数据 |
| `src/main/coworkStore.ts` | 持久化层：`replaceConversationMessages`、`deleteMessage` |
| `src/main/libs/openclawChannelSessionSync.ts` | Channel 会话发现与映射 |
| `src/main/libs/openclawHistory.ts` | 历史消息提取工具 |
| `src/main/im/imReplyGuard.ts` | IM 回复守卫（防止误导性提醒） |
| `src/main/sqliteStore.ts` | SQLite 数据库初始化与表结构 |
| `tests/openclawReconcile.test.mjs` | 对账算法自动化测试 |
