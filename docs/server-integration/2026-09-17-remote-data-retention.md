# 远控同步保留 v2：桌面端接入

2026-09-22 同步设计更新（代码已实现，未部署）：见[远程同步使用当前生效服务](../../specs/bugfixes/remote-sync-target/2026-09-22-effective-server-sync-design.md)。最终不以域名或线上／测试模式阻断同步，而由当前服务确认绑定及进度；下文描述既有协议，新增身份发现和目标校验的部署状态见 2026-09-22 配套接入文档。

2026-09-17。本次实现服务端数据保留方案所需的桌面同步协议与源头减量；是否可用以服务端能力公告为准。需要先部署扩展数据库结构及所有服务节点，再发布桌面端。本文不表示线上已开启清理。

默认值更新：按用户要求，服务端 retention 功能开关全部默认开启，`mode=purge`、`cluster-ready=true`。部署前必须完成 V95–V97，并确认所有共用数据库的实例兼容；混部期间须显式覆盖 `mode=observe`、`cluster-ready=false`、`sync-v2-enabled=false`，完成升级后移除临时覆盖。NOS 配置、引用保护与删除证明仍需满足；桌面继续依据实际 capabilities 协商。

## 变更摘要

- HTTP、WS 路径仍为 `/api/remote/v1`、`/api/remote/v1/ws`，不改变登录方式。`syncProtocolVersion=2` 与消息 `projectionVersion=4` 是独立协议。
- 桌面使用增量 SQLite 列保存服务环境、协议、epoch、恢复水位和迁移冻结状态；原 v1 outbox 不改 ID 或正文。
- 已登录归属的会话才同步；owner、scope、设备、服务环境必须匹配。数据回滚、身份/epoch 不一致只阻断该会话同步，本地 Agent 不因此重跑。
- 能力未知不会写入 false。投影模式按服务环境、owner/scope、设备保存，实际格式变化仅标记当前身份的会话。稳定协商、WS 重连及重启复用原 SavedImport。

## 能力与认证

`GET /capabilities` 新能力为 `sync_retention_v2` 和 `operation_receipts_v1`，前者还要求：

```json
{"syncRetention":{"version":2,"eventReplayDays":7,"eventIdAlgorithm":"sha256-array-v1"}}
```

能力发现继续使用原 v1 请求。其他管理请求使用既有 Bearer 和 `X-Remote-Device-Credential`。写请求保留 `mode`、`connectionGeneration`。状态 GET 不携带新写入许可，不因读取而改变 ACK。

新迁移开关关闭时，v1 保持原协议。已持久激活 v2 的会话必须继续 v2；桌面通过状态接口核实兼容性，遇到不认识协议的旧服务暂停该会话远程同步，不能自动降级或生成新身份。

## 状态读取与首次导入

`GET /sync/state?localSessionId=<本地会话ID>` 返回 `deviceId/sessionId/localSessionId/syncProtocolVersion/streamEpoch/lastSourceSeq/lastSeq/sourcePurgeSeq/eventPurgeSeq/activeImport`。

仅 `404 / 47038 / SYNC_STATE_NOT_FOUND` 且本地 v1、ACK 为零时允许首次建立映射。普通 404、其他设备的映射以及服务端序号超过本地持久上限不能当作新任务。GET 的序号只作为新导入的期望基线，不能用于删除 outbox。

后续设计将这些进度条件限定在**当前服务的绑定**内：另一个服务的旧 ACK 既不能阻止经权威确认的新绑定，也不能被新绑定复用。已发布会话在当前服务缺失时，需要新增 resolve/reservation 契约确认可以 bootstrap；现有 47038 不提供该授权。同流安全快照、回滚/未知历史、删除墓碑与真正的新服务分支详见新 spec §4–7；在新协议实现前，上述既有门禁保持有效。

`POST /sync/imports` 在原 DTO 上增量添加：

```json
{"syncProtocolVersion":2,"expectedStreamEpoch":null}
```

首次或 v1 升级使用 null；v2 恢复使用现有 epoch。完整的 importId、records、parts、manifest、projectionVersion、身份及触发原因先保存在一个 SQLite 事务里。首次迁移同事务冻结远程投影，Agent 原始消息仍继续写入，dirty 标记保留。

