# IM 渠道停止对话后消息状态异常分析

## 问题描述

从 IM 渠道发送消息的对话，在 UI 端手动停止后：
1. 后续从 IM 发送消息不展示"运行中"状态
2. 新消息需要切换对话后再进入才能展示

## 核心结论

**本质原因是两个独立但叠加的 bug：**

| # | Bug | 影响 | 严重程度 |
|---|-----|------|---------|
| 1 | `stopSession` 不 emit `complete` 事件，但 Renderer 的 `isStreaming` 依赖 `updateSessionStatus` 来重置，而 stop 后的 IM 新消息触发的 `status: 'running'` 只在 `currentSession.id === sessionId` 时才同步到 `isStreaming` | 用户正在查看该 IM 对话时，停止后再收到 IM 消息不显示运行中状态 | 高 |
| 2 | `addMessage` reducer 只在 `currentSession.id === sessionId` 时向 `currentSession.messages` 数组追加消息，否则只更新 `sessions[]` 列表的 `updatedAt` | 用户不在该对话页面时收到的消息不显示，切换回来后 `loadSession` 才加载到完整消息 | 中 |

---

## 详细流程分析

### 正常流程（用户从 UI 发消息）

```
User clicks Send → coworkService.startSession()
  → dispatch(setStreaming(true))                    ← isStreaming = true ✅
  → IPC cowork:session:start
  → CoworkRunner.startSession()
  → emit('message', userMessage)                    ← onStreamMessage 触发
  → emit('messageUpdate', ...)                      ← 流式更新
  → emit('complete', sessionId)                     ← onStreamComplete 触发
  → dispatch(updateSessionStatus({status:'completed'}))
  → isStreaming = false                             ← 因为 currentSession.id 匹配 ✅
```

### 异常流程（IM 消息 → UI 手动停止 → IM 再次发消息）

#### 第一阶段：IM 消息正常处理

```
IM message arrives → IMCoworkHandler.processMessage()
  → getOrCreateCoworkSession() → 获取/创建 cowork session
  → createAccumulatorPromise(sessionId)             ← 创建消息累积器
  → isActive = false
  → coworkRuntime.startSession(sessionId, ...)      ← 启动 session
  → emit('message', userMessage)
    → Main process forwards via IPC: cowork:stream:message
    → Renderer onStreamMessage: dispatch(updateSessionStatus({status:'running'}))
    → 如果 currentSession.id === sessionId:
        isStreaming = true ✅
        currentSession.messages.push(message) ✅
    → 如果 currentSession.id !== sessionId:
        只更新 sessions[] 列表的 status ⚠️
        不更新 isStreaming ⚠️
        不追加到 currentSession.messages ⚠️
  → 流式消息处理...
  → emit('complete', sessionId)
    → Renderer onStreamComplete: dispatch(updateSessionStatus({status:'completed'}))
    → IMCoworkHandler.handleComplete(): resolve accumulator → IM 回复
```

#### 第二阶段：用户在 UI 手动停止

```
User clicks Stop → coworkService.stopSession(sessionId)
  → IPC cowork:session:stop
  → CoworkEngineRouter.stopSession(sessionId)
    → CoworkRunner.stopSession():
        this.stoppedSessions.add(sessionId)
        activeSession.abortController.abort()
        this.activeSessions.delete(sessionId)
        store.updateSession(sessionId, { status: 'idle' })
        ⚠️ 不 emit('complete')
        ⚠️ 不 emit('error')
    → OpenClawRuntimeAdapter.stopSession():
        turn.stopRequested = true
        this.manuallyStoppedSessions.add(sessionId)      ← 🔴 关键：标记为手动停止
        gateway.request('chat.abort', ...)
        this.stoppedSessions.set(sessionId, Date.now())   ← 🔴 关键：10s 冷却期
        this.cleanupSessionTurn(sessionId)
        store.updateSession(sessionId, { status: 'idle' })
        ⚠️ 不 emit('complete')
  → Renderer:
      dispatch(setStreaming(false))
      dispatch(updateSessionStatus({ sessionId, status: 'idle' }))
```

#### 第三阶段：IM 再次发消息（问题发生）

