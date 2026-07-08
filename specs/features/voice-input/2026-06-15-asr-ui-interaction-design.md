# 实时听写交互调整设计文档

## 1. 概述

### 1.1 背景

实时语音输入已经接入 cowork 输入框，但现有实现仍以单次录音为主：录音按钮在任务运行中被禁用，发送时不会自动结束听写，额度耗尽状态也没有在前端形成统一记忆。

本次调整基于 `C:\Users\yangwn\Desktop\zhiyun-asr\ui\实时语音的功能-交互方案.pdf`，目标是在不新增额度查询接口的前提下补齐听写按钮、额度提示、录音中交互和发送联动。

### 1.2 目标

- 登录态沿用既有认证逻辑，未登录用户点击听写时提示登录。
- 订阅权益按 HTML Share 的口径判断：`auth.quota.subscriptionStatus === 'active'` 表示订阅用户。
- 不预查询 ASR 额度。登录用户初始都可以点击听写，实际请求 ASR 后再记录服务端返回的额度状态。
- 额度状态仅在 Redux 内存中维护，不持久化。
- 跨日不使用定时器，仅在用户进入或使用听写能力时做懒重置。
- 任务运行中不禁用听写。
- 录音中点击发送时，自动结束听写并发送最终内容。

## 2. 用户场景

### 场景 1: 未登录用户点击听写

**Given** 用户未登录
**When** 点击听写按钮
**Then** 弹出登录/权益提示，不发起 ASR 请求。

### 场景 2: 登录用户首次点击听写

**Given** 用户已登录，ASR 额度状态未知
**When** 点击听写按钮
**Then** 发起实时 ASR 会话请求；成功后记录 `usedSecondsToday`、`remainingSecondsToday`、`limitSecondsToday`。

### 场景 3: ASR 额度已用完

**Given** 用户点击听写后服务端返回 `DailyLimitExceeded`，或录音中服务端报告额度耗尽
**When** 前端收到错误
**Then** 记录当天 ASR 状态为 `exhausted`，展示额度用完弹窗，按钮呈禁用样式但仍可点击再次展示提示。

### 场景 4: 应用跨日保持打开

**Given** 前一天 ASR 状态为 `exhausted`
**When** 用户第二天再次进入或点击听写入口
**Then** 前端发现本地日期变化，懒重置为 `unknown`，允许用户再次点击并由服务端校准真实额度。

### 场景 5: 录音中点击发送

**Given** 用户正在听写，输入框内已有实时识别内容
**When** 用户直接点击发送按钮
**Then** 前端先结束听写并等待最终识别结果，再按现有提交流程发送内容。

## 3. 功能需求

### FR-1: ASR 额度状态

新增内存级 Redux slice，记录：

- `status`: `unknown | available | exhausted`
- `dayKey`: 本地自然日，格式 `YYYY-MM-DD`
- `usedSecondsToday`
- `remainingSecondsToday`
- `limitSecondsToday`
- `lastUpdatedAt`
- `lastErrorCode`

### FR-2: 懒重置

在读取或使用 ASR 额度状态前检查 `dayKey`。如果 `dayKey` 不是当天，则重置为 `unknown`。

触发点：

- cowork 输入框挂载或登录态变化时。
- 用户点击听写按钮前。
- 用户点击发送且当前正在听写前。

### FR-3: 权益文案

免费和订阅用户的文案按 `subscriptionStatus === 'active'` 区分：

- 免费用户：展示每日 20 分钟相关提示，并引导升级订阅。
- 订阅用户：展示每日 200 分钟相关提示，仅告知额度已用完。

前端不根据本地配置推导额度数值；若 ASR session 返回 `limitSecondsToday`，优先使用服务端返回值展示。

### FR-4: 任务运行中的听写

听写按钮不再因为 cowork session 正在运行而禁用。录音中仍禁用键盘输入和附件/模型等输入区操作，避免识别过程被手动编辑打断。

### FR-5: 发送联动

当录音中点击发送：

1. 调用停止听写并等待最终识别。
2. 将最终识别文本写入 draft。
3. 若最终内容非空，继续执行现有提交。
4. 若识别失败或内容为空，展示错误并停止提交。

### FR-6: 录音态 UI 与文案

听写按钮与录音态输入框按原型收敛：

- 常规态听写按钮悬停文案为“点击开始听写”，英文为 `Click to start dictation`。
- 录音态和识别中态均使用圆形按钮外圈加中间方形停止图标，不展示麦克风中间态。
- 停止听写按钮悬停文案为“点击结束听写”，英文为 `Click to end dictation`。
- 未输入内容且正在录音时，输入框 placeholder 隐藏；波形动画和计时与已有输入状态共用输入框底部操作区中线位置，tips 独立显示在波形动画上方并接近输入区视觉中心。
- 已有输入内容且正在录音时，不展示 tips，仅在输入框底部操作区中线位置展示波形动画和计时。
- 录音态隐藏输入框内部左侧工具入口和右侧模型选择，保留停止听写、发送按钮，以及输入框下方的 project / Agent 上下文行。
- 继续对话中如果任务仍在执行，录音态右侧第二个按钮仍展示发送箭头禁用态，不展示停止任务按钮，避免与停止听写按钮并排混淆。

