# 语音输入快速点击并发启动修复设计文档

## 1. 概述

### 1.1 问题

QA 复现实时 ASR 时，快速双击或多次点击语音输入按钮后，端侧会连续创建多个实时识别会话。服务端日志显示同一用户的实时 ASR active session 计数达到 `active=3, max=2`，随后 WebSocket 被服务端以并发超限拒绝，端侧展示“语音识别服务繁忙，请稍后重试”。

### 1.2 根因

语音输入按钮点击后，`handleVoiceInput()` 会异步执行 `startRealtimeVoiceInput()`。在该 Promise 完成前，React 状态仍处于 `Idle`，`voiceRecordingRef` 也尚未写入当前录音会话。用户快速重复点击时，多次点击都会通过状态检查，并发调用实时 ASR session 创建和 WebSocket 建连。

按钮组件此前只设置了 `aria-disabled`，没有设置原生 `disabled` 属性。`aria-disabled` 只提供可访问性语义，不会阻止浏览器继续触发点击事件。

## 2. 用户场景

### 场景 1: 快速双击语音输入按钮

**Given** 用户已登录且语音输入模式为实时识别  
**When** 用户快速双击语音输入按钮  
**Then** 客户端只发起一次实时 ASR 启动流程，不会并发创建多个 WebSocket session

### 场景 2: 实时 ASR 启动中再次点击

**Given** 第一次点击已经进入实时 ASR 初始化流程，但录音会话尚未创建完成  
**When** 用户继续点击语音输入按钮  
**Then** 后续点击被忽略，直到启动成功进入录音态或启动失败回到空闲态

### 场景 3: 未登录点击语音输入按钮

**Given** 用户未登录  
**When** 用户点击语音输入按钮  
**Then** 仍按原有逻辑弹出登录提示，不被原生 disabled 阻断

## 3. 功能需求

### FR-1: 防止启动阶段重入

语音输入启动流程必须具备同步重入保护。第一次点击进入启动流程后，后续点击必须在异步状态更新完成前被拦截。

### FR-2: 启动阶段需要有 UI busy 状态

实时 ASR 初始化期间，按钮应进入不可用状态，避免用户误以为点击未生效。

### FR-3: 失败和卸载时释放启动锁

启动失败、录音出错、组件卸载等路径必须释放启动锁，避免语音输入永久不可用。

## 4. 实现方案

### 4.1 Hook 级同步锁

在 `useCoworkVoiceInput()` 中新增 `voiceInputStartingRef`：

- `handleVoiceInput()` 入口先检查该 ref，若已经启动中则直接返回。
- 通过检查后立即将 ref 置为 `true`，早于任何 `await`。
- 启动成功写入 `voiceRecordingRef` 后，将 ref 置为 `false` 并切换到 `Recording`。
- 启动失败、录音错误回调和组件卸载时，将 ref 置为 `false`。

该方案使用 ref 而不是 React state 作为首层拦截，是因为 ref 的写入同步生效，可以覆盖同一轮事件循环内的快速重复点击。

### 4.2 启动阶段复用 Recognizing 状态

启动流程开始后立即调用 `setVoiceInputState(VoiceInputState.Recognizing)`，让现有按钮状态和交互保护进入 busy 状态。启动成功后切换为 `Recording`，启动失败后回到 `Idle`。

该实现不新增用户可见文案，复用已有“识别中”状态，保持改动范围小。

### 4.3 按钮补原生 disabled

`VoiceInputButton` 在 `unavailable || isRecognizing` 时设置原生 `disabled` 属性。这样在启动中、识别中、禁用或流式输出中，浏览器会直接阻止点击事件。

未登录状态不纳入 `disabled`，以保留原有点击后展示登录提示的行为。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 实时 ASR 创建 session 失败 | catch 分支释放 `voiceInputStartingRef`，状态回到 `Idle`，展示原错误提示 |
| WebSocket 建连后立刻报错 | `onError` 路径清理录音引用、释放启动锁、展示错误提示 |
| 用户启动后正常停止录音 | `voiceRecordingRef` 已存在，后续点击进入原停止识别流程 |
| 组件卸载 | cleanup 中取消当前录音并释放启动锁 |
| 未登录用户点击 | 不设置原生 disabled，继续触发登录提示 |

## 6. 涉及文件

- `src/renderer/components/cowork/voiceInput/useCoworkVoiceInput.ts`
- `src/renderer/components/cowork/voiceInput/VoiceInputButton.tsx`

## 7. 验收标准

1. 快速双击或连续多击语音输入按钮时，端侧最多创建一个实时 ASR session。
2. 启动中按钮不可重复触发启动流程。
3. 启动失败后按钮可恢复再次点击。
4. 未登录点击语音输入按钮仍弹出登录提示。
5. `npm run build` 通过。