```
IM message arrives → IMCoworkHandler.processMessage()
  → getOrCreateCoworkSession()
    → existing mapping 仍存在 ✅ (stop 不清理 IM mapping)
    → session 仍存在 ✅
    → return existing coworkSessionId
  → createAccumulatorPromise(sessionId) ← 新的累积器
  → isActive = coworkRuntime.isSessionActive(sessionId) = false ← session 已停止
  → coworkRuntime.startSession(sessionId, ...) ← 尝试启动新 turn
```

**接下来的行为取决于使用的引擎：**

##### yd_cowork 引擎 (CoworkRunner)：

```
CoworkRunner.startSession():
  this.stoppedSessions.delete(sessionId) ← 清除停止标记 ✅
  store.updateSession(sessionId, { status: 'running' }) ← DB 更新 ✅
  emit('message', userMessage) ← 发送用户消息事件 ✅
    → Main → IPC → Renderer:
      onStreamMessage:
        dispatch(updateSessionStatus({ sessionId, status: 'running' }))
        → sessions[i].status = 'running' ✅ (列表更新)
        → 🔴 BUG 1: 如果 currentSession.id === sessionId:
            currentSession.status = 'running' ✅
            isStreaming = true ✅
          否则:
            isStreaming 保持之前的值（false）❌
        dispatch(addMessage({ sessionId, message }))
        → 🔴 BUG 2: 如果 currentSession.id === sessionId:
            currentSession.messages.push(message) ✅
          否则:
            消息不追加到 currentSession.messages ❌
            只更新 sessions[i].updatedAt ⚠️
```

##### openclaw 引擎 (OpenClawRuntimeAdapter)：

```
OpenClawRuntimeAdapter → runTurn():
  this.stoppedSessions.delete(sessionId)         ← 清除冷却期 ✅
  this.manuallyStoppedSessions.delete(sessionId)  ← 清除手动停止标记 ✅
  → 正常启动 turn ✅
  → 后续事件流与 yd_cowork 相同的 Renderer 端问题
```

**注意：如果 IM 消息在停止后 10 秒内到达（OpenClaw 冷却期内），`ensureActiveTurn` 会被抑制，但由于 IM 走的是 `startSession` / `continueSession` 路径（不走 `ensureActiveTurn`），所以冷却期对 IM 消息的 `processMessageInternal` 流程无影响。**

---

## Bug 1 详解：`isStreaming` 不更新

### 根因代码

```typescript
// src/renderer/store/slices/coworkSlice.ts:184-201
updateSessionStatus(state, action) {
  const { sessionId, status } = action.payload;

  // 更新 sessions 列表 ← 总是生效 ✅
  const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
  if (sessionIndex !== -1) {
    state.sessions[sessionIndex].status = status;
  }

  // 🔴 仅当 currentSession.id === sessionId 时才更新 isStreaming
  if (state.currentSession?.id === sessionId) {
    state.currentSession.status = status;
    state.isStreaming = status === 'running';  // ← 核心问题
  }
}
```

### 场景复现

1. 用户在 UI 查看 IM 对话 A（`currentSession.id === A`）
2. 用户停止对话 A → `isStreaming = false`, `status = 'idle'`
3. IM 发来新消息到对话 A
4. `onStreamMessage` 触发 `updateSessionStatus({ sessionId: A, status: 'running' })`
5. 因为 `currentSession.id === A` → `isStreaming = true` ✅ **此场景 OK**

**但如果用户在停止后切换到了其他对话 B：**

1. 用户查看对话 B（`currentSession.id === B`）
2. IM 发来新消息到对话 A
3. `updateSessionStatus({ sessionId: A, status: 'running' })`
4. `currentSession.id === B ≠ A` → **`isStreaming` 不变** ❌
5. 用户切回对话 A → `loadSession(A)` → `setStreaming(session.status === 'running')`
6. **此时如果 session 还在 running，isStreaming 恢复 ✅**
7. **但如果 session 已 complete，isStreaming = false，但消息已更新 — 用户错过了运行中状态 ⚠️**

**更关键的场景 — 用户停止后仍在该对话页面：**

1. 用户查看对话 A，停止 → `isStreaming = false`
2. IM 发来新消息 → `startSession` 调用
3. `onStreamMessage` 触发，`currentSession.id === A` → `isStreaming = true` ✅ **理论上 OK**
4. 但！`stopSession` 是 async 的，UI 先 dispatch `setStreaming(false)` 和 `updateSessionStatus({status:'idle'})`
5. 此后 IM 的 `startSession` 异步触发事件可能在同一个或下一个 tick
6. 如果 `startSession` 抛出异常（例如 session 仍在被清理中），`onSessionStartError` 会 reject accumulator 但不会更新 UI 状态

