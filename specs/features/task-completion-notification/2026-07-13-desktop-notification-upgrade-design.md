# LobsterAI 桌面通知升级设计文档（完成通知三态 + 等待授权/输入通知）

> 本文档是 `2026-06-08-task-completion-notification-design.md` 的迭代版本。一期的任务完成提醒（系统通知 + Dock 角标 / Windows 任务栏 / 托盘提醒 + 查看清理闭环）已上线，本文在其基础上升级通知设置模型并扩展通知类型。一期已实现且本期不改变的部分（角标、任务栏、托盘、查看清理、通知点击重建窗口等）在本文中仅作声明，细节以一期文档为准。

## 1. 概述

### 1.1 背景

一期任务完成提醒解决了「应用不在前台时任务完成无感知」的问题，但上线后存在三个缺口：

1. **开关粒度不足**。当前是单个 bool 开关（开 = 仅失焦时通知）。多任务并行的用户（应用在前台、正在看会话 A，会话 B 完成）没有任何提示手段，缺少「总是通知」档位。
2. **只覆盖「完成」一类事件**。会话执行中的**等待授权**（权限审批）与**等待输入**（AskUserQuestion 提问）是阻塞性事件：用户不响应，任务就永远卡住。后台会话一旦进入等待，用户完全无感知，比「完成不知道」的代价更高。当前这两类事件不发任何系统通知。
3. **通知不可辨识**。标题正文均为固定文案（`任务已完成` / `有任务已完成，点击查看结果`），多个任务完成时通知内容完全相同，用户无法判断是哪个任务。

竞品参照：对 Codex 桌面版（26.623.81905）通知实现的逆向分析结论——

| 维度 | Codex 设计 |
|------|-----------|
| 完成通知 | 三态下拉：始终 / 仅当应用失焦时（默认）/ 从不 |
| 授权通知 | 独立开关（默认开），抑制条件为「窗口聚焦**且**正在查看该会话」，通知常驻（`timeoutType: 'never'`）直到被处理 |
| 提问通知 | 独立开关（默认开），抑制条件同授权 |
| 通知内容 | 标题 = 会话标题，正文 = 最后一条 assistant 消息摘要 |
| 通知交互 | macOS 通知内直接回复、授权通知带 Approve / Decline 按钮 |

本期采纳其**设置模型与类型分层**（第 1、2、3 行），不跟进消息内容进通知和通知内按钮/回复（理由见 1.4）。

### 1.2 目标

- 将 `任务完成通知` 从 bool 开关升级为三态模式：`总是` / `应用未聚焦时`（默认）/ `从不`，兼容迁移存量配置。
- 新增 `等待授权时通知`：会话产生权限审批请求且用户未在查看该会话时，发送常驻系统通知；请求被处理后通知自动关闭。
- 新增 `等待输入时通知`：AskUserQuestion 类提问请求同上，可独立开关（分期见第 11 节）。
- 通知标题改为**会话标题**（缺失时回落固定文案），解决多任务不可辨识问题；正文维持固定文案，不泄露内容。
- 设置页将通知相关设置组织为「通知」分组：一个三态下拉 + 两个开关。
- macOS / Windows 系统层通知被禁用时提供系统设置入口引导（macOS 权限拒绝、Windows 应用通知关闭或勿扰/专注助手）。
- 补齐一期设计承诺但缺失的 `taskCompletionNotifier` 单元测试。

### 1.3 非目标

- 不把消息内容、命令内容、工具入参、路径等放进系统通知（隐私红线，延续一期 FR-3）。
- 不实现通知内操作按钮（Approve/Decline）与通知内回复：Electron 的 `actions`/`hasReply` 仅 macOS 可用且依赖签名 entitlement；从通知栏一键批准命令执行有误触风险；「人不在电脑前遥控 agent」场景已由 IM 通道承接，重复建设价值低。
- 不实现自定义通知音效（Codex 方案需向 `~/Library/Sounds` 拷贝文件，有卸载残留问题），维持系统默认提示音。
- 不实现通知中心 / 历史收件箱。
- 不改变一期的角标、任务栏、托盘提醒与查看清理机制。
- 不改变权限审批本身的流程与数据结构，本期只增加「审批在等待」这一事实的外部提醒。

### 1.4 产品决策

