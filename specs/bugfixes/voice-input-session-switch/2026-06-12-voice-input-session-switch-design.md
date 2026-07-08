# 语音输入切换会话录音串写修复设计文档

## 1. 概述

### 1.1 问题

测试反馈：用户在 Cowork 对话 A 中点击语音输入按钮开始录音后，切换到对话 B，录音不会自动停止。随后用户在对话 B 中点击停止录音按钮，识别出的文字会展示在对话 B 的输入框中，而不是录音开始时所在的对话 A。

该问题会造成两个明显体验风险：

| 操作 | 当前行为 | 期望行为 |
|------|---------|---------|
| 录音中切换对话 | 麦克风继续录音，按钮状态随当前输入框展示 | 切换对话时立即停止并取消本次录音 |
| 在新对话点击停止 | 识别文本写入当前对话草稿 | 不允许录音结果串写到其他对话 |
| 录音异步回调晚到 | 可能使用最新 `draftKey` 更新输入框 | 旧录音回调必须被丢弃或只写回原归属 |

### 1.2 根因

语音输入状态目前维护在 `useCoworkVoiceInput()` hook 内部，文本回写依赖当前渲染时传入的 `draftKey`、`value` 和 `setValue`。

**关键代码路径**：

```typescript
const draftKey = sessionId || '__home__';

const {
  handleVoiceInput,
  isVoiceRecording,
  isVoiceRecognizing,
  recordingElapsedSeconds,
} = useCoworkVoiceInput({
  draftKey,
  value,
  setValue,
  textareaRef,
  minHeight,
  maxHeight,
  isLoggedIn,
  disabled,
  isStreaming,
});
```

`draftKey` 会随着当前会话切换而变化。录音开始时创建的 `voiceRecordingRef` 仍保留在 hook 中，但停止录音和识别结果回写函数会使用最新闭包中的 `draftKey`。因此，用户从对话 A 切到对话 B 后，后续停止录音会将识别结果写入 B 的草稿。

实时 ASR 模式还存在额外风险：`onText` 是 WebSocket 滚动回调。如果切换对话后旧实时会话仍未取消，后续滚动识别文本会继续调用当前输入框的 `setPromptValue()`，进一步扩大串写窗口。

## 2. 用户场景

### 场景 1: 录音中切换到另一条已有对话

**Given** 用户在对话 A 中点击语音输入按钮并开始录音
**When** 用户从侧边栏切换到对话 B
**Then** 应用立即取消对话 A 的本次录音，释放麦克风，并且不向对话 B 写入任何识别文本

### 场景 2: 录音中切换到首页输入框

**Given** 用户在某个对话中正在录音
**When** 用户切换到无 `sessionId` 的首页输入框
**Then** 当前录音被取消，首页草稿不接收旧对话的识别文本

### 场景 3: 切换后旧实时 ASR 回调晚到

**Given** 用户使用实时语音输入，旧实时 ASR session 已经开始返回滚动文本
**When** 用户切换对话并触发录音取消
**Then** 旧 session 的 `onText` 或 `stop()` 结果如果晚到，必须被忽略，不得覆盖当前输入框

### 场景 4: 在原对话正常停止录音

**Given** 用户在对话 A 中开始录音且未切换对话
**When** 用户再次点击语音输入按钮停止录音
**Then** 识别文本按原有逻辑写入对话 A 的草稿

## 3. 功能需求

### FR-1: 录音归属必须绑定到开始录音时的 draftKey

每次开始语音输入时，必须记录本次录音所属的 `draftKey`。后续停止、识别结果回写、实时 ASR 滚动回调都不能隐式使用切换后的当前 `draftKey`。

### FR-2: 切换输入上下文时取消当前录音

当 `draftKey` 变化时，如果语音输入处于启动中、录音中或识别中的可取消阶段，应立即取消当前录音会话并重置语音输入状态。取消路径不触发 ASR 识别，不写入任何草稿文本。

### FR-3: 异步回调必须具备录音代际校验

语音输入需要记录当前录音代际或请求 ID。取消、切换会话、重新开始录音时递增代际。任何旧代际的 `onText`、`stop()`、`recognizeVoiceInput()` 返回结果都必须被忽略。

### FR-4: 停止按钮不能误写入当前会话

点击停止录音时，如果当前 `draftKey` 已经不是录音开始时的归属，应优先取消旧录音并忽略结果，而不是按当前输入框执行停止识别和回写。

## 4. 实现方案

### 4.1 在 hook 中记录录音归属和代际

**位置**：`src/renderer/components/cowork/voiceInput/useCoworkVoiceInput.ts`

新增两个 ref：

```typescript
const activeVoiceDraftKeyRef = useRef<string | null>(null);
const voiceInputGenerationRef = useRef(0);
```

开始录音时写入：

```typescript
const generation = voiceInputGenerationRef.current + 1;
voiceInputGenerationRef.current = generation;
activeVoiceDraftKeyRef.current = draftKey;
```

后续异步路径使用 `generation` 判断当前回调是否仍有效：

```typescript
if (generation !== voiceInputGenerationRef.current) return;
```

该保护覆盖：

- 实时 ASR `onText`
- 实时 ASR `onError`
- `stopVoiceRecordingAndRecognize()` 中的 `session.stop()`
- 短 ASR `recognizeVoiceInput()`
- 自动停止计时器触发的停止识别

### 4.2 抽出可复用的取消函数

在 `useCoworkVoiceInput()` 内新增 `cancelActiveVoiceInput()`：