### 实际最可能触发的场景

用户在 UI 停止 IM 对话后**不离开该页面**。此时：

- `isStreaming = false` ✅
- IM 来新消息 → `startSession` 成功启动
- `emit('message', userMessage)` → Renderer `onStreamMessage` 触发
- `updateSessionStatus({status:'running'})` → `currentSession.id === sessionId` → `isStreaming = true` ✅
- **运行中状态应该正常显示** ← 理论上这里 OK

**那为什么用户还是看不到运行中？** 继续分析...

---

## Bug 2 详解：消息不实时显示

### 根因代码

```typescript
// src/renderer/store/slices/coworkSlice.ts:211-229
addMessage(state, action) {
  const { sessionId, message } = action.payload;

  // 🔴 只有当前显示的 session 才追加消息到 messages 数组
  if (state.currentSession?.id === sessionId) {
    const exists = state.currentSession.messages.some((item) => item.id === message.id);
    if (!exists) {
      state.currentSession.messages.push(message);
    }
  }

  // sessions 列表只更新时间戳
  const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
  if (sessionIndex !== -1) {
    state.sessions[sessionIndex].updatedAt = message.timestamp;
  }

  markSessionUnread(state, sessionId);
}
```

### 关键影响

如果用户**正在查看该 IM 对话**（`currentSession.id === sessionId`），消息会正常追加到 `currentSession.messages`，UI 实时更新。

如果用户**不在该对话页面**，消息只更新 `sessions[]` 的 `updatedAt`，不追加到 `currentSession.messages`。切回后 `loadSession` 从数据库重新加载完整消息列表。

**这是设计如此（by design）—— 非当前 session 的消息只在后台累积，切换回来才加载。**

---

## 真正的 Bug：`stopSession` 后 `complete` 事件与 `isStreaming` 状态不一致

经过以上全部分析，问题的核心定位如下：

### 场景重现路径

```
1. IM 发消息到对话 A → A 开始运行 → UI 显示 running ✅
2. 用户手动停止对话 A:
   - Main: stopSession → status = 'idle', ⚠️ 不 emit('complete')
   - Renderer: dispatch(setStreaming(false)) + dispatch(updateSessionStatus({status:'idle'}))
   - IMCoworkHandler: accumulator 仍然存在！❌ 没有被 cleanup
     → accumulator 等待 'complete' 事件来 resolve，但 stop 不发 'complete'
     → 5 分钟后 accumulator 超时
3. IM 发送新消息:
   - IMCoworkHandler.processMessage():
     → getOrCreateCoworkSession() → 返回已有 session ✅
     → createAccumulatorPromise(sessionId):
       🔴 发现已有旧 accumulator（stopSession 未清理的！）
       → 清理旧 accumulator，reject 旧 promise（Error: 'Replaced by a newer IM request'）
       → 创建新 accumulator ✅
     → isActive = false (session 已停止)
     → startSession(sessionId, prompt, ...)
       → 引擎接受，开始运行 ✅
     → 返回新的 responsePromise
4. 运行过程中:
   - emit('message') → Renderer onStreamMessage → updateSessionStatus({status:'running'})
     → 如果 currentSession.id === sessionId: isStreaming = true ✅
   - emit('complete') → Renderer onStreamComplete → updateSessionStatus({status:'completed'})
     → 如果 currentSession.id === sessionId: isStreaming = false ✅
   - IMCoworkHandler.handleComplete() → resolve accumulator → IM 回复 ✅
```

**等等 — 按上面分析，如果用户一直停留在该对话页面，流程应该是正常的？**

### 关键发现：竞态条件

再仔细看 `stopSession` 的时序：

```
T0: 用户点击 Stop
T1: Renderer: await cowork.stopSession(sessionId) → IPC 到 Main
T2: Main: CoworkRunner.stopSession()
    - stoppedSessions.add(sessionId)
    - abortController.abort()
    - activeSessions.delete(sessionId)
    - store.updateSession(sessionId, {status: 'idle'})
    - ⚠️ 不 emit 'complete'
T3: IPC 返回 { success: true }
T4: Renderer: dispatch(setStreaming(false))
T5: Renderer: dispatch(updateSessionStatus({sessionId, status: 'idle'}))
```

