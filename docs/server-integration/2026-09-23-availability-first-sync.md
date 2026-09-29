# 手机远控：独立控制、当前展示与历史缺口恢复

日期：2026-09-23。此次修改服务端和 Electron；没有修改 iOS。

## 改动及消费方行为

桌面接管原会话后，控制事实和当前消息通过独立协议发布，不再排在历史 outbox 后面。一条坏的旧 artifact/message 不会阻止后续真实运行状态、新消息或手机命令领取。原会话身份、核心命令幂等、审批、问题决定、删除保护继续使用已有真实核心状态。取消旧 run 时只有真实本地终态历史可返回 already_terminal；不存在的 run 不会被当作已结束，也不会误停新的 run。

桌面新增 `RemoteAvailabilityPublisher`，负责三个分别计时的任务：控制事实、当前消息/工具、可选历史恢复。当前消息取核心对象的真实递增版本，重编码由有时间/堆预算的子进程完成。历史投影及 import 编码也使用可终止子进程。可选 Agent 目录、模型公告、产物基线收集不占用下一次命令领取的等待链路；必需的输入附件准备仍须成功后才能执行。

这不是所有远控逻辑迁入独立进程：WS、命令执行桥和短核心 SQLite 事务仍由主进程拥有。当前实现隔离了重编码进程、历史存储、重试队列和可选网络等待；不能承诺主进程崩溃、核心数据库损坏、网络或认证故障时仍能远控。

## 服务端部署及认证

先执行 V103、V104；启用历史恢复需要 V105。所有共享数据库的服务端 writer 升级完成后，设置 `REMOTE_AVAILABILITY_WRITERS_READY=true`。该配置是多节点兼容部署的确认，不是普通产品功能开关。

三个功能开关默认开启：`REMOTE_CONTROL_FACTS_ENABLED`、`REMOTE_LIVE_PROJECTIONS_ENABLED`、`REMOTE_SYNC_RECOVERY_ENABLED`。桌面只在同时收到 `control_facts_v1` 和 `live_projections_v3` 后开始新接管；新历史恢复还要求 `sync_recovery_v3`。撤回能力公告不使已接管会话恢复旧 writer，也不丢弃原未知请求。

全部接口沿用 JWT Bearer 和桌面设备凭据，同时必须携带 `X-Remote-Data-Space-Id`、`X-Remote-Data-Generation`。公共 body：

```json
{"deviceId":"desktop","owner":{"userId":"123","scopeKey":"personal"},"sessionId":"remote-session","localSessionId":"local-session","writerGeneration":"fixed-writer-id","mode":"online","connectionGeneration":"current-connection"}
```

`writerGeneration` 在重连后保持不变；`connectionGeneration` 可更新。请求 ID、业务内容和 hash 在结果未知时保持不变，先查询原回执，404 后也只重放同一请求。接口统一返回 `{code,message,data}`，必须核对 `data.state`。

## 协议路径与数据

| 方法/路径 | 作用 |
| --- | --- |
| POST/GET `/api/remote/v3/sync/mode-activations[/{id}]` | 原会话持久接管；返回需核对的命令、run、审批和问题 ID |
| POST `/api/remote/v1/control/bootstrap` | 封存控制基线 |
| PUT `/api/remote/v1/control/bootstrap/{id}/parts/{partNo}` | 发送带 hash 的完整控制记录 |
| POST `/api/remote/v1/control/bootstrap/{id}/commit`、`abort` | 核对提交或明确终止；缺失 begin 的 abort 使用原 `beginRequestHash` |
| POST `/api/remote/v1/control/facts/batches` | 连续 `factSeq` 的真实控制变更，每批最多 16 条/64 KiB |
| GET `/api/remote/v1/control/operations/{id}` | 原操作回执 |
| POST/GET `/api/remote/v3/sync/live-projections[/{id}]` | 单个当前消息/工具完整发布及原回执 |
| GET `/api/remote/v3/sync/state` | 历史独立水位 |
| POST/GET `/api/remote/v3/sync/recoveries[/{id}]` | 原历史恢复计划及核对 |
| PUT `/api/remote/v3/sync/recoveries/{id}/parts/{partNo}` | 不可变恢复 manifest/分片 |
| POST `/api/remote/v3/sync/recoveries/{id}/commit`、`abort` | 独立 resolved 回执或明确终止 |