begin 返回 `targetStreamEpoch`、`manifestHash`。桌面先校验并持久化，再调用：

- `PUT /sync/imports/{id}/parts/{partNo}`：原 payload/hash，加 `syncProtocolVersion=2, streamEpoch=targetStreamEpoch`。
- `POST /sync/imports/{id}/commit`：原 expectedStateVersion/manifestHash，加相同协议/epoch。
- `POST /sync/imports/{id}/abort`：原 expectedStateVersion/reason，加相同协议/epoch。
- `GET /sync/imports/{id}`：恢复原操作状态，不创建替代 ID。

begin/commit 丢 ACK 时重试原 importId。只有固定终态回执的 importId、session、epoch、manifest、baseSourceSeq、提交位置全部一致，才能在一个本地事务内激活协议、ACK 删除 ≤N outbox、删除 SavedImport、解除冻结。事务尾部将冻结期间的 dirty 生成为 N+1 的 v2 事件。

普通 v2 恢复沿用 epoch，快照 N 之后可继续生成事件，ACK 只删除前缀。删除会话、格式切换或基线竞争须先确认原导入提交/中止；未知结果保留原包。`IMPORT_PARTS_EXPIRED` 查询父回执：committed 补 ACK，aborted/expired 才重建。

## 增量批次

`POST /sync/batches` 保留原 DTO，增加 `syncProtocolVersion=2, streamEpoch`。eventId 算法：

```text
UTF8(JSON.stringify(["remote-sync-event-v2", deviceId, sessionId, streamEpoch, canonicalSourceSeq]))
→ SHA-256 → base64url 无 padding → 加 e2_
```

跨 Java/TypeScript 金样例：

```text
["remote-sync-event-v2","dev_pc_demo","session_demo","11111111-2222-4333-8444-555555555555","42"]
e2_Vck7wl6vbphlOngJDSFvQ7SOBxpXFWIcksQ-bmHRztU
```

wire 序号使用规范十进制字符串，本地现有 SQLite 数值路径在安全整数边界前阻断。ACK 校验 batch/device/session/协议/epoch/提交范围，水位单调保存。固定旧 import 回执中的历史 floor 不覆盖更大的本地 floor。

`409 / 47015 RESYNC_REQUIRED`（SOURCE_WINDOW_EXPIRED、GAP 等）停止原批次重试，查询状态并建立完整快照；epoch 不能核对则保留数据并阻断。设置页“重新连接”可以重试已阻断项；不会以换 eventId/epoch 绕过冲突。

## 设备 fence 与精简回执

`GET /devices/{deviceId}/sync-retention/fence` 查看旧会话/导入 blocker。全部本地会话迁移后尝试 POST：

```json
{"requestId":"22222222-3333-4444-8555-666666666666","expectedFenceVersion":"0","minSyncProtocolVersion":2,"mode":"online","connectionGeneration":"12"}
```

requestId 和业务字段持久化；网络重连只改变 transport。服务端依然校验本地未保留的历史会话，桌面不能删除这些会话强行完成升级。409 blocker、426 未开放均延后尝试，不影响已迁移会话。

声明 `operation_receipts_v1` 后，终态 `detailState=compacted` 可能缺少原 request/claimHistory。桌面更新本地终态，不将缺失字段解释为“未执行”，不请求执行许可，不重新执行命令。

## 发布与验证

1. 服务端新增 DDL、双读兼容和所有节点上线；混合节点期间暂不公告新迁移。
2. 开启服务端协议迁移能力并发布桌面，observe 下先核实导入、批次和丢 ACK 恢复。
3. 分类型启用清理；NOS 删除闭环未验证时继续阻止依赖它的回收。
4. fence 是不可逆最低协议限制，执行之后不能回滚到不认识 v2 的旧服务/客户端。

定向覆盖：确定性 ID、SQLite 冻结重启/dirty 不丢、十次进程重启与十次 WS 协商无重复导入、账号隔离、begin/commit 丢 ACK、源窗口恢复、服务端超前阻断、精简回执不执行、fence blocker；已通过完整远控模块 25 个测试文件、325 项测试（其中 retention 新增 15 项）、Electron 编译和改动文件 ESLint。真实四节点竞争和 App 游标恢复仍需联调；本次未启动任务或依赖外部服务的端到端测试。