```
T6: IM 新消息到达 Main Process
T7: IMCoworkHandler.processMessage()
T8: createAccumulatorPromise(sessionId) — 创建新 accumulator
T9: isActive = false
T10: coworkRuntime.startSession(sessionId, prompt)
     → stoppedSessions.delete(sessionId)
     → store.updateSession(sessionId, {status: 'running'})
     → emit('message', userMessage)
T11: Main IPC forward → Renderer: onStreamMessage
     → dispatch(updateSessionStatus({sessionId, status: 'running'}))
     → 如果此时 currentSession.id === sessionId:
         isStreaming = true ✅
         currentSession.messages.push(message) ✅
```

**理论上这应该工作正常。** 那为什么用户报告看不到 running 状态？

### 🔴 根因定位：`stopSession` 后 `stoppedSessions` 标记导致运行中的事件被忽略

回到 `CoworkRunner.startSession` 的完整实现（line 1427-1510）：

```typescript
async startSession(sessionId, prompt, options) {
  this.stoppedSessions.delete(sessionId);  // 清除停止标记
  // ... setup ...
  this.activeSessions.set(sessionId, activeSession);
  // ... 调用 runClaudeCodeLocal() ...
}
```

而 `runClaudeCodeLocal` 内部（line 1678-1686）：

```typescript
private async runClaudeCodeLocal(activeSession, prompt, cwd, systemPrompt) {
  const { sessionId, abortController } = activeSession;
  if (this.isSessionStopRequested(sessionId, activeSession)) {
    // 🔴 如果 stopSession 的清理还未完成，这里可能直接返回
    this.store.updateSession(sessionId, { status: 'idle' });
    this.activeSessions.delete(sessionId);
    return;
  }
  // ...正常流程
}
```

`isSessionStopRequested` 检查 `stoppedSessions.has(sessionId)` 和 `abortController.signal.aborted`。

在正常流程中，`startSession` 第一行就 `stoppedSessions.delete(sessionId)`，所以 `isSessionStopRequested` 不会命中 stoppedSessions 检查。但 `abortController` 是**新创建的**，所以也不会命中。

**所以 yd_cowork (CoworkRunner) 引擎应该是正常的。**

### 🔴🔴 根因再聚焦：OpenClaw 引擎的 `manuallyStoppedSessions`

```typescript
// openclawRuntimeAdapter.ts:1034-1058
stopSession(sessionId) {
  const turn = this.activeTurns.get(sessionId);
  if (turn) {
    turn.stopRequested = true;
    this.manuallyStoppedSessions.add(sessionId);  // 🔴 加入永久标记
    // ... abort gateway
  }
  this.stoppedSessions.set(sessionId, Date.now()); // 10s 冷却期
  this.cleanupSessionTurn(sessionId);
  this.store.updateSession(sessionId, { status: 'idle' });
  this.resolveTurn(sessionId);
}
```

```typescript
// openclawRuntimeAdapter.ts:1130-1147
private async runTurn(sessionId, prompt, options) {
  // ...
  this.stoppedSessions.delete(sessionId);          // 清除冷却期 ✅
  this.manuallyStoppedSessions.delete(sessionId);   // 清除手动停止标记 ✅
  // ...正常执行
}
```

OpenClaw 引擎在 `runTurn` 中同时清除了两个标记，**所以后续 IM 消息触发的 `startSession/continueSession` 也应该正常。**

---

## 重新审视：渠道对话（Channel Session）的特殊路径

**以上分析都基于 `IMCoworkHandler.processMessage()` → `coworkRuntime.startSession()` 的路径。但如果使用 OpenClaw 引擎，IM 渠道消息可能走一条完全不同的路径 — Channel Session Sync。**

OpenClaw 引擎中，IM 平台（POPO、Telegram 等）的消息可能通过 Gateway 的 channel session 机制到达，而不是通过 `IMCoworkHandler`：

```typescript
// openclawRuntimeAdapter.ts:3745-3753
private ensureActiveTurn(sessionId, sessionKey, runId) {
  if (this.activeTurns.has(sessionId)) return;
  // 🔴🔴 关键：手动停止后的会话在此被永久抑制
  if (this.isSessionInStopCooldown(sessionId) || this.manuallyStoppedSessions.has(sessionId)) {
    console.log('[Debug:ensureActiveTurn] suppressed — session was manually stopped');
    return;  // ← 直接返回，不创建 ActiveTurn
  }
  // ... 创建新的 ActiveTurn
}
```