## 4. 实现方案

### 4.1 Redux

新增 `src/renderer/store/slices/asrQuotaSlice.ts`，并在 `src/renderer/store/index.ts` 注册。

核心 action：

- `ensureAsrQuotaFreshForDay(dayKey)`
- `updateAsrQuotaFromSession({ dayKey, data })`
- `markAsrQuotaExhausted({ dayKey, errorCode })`
- `resetAsrQuota()`

### 4.2 语音输入 hook

`useCoworkVoiceInput` 负责：

- 启动成功后从 ASR session 数据写入 quota。
- ASR 返回 `DailyLimitExceeded` 时写入 exhausted。
- 暴露 `stopVoiceRecordingAndRecognize()`，供发送流程自动结束听写。
- 不再用 `isStreaming` 阻止听写入口。

### 4.3 输入框 UI

`CoworkPromptInput` 负责：

- 按登录态、ASR quota 状态和录音状态渲染按钮样式。
- 对 `exhausted` 状态点击时弹额度提示，而不是真正禁用按钮。
- 发送前如果正在录音，先停止听写再提交。
- 录音时禁用键盘输入和其他工具按钮。
- 录音态仅条件隐藏工具入口和模型选择，不清空附件、技能、模型选择、草稿等状态；停止听写后恢复原 UI。
- 未输入内容的录音态由底部操作区承载波形和计时，tips 作为附属文案显示在波形上方；已有输入内容时仍由同一底部操作区位置承载波形和计时。
- 录音态下发送位固定为发送箭头；当 cowork session 正在执行时保持禁用态，不切换为停止任务按钮。

### 4.4 语音按钮与录音状态组件

`VoiceInputButton` 负责：

- 常规态展示麦克风图标和开始听写文案。
- 录音态与识别中态都展示停止方块图标，避免创建 ASR session 期间出现短暂麦克风中间态。
- 录音态使用结束听写文案。

`VoiceInputRecordingStatus` 负责：

- 根据调用方传入的 `showHint` 决定是否展示 tips。
- 统一渲染波形动画和计时，保证未输入/已输入两种录音态的波形和计时位置一致；tips 不参与波形和计时的垂直定位。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 应用跨日但页面一直打开 | 不使用定时器，下一次挂载/点击/发送前懒重置 |
| 本地日期和服务端重置时间不一致 | 前端只从 exhausted 回到 unknown，最终仍由服务端 ASR 请求决定真实额度 |
| 额度未知但实际已用完 | 用户可点击，服务端返回错误后弹窗并记录 exhausted |
| 录音中任务运行结束或开始 | 不影响录音；发送按钮仍按任务状态处理 |
| 录音中识别失败后点击发送 | 停止提交，展示 ASR 错误 |
| 录音中隐藏的工具入口已有状态 | 仅隐藏入口控件，不清空已有附件、技能、模型或 draft 状态 |
| 创建 ASR session 期间状态短暂切换 | 按钮仍展示停止方块，避免出现麦克风中间态 |
| 继续对话录音时任务仍在执行 | 输入框内不展示停止任务按钮，只保留停止听写按钮和禁用发送箭头 |

## 6. 涉及文件

- `src/renderer/store/slices/asrQuotaSlice.ts`
- `src/renderer/store/index.ts`
- `src/renderer/components/cowork/CoworkPromptInput.tsx`
- `src/renderer/components/cowork/voiceInput/useCoworkVoiceInput.ts`
- `src/renderer/components/cowork/voiceInput/VoiceInputButton.tsx`
- `src/renderer/components/cowork/voiceInput/VoiceInputRecordingStatus.tsx`
- `src/renderer/services/voiceInput/realtimeAsrClient.ts`
- `src/renderer/services/i18n.ts`

## 7. 验收标准

- 未登录点击听写展示登录提示。
- 登录用户初始可以点击听写，不要求预先知道额度。
- ASR 返回额度用完后，按钮进入无时长样式，再次点击展示额度弹窗。
- 第二天再次点击时，前端状态懒重置为可点击的 unknown。
- 任务运行中仍可点击听写。
- 录音中点击发送会先结束听写再发送。
- 听写按钮常规态 hover 为“点击开始听写”，录音态 hover 为“点击结束听写”。
- 点击开始听写后不出现麦克风中间态，录音态按钮始终为圆形外圈加中间方形停止图标。
- 未输入内容录音时隐藏 placeholder 和输入框内部工具入口，波形和计时与已有输入状态保持同一底部操作区中线位置，tips 显示在波形上方并接近输入区视觉中心。
- 已有输入内容录音时隐藏 tips，仅在底部操作区中线位置展示波形和计时。
- 录音态隐藏左侧工具入口和右侧模型选择，但保留停止听写、发送按钮和 project / Agent 上下文行。
- 继续对话且任务执行中开始听写时，右侧不会出现两个停止方块；第二个按钮为禁用发送箭头。
- 新增文案均包含中文和英文翻译。
