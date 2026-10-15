# 远控可靠性接入与桌面实现（2026-10-15）

本轮实现 RC-13、RC-14、RC-07.S 及服务端逐项命令恢复接入。保留已有脏工作区改动；未改手机 App、未部署、未执行数据库迁移。本文件补充既有 `2026-10-15-remote-iap-resilience.md`，以服务端 `docs/api/remote-reliability-v4.md` 为接口契约。

## 变更摘要

- 控制 bootstrap 每任务单飞、最多两个任务并行。1 秒调度片只决定是否启动下一请求，不充当 HTTP 超时；已经成功返回的有效回执可落盘。begin 与所有格式的 part 确认持久化，继续同一 operationId 和不可变请求。begin 必须匹配原 operation/session/writer；committed 还须匹配 epoch、manifestHash、coreCheckpointId、throughFactSeq 及可用恢复证明，才允许 active/archive。异常后先查询原操作，不能因超时重建身份。
- 桌面主动删除在原核心 SQLite 事务记录稳定 deleteEventId、owner/device/session/environment/streamEpoch/sourceHighWatermark 及可用的原 v3 writer/epoch 绑定，不访问远控旁库。旁库故障不阻塞本地删除。恢复后用独立单条 `session.deleted` 控制事实提交，完整验证原服务端删除回执后才保存独立 ACK；不改写 legacy sourceSeq/ackSeq，也不以本地缺行推导删除。
- 健康状态读取 v3 控制 revision、未确认请求、live 源变化、历史和删除进度，增加可选 `lanes` 与 `countsTruncated`。历史读取失败显示 unknown，不自动推导控制不可用。展示用 live ACK 镜像不参与权限、执行许可或删除 GC。
- 能力协商后使用 v4 命令恢复，一条坏记录不会使其他可信命令丢失恢复机会；旧服务继续 v1。

## 接口与认证

沿用 JWT Bearer、`X-Remote-Device-Credential`、owner/scope 及 sync-target 认证。以下均由桌面原 HTTP 通道调用，保持请求大小限制、连接代次与执行证据校验。

### 单项命令恢复

能力 `isolated_command_recovery_v1` 存在时调用：

```http
GET /api/remote/v4/devices/{deviceId}/commands/unresolved?limit=20&cursor={opaqueCursor}
X-Remote-Connection-Generation: {currentGeneration}
```

```json
{"code":0,"message":"success","data":{"items":[{"command":{},"request":{},"requestHash":"...","currentClaimId":"...","claimHistory":[]}],"unresolvedItems":[{"commandId":"bad-id","sessionId":"original-session","diagnostic":{"kind":"stored_data_unavailable","reason":"COMMAND_INTEGRITY_BLOCKED","retryAfterMs":30000}}],"nextCursor":null,"scanComplete":true}}
```

`items` 仍走原 hash/归属/本地 inbox/received/reconcile/permit 流程。`unresolvedItems` 不覆盖本地 inbox、不制造完成状态、不删除执行证据、不授权重执行。`scanComplete` 只表示枚举完成。连接代次、目标或协议变化重置游标；47008/47019 只重启扫描，不清台账。能力缺失或新端点确实不支持时退回原 v1；旧接口仍保留原错误语义。

### v3 删除事实

`POST /api/remote/v1/control/facts/batches` 使用既有请求字段；删除为独立单条事实，eventId 来自核心墓碑：

```json
{"factSeq":"12","eventId":"stable-core-delete-id","eventType":"session.deleted","payload":{"deletedAt":"2026-10-15T08:00:00.000Z"}}
```

事实 batch 与普通 control 一样保留原 owner/device/session/localSession/writerGeneration/controlEpoch、first/lastFactSeq、batchId 和不可变请求。`payload` 不增加 deleteEventId。服务端兼容追加的成功证明：

```json
{"state":"committed","operationId":"original-batch","batchId":"original-batch","sessionId":"original-session","writerGeneration":"original-writer","controlEpoch":"original-epoch","requestHash":"canonical-business-hash","firstFactSeq":"12","lastFactSeq":"12","committedSeq":"87","deletionReceipts":[{"eventId":"stable-core-delete-id","factSeq":"12","deletedAt":"2026-10-15T08:00:00.000Z","serverSeq":"87"}]}
```

requestHash 是实际发送的业务请求 canonical hash，只移除 `mode`/`connectionGeneration`；本地内部 coreRevision 等不会发送。所有身份、epoch、批次、hash、单条 seq、eventId、deletedAt、serverSeq 精确匹配后，才把完整回执和摘要写入核心独立 ACK。随后旁库完成原请求；中途失败仍保留原请求，operation 查询返回原证明后继续。`covered_by_checkpoint`、已删除、404、旧服务无新增字段均不是删除 ACK。

旧墓碑没有原绑定时，仅可用原核心 writer migration manifest 及其已提交 checkpoint 原回执补证，必须匹配原 owner/device/session/streamEpoch/sourceHighWatermark/writer/epoch。证据缺失保持 pending/unknown，不为新代次构造删除、不伪造 legacy ACK。该保守分支需要运维补证，无法承诺自动修复所有历史缺证据记录。

## 健康字段

`RemoteSyncHealth` 原字段继续存在，新增可选：

```json
{"lanes":{"control":"idle","live":"pending","history":"unknown","deletion":"idle","recovery":"idle"},"countsTruncated":false}
```

lane 值为 idle/pending/in_flight/backoff/degraded/unknown。尚未生成网络请求的源变化也计入 pending；oldest 合并源、请求及删除时间；v3 lastSuccessfulSyncAt 采用实际已确认控制/live/history 进度，不借用 legacy 时间。当前一次最多检查 128 个 v3 会话，超出明确标记 countsTruncated + unknown，不能据此显示完全同步。此上限是健康查询预算，不删除任务、不限制历史保留数量。

## 发布与验收

1. 先升级服务端兼容字段和 v4 恢复端点，再升级桌面。旧服务/旧结果无删除证明时安全等待，普通桌面操作继续可用。
2. server 的普通功能开关与 writers-ready/安全证明不同；不得因为客户端接入就开启未经验证的安全证明。手机独立取消仍需 App 按服务端新 API 接入，本轮未修改手机源码。
3. 本地新增 SQLite 表均是增量表；显示镜像可重建，核心墓碑及执行证据必须保留。回滚旧桌面可能无法完成新增 v3 删除 ACK，应保留数据等待再次升级，不手改 source/ack 水位。
4. 本地针对性 Vitest 已覆盖 600 ms 非分页 bootstrap 推进、慢任务隔离、旁库不可用时核心删除、丢响应原操作恢复、旧墓碑补证、错 epoch/目标拒绝、源变化健康与 v4/旧接口恢复。仍需集成验收实际服务端 canonical hash、断网/进程重启/旁库损坏、账号切换和移动端展示；编译与单元测试不等同生产验收。

验证命令：

```bash
npm test -- src/main/remote/remoteAvailabilityPublisher.test.ts src/main/remote/remoteLocalGc.test.ts src/main/remote/remoteSessionDeletionClient.test.ts src/main/remote/remoteBridge.test.ts src/main/remote/remoteAvailabilitySessionBudget.test.ts src/main/remote/remoteTransactionSafety.test.ts
npm run compile:electron
```

当前结果：6 个测试文件、239 项通过；Electron 编译通过；本轮修改 TypeScript 文件 ESLint 无错误/警告。服务端测试未运行。