**这就是根因！** 当 OpenClaw 引擎处理渠道对话时：

1. 用户手动停止 → `manuallyStoppedSessions.add(sessionId)`
2. Gateway 收到新的 IM 消息 → channel event 到达
3. `ensureActiveTurn` 检测到 `manuallyStoppedSessions.has(sessionId)` → **直接返回**
4. **新消息的 turn 不被创建，消息被静默忽略**

但 `manuallyStoppedSessions` 只在以下情况被清除：
- `runTurn()` 被调用时（line 1147）— 但如果 channel event 走的是 `ensureActiveTurn` 而不是 `runTurn`，就不会被清除
- `onSessionDeleted()` 被调用时（line 3722）

**这意味着：如果 IM 消息通过 OpenClaw Gateway 的 channel session 机制到达（而不是通过 IMCoworkHandler），手动停止后的会话将永久忽略新消息。**

### `IMCoworkHandler` 路径 vs Channel Session 路径

| 特性 | IMCoworkHandler 路径 | Channel Session 路径 |
|------|---------------------|---------------------|
| 触发方式 | IM Gateway → IMCoworkHandler → coworkRuntime.startSession() | OpenClaw Gateway channel event → ensureActiveTurn() |
| 调用 runTurn | ✅ 通过 startSession/continueSession | ❌ 通过 ensureActiveTurn (不调用 runTurn) |
| 清除 manuallyStoppedSessions | ✅ runTurn 第一行清除 | ❌ 不清除 |
| 停止后行为 | 正常（下次 IM 消息仍可启动） | 🔴 永久抑制 |

---

## 🔴 最终定位

### 根因 1（主要）：`manuallyStoppedSessions` 在 Channel Session 路径下永久抑制新消息

**文件**：`src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

**位置**：`ensureActiveTurn` 方法（line 3745-3753）

**问题**：`manuallyStoppedSessions` 是一个 `Set<string>`，只在 `runTurn()` 和 `onSessionDeleted()` 中被清除。通过 channel session event 到达的消息走 `ensureActiveTurn` 路径，不调用 `runTurn`，因此 `manuallyStoppedSessions` 永远不会被清除，导致该 session 的所有后续 channel event 被永久忽略。

**影响**：
- 运行中状态不显示：新消息的 turn 不被创建，不 emit 'message' 事件，Renderer 不更新 `isStreaming`
- 消息不实时显示：没有 turn 就没有 stream 事件，消息不会被 IPC 转发到 Renderer

### 根因 2（次要）：Renderer `addMessage` 不更新非当前 session 的消息列表

**文件**：`src/renderer/store/slices/coworkSlice.ts`

**位置**：`addMessage` reducer（line 211-229）

**问题**：如果 `currentSession.id !== sessionId`，新消息不追加到 `currentSession.messages`。这是设计如此（避免跨 session 数据污染），但导致切换回该 session 前看不到消息。

**影响**：即使根因 1 修复后，如果用户不在该对话页面，消息仍需要切换对话才能看到（但这属于已知的设计行为，不是 bug）。

### 根因 3（辅助）：`stopSession` 不触发 `complete` 事件导致 IMCoworkHandler 的 accumulator 悬挂

**文件**：`src/main/libs/coworkRunner.ts`（line 1624-1635）和 `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`（line 1034-1058）

**问题**：`stopSession` 不 emit `complete` 事件，但 `IMCoworkHandler.handleComplete` 是唯一清理 accumulator 并 resolve IM 回复的入口。Stop 后 accumulator 悬挂直到 5 分钟超时。

**影响**：IM 端在用户手动停止后需等 5 分钟才收到超时错误回复，而不是立即收到"已停止"反馈。

---

## 修复建议

### Fix 1：`ensureActiveTurn` 中增加 channel session 的清除逻辑（必须修复）

```typescript
// openclawRuntimeAdapter.ts — ensureActiveTurn
private ensureActiveTurn(sessionId: string, sessionKey: string, runId: string): void {
  if (this.activeTurns.has(sessionId)) return;

  if (this.isSessionInStopCooldown(sessionId)) {
    // 10s 冷却期内抑制，合理
    console.log('[Debug:ensureActiveTurn] suppressed — in stop cooldown');
    return;
  }

  // 🔧 FIX: 冷却期后清除手动停止标记，允许新消息恢复 turn
  if (this.manuallyStoppedSessions.has(sessionId)) {
    console.log('[Debug:ensureActiveTurn] clearing manuallyStoppedSessions for channel re-activation');
    this.manuallyStoppedSessions.delete(sessionId);
  }

  // ... 正常创建 ActiveTurn
}
```

或者更保守的方案 — 在 `stopSession` 中增加超时自动清理：

```typescript
stopSession(sessionId: string): void {
  // ... existing logic ...
  this.manuallyStoppedSessions.add(sessionId);
  this.stoppedSessions.set(sessionId, Date.now());

  // 🔧 FIX: 冷却期后自动清除手动停止标记
  setTimeout(() => {
    this.manuallyStoppedSessions.delete(sessionId);
  }, OpenClawRuntimeAdapter.STOP_COOLDOWN_MS);
}
```

### Fix 2：`stopSession` 通知 IMCoworkHandler 清理 accumulator（建议修复）

```typescript
// 方案 A: stopSession 时 emit 一个专门的事件
stopSession(sessionId: string): void {
  // ... existing logic ...
  this.emit('sessionStopped', sessionId);  // 🔧 新事件
}

