# 设备连接管理 v2 接入与实施记录

日期：2026-09-18。服务端与桌面代码已实施，测试库 V98 已执行并校验，生产未迁移、尚未部署。对应服务端 Spec：`../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-18-device-connection-management.md`；完整 App/API 契约：`../lobsterai-server/docs/api/mobile-remote-device-connections-v2.md`。

## 1. 变更概要

同账号、同身份空间的在线桌面上限由服务端配置，默认 5 个桌面实例；页面不展示具体数量上限。新版登记取消 10 台历史登记门槛，服务端 v1 行为保留。超过当前服务端上限的桌面保留“允许手机连接”偏好但暂停业务同步，电脑本地任务照常运行。设置页始终显示当前电脑，增加官网占位二维码与占名额设备列表。主动移除持久暂停目标连接，不使用旧 retire 或关闭 remoteEnabled，不停止任务、不删除历史。

## 2. API

认证沿用 Bearer JWT 与 `X-Remote-Device-Credential: <deviceId>.<deviceKey>`；首次 register 无需设备凭证。用户、身份空间、操作发起设备从认证推导。列表/管理不要求 WS，关闭手机连接或被移除仍可查询。

| 方法 / 路径 | 用途 |
| --- | --- |
| GET `/api/remote/v1/capabilities` | 新 `deviceConnectionPolicy.version=2` 表示管理契约；enabled、clusterReady 表示入口状态 |
| POST `/api/remote/v2/devices/register` | 登记字段/返回与 v1 一致，复用已有身份；新身份每小时默认 30 个预算 |
| GET `/api/remote/v2/device-connections` | quota、observedAt、presenceAvailable、currentDevice、connections |
| POST `/api/remote/v2/devices/{deviceId}/connection/remove` | 同账号/空间移除桌面连接 |
| POST `/api/remote/v2/devices/{deviceId}/connection/resume` | 仅当前桌面自己显式恢复 |
| GET `/api/remote/v2/device-connection-operations/{requestId}` | 原发起设备查询幂等回执 |

只有能力数组公告 `device_connection_management_v2` 才使用 v2 新登记；入口暂停时仍根据 policy.version=2 保留查询与恢复。绝不能因业务拒绝降级 v1 绕过限制。

移除/恢复 body：

```json
{"requestId":"dcd8c7ec-5967-43a2-a683-f6f6407a8d41","expectedConnectionVersion":"3"}
```

成功响应示例：

```json
{"code":0,"message":"success","data":{"requestId":"dcd8c7ec-5967-43a2-a683-f6f6407a8d41","deviceId":"target-id","connectionState":"removed","connectionVersion":"4","releaseState":"pending","nextAction":"resume_on_target"}}
```

version 始终保留十进制字符串。pending 是已提交、释放待完成，不能立即减少额度；超时查询原 requestId，重试相同载荷。47120 版本冲突刷新，47121 进入持久已移除态，47122 是请求 ID 载荷冲突，47123 表示旧连接命令不可重获执行许可。47022 是等待名额，不是凭证失效。

## 3. 桌面接线

- 新共享 DTO：`src/shared/remote/connections.ts`；IPC：queryConnections、removeConnection、resumeCurrentConnection、queryConnectionOperation。每次携带 expectedAccountEpoch，凭据只在主进程持有。
- `RemoteConnectionClient` 负责 HTTP 管理和结果身份/版本检查；`RemoteBridge` 保存按服务环境、账号、空间隔离的移除状态，暂停新同步/文件/claim，保留有界既有命令回执。恢复只来自用户操作。
- `remoteDeviceConnections` renderer store 独立管理快照和幂等操作，前台约 15 秒刷新、后台降频、页面关闭停轮询。切号清列表/弹窗/草稿；失效响应不得覆盖新账号。
- `RemoteDeviceSettings` 保留真实当前电脑与本地重命名状态，新增官网 QR 横幅和 `RemoteDeviceConnectionList`。当前电脑不在列表重复渲染，服务器 quota 仅用于额度状态判断；页面不展示计数或上限，presence 不可用保留独立错误提示。
- 被移除电脑显示“重新连接”；满额显示“等待连接”“管理连接”。唤醒与手机连接开关仍在侧栏弹层，本页不加全局保存/取消。
- 已连接 WS 不因页面列表请求失败主动断开。本地新建、继续、审批和运行不等待远控管理请求。收到 hello 才显示本机在线，同步恢复仍走原 cursor/epoch，不重放任务。
- 已发出执行许可无法从网络瞬间撤回；已开始任务继续。暂停时只对账命令 ACK/reconcile；启动命令 applied 仅表示已启动，任务终态/内容/文件恢复后同步。