1. **对齐 Codex 的设置结构，隐私上保持自己的底线。** 三态模式与通知类型分层是良好设计，直接采纳；但 Codex 将最后一条 assistant 消息放进通知正文，在办公/投屏场景有暴露风险，我们折中为「标题用会话标题（用户可控、低敏感），正文用类型化固定文案」。
2. **授权/提问通知不受完成通知三态控制**，是两个独立开关。阻塞性事件的漏报代价高，即使用户把完成通知设为 `从不`，授权通知仍应默认工作。
3. **授权/提问通知使用比完成通知更宽松的触发条件**：完成通知看「应用是否前台」，授权/提问通知看「用户是否正在查看该会话」——应用在前台但停留在其他会话时照样提醒。
4. **授权/提问通知不进入未查看角标计数。** 角标语义保持一期的「未查看的完成结果数」；等待类通知是行动导向的常驻通知，本身即提醒载体。
5. 设置页由单开关升级为「通知」分组，三态使用现有 `ThemedSelect` 控件（与语言选择一致），其余沿用 `SettingsToggleRow`。

## 2. 用户场景

一期场景（失焦后完成弹通知、点击跳会话、角标计数与清理、托盘入口、窗口销毁后点通知重建窗口）全部保留，此处仅列新增/变化场景。

### 场景 1: 后台会话等待授权

**Given** 用户正在查看会话 A，会话 B 在后台执行中产生了权限审批请求
**When** 主进程收到会话 B 的 `permissionRequest` 事件
**Then** 即使应用在前台，也发送系统通知（标题 = 会话 B 标题，正文提示等待授权），通知常驻不自动消失

**When** 用户点击通知
**Then** 应用聚焦并打开会话 B，权限审批 UI 可见；会话 B 的等待类通知全部关闭

**When** 用户在应用内（或 IM 端）处理了该审批
**Then** 对应系统通知自动关闭

### 场景 2: 正在查看的会话等待授权

**Given** 应用在前台，用户正在查看会话 A
**When** 会话 A 产生权限审批请求
**Then** 不发送系统通知（应用内审批 UI 已直接可见）

### 场景 3: 等待输入（AskUserQuestion）

**Given** 会话 B 在后台通过 AskUserQuestion 向用户提问
**When** 主进程收到该请求且用户未在查看会话 B
**Then** 发送常驻系统通知，正文提示「等待你回答问题后继续」；点击与自动关闭行为同场景 1

### 场景 4: 完成通知设为「总是」

**Given** 用户将任务完成通知设为 `总是`，应用在前台，用户正在查看会话 A
**When** 会话 B 执行完成
**Then** 发送完成系统通知（标题 = 会话 B 标题）；由于应用在前台，不记录未查看状态、不更新角标

### 场景 5: 完成通知设为「从不」

**Given** 用户将任务完成通知设为 `从不`，等待授权通知保持开启
**When** 后台会话完成
**Then** 无系统通知、无角标
**When** 后台会话产生权限审批请求
**Then** 仍然发送等待授权通知（两者互不影响）

### 场景 6: 存量配置迁移

**Given** 用户在旧版本关闭过 `任务完成通知`（`taskCompletionNotificationsEnabled: false`）
**When** 升级到本版本
**Then** 完成通知模式显示为 `从不`；开启过的用户显示为 `应用未聚焦时`；行为与升级前一致

### 场景 7: 系统层通知被禁用（macOS / Windows）

**Given** 用户曾在 macOS 系统设置中关闭 LobsterAI 的通知权限，或在 Windows「设置 → 系统 → 通知」中关闭了 LobsterAI 的通知 / 开启了勿扰（专注助手）
**When** 用户打开设置页通知分组
**Then** 分组内常显「若未收到通知，请在系统设置中允许 LobsterAI 发送通知」说明与「打开系统设置」入口，点击后深链到对应平台的系统通知设置面板；角标、任务栏与托盘提醒不受系统通知禁用影响，继续工作

### 场景 8: 会话停止或删除

**Given** 会话 B 存在未处理的等待授权通知
**When** 用户停止或删除会话 B
**Then** 该会话的所有系统通知（含等待类）关闭，未查看状态清理（沿用一期清理链路并扩展到等待类通知）

## 3. 功能需求

### FR-1: 任务完成通知三态模式