// IMCoworkHandler 监听
this.coworkRuntime.on('sessionStopped', (sessionId: string) => {
  const accumulator = this.messageAccumulators.get(sessionId);
  if (accumulator) {
    this.cleanupAccumulator(sessionId);
    // 回复 IM 端告知已停止
    const partialReply = this.formatReply(sessionId, accumulator.messages);
    accumulator.resolve?.(partialReply || '任务已手动停止。');
  }
});
```

```typescript
// 方案 B: stopSession 直接 emit 'complete' (更简单但语义不够精确)
stopSession(sessionId: string): void {
  // ... existing logic ...
  this.emit('complete', sessionId, null);
}
```

### Fix 3：Renderer `updateSessionStatus` 在非当前 session 时也更新 `isStreaming`（可选优化）

当前设计是 `isStreaming` 只跟踪当前查看的 session。如果需要全局显示任意 session 的运行状态，需要改为 per-session 的 streaming 状态：

```typescript
// 当前设计（全局单一 isStreaming）：
state.isStreaming = status === 'running'; // 只在 currentSession 匹配时

// 改进方案（per-session streaming 状态）：
// 已在 sessions[].status 中体现，UI 组件可直接使用 session.status === 'running'
// 而不是依赖全局 isStreaming
```

---

## 涉及文件清单

| 文件 | 角色 | 相关代码 |
|------|------|---------|
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | OpenClaw 运行时 | `stopSession` (L1034), `ensureActiveTurn` (L3745), `manuallyStoppedSessions` (L596), `runTurn` (L1130) |
| `src/main/libs/coworkRunner.ts` | 内置运行时 | `stopSession` (L1624), `startSession` (L1427), `stoppedSessions` (L268) |
| `src/main/libs/agentEngine/coworkEngineRouter.ts` | 引擎路由 | `stopSession` (L77), `bindRuntimeEvents` (L154) |
| `src/main/im/imCoworkHandler.ts` | IM 消息处理 | `processMessage` (L152), `handleComplete` (L832), `createAccumulatorPromise` (L585) |
| `src/main/main.ts` | IPC 处理 + 事件转发 | `cowork:session:stop` (L2638), `bindCoworkRuntimeForwarder` (L1033) |
| `src/renderer/services/cowork.ts` | 前端 Cowork 服务 | `stopSession` (L336), `onStreamMessage` (L78), `onStreamComplete` (L142) |
| `src/renderer/store/slices/coworkSlice.ts` | Redux 状态管理 | `updateSessionStatus` (L184), `addMessage` (L211), `setStreaming` (L249) |

---

## 验证方法

### 验证根因 1

1. 启动应用，配置 OpenClaw 引擎
2. 从 IM（如 Telegram）发消息创建对话
3. 等待对话完成，确认 UI 正常显示
4. 在 UI 端点击停止按钮
5. 从 IM 再次发消息
6. 检查控制台日志：如果出现 `[Debug:ensureActiveTurn] suppressed — session was manually stopped`，则确认根因 1

### 验证修复

1. 应用 Fix 1 后重复上述步骤
2. 确认不再出现 suppressed 日志
3. 确认 UI 端正确显示 running 状态
4. 确认消息实时显示