控制基线提供 `operationId/controlEpoch/throughFactSeq/coreCheckpointId/manifestHash/partCount/kindCounts/pendingCommandIds/pendingCommandIdsDigest` 以及服务器要求的待处理对象集合；每条 `{eventType,payload}` 使用原完整控制对象。缺失真实本地执行或决定证据时停止该基线，不推断已取消或重新执行。历史专用基线在控制通道上使用 3 秒总预算，HTTP 使用剩余 AbortSignal 超时；等待期间发现新核心控制版本立即让位，原请求留待核对。`COMMAND_LEDGER_CHANGED` / `CONTROL_LEDGER_CHANGED` 必须先核对并终止旧基线，再创建新 ID。

当前对象示例（公共上下文略）：

```json
{"publicationId":"immutable-id","objectKind":"message","objectId":"original-message-id","sourceObjectRevision":"12","representation":"complete","policyVersion":"1","payloadHash":"sha256-of-canonical-payload","payload":{"messageId":"original-message-id","role":"assistant","status":"completed","blocks":[]}}
```

示例仅展示新增字段，完整 payload 仍需原 message/tool 必需字段；不提交 wire `revision`。服务端分配手机可见版本，返回 `accepted/superseded/rejected`。超大正文采用诚实的 `desktop_only` 表示。已确定失败的单条正文可使用新 publication ID 提交同来源的明确占位；不能修改原请求。产物公开元数据变更也在核心事务中增加消息来源版本，上传完成可独立刷新 ready 卡片，不要求历史 ACK 追平。

完整字段和约束见[服务端协议](../../../lobsterai-server/docs/api/remote-availability-v3.md)。

## 本地持久化及历史恢复边界

- 核心库保留会话身份、真实执行/决定事实、递增来源版本和原 v1/v2 outbox/ACK 原始证据。
- `remote-control.sqlite` 保存控制与当前对象请求、结果、对象级失败预算；已采用的文件丢失或身份不匹配时不悄悄新建空账本。
- `remote-sync.sqlite` 按 prepare/copy/verify/ready 切换，仅保存 v3 历史恢复操作及独立水位。损坏或不可用只暂停历史，不阻止已建立的控制和当前消息。

首版自动 H1 每次最多核对 64 条旧 source（读取预算 512 KiB），使用**空对象合并并记录明确范围缺口**。当前最近消息/工具已由 live 通道发布；H1 不删除已有服务端健康历史，也不声称补齐所有旧内容。它不会重置会话、source/epoch、旧 ACK 或原始请求原文。

受保护旧记录必须能在封存核心中找到相同身份、足够版本及一致终态的 run/审批/问题/墓碑。专用控制 checkpoint 绑定精确 `sourceManifestHash/frozenThroughSourceSeq/expectedResolvedSourceSeq`；普通控制基线不能替代该证明。未知事件、缺失 core 证据或不可解析原文仅暂停历史。恢复成功仅推进 `historyGeneration/resolvedSourceSeq`，`exactSourcePrefix` 保持准确回执的语义。

服务端另有 v3 连续历史批次和非空近期对象 merge 接口；此桌面首版自动路径尚未使用它们补齐全部旧展示。旧存量 outbox 保留用于审计，不做破坏性清理。

## 验证及发布检查

回归覆盖坏历史下的当前消息/控制、迟到回执不回退新基线、核心版本回滚、多墓碑分批、旧终态 run、审批完整基线、关闭新接管公告后的既有 writer、显式历史缺口/缺失保护证据、文件上传后 ready 版本更新、子进程终止及打包。最终验证：`npm run compile:electron` 通过；全部 33 个改动 TypeScript 文件严格 ESLint（0 warning）通过；23 个定向测试文件共 385 条通过。测试数量去重计算：综合回归中未再修改的 18 文件/256 条，加上最终增量回归的 5 文件/129 条，未重复累计中间测试。最终增量包含 availability 22、恢复证明 4、命令轮询 26、命令执行 28、文件同步 49 条。

尚未执行测试服迁移/部署、双端真机验收或规模压测。上线应实测原坏会话能继续对话、停止/审批正常、新回复和 ready 文件卡片到达、断线与未知响应重启后仍使用原操作 ID。回滚须使用理解新 fence 的构建，不能删除账本或启动不认识 fence 的旧桌面。
