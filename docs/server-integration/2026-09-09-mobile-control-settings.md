# 手机控制电脑：新版设置与同账号接入

日期：2026-09-09。基于远控协议 v1，代码已实现，尚需发布后的跨端联调。本版替代旧接入说明中的“通用页配置 / 手动手机批准 / 手动添加工作目录”交互；任务归属、命令幂等、恢复水位和必要的工具审批继续沿用。

## 1. 变更概览

- 设置侧栏新增“手机控制电脑”，两个开关“允许手机连接”“保持电脑唤醒”，显示本机在线/离线、默认主机名、重命名。
- 已登录且缺少偏好时两个开关默认开启；未登录时两个开关关闭，点击任一个开关使用现有浏览器登录入口，不写入设置草稿，等待真实登录状态更新后恢复默认或已保存的选择。取消登录保持关闭。
- 已保存的 false 不覆盖。防休眠为本机全局偏好，远控为 userId/scopeKey 偏好，两者独立；退出登录停止远控并释放防休眠，不以登出状态覆盖已保存偏好，重新登录时恢复。
- 新桌面使用 same_account_access，手机同账号初始化访问资格时服务端直接 approved，不再到电脑批准。
- 远控默认目录自动采用主 Agent/全局/应用默认工作目录，无需用户配置。默认应用目录为 ~/lobsterai/project。
- 开关和名称先保留为设置草稿，点击底部“保存”才提交；“取消”或关闭设置不提交。保存后离线写入持久队列，恢复后补送。禁用→开启按顺序发送，改名单独更新 metadata。

## 2. HTTP 接口

除 capabilities 仅需 Bearer 外，设备接口均带有效登录身份和当前实例凭证：

```http
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
Content-Type: application/json
```

所有响应仍为 `{ "code": 0, "message": "success", "data": ... }`。账号及 scopeKey 来自 access token，不能自行指定 userId；个人和不同团队身份分别隔离，同团队其他成员无自动访问权。

### 能力探测

`GET /api/remote/v1/capabilities` 在现有返回中新增：

```json
{
  "enabled": true,
  "protocolVersions": [1],
  "capabilities": ["same_account_access"]
}
```

只有服务器声明支持后，桌面才将 same_account_access 加入 register/settings 的 capabilities。缺少此能力时新版桌面显示服务升级提示并退避，不能把没有人工批准入口误当作已可接入。

### 桌面发布设置和默认目录

`GET /api/remote/v1/devices/{deviceId}/settings` 取得 settingsVersion，随后 CAS 更新：

```http
PATCH /api/remote/v1/devices/{deviceId}/settings
```

```json
{
  "remoteEnabled": true,
  "protocolVersion": 1,
  "capabilities": ["session.read", "session.create", "session.continue", "run.cancel", "approval.respond", "same_account_access"],
  "workspaces": [{"workspaceId": "workspace_01", "name": "project", "available": true}],
  "expectedSettingsVersion": "3"
}
```

响应包含最新 settingsVersion；冲突 47026 携带 currentSettingsVersion。默认工作区放数组第一项，路径仅在桌面本地保存。目录暂不可用时默认项 available=false，不能换用后续目录；已有目录 ID/路径映射仍保留。在映射达到 50 项而无法表示新默认目录时，暂移除 session.create 能力，继续提供读/续聊，不改派新建任务。

### 手机自动接入（供 App 开发同步）

`GET /api/remote/v1/devices?kind=desktop` 后，检查服务端与目标桌面均支持 same_account_access，再在后台调用：

```http
POST /api/remote/v1/devices/{desktopDeviceId}/access-requests
```