## 4. 发布与注意事项

先执行服务端 V98（MySQL 5.7，无外键、增量列与回执表），再发布服务端。所有新开关默认 true。旧新节点混部时显式 `REMOTE_DEVICE_CONNECTION_MANAGEMENT_CLUSTER_READY=false`，全节点升级后再恢复 true，然后发布桌面。入口临时 `REMOTE_DEVICE_CONNECTION_MANAGEMENT_ENABLED=false` 保留 GET/resume；clusterReady=false 禁止 v2 写操作。

旧客户端未被移除时保持原行为；旧电脑一旦被主动移除，须升级后在该电脑显式恢复，确认框提前说明。removed 状态写入后不能回滚到完全不理解该状态的服务端。无需改 WS 地址、Nginx 或 Redis/MySQL 基础设施。

本次已执行并校验测试库 V98（记录见服务端 `docs/operations/2026-09-18-test-v98.md`），未执行生产迁移或部署；服务端测试按项目约定不运行。服务端编译、桌面测试与 UI 验证结果记录在服务端增量 Spec §9。真实 4 节点并发/Redis 故障恢复需测试环境验收。


## 2026-09-18 紧凑页面补充

本次仅优化桌面端展示，沿用本文既有接口、认证、连接额度及移除/恢复语义，无新增服务端或数据库变更。

- 顶部横幅 116px、二维码区域 80px、设备行最小 64px；当前电脑的分组标题和刷新入口放在卡片外，数值额度不展示。
- 单机时不显示其他设备空框，通用规则收进标题旁的信息浮层；满额、移除、失联、同步失败和管理接口故障继续内联展示。
- 帮助中的名额说明统一使用无数字文案，不读取额度快照。接口未暴露保留时长，因此不写死 90 秒。
- 直接从账号菜单打开设备管理时隐藏全局保存按钮；本次访问过其他设置页后保留原保存入口，避免影响共享表单草稿。
- `RemoteDeviceConnectionSummary` 仅保留刷新，`RemoteDeviceConnectionList` 仅展示其他连接和操作反馈，`RemoteDeviceHelp` 负责说明交互，列表与刷新复用同一个管理状态源，帮助仅保留账号边界订阅。
- 旧服务端无管理能力时仍保留当前电脑和既有恢复入口。

验证：相关 5 个 Vitest 文件、65 个用例通过；TypeScript noEmit 通过。已在运行中的 Electron 开发版验证正常页面、说明打开及 Esc 收起；未更改真实设备名称、移除设备或切换远控开关。


## 2026-10-27 隐藏数值额度

设备管理不再展示“已连接数量 / 上限”，帮助中也不展示“最多 N 台”。保留刷新、设备状态、满额和恢复提示，以及原有服务端额度判断。此变更仅涉及桌面展示，不更改 API 字段、限额或认证。后台额度按现有服务端配置发布流程调整，不需要同步修改客户端文案；没有新增 Admin 热调额能力。

详见 [客户端 spec](../../specs/bugfixes/device-management-quota-display/2026-10-27-hide-device-quota-count.md)。本轮 95 项相关测试、类型检查、严格 lint 及实际 Electron 页面核验通过。
