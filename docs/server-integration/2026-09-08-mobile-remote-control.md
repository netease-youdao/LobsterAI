# 手机远程控制：桌面接入说明

日期：2026-09-08。状态：已实现桌面接入，尚未部署或连接真实手机进行端到端验收。

服务端协议以 `lobsterai-server/docs/api/mobile-remote-api.md` 和 `docs/specs/mobile-remote-control/feature-2026-09-08-mobile-remote-control.md` 为准。此文档说明桌面落点与运行边界；不包含设备密钥、测试数据库口令或用户数据。

## 1. 行为与入口

设置 → 通用 → 手机远程控制。默认关闭。当前用户可启用、修改设备名称、选择手机允许使用的任务目录、批准或拒绝待授权手机。目录使用随机 workspaceId 向服务端发布，真实文件系统路径只保存在桌面 SQLite。

打开开关后，桌面向同一服务端登记实际执行实例，申请短期 WSS ticket，建立 WSS。手机发起会话及继续会话使用桌面和本地界面共同的 start/continue 流程；OpenClaw 仍是唯一执行引擎。模型 readiness、账号检查、任务目录和已有能力准备步骤被保留。

WSS 仅用于在线状态和低延迟通知。命令领取、received/applied 确认、重连核对、快照分片及增量写入均走 HTTPS。WSS 断开不会调用任务停止、关闭 Gateway 或取消模型 SSE。Gateway/模型 SSE 自身断开可能中断执行，此时同步 reconciling，禁止自动重跑。

首期只接受手机文本（UTF-8 ≤16 KiB），结果为安全 Markdown/文本、工具状态及已关联资料库产物的文件卡片元数据。卡片仅含 ID、名称、类型、大小和可用性，不传真实路径；资料库条目变化触发同步，不扫描任意文件。文件上传、产物下载、任意路径访问和云端执行不启用。超限消息投影为 desktop_only；工具输入、原始输出和内部 thinking 不发布。

## 2. 代码落点

| 文件 | 职责 |
| --- | --- |
| `src/shared/remote/constants.ts` | 协议常量、IPC 和设置类型 |
| `src/main/remote/remoteStore.ts` | 固定 owner、SQLite FULL 持久事务、可信写入标记、队列、投影、快照及 ACK 边界 |
| `src/main/remote/installationIdentity.ts` | OS 安全存储加密的独立实例凭证、外部数据库 checkpoint |
| `src/main/remote/remoteBridge.ts` | HTTPS/WSS、设备设置/授权、命令领取/核对、immutable import/outbox 传输 |
| `src/main/remote/sessionCommandService.ts` | 本地/手机统一提交控制、执行许可复检、运行/审批状态 |
| `src/main/remote/automationOwnership.ts` | IM 实例过滤及切账号时 cron 归属隔离 |
| `src/main/main.ts` | 认证上下文、共享 start/continue、设置 IPC、账号切换屏障及生命周期 |
| `src/main/coworkStore.ts` | 创建事务记录 owner、fork/subagent 继承、所有消息写入持久事务 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 独立 Gateway run 映射及匹配 aborted 事件的取消确认 |
| `src/renderer/components/RemoteControlSettings.tsx` | 开关、目录、设备名称、手机授权 |

## 3. Owner 与旧版本兼容

owner 只使用已认证服务端用户对象的 users.id（userId/id）和 personal/enterprise:<id> 范围，不使用 YID、昵称或 installation_uuid。每次创建会话在同一个 SQLite 事务中写入 cowork_session_ownership；关闭远程功能也记录 owner。

未登录创建以及升级前无 owner 的历史始终无 owner，后续登录、打开远程开关、继续旧会话或选择目录都不回填。fork/subagent 只继承父会话已确认的 owner。新 IM 实例和新 cron 显式创建时绑定 owner；旧配置/任务不从触发时当前登录者推断归属。

不同账号/企业范围不能通过本地或手机的继续、改名、置顶、删除、fork、运行控制修改已确认属于其他账号的会话。来自原运行的输出仍写入原会话。SQLite 触发器会将旧客户端绕过支持的事务边界所修改的已归属会话隔离，不再上传。