```typescript
const cancelActiveVoiceInput = useCallback(() => {
  voiceInputGenerationRef.current += 1;
  voiceInputStartingRef.current = false;
  clearVoiceAutoStopTimer();
  voiceRecordingRef.current?.session.cancel();
  voiceRecordingRef.current = null;
  voiceRecordingStartedAtRef.current = null;
  voiceRecordingMaxMsRef.current = VOICE_INPUT_MAX_RECORDING_MS;
  realtimeVoiceBaseValueRef.current = null;
  activeVoiceDraftKeyRef.current = null;
  setVoiceInputState(VoiceInputState.Idle);
  setRecordingElapsedSeconds(0);
}, [clearVoiceAutoStopTimer]);
```

该函数只做本地取消和状态清理，不调用 `stop()`，不触发识别请求。

### 4.3 监听 draftKey 变化并取消旧录音

`draftKey` 变化意味着输入上下文已经切换。此时应立即取消旧录音：

```typescript
useEffect(() => {
  if (!activeVoiceDraftKeyRef.current) return;
  if (activeVoiceDraftKeyRef.current === draftKey) return;
  cancelActiveVoiceInput();
}, [cancelActiveVoiceInput, draftKey]);
```

这样切换会话时麦克风会被释放，旧实时 ASR session 会被取消，旧短录音 buffer 也会被丢弃。

### 4.4 文本回写使用显式 targetDraftKey

当前 `setPromptValue()` 隐式使用 hook 最新 `draftKey`。为避免串写，识别结果回写应接收明确的目标草稿 key：

```typescript
const setPromptValue = useCallback((targetDraftKey: string, nextValue: string) => {
  if (targetDraftKey !== draftKey) {
    dispatch(setDraftPrompt({ sessionId: targetDraftKey, draft: nextValue }));
    return;
  }

  setValue(nextValue);
  valueRef.current = nextValue;
  dispatch(setDraftPrompt({ sessionId: targetDraftKey, draft: nextValue }));
  // 当前可见输入框才执行 focus、height 和 selection 更新
}, [dispatch, draftKey, maxHeight, minHeight, setValue, textareaRef]);
```

本次修复的产品策略是“切换即取消”，因此正常情况下切换后不会再写回旧草稿。但显式 `targetDraftKey` 能作为第二层保护，避免未来调整为“切换后自动识别并回填原对话”时再次引入串写。

### 4.5 停止流程校验当前归属

`stopVoiceRecordingAndRecognize()` 开始时读取当前录音归属：

```typescript
const targetDraftKey = activeVoiceDraftKeyRef.current;
if (!targetDraftKey || targetDraftKey !== draftKey) {
  cancelActiveVoiceInput();
  return;
}
```

只有用户仍停留在录音开始时的输入上下文，才进入 `stop()` 和识别流程。否则按切换上下文处理，直接取消。

### 4.6 按钮点击逻辑保留停止优先级

**位置**：`src/renderer/components/cowork/CoworkPromptInput.tsx`

当前点击处理在 `disabled || isStreaming` 时直接返回。为避免录音中因为会话状态变化导致停止按钮不可操作，应让“正在录音时点击停止”优先于普通禁用逻辑：

```typescript
const handleVoiceInputClick = useCallback(() => {
  if (isVoiceRecording) {
    void handleVoiceInput();
    return;
  }
  if (disabled || isStreaming) return;
  if (!isLoggedIn) {
    setShowVoiceLoginPrompt(true);
    return;
  }
  void handleVoiceInput();
}, [disabled, handleVoiceInput, isLoggedIn, isStreaming, isVoiceRecording]);
```

`VoiceInputButton` 的 `disabled` 计算也需要允许录音态点击：

```typescript
disabled={!isRecording && (unavailable || isRecognizing)}
```

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 录音中切换会话 | `draftKey` effect 调用取消函数，释放麦克风，不识别 |
| 录音启动中切换会话 | 递增 generation，启动完成后的旧 session 立刻被忽略或取消 |
| 实时 ASR `onText` 晚到 | generation 不匹配，直接返回，不更新草稿 |
| 实时 ASR `onError` 晚到 | generation 不匹配，直接返回，不展示过期错误 |
| 自动停止计时器晚到 | generation 或 active recording 不匹配，不写入当前会话 |
| 用户停留在原会话点击停止 | 保持原行为，识别文本写入当前草稿 |
| 用户未登录点击语音按钮 | 保持原行为，弹出登录提示 |
| 组件卸载 | 复用取消函数清理录音和计时器 |

## 6. 涉及文件

- `src/renderer/components/cowork/voiceInput/useCoworkVoiceInput.ts` — 记录录音归属、generation 校验、切换会话取消录音、显式目标草稿回写
- `src/renderer/components/cowork/voiceInput/VoiceInputButton.tsx` — 允许录音态点击停止，避免被普通 unavailable 状态误禁用
- `src/renderer/components/cowork/CoworkPromptInput.tsx` — 调整语音按钮点击优先级，录音中点击始终进入停止或取消流程

## 7. 验收标准

1. 在对话 A 开始录音后切换到对话 B，麦克风立即停止，B 的输入框不出现 A 的识别文字。
2. 在对话 A 开始录音后切换到首页输入框，首页草稿不出现旧录音文本。
3. 使用实时 ASR 时，切换会话后旧 `onText` 回调不会覆盖当前输入框。
4. 留在同一对话中正常点击停止录音，识别结果仍按原逻辑写入当前草稿。
5. 快速切换会话、自动停止计时器触发、实时 ASR 错误晚到等异步路径不会导致串写或按钮卡死。
6. `npm run build` 通过。