```json
{
  "requestId": "81d1c74a-bcb1-48d3-9d9d-b13af62b06ed",
  "permissions": ["sessions:read", "sessions:control"]
}
```

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "requestId": "81d1c74a-bcb1-48d3-9d9d-b13af62b06ed",
    "deviceId": "desktop_01",
    "status": "approved",
    "expiresAt": "2026-09-09T08:05:00.000Z",
    "grant": {"grantId": "grant_01", "status": "active", "permissions": ["sessions:read", "sessions:control"]}
  }
}
```

旧桌面仍返回 pending 并等待原人工确认。App 重试沿用 requestId；普通读请求不生成授权，显式撤销后停止重试，新的连接意图才使用新 requestId。不要删除 grant/版本校验。电脑离线时可初始化以读取已有镜像，新建/继续仍要求电脑在线；关闭远控、账号失效或退役时读取也被拒绝。

### 重命名

`PATCH /api/remote/v1/devices/{deviceId}/metadata`：

```json
{"name": "我的工作电脑", "expectedMetadataVersion": "3"}
```

响应含新 metadataVersion；47020 携带 currentMetadataVersion。名称去首尾空白，1–100 UTF-16 单元且无控制字符。只改显示名，不改 hostname、deviceId 或会话归属。独立发 metadata，不额外修改 settings/authVersion。

## 3. 桌面 IPC 和 UI

- `window.electron.remote.state()` 返回统一状态；`onChanged(listener)` 返回取消订阅函数，事件为 RemoteIpc.Changed。
- 新字段：hostName、stateRevision、connectionStatus、connectionReason、settingsSyncStatus、nameSyncStatus、keepAwakeEnabled、keepAwakeActive、keepAwakeError、screenLocked。原 enabled/connected/owner/workspaces/accessRequests 字段保留兼容。
- UI 编辑开关或确认名称只修改父设置页草稿，切换设置标签时保留，切换账号时丢弃。统一“保存”调用 `configure({enabled?, name?, keepAwakeEnabled?})`，仅提交修改的字段；IPC 的本地持久化语义保持兼容。保存失败保留窗口和草稿。
- 两个开关在初始状态加载时显示关闭并暂不可操作；未登录状态加载完成后可点击，引导登录，不需要先点击“保存”。主进程也拒绝未登录修改，防止通过 IPC 绕过界面开启防休眠或远控。
- `configure({retry:true})` 是独立即时操作：关闭旧 WS，废弃旧连接尝试，重新获取 ticket，并重试电源恢复；不会提交未保存的开关或名称。
- 页面订阅后获取初始状态，按单调 stateRevision 忽略旧回包；可见时每 5 秒兜底读取，关闭时解除订阅。
- 只在 hello/有效心跳后显示在线；目录故障和名称待同步不应把有效 WS 显示为离线。账号切换清理旧名称及编辑状态。
- 防休眠使用 prevent-app-suspension，允许显示器熄屏；锁屏不等于休眠。图形操作仍可能需解锁，不自动修改系统锁屏或合盖策略。
- 底部统一显示“取消 / 保存”；名称弹窗的“确认”只更新草稿，需点击设置页“保存”后生效。取消或关闭只丢弃尚未提交的编辑，不撤回已经发起的“重新连接”。
- 网络、握手和心跳失败显示“连接失败”及本地化原因，自动重试时保留错误直到有效 hello；显式重新连接开始时清除上次错误。47013（设备凭证无效）、47023（设备不可用）关闭传输并暂停自动重试；普通改名/保存不会解除暂停，只有显式重新连接、重新启用或账号切换才重试。设备身份和 inbox/outbox 均保留，不以重建身份绕过服务端校验。

## 4. 命令、恢复与发布

- App 新建可省略 workspaceId；服务端首次受理将默认 ID 固定到 remote_sessions.workspace_id。
- 下发桌面的 request 可补齐该 ID，requestHash 对实际下发内容计算；手机原 body/bodyHash 保持原样用于幂等。不要用手机原请求哈希比较已补齐的桌面请求。
- 桌面准备时将 cwd 和 inbox/会话持久化；续聊及恢复沿用原目录。原路径失效应报错，不能改用新默认。
- 保存关闭连接后立即停止本机接受新远控操作，服务器确认禁用后撤销旧授权。已启动的本地任务继续执行，重启/重连不自动重跑不确定结果。
- 服务端先完成所有 Pod 滚动发布，再发布新版桌面及 App。旧 Pod 在混跑窗口保留旧批准/目录行为，原 body/hash 兼容；不要在混跑窗口验证新版本全部语义。
- 无新增数据库迁移、Portal/Admin 变更或基础设施要求，继续使用 V88 的 MySQL 5.7 兼容结构。
- 本次不实现手机 App；完整接口、状态恢复与 App 验收见服务端仓库 docs/api/mobile-remote-api.md。

## 5. 登录开关联动验证（2026-09-09）

- 定向 Vitest：远控设置控制器、远控 Bridge 设置、主进程启动/账号监听、界面状态辅助逻辑共 4 个文件，61 项通过；仅使用本地模拟依赖及内存数据库。
- 主进程与 Renderer 的 TypeScript `--noEmit` 检查通过；本次涉及的 TypeScript/TSX 文件 ESLint 零错误、零警告。
- 在临时本地页面加载实际 `RemoteControlSettings` 组件，模拟登录及 IPC，手动验证：未登录两个开关关闭且任一个点击均触发登录入口；收到登录完成状态后默认开启；取消丢弃编辑；保存关闭后，退出并重新登录仍保持用户选择。
- 未使用真实账户完成登录联调，未重启已安装应用或执行系统电源切换；系统电源调用及异常恢复由控制器测试覆盖。本次无需服务端和数据库变更。