- 设置项 `taskCompletionNotificationMode`，取值 `always` / `unfocused` / `off`，默认 `unfocused`。
- `off`：完成时不发系统通知，也不创建未查看角标/托盘提醒（等同一期关闭）。
- `unfocused`：维持一期行为——仅主窗口不存在、失焦、最小化或隐藏时提醒并记录未查看状态。
- `always`：任何情况下都发送完成系统通知；**未查看状态与角标仍仅在非前台时记录**（前台弹的通知只是即时提示，用户看得到结果，不产生未读语义）。
- 失败事件（`runtime.on('error')`）复用同一三态模式发送「任务执行出错」通知（P1，见第 11 节）。

### FR-2: 设置结构与迁移

- `NotificationSettings` 升级为：

```ts
// src/shared/notifications/constants.ts
export const TaskCompletionNotificationMode = {
  Always: 'always',
  Unfocused: 'unfocused',
  Off: 'off',
} as const;
export type TaskCompletionNotificationMode =
  typeof TaskCompletionNotificationMode[keyof typeof TaskCompletionNotificationMode];

export interface NotificationSettings {
  taskCompletionNotificationMode: TaskCompletionNotificationMode;
  permissionNotificationsEnabled: boolean;
  questionNotificationsEnabled: boolean;
  /** @deprecated 迁移自一期 bool 开关，读取时由 normalize 折算，不再作为行为依据 */
  taskCompletionNotificationsEnabled?: boolean;
}

export const defaultNotificationSettings: NotificationSettings = {
  taskCompletionNotificationMode: TaskCompletionNotificationMode.Unfocused,
  permissionNotificationsEnabled: true,
  questionNotificationsEnabled: true,
};
```

- 迁移在 `normalizeNotificationSettings()` 内完成，不需要数据库迁移：
  - 新字段存在 → 直接使用；
  - 仅有旧 bool → `true → 'unfocused'`，`false → 'off'`；
  - 都缺失 → 默认值。
- renderer 保存设置时写入新结构，同时**继续写旧 bool 字段**（`mode !== 'off'`），保证用户回滚到旧版本时行为不劣化。

### FR-3: 等待授权通知

- 触发源：主进程 `runtime.on('permissionRequest', (sessionId, request))`（`CoworkRuntimeEvents` 既有事件，payload 为 `{ requestId, toolName, toolInput, toolUseId }`）。
- 发送条件（全部满足）：
  - `permissionNotificationsEnabled` 为 `true`；
  - 非（主窗口前台 **且** 该 sessionId 是当前活跃会话）——活跃会话判断见 FR-6；
  - sessionId 不是 `SESSION_AGNOSTIC_PERMISSION_SESSION_ID`（`'__askuser__'`）的边界处理见第 6 节。
- 通知属性：
  - 标题 = 会话标题（`coworkStore.getSession(sessionId).name`），缺失回落 `t('permissionNotificationTitle')`；
  - 正文 = `t('permissionNotificationBody', { toolName })`，形如 `Agent 请求执行 {toolName}，等待你的确认`；**不包含 toolInput/命令内容**；
  - `timeoutType: 'never'`：该属性仅 macOS / Linux 生效（Electron 限制），实现时按平台传入；Windows toast 横幅短暂展示后自动进入操作中心驻留，用户仍可从操作中心点击，等价达成「不丢失」目标，无需额外处理。
- 点击行为：聚焦/重建主窗口 + 打开对应会话（复用一期 `focusMainWindow` + `OpenSessionFromNotification` 链路）。
- 自动关闭时机（任一）：
  - 该请求被应答（renderer `cowork:permission:respond`，或 gateway 侧 resolved，见 4.3）；
  - 用户打开/切换到该会话（FR-6 上报时按 sessionId 关闭其全部等待类通知）；
  - 会话停止（`sessionStopped`）、删除，或应用退出。
- 同一 `requestId` 重复到达时先关闭旧通知再发新通知（去重见 FR-5）。

### FR-4: 等待输入通知（AskUserQuestion）

- AskUserQuestion 请求复用 `permissionRequest` 事件通道到达主进程，按 `request.toolName` 判别（判别函数放 shared，具体匹配值实现时以 `openclawApprovalBridge` 构造的 toolName 为准）。
- 独立开关 `questionNotificationsEnabled`，默认开启；其余触发条件、点击行为、关闭时机与 FR-3 一致。
- 通知正文 = `t('questionNotificationBody')`，形如 `等待你回答问题后继续`。
- 分期：若实现时判别链路验证顺利可随 P0 一并交付；否则 P0 期间 AskUserQuestion 类请求暂按 FR-3 的授权开关统一控制，本 FR 落入 P1（见第 11 节）。