OpenClaw 模型 token 是全局注入能力。切账号期间暂停 token proxy 新请求，等待旧 Gateway 停止后才允许写入新账号配置；旧运行保留 reconciling。新配置过滤不属于当前 owner 的已绑定 IM 实例，并暂停异主 cron。恢复相同 owner 时恢复由此屏障暂停的任务。上述停止仅发生于账号切换，不由远程连接断开触发。

安装实例凭证位于 appData/LobsterAI-remote-identity/<profile-hash>/，不在迁移备份的 userData 中，不复用 installation_uuid。安全存储不可用时禁止启用远程功能。独立写前 checkpoint 与数据库内水位不符（复制、回滚、恢复或中间崩溃）时会保守隔离 owner、清除本地执行/传输凭证及来源绑定，不能继承执行权。

## 4. 持久性与命令顺序

本地使用原生 better-sqlite3，WAL + synchronous=FULL。远程支持的写事务同时包含源数据、owner、投影和 outbox；事务 COMMIT 后才唤醒传输。外部 checkpoint 先 fsync，再提交数据库水位；这会增加写入成本，但不会把尚未耐久的数据确认成已接收。

命令流程：

1. HTTPS claim 获得 `{command,request,requestHash,claimId,claimToken,claimUntil}`，校验规范 JSON 请求哈希。
2. 在本地事务中保存原始请求、固定 local/remote sessionId、remoteRunId、inbox，随后发送 received ACK。
3. 获得服务器确认后落盘 execution marker；实际调用运行器前再次检查 owner、generation、remoteEnabled 和许可截止时间。
4. 应用结果保存后发送 applied。重复领取只核对已保存命令，不再调用运行器。
5. 重启发现 executing 或不确定副作用时报告 unknown；只有健康完整数据库中持久证明 prepared/not_started，才请求同命令的新许可。recovery 不领取或执行新任务。

shared session control lane 在等待 readiness 前占用已有会话，不把并发手机/桌面继续隐式排队。remoteRunId 独立于可能变化的 Gateway runId。完成/错误来自运行事件；本地 idle、legacy sessionStopped 和 chat.abort RPC 接收成功均不是 cancelled 证据。只有匹配运行的 aborted 事件才确认 cancelled，否则保留 reconciling。

## 5. 同步协议

- 普通 HTTP：Authorization Bearer，桌面请求额外携带 `X-Remote-Device-Credential: <deviceId>.<deviceKey>`；企业请求复用既有企业范围头。
- `GET /api/remote/v1/capabilities` 探测后，`POST /devices/register` 幂等登记。
- `GET/PATCH /devices/{deviceId}/settings` 使用 settingsVersion；metadata PATCH 使用 metadataVersion。
- `POST /connection-tickets` 获得单次 ticket。只接受与 API 主机相同的 `wss:` URL；WS 连接不携带账号 token。
- commands.available/access.requested 是通知；仍通过 HTTPS 获取当前权威数据。access.changed 使尚未开始的旧连接许可失效；已运行任务不因授权撤销被取消。
- 每个会话串行增量批次，每批最多 100 条，普通批次控制在 256 KiB 内；单条大消息独立批次。sourceSeq/payload 不重写。
- 首次导入/恢复先捕获固定 baseSourceSeq 的安全投影并持久保存分片，再 PUT parts 和 commit。运行继续产生后续 sourceSeq。commit 丢响应重试相同 importId。只有 commit 水位确认后清理旧 outbox。
- Snapshot 包含 message.deleted 墓碑；message ordinal/runId/commandId 一经发布固定；内容变更递增 revision。
- 分片为 `{records:[{eventType,payload}]}`。所有 hash 使用递归字典序 key、保留数组顺序的 UTF-8 canonical JSON。manifest hash 覆盖 `[{partNo,payloadHash,byteSize}]`，recordCounts 按 eventType 计数。
- ACK 必须匹配本地 owner/device/session 和已分配 sequence 范围。清理与水位保存是一个 FULL 事务。快照期间再次溢出或关闭同步会保留下一轮 needs_snapshot，不能被旧快照确认覆盖。

