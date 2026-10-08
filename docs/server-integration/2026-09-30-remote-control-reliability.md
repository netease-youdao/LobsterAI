# 手机远控可靠性接口对接（2026-09-30）

> 2026-10-08 全面评估：最新源码核验、存储方案和新增 X08/V46–V55 见[10/08 Spec](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-10-08-remote-control-assessment.md)。本次只更新设计与交接文档；下列已有 API 契约保持，新方案尚未实施，未运行测试或变更数据库。

本轮为兼容扩展。普通开关默认开启，但分页控制基线和发布封存须在全部服务端 writer/reader/GC 升级、迁移验证后显式声明 readiness；客户端仅根据 capabilities 启用。本文描述源码契约，不代表服务已部署或手机 App 已接入。

> 2026-09-30 第二轮复核：本文原接口章节继续记录现有源码；文末新增优化要求属于待实施设计，不新增已可调用的 API、IPC 或 capability。跨端方案见[可靠性总 Spec §10](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-30-remote-control-reliability-remediation.md#review-20260930)，本次仅修改文档。

## 变更概览

| 能力 | 接口 | 使用方 |
| --- | --- | --- |
| `control_checkpoint_pages_v1` | `POST /api/remote/v1/control/bootstrap/paged`，复用原 parts/commit/abort/query | Electron |
| `live_publication_resolution_v1` | `POST /api/remote/v3/sync/live-projections/{publicationId}/resolve` | Electron |
| `partial_read_view_v1` | `GET /api/remote/v2/sessions/{sessionId}/read-view` | 手机 App，必须 projectionVersion 5 |

旧 bootstrap 保留最多 4 片/64 条，旧 snapshot、commands、错误码和认证语义保持。坏控制事实使用既有 `47014/SYNC_IN_PROGRESS`；已 accepted 命令只延期，不能将该错误视为已拒绝、执行成功或重发许可。

## 认证与公共上下文

沿用 JWT Bearer、原设备凭据及 owner/scope 权限校验。桌面新 mutation 必须携带已验证的 `X-Remote-Data-Space-Id` / `X-Remote-Data-Generation`，不可猜测或换成另一个服务端的数据目标。请求公共字段继续使用 `deviceId`、`owner:{userId,scopeKey}`、`sessionId`、`localSessionId`、`writerGeneration`、`mode`，在线模式另需 `connectionGeneration`。

## 分页控制基线

begin 复用 `operationId/controlEpoch/throughFactSeq/coreCheckpointId`，增加：

```json
{
  "checkpointFormat": "paged_v1",
  "captureControlRevision": "42",
  "totalRecords": 65,
  "totalBytes": 12000,
  "pageManifest": [
    {"partNo":0,"payloadHash":"sha256","bytes":6000,"recordCount":32,"kindCounts":{"message.deleted":32}},
    {"partNo":1,"payloadHash":"sha256","bytes":6000,"recordCount":33,"kindCounts":{"message.deleted":32,"session.upsert":1}}
  ],
  "requiredSets": {
    "commands":{"count":0,"sortedIdsDigest":"sha256"},
    "runs":{"count":0,"sortedIdsDigest":"sha256"},
    "approvals":{"count":0,"sortedIdsDigest":"sha256"},
    "questions":{"count":0,"sortedIdsDigest":"sha256"}
  },
  "manifestHash":"sha256"
}
```

示例省略公共上下文，hash/bytes 为说明值。实际使用排序键的规范 JSON：每片 hash/bytes 对 `records` 计算；父 hash 固定 `checkpointFormat/captureControlRevision/totalRecords/totalBytes/pageManifest/requiredSets` 及实际存在的 `sourceManifestHash/frozenThroughSourceSeq/expectedResolvedSourceSeq`。`requiredSets` 四组绑定最近 activation 返回的原核对集合；额外本地 run 放 records，不改变这四组集合摘要。

每片最多 64 条、完整 HTTP body 64 KiB，最多 256 片/4096 条/16 MiB；manifest 本身最多 48 KiB。先持久冻结原片和原 hash，再上传。相同 partNo/hash 幂等；重试不延长有效期。5 分钟无新片或 30 分钟绝对期限后必须查原终态。

commit 冲突的关键集合变化会得到真实 `state:"superseded", reason:"CONTROL_CHECKPOINT_STALE"`，原活动基线保留；客户端归档该终态后使用新 ID 重新冻结。不得把 superseded 当作 controlReady。提交成功包含原 state 字段、`controlReady:true`、`committedSeq`、`manifestHash` 和 `preparedDigest`，不推进历史 source ACK。

## 未知 live 发布核对

先按原 publicationId GET 查结果；404/超时不是“从未写入”。确有可独立验证的 session/writer/publication 绑定时，POST resolve：公共上下文加 `resolutionId`、`action:"recover_or_seal"`，可选 `expectedOriginalRequestHash`。

响应包仍为 `{code:0,message:"success",data:...}`：

- `state:"original_terminal"`：包含 `publicationId/sessionId/writerGeneration/originalRequestHash/objectKind/objectId/receipt`，复用原 accepted/superseded/rejected 回执。
- `state:"sealed_unpublished"`：包含 `sealId/publicationId/sessionId/writerGeneration/resolutionRequestHash/sealedAt`。原 ID 的迟到写入被同一数据库主键拒绝；没有 serverSeq/projectionRevision/source ACK 前进。

`resolutionRequestHash` 对原 resolve body 加 publicationId 后、删除 mode/connectionGeneration 计算。相同 resolutionId 必须保留原 body；存量原回执可能缺少 objectKind，不能自行猜测目标。没有可信绑定时维持该任务核对，不得换新 ID 绕过。

## 手机部分读取视图

必须 `X-Remote-Projection-Version: 5`；缺省或其它版本返回既有 `47017/CAPABILITY_UNSUPPORTED`，App 回退原 snapshot。认证、撤权、任务删除和目标校验继续生效。

返回 `viewVersion:"1"`、`identity`、`session/sessionState`、`control:{state,reason,retryAfterMs}`、`messages:{items,beforeCursor}`、`tools:{items,nextCursor}`、`decisions:{state,approvals,questions,approvalsNextCursor,questionsNextCursor}`、`displayState/readSeq/readerGeneration/activeSnapshotVersion/controlCheckpointVersion/serverTime`。

`session:null` 或 `decisions.state:"partial"` 表示不可确认，不能解释为 idle/无待办。历史可继续呈现，执行仍走原命令准入。翻页参数为 beforeCursor/toolsCursor/approvalsCursor/questionsCursor；待办游标不可跨类别或授权代次使用，读基线变化后按既有 resync 错误重新读取。首屏走 LIVE 预算，翻页走 BACKGROUND。

## 发布注意事项

V106 为新构建命令完整性最低结构；V107 提供公平扫描，V108 提供分页基线，均兼容 MySQL 5.7、无外键。2026-09-30 测试库 V107/V108 已执行，V106 结构复核通过；生产迁移未执行。服务端执行记录为 `docs/operations/2026-09-30-test-v107-v108.md`。测试规模的结构/EXPLAIN 核验不代替真实规模性能、全节点兼容及 App 验收，本次未调整 readiness 或部署服务。已产生新格式证据后，回滚构建必须仍理解封存、基线和本地执行账本；只关闭能力公告不能解除已有 writer fence。

服务端测试按项目约定未执行；源码编译通过不替代真实 MySQL/Redis/手机的验收。

## 第二轮优化：桌面实现约束（待实施）

本节对应总 Spec R30-01–R30-17，不改变上面的请求字段、认证、回执或限额。已有分页基线、发布封存和部分读取无需重建；新增目标仍需代码实现与验收。

| 范围 | 桌面侧要求 | 两端依赖 |
| --- | --- | --- |
| 本地执行核心 | 远控适配器失败后仍有统一 submit 服务，保留 actor/generation、agent 权限、输入/删除 fence 和真实派发证据；不得裸调用 start/continue handler | 本地内部边界，不新增远程命令入口 |
| 可选同步存储 | 纯投影/队列/缓存故障不回滚核心消息；必要归属、审批、删除及最小 revision 仍原子保存 | 本地增量迁移；回滚构建须理解已写入证据 |
| 坏记录范围 | 先用独立可信绑定定位 task/owner，再解析正文和检查大小；无关任务/旧账号不触发全局显示同步阻断 | 未知共享执行事实仍保持必要保护 |
| 活动与归档 | live/control 已终态请求退出活动额度，证明归档和计数同事务；按任务公平调度、物理磁盘仍有总预算 | 只接受原 publication/resolution 的可信终态，不清未知请求 |
| 重试分类 | worker busy/timeout、网络故障不误判持久内容损坏；非法可选重试提示只丢弃提示，按原业务错误分类；未知结果先查询 | 403、hash/fence 等不因提示坏而放宽；尊重有效等待，不换 ID 绕过去重 |
| 历史缺口 | 通过已协商 recovery/gap 处理坏显示对象，不改变正常 batch 连续原子 ACK | 服务端显示 400/413 分类及 partial 读取修复解耦待完善 |
| 文件旁路 | 文件失败独立展示/重试，原冻结输入不变；排队和执行超时分开，真实退出才释放许可 | 用户本次执行必需附件不能被静默丢弃 |
| 删除与目标迁移 | Pending 逐行检查、recover/claim 公平轮转；全量 activate 复用增量 admission 边界 | 原 claim/permit/fence/停止证明及未归属 inbox 保护不变 |

“恢复运行状态”是原证据核对与 CAS 决议，不是清隔离。坏 run 不按 null 处理，内存 inactive/404/超时不等于未执行或已停止；只撤销旧 writer 写权限不证明其工具已经停止。确认原运行结束且当前控制事实可信后，可继续原会话的新运行，旧命令未知结果及不可重放事实仍保留。

上述本地恢复不自动解除服务端未解决命令占用。原启动仍 reconciling 时，手机继续遵守既有 SESSION_BUSY/待核对行为，须先按原协议可信结算；仅发布终态 run 不够。本批不新增“未知命令解除占用”协议，也不通过假终态或忽略所有 reconciling 放行。只有显示历史缺口而当前命令/控制完整时，手机续聊无需这一额外恢复。

本地账号归属与远端目标签名分开判定；只有前者有独立可信证据时，远端证明失效才能仅暂停远控。本次不批量解除旧 quarantine、不把任务变匿名、不自动创建替代会话，不清 ACK、安装身份或本地引擎上下文。

## 第二轮优化：消费方状态与验收（待执行）

- 分别展示连接、控制、当前内容、历史和文件状态；历史缺口且 control ready 时允许发送/合法停止。control unknown 只限制依赖动作，保留可信历史及草稿，不能假定 idle 或完成。
- 同一任务多种故障只计一个失败任务；任务详情、projection failure 和整体 Degraded 使用同一有效故障集合。当前已有整体投影降级显示，本轮目标是补齐计数、详情与调度一致性。
- “重试同步”仅安排原操作调度/核对；“核对运行状态”遵循证据恢复流程，不重跑工具/旧命令。自动恢复不反复弹窗、不要求清缓存或重新登录、不打开用户关闭的远控。
- 支持 partial_read_view_v1 的 App 保留健康缓存，session:null 不当删除、decisions.partial 不当空待办；修复写入失败时安全返回 partial 的新行为须待服务端实现。旧 snapshot/WS 契约不变，旧 App 对坏控制快照的限制仍须明确。
- 现有严字段校验不能全局删除。新增显示字段按 projectionVersion/capability 协商；命令、审批、输入和删除 proof 继续严格。没有新能力时不发送新字段，不回落不理解 writer fence 的旧写入方式。
- 对应验收为总 Spec V23–V45：包含主窗口与 IPC 的真实接线、文件 worker/网络/数据库故障、跨任务和跨账号、已处置请求累计超过 32 MiB、恢复各阶段重启、手机 partial 合并及混版回滚。测试目标不等于本次已通过。

MySQL 5.7、useAffectedRows=true、增量无外键迁移及全 writer/reader/GC readiness 继续适用。先结构核验和兼容服务端，再满足真实 readiness、公告能力、小范围启用；原操作查询/核对/abort 及已激活会话不能随能力关闭一并停止。已有测试库迁移记录不证明后续新增结构已执行，也不证明生产已就绪。


## 2026-10-08 评估补充与消费方任务（待实施）

本节补充现有 R30 计划，保留本文件原文和工作区既有修订。没有新增线上 API、已发布 capability 或数据库迁移；既有认证、错误码、请求/响应仍以正文为准。受限环境首次 DNS 失败，确认网络权限后已完成测试库只读元数据核验：MySQL 5.7.33-36-log，58 张远控表，data+index 估算约 52.9 MiB；未改库、未做功能或性能验收。小样本和历史迁移记录均不证明生产就绪。

| 使用方 | 具体工作 | 兼容与验收 |
| --- | --- | --- |
| Electron 本地执行 | 在远控适配器前独立初始化共享执行核心；保留 actor/generation、agent 权限、输入/删除 fence、真实派发/审批证据 | 远控可选构造失败下验证真实主窗口和 start/continue/stop IPC；不得裸调 handler 代替核心 submit |
| Electron 同步 | 私有 questionDecision 先可信绑定后局部解析；活动请求与终态归档分账；瞬时 encoder/worker 失败不计永久内容损坏 | 旧账号坏行不污染独立健康任务；resolve 累积超过 32 MiB 后健康 live 仍可入队；原未知请求不丢 |
| Electron 文件 | 排队/执行 watchdog 分开；实际 worker exit 后再释放资源和重启 | 旧回包不完成新请求；一个慢文件不永久隔离其他文件；用户本次必需输入不被静默剔除 |
| 手机 App 首次订阅 | 先独立 catalog，再逐会话 subscribe；每任务单独保存游标、恢复和退避 | 无需新服务端接口；最多 5 个会话及现有预算不变。旧 App 同帧批量仍有单任务失败牵连首次订阅的边界 |
| 手机 App 部分视图 | 按能力使用 v5 read-view；保留草稿/健康缓存，partial/session:null 不当删除 | decisions.complete 不代表全集耗尽，继续按 approvalsNextCursor/questionsNextCursor 翻页；命令接口最终核验 |
| 后续分页增强 | 使用能覆盖所有控制变更的独立集合版本；旧游标仍按原 readSeq 规则 | 当前 controlVersion 并非每次审批/问答更新均递增，不能简单替换；新语义须能力/游标格式协商，尚不可调用 |

现有 WebSocket 协议下的建议 App 订阅顺序（示例；afterSeq 使用该任务已应用的连续水位）：

```json
{"type":"subscribe","requestId":"catalog-1","catalog":true,"sessions":[]}
{"type":"subscribe","requestId":"task-a-1","catalog":false,"sessions":[{"sessionId":"session-a","afterSeq":"42"}]}
{"type":"subscribe","requestId":"task-b-1","catalog":false,"sessions":[{"sessionId":"session-b","afterSeq":"7"}]}
```

上面是三条独立帧；等待各自 subscribed/错误后按预算推进。catalog=false 不取消已有目录订阅。B 需要 resync 时，只恢复 B，不把 A 的游标归零、不清 A 缓存、不反复重连整条健康 WS。服务端旧 subscribed 成功语义不改成隐式部分成功；逐项 accepted/failed 帧若需要，另行版本化。

历史缺口但控制可信时仍允许原会话继续和合法停止；控制未知只限制依赖动作，不重放旧命令、不清 ACK、不重新生成安装身份。原服务端启动仍 reconciling 时须按旧协议取得可信结算，不能用本地 run 终态绕过。

服务端存储优化对现有客户端保持透明：不按日期删除原幂等键或旧请求结果；checkpoint 必须覆盖验证后回收，writer fence/权限/删除语义不变。若新增冷内容表示或分页协议，另出实际 API 接入文档。所有普通开关默认 true，schema/writers readiness、权限和存储证明仍需真实满足。上线顺序与回滚边界见[10/08 兼容计划](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-10-08-remote-control-assessment.md#compatibility-plan)。

本次未提供手机源码或具体 build，未完成 App 接入/真机验收；上述 UI/订阅任务需由手机项目承接。新增验收 V46–V55 与原 V01–V45 分别登记实现、验证和部署证据。

> 2026-10-08 执行更新：已进入代码修复阶段，实际实现、接入和限制见[故障隔离修复指南](2026-10-08-remote-control-fault-isolation.md)。本文此前“本次仅文档”是评估阶段记录。