### FR-5: 通知内容与生命周期规范

- 通知 id 规范（主进程内部去重键）：
  - 完成：`complete-${sessionId}`；
  - 失败：`error-${sessionId}`；
  - 等待授权/输入：`permission-${sessionId}-${requestId}`。
- 同 id 通知重复发送时，先 `close()` 旧引用再发送新通知。
- 活动通知引用继续受一期上限约束（`MAX_ACTIVE_NOTIFICATION_REFERENCES = 50`），超限关闭最旧引用。
- 隐私红线（延续一期 FR-3）：任何通知不得包含用户 prompt、模型输出、命令与工具入参、本地路径、token。会话标题视为用户可控的低敏感信息，允许进入标题。
- 所有通知点击后均走「聚焦/重建窗口 → renderer ready → 打开对应会话」链路。

### FR-6: 当前活跃会话上报

- 新增 IPC channel（定义于 `CoworkIpcChannel`）：`SetActiveSession: 'cowork:session:setActive'`。
- renderer 在以下时机上报：切换/打开 Cowork 会话（携带 sessionId）、离开 Cowork 页面或关闭会话视图（携带 `null`）。
- 主进程维护 `activeSessionId: string | null`，用于：
  - FR-3/FR-4 的「正在查看该会话」抑制判断（需同时满足主窗口前台）；
  - 收到上报时关闭该会话的等待类通知；
  - 补充一期 `markSessionViewed` 的清理粒度（`markSessionViewed` 原调用点保留不变）。
- 窗口失焦不清空 `activeSessionId`（用户切回来仍在看同一会话）；窗口销毁时置 `null`。

### FR-7: 设置 UI

- 设置页通用 tab 将现有 `任务完成通知` 开关升级为「通知」分组，位置不变（`sqlite 自动备份` 与 `跳过未执行任务` 之间）：

```text
通知
├─ 任务完成通知               [ThemedSelect: 总是 | 应用未聚焦时 | 从不]
│   设置任务完成时的系统提醒时机
├─ 等待授权时通知             [toggle]
│   会话等待你确认操作时显示系统提醒
└─ 等待输入时通知             [toggle]
    会话等待你回答问题时显示系统提醒
```

- 三态控件复用 `ThemedSelect`（与语言选择一致），开关复用 `SettingsToggleRow`。
- 保存流程沿用一期：随 `app_config.notificationSettings` 整体保存；完成模式切到 `off` 时立即 `clearAll` 清理外部提醒状态（沿用一期行为），并关闭所有活动系统通知。
- macOS / Windows 上分组底部常显系统权限引导（FR-8）；Linux 不显示。

### FR-8: 系统通知权限引导（macOS / Windows）

- Electron 无跨平台 API 查询系统通知授权/启用状态（Codex 在 macOS 通过 objc 桥接实现，本项目无此基建，不引入 native 依赖）。P0 统一采用**无状态检测的静态引导**：设置页通知分组底部显示说明文案与「打开系统设置」按钮。按钮经专用 IPC（`AppIpcChannel.OpenSystemNotificationSettings`）由主进程按平台构造深链并 `shell.openExternal` 打开——bundleId 与 `app.isPackaged` 判断都留在主进程。
- **macOS** 深链（跳转到本应用的通知权限面板）：

```text
x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.lobsterai.app
```

  bundleId 使用 `APP_USER_MODEL_ID` 常量（与 electron-builder `appId` 一致）；开发态（`!app.isPackaged`）隐藏该入口（未打包应用无独立通知注册项）。
- **Windows** 深链（跳转到系统通知设置页，用户可在其中启用 LobsterAI 的通知、管理勿扰/专注助手）：

```text
ms-settings:notifications
```

  Windows 无按应用直达的深链，跳到通知设置总页即可；打包版与便携版均可用。
- **Windows toast 前提确认（已具备，本期无需改动）**：`app.setAppUserModelId(APP_USER_MODEL_ID)` 已在主进程启动早期设置（`src/main/main.ts`，仅 win32），且与 electron-builder `appId` `com.lobsterai.app` 一致——这是 Windows toast 正确归属应用名/图标与点击回调可靠触达的前提。已知限制：开发态（未安装、无开始菜单快捷方式）toast 可能归属为 Electron，验收以打包版为准。
- **Linux**：桌面环境差异大，无统一设置深链，不提供入口（沿用一期降级原则，以角标/托盘为主）。
- 引入 native 授权检测（显示「已被系统禁用」状态条）列为后续增强，不在本期范围。