金样例：`{"a":["1",{"a":null,"z":true}],"b":"中文"}` 的 SHA-256 为 `7eaeb5e471966f6be4cc5d06226663f1a5f9d1bf9d791ce9f5d90e3cfa0c3086`。

## 6. 审批与实际限制

现有 Bash/插件审批包含命令、路径或任意插件描述，缺少可安全发布的完整操作摘要，因此首期显示 waiting_local，并提示在电脑处理。代码提供 confirmed approval 通道；只有运行器显式给出 remoteSafe/publicSummary 且支持 allow-once 的结构化审批才开放手机 approve/deny。不能把本地 permissionResolved 提前通知当作云端执行成功。pending 审批自然到期由桌面转为 expired，同时递增 approvalVersion、补 resolvedAt；运行终态也使未决审批失效。

自动化实例归属只覆盖明确新建的 IM/cron，不通过编辑旧配置“认领”。未知恢复和审批状态采取保守不重跑/在电脑处理。手机界面需分别展示设备在线状态、同步状态、run 状态，不能因设备离线把任务显示为已失败或已取消。

本功能尚未执行真实手机/线上服务/生产数据验收。最终联调需验证：两账号与企业范围切换、设备授权撤销、跨 Pod 重连、received/applied 丢包、数据库回滚、快照提交丢响应、后台恢复、任务继续和取消证据、桌面主动发起任务同步。服务器未部署/功能关闭时客户端保持兼容，原会话本地使用不依赖远程服务。


## 7. HTTP 请求与响应示例

以下示例中的 ID 和凭据均为占位值。桌面使用既有 Electron JWT Bearer；范围来自可信当前账号，企业场景沿用既有企业范围请求头。完整 DTO、错误码和手机侧调用顺序见服务端 `docs/api/mobile-remote-api.md`。

```http
GET /api/remote/v1/devices/dev_pc_01/settings
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: dev_pc_01.<deviceKey>
```

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "remoteEnabled": false,
    "settingsVersion": "1",
    "protocolVersion": 1,
    "capabilities": ["session.read", "session.create", "session.continue", "run.cancel", "approval.respond"],
    "workspaces": []
  }
}
```

```http
PATCH /api/remote/v1/devices/dev_pc_01/settings
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: dev_pc_01.<deviceKey>
Content-Type: application/json
```

```json
{
  "expectedSettingsVersion": "1",
  "remoteEnabled": true,
  "protocolVersion": 1,
  "capabilities": ["session.read", "session.create", "session.continue", "run.cancel", "approval.respond"],
  "workspaces": [{"workspaceId": "workspace_01", "name": "任务目录", "available": true}]
}
```

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "remoteEnabled": true,
    "settingsVersion": "2",
    "protocolVersion": 1,
    "capabilities": ["session.read", "session.create", "session.continue", "run.cancel", "approval.respond"],
    "workspaces": [{"workspaceId": "workspace_01", "name": "任务目录", "available": true}]
  }
}
```

版本冲突重新 GET 并串行提交最新用户意图，不能让较早的“开启”响应覆盖随后“关闭”。received ACK 的会话/run 映射严格使用服务端预分配 ID；applied.result 仅为 `{ "outcome": "started" }`、cancel_requested、already_terminal 或 approval_applied，不把会话映射塞入 result。错误对象使用协议要求的数值 code 及完整 CommonError 字段。

服务端上线顺序：先兼容数据库迁移和新 API，再灰度桌面，最后 App 联调。后台 `remote-control.commands-enabled` / `REMOTE_COMMANDS_ENABLED=false` 只停止新命令，保留已有任务结果补传；桌面无需实现此后台开关。关闭整项功能与只停新命令应分别操作。

## 8. 验证

使用 Node 24 对远控持久化/命令协议、会话库、运行器、路由、IM 同步、定时任务入口及 token proxy 执行定向 Vitest；包括真实 server DTO 约束、固定服务端 runId、received 终态防重跑、SQLite 恢复隔离、裸 isThinking 隐私过滤、资料库产物变更、匹配 aborted 取消证据和 settings 并发关闭。执行 Electron TypeScript 编译、renderer/Electron 构建及改动 TypeScript 文件 ESLint。不执行依赖外部服务的服务端测试，也不启动真实任务或修改真实 App 数据。
