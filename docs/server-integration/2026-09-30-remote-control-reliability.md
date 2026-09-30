# 手机远控可靠性接口对接（2026-09-30）

本轮为兼容扩展。普通开关默认开启，但分页控制基线和发布封存须在全部服务端 writer/reader/GC 升级、迁移验证后显式声明 readiness；客户端仅根据 capabilities 启用。本文描述源码契约，不代表服务已部署或手机 App 已接入。

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