### FR-9: i18n

- 全部新增文案接入 i18n，zh/en 同步提供。
- renderer 新增 key（`src/renderer/services/i18n.ts`）：`notificationsGroupTitle`、`taskCompletionNotificationMode`、`taskCompletionNotificationModeDescription`、`taskCompletionNotificationModeAlways`、`taskCompletionNotificationModeUnfocused`、`taskCompletionNotificationModeOff`、`permissionNotifications`、`permissionNotificationsDescription`、`questionNotifications`、`questionNotificationsDescription`、`notificationSystemPermissionHint`、`openSystemNotificationSettings`。
- main 新增 key（`src/main/i18n.ts`，`t()` 支持 `{param}` 插值）：`permissionNotificationTitle`、`permissionNotificationBody`（含 `{toolName}`）、`questionNotificationBody`、`taskErrorNotificationTitle`、`taskErrorNotificationBody`（P1）。
- 一期已有 key（`taskCompletionNotificationTitle/Body`、托盘文案）继续使用；完成通知标题改为会话标题后，`taskCompletionNotificationTitle` 降级为标题缺失时的回落文案。

### FR-10: 沿用能力声明（不变项）

以下一期能力本期不改变，仅确认兼容：Dock 角标 / Windows overlay + flashFrame / 托盘 tooltip 与菜单、窗口聚焦时 `clearAll`、`markSessionViewed` 查看清理、会话删除清理、通知点击后窗口重建与 renderer ready 握手、未查看状态仅内存态（重启不恢复）、日志规范。

## 4. 实现方案

### 4.1 通知管理器演进

推荐将 `src/main/libs/taskCompletionNotifier.ts` 演进为 `src/main/libs/desktopNotificationManager.ts`（`git mv` + 类名 `TaskCompletionNotifier → DesktopNotificationManager` + `main.ts` 注入点同步），因为其职责已从「完成提醒」扩展为「桌面通知管理」。改名范围仅一个文件与其引用点，属本功能直接范畴；若评审认为 churn 不值得，保留原名、仅扩展方法也可接受，不影响其余设计。

类内新增：

```ts
interface ActivePermissionNotification {
  sessionId: string;
  requestId: string;
  kind: 'permission' | 'question';
}

// 新增状态
private permissionNotifications = new Map<string, ActivePermissionNotification>(); // key = 通知 id
private activeSessionId: string | null = null;

// 新增/调整方法
handleComplete(sessionId)                    // 改为按三态判定（见 4.2）
handlePermissionRequest(sessionId, request)  // FR-3/FR-4
handlePermissionResolved(sessionId, requestId)
handleSessionError(sessionId)                // P1
setActiveSession(sessionId | null)           // FR-6
private isViewingSession(sessionId): boolean // 前台 && activeSessionId === sessionId
```

选项注入新增 `getSessionTitle: (sessionId: string) => string | null`（由 `main.ts` 用 `coworkStore.getSession(id)?.name` 提供，注意消息分页参数传 0 避免拉消息）。

### 4.2 完成通知三态判定

`handleComplete` 的前台早退改为模式判定：

```text
mode = normalize(settings).taskCompletionNotificationMode
mode === 'off'        → return（不通知不记 pending，行为同一期关闭）
isForeground:
  mode === 'unfocused' → return（同一期）
  mode === 'always'    → 仅发系统通知（标题=会话标题），不记 pending、不更新角标
非前台（unfocused/always 相同）→ 记 pending + 角标/托盘 + 系统通知（同一期）
```

去重逻辑（同 session 已 pending 则跳过）保留；`always` 前台分支不受 pending 去重影响（不写 pending，但需防抖同一会话短时间重复 complete——以通知 id `complete-${sessionId}` 的替换语义天然覆盖）。

### 4.3 等待授权/输入事件接线

1. **请求侧**（已有事件，直接接线）：

```text
main.ts runtime.on('permissionRequest', (sessionId, request) => {
  ...现有转发 renderer 逻辑不变...
  getNotifier().handlePermissionRequest(sessionId, request);
})
```

`handlePermissionRequest` 内部：按 toolName 判别 kind（question/permission）→ 查对应开关 → `isViewingSession(sessionId)` 抑制 → 发常驻通知并登记 `permissionNotifications`。

2. **解决侧**（需要新增事件）：`CoworkRuntimeEvents` 增加

```ts
permissionResolved: (sessionId: string, requestId: string) => void;
```

emit 点两处：
- `openclawApprovalController.handleExecApprovalResolved` / `handlePluginApprovalResolved`（gateway 侧解决，如 IM 端处理、自动批准）——当前仅删除 `pendingApprovals`，需在删除前取出 sessionId 一并 emit；
- `main.ts` 的 `cowork:permission:respond` handler（renderer 应答）在调用 `runtime.respondToPermission` 后直接调 `notifier.handlePermissionResolved`（双保险，避免依赖 gateway 回执时序）。

3. **清理侧**：`runtime.on('sessionStopped')` 与会话删除处理中，追加关闭该会话全部等待类通知（扩展现有 `handleSessionDeleted`）。

### 4.4 活跃会话上报

- `src/shared/cowork/constants.ts` 的 `CoworkIpcChannel` 增加 `SetActiveSession: 'cowork:session:setActive'`。
- preload 暴露 `setActiveSession(sessionId: string | null)`。
- renderer 调用点：`coworkService.loadSession` 成功后（紧邻现有 `markSessionViewed` 调用）、离开 Cowork 视图 / 切换到设置等页面时上报 `null`（`App.tsx` 的 `mainView` 变化处）。
- main handler：校验 sender 为主窗口后调 `notifier.setActiveSession(...)`；`setActiveSession` 收到非空值时同时关闭该会话等待类通知。

### 4.5 Settings UI 与保存

- `Settings.tsx` general tab：state 从单 bool 改为 `taskCompletionNotificationMode` + 两个 bool；初始化经 `normalizeNotificationSettings`；保存时写入完整新结构 + 同步旧 bool（FR-2）。
- 埋点：沿用现有设置变更上报，新增模式与两开关的变更事件。
- 主进程读取路径不变（`getNotificationSettings()` 返回 Partial，normalize 后使用）。

### 4.6 日志

沿用主进程日志规范，关键事件示例：

```ts
console.log('[DesktopNotification] showed permission notification for session xxx, request yyy');
console.debug('[DesktopNotification] suppressed permission notification because session is being viewed');
console.log('[DesktopNotification] closed permission notification after resolve, request yyy');
```

等待类事件频率低，允许 info 级；判定抑制用 debug 级。

## 5. 数据与持久化

- 通知偏好持久化在现有 `app_config.notificationSettings`（`kv` 表），结构见 FR-2；无数据库迁移。
- 等待类通知登记表（`permissionNotifications`）与一期 pending 状态一致，**仅内存态**：应用重启后不恢复（重启后 gateway 若重发未决审批事件，会自然重建通知；不做主动补偿）。
- `activeSessionId` 仅内存态。

## 6. 边界情况

| 场景 | 处理方式 |
|------|---------|
| sessionId 为 `__askuser__`（无法解析会话的 AskUserQuestion） | 发送通知（标题回落固定文案）；点击仅聚焦窗口不跳会话（renderer 会把该请求显示在当前打开的会话）；活跃会话抑制按「主窗口前台且 Cowork 视图活跃」判定 |
| 同一会话短时间多个授权请求 | 每个 requestId 一条通知（id 含 requestId 天然区分）；总量受 50 上限保护 |
| 授权请求到达时会话已停止 | `openclawApprovalController` 已有 stop-cooldown 抑制，不会 emit；无需额外处理 |
| 定时任务/IM 驱动的后台会话触发授权 | 正常通知（此类会话卡住的代价最高，正是目标场景）；若该请求同时被 IM 端处理，`permissionResolved` 会关闭桌面通知 |
| 定时任务/IM 会话完成 | 沿用一期行为照常通知；如后续反馈打扰，再按会话来源加抑制（不在本期） |
| 完成模式 `always` 且窗口前台 | 只弹通知，不记 pending/角标（FR-1）；窗口聚焦触发的 `clearAll` 与此无冲突（无新增 pending） |
| 模式切换 `always/unfocused → off` | 立即 `clearAll` + 关闭全部活动通知（含等待类不关闭——等待类由独立开关控制；仅当对应开关关闭时关闭对应类） |
| 授权开关运行中关闭 | 关闭现存全部等待授权通知；提问开关同理 |
| 通知点击时窗口已销毁 | 沿用一期重建窗口 + renderer ready 握手链路 |
| 系统层通知被禁用（macOS 权限拒绝 / Windows 应用通知关闭或勿扰模式） | `show()` 静默失效或被系统吞掉；角标、Windows 任务栏 overlay/flashFrame、托盘提醒不受影响（一期降级路径）；设置页常显系统设置入口（FR-8） |
| Windows 勿扰（专注助手）开启 | 横幅不弹但通知进入操作中心，用户事后仍可点击跳转；无 API 可检测，不做特殊处理 |
| Windows 开发态 toast 归属显示为 Electron | 无开始菜单快捷方式时的系统行为，已知限制；打包版正常，验收以打包版为准 |
| Linux 桌面环境差异 | `timeoutType` 与常驻行为不保证；沿用一期原则，Linux 不作为角标/常驻验收硬要求 |
| 旧配置仅有 bool / 字段缺失 | normalize 折算（FR-2），不改用户既有行为 |
| 版本回滚 | 保存时同步写旧 bool 字段，旧版本按 bool 正常工作 |

## 7. 涉及文件

| 文件 | 变更 |
|------|------|
| `src/shared/notifications/constants.ts` | `TaskCompletionNotificationMode` 常量、`NotificationSettings` 扩展、normalize 迁移逻辑 |
| `src/main/libs/taskCompletionNotifier.ts` | 演进为 `desktopNotificationManager.ts`（推荐）：三态判定、等待类通知、活跃会话、解决/清理 |
| `src/main/main.ts` | notifier 注入项（getSessionTitle）、`permissionRequest`/`permissionResolved`/`sessionStopped` 接线、`SetActiveSession` handler、`cowork:permission:respond` 双保险关闭 |
| `src/main/libs/agentEngine/types.ts` | `CoworkRuntimeEvents` 增加 `permissionResolved` |
| `src/main/libs/agentEngine/openclawApprovalController.ts` | resolved 时 emit `permissionResolved`（携 sessionId） |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 透传 `permissionResolved` |
| `src/shared/cowork/constants.ts` | `CoworkIpcChannel.SetActiveSession` |
| `src/main/preload.ts` / `src/renderer/types/electron.d.ts` | `setActiveSession` API |
| `src/renderer/services/cowork.ts` / `src/renderer/App.tsx` | 活跃会话上报调用点 |
| `src/renderer/components/Settings.tsx` | 通知分组 UI（ThemedSelect + 2 toggle + macOS/Windows 系统设置引导入口） |
| `src/shared/app/constants.ts` | `AppIpcChannel.OpenSystemNotificationSettings`（引导入口专用 IPC） |
| `src/renderer/services/i18n.ts` / `src/main/i18n.ts` | 新增 zh/en key（FR-9） |
| `src/main/libs/desktopNotificationManager.test.ts` | 新增单元测试（见 8.1） |

## 8. 测试计划

### 8.1 单元测试（Vitest，co-locate，补齐一期缺口）

通过构造函数注入 mock（getWindow/getNotificationSettings/getSessionTitle 等）测试，避免直接依赖 Electron：

- 三态判定：`off` 全静默；`unfocused` 前台静默/后台通知；`always` 前台仅通知不记 pending、后台通知且记 pending。
- normalize 迁移：旧 `true → unfocused`、`false → off`、缺失 → 默认；新旧字段并存时新字段优先。
- 一期承诺用例补齐：重复 complete 不重复计数；`markSessionViewed` 清除对应提醒；删除会话清除提醒；count 归零触发清理。
- 等待类：开关关闭不通知；前台且活跃会话抑制；前台非活跃会话通知；`handlePermissionResolved` 关闭对应通知；`setActiveSession` 关闭该会话等待类通知；`sessionStopped`/删除清理；同 requestId 重发先关旧。
- 通知 id 去重与 50 上限。

### 8.2 手动验证

- macOS / Windows 双平台各验证：
  - 三态各档位的完成通知行为（前台/后台 × 三档）。
  - 前台停留会话 A，会话 B 触发权限审批 → 弹通知；点击跳到会话 B；批准后通知消失。
  - 正在查看的会话触发审批 → 不弹通知。
  - IM 端处理审批 → 桌面通知自动关闭。
  - AskUserQuestion 提问 → 等待输入通知（若随 P0 交付）。
  - 设置分组 UI、三态下拉、开关即时生效；关闭开关后现存对应通知关闭。
  - 旧配置升级后模式映射正确。
  - 通知点击后窗口恢复/聚焦并打开对应会话（含窗口最小化、隐藏两种状态）。
- macOS 专项：
  - 等待类通知横幅常驻（`timeoutType: 'never'`）直到被处理。
  - 系统设置关闭通知权限后角标/托盘仍工作；设置页入口可打开本应用的通知权限面板。
- Windows 专项（打包版验证）：
  - toast 归属显示 LobsterAI 名称与图标（AUMID 生效）；操作中心内的历史通知点击仍可跳转对应会话。
  - 等待类通知横幅消失后可从操作中心找回并点击。
  - 「设置 → 系统 → 通知」关闭 LobsterAI 通知后：不弹 toast，但任务栏 overlay/flashFrame 与托盘仍工作；设置页入口可打开 `ms-settings:notifications`。
  - 开启勿扰（专注助手）：横幅不弹，通知进操作中心，点击仍可跳转。
- 回归一期：角标计数增减、窗口聚焦清理、托盘入口、窗口销毁后点通知重建、通知文案无隐私内容。

## 9. 验收标准

1. 完成通知支持三态且默认 `unfocused`，存量 bool 配置无损迁移，回滚兼容。
2. 后台/非活跃会话的权限审批请求产生常驻系统通知，点击直达会话，处理后自动关闭；正在查看的会话不弹。
3. 通知标题为会话标题（缺失回落固定文案），任何通知不含消息内容、命令、路径。
4. 设置页呈现「通知」分组（1 下拉 + 2 开关），zh/en 文案完整，macOS 有系统权限引导入口。
5. 等待类通知不影响角标计数语义；一期全部行为回归通过。
6. `desktopNotificationManager.test.ts` 覆盖 8.1 用例并通过 `npm test`；touched 文件通过 CI 同参数 ESLint。

## 10. 风险与兼容性

- **权限事件的可靠性**：等待类通知依赖 `permissionRequest`/resolved 事件的成对到达；gateway 侧 resolved 若丢失，通知会驻留到用户点击或会话停止。`setActiveSession` 与 `cowork:permission:respond` 双保险已覆盖主要路径，残留通知的兜底是点击行为本身无害（跳转会话）。
- **AskUserQuestion 判别**：toolName 匹配值依赖 openclaw 扩展的构造行为，版本升级时需回归；判别函数集中在 shared 便于维护。
- **`always` 模式的打扰面**：前台弹通知可能被部分用户视为噪音——该档位是可选项且非默认，风险可接受。
- **权限引导为静态入口（macOS / Windows）**：无授权状态检测，用户可能在通知正常时也看到入口；文案措辞用「若未收到通知…」弱化存在感。Windows 勿扰/专注助手同样无法检测，仅靠引导文案覆盖。
- **Windows toast 行为差异**：`timeoutType` 不生效、横幅停留时长由系统控制；等待类通知的「不丢失」依赖操作中心驻留，用户若清空操作中心则只能回应用内处理（应用内审批 UI 始终存在，无功能损失）。
- 多窗口架构（若未来引入）需把 `activeSessionId` 扩展为按窗口维度维护（延续一期同类风险声明）。

## 11. 分阶段实施建议

### Phase 1（P0，本期核心）

- FR-1 三态 + FR-2 迁移 + FR-7 设置 UI + FR-9 i18n。
- FR-3 等待授权通知全链路（含 `permissionResolved` 事件、FR-6 活跃会话上报）。
- FR-8 macOS 权限静态引导。
- 8.1 单元测试全量补齐。
- FR-4 等待输入独立开关：判别链路验证顺利则随 P0，否则该类请求暂并入授权开关。

### Phase 2（P1）

- FR-4 独立开关落地（若 P0 未随）。
- 失败通知（`error` 事件复用三态，文案 `taskErrorNotification*`）。
- 定时任务/IM 来源会话的完成通知抑制选项（视用户反馈）。

### Phase 3（P2，暂缓）

- 自定义品牌提示音（macOS 需解决 `~/Library/Sounds` 卸载残留；Windows 走 toast audio 配置，能力不同需分别评估）。
- 通知授权状态原生检测（macOS `UNUserNotificationCenter` / Windows `Windows.UI.Notifications`，均需 native 依赖）。
- 通知内操作按钮 / 通知内回复（重新评估必要性后再立项）。
