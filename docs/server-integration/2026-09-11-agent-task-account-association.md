# Agent / 任务主动关联：服务端接入增量

日期：2026-09-11。消费端：LobsterAI 桌面。服务端无需新增 MySQL DDL；依赖既有 V88/V89 远控与 Agent 表。

## 1. 变更摘要

服务端允许会话摘要中同一 Agent 从 `anonymous` 以严格更高的 `version` 单向变为 `owned`。Agent ID、会话 ID、所有者、空间、设备、原本地会话映射均保持不变。相同逻辑用于 `sync/batches` 与历史快照 import commit。

新增 `agent_ownership_claim_v1` 服务能力，独立开关默认关闭。开关只控制能力公告，关闭后保留已经上线的兼容合并逻辑，确保已准入的关联操作能够继续同步。

这是桌面归属变化后的远程投影兼容，不新增服务端“认领匿名任务”或转移账户接口。服务端看不到本机未上传的其他账号任务；完整的本地归属、关系、忙碌及原子事务检查由桌面负责。

## 2. 接口、鉴权与示例

所有路径前缀为 `/api/remote/v1`。`GET /capabilities` 使用 `Authorization: Bearer <accessToken>`；其他下表接口还需要 `X-Remote-Device-Credential: <deviceId>.<deviceKey>`。JSON 请求使用 `Content-Type: application/json`。Portal 登录 Cookie 不能替代 JWT，前端传 userId 不能替代认证。

| 方法、路径 | 用途与变化 |
| --- | --- |
| `GET /capabilities` | 新增能力字符串；只有远控、summary、claim 公告开关均开启时才返回 |
| `POST /sync/imports` | 复用首次历史快照初始化和唯一映射 |
| `PUT /sync/imports/{id}/parts/{partNo}` | 复用不可变分片，先暂存摘要；不在分片上传时改变当前绑定 |
| `POST /sync/imports/{id}/commit` | 在原会话事务锁内比较当前摘要版本并提交提升 |
| `POST /sync/batches` | `session.upsert.payload.session.agent` 可提交同 ID 高版本 owned 摘要 |
| `PUT /devices/{id}/agents` | 原匿名 Agent 作为新 owned 目录项加入，保持完整目录替换和 CAS 规则 |
| `GET /sessions`、`GET /sessions/{id}/snapshot`、`GET /devices/{id}/agents` | App 沿用现有读取接口，不新增必填响应字段 |

能力响应示例（下例省略原有 limits/features/serverTime 字段，其他能力以实际开关为准）：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "enabled": true,
    "protocolVersions": [1],
    "sessionSyncPolicy": "owned_only",
    "capabilities": [
      "same_account_access",
      "session_agent_v1",
      "agent_ownership_claim_v1",
      "agent_catalog_v1",
      "agent_selection_v1"
    ]
  }
}
```

原已同步会话的 Agent 摘要从下列左值更新为右值。`version` 仍为十进制字符串，必须严格递增；其他会话字段沿用 v1 完整契约。

```json
{
  "before": {"agentId":"agent_office","name":"日常办公","icon":"clipboard","kind":"anonymous","version":"7","state":"available"},
  "after": {"agentId":"agent_office","name":"日常办公","icon":"clipboard","kind":"owned","version":"8","state":"available"}
}
```

增量请求示例（`mode: recovery` 适用于既有会话恢复；正常在线同步沿用原协议携带 connectionGeneration）：

```json
{
  "batchId": "batch_claim_01",
  "deviceId": "desktop_01",
  "owner": {"userId":"7","scopeKey":"personal"},
  "sessionId": "session_01",
  "localSessionId": "local_session_01",
  "mode": "recovery",
  "events": [{
    "eventId":"event_claim_06",
    "sourceSeq":"6",
    "eventType":"session.upsert",
    "occurredAt":"2026-09-11T08:00:00Z",
    "payload":{"session":{
      "sessionId":"session_01","deviceId":"desktop_01","title":"周报整理",
      "origin":"desktop","workspaceId":null,"preview":"周报已完成",
      "createdAt":"2026-09-08T08:00:00Z","updatedAt":"2026-09-11T08:00:00Z",
      "localStatus":"idle","controlVersion":"0","run":null,
      "agent":{"agentId":"agent_office","name":"日常办公","icon":"clipboard","kind":"owned","version":"8","state":"available"}
    }}
  }]
}
```

成功返回原增量回执：

```json
{"code":0,"message":"success","data":{"batchId":"batch_claim_01","deviceId":"desktop_01","sessionId":"session_01","committedSourceSeq":"6","committedSeq":"11"}}
```

拒绝冲突仍使用 HTTP 409、业务码 `47006`、`reason: IDEMPOTENCY_CONFLICT`，不新增错误码。格式非法仍沿用 `47019`。发生类型冲突时应停止该资源同步并核对，不能通过重新生成 ID 或修改已排队事件来绕过。

## 3. 摘要合并契约

- 无旧摘要：合法初始摘要可绑定，预绑定的 Agent ID 必须一致。已有 kind 而没有可信旧版本时不能提升。
- incoming 缺省或 null：保留旧字段，兼容未发送 Agent 的旧客户端。
- 同 ID、同 kind：更高版本更新、更低版本只忽略 Agent 部分，同版本要求规范化内容完全相同。
- `anonymous → owned`：只允许严格更高版本。
- `owned → anonymous`：严格更低版本是迟到旧摘要，保留 owned，但同事件正文、状态、sourceSeq 正常处理；同版或更高版拒绝降级。
- `anonymous → owned` 的同版或更低版不是正常旧事件，拒绝。
- 不同 Agent ID、default 与普通 Agent 转换，始终拒绝。
- 持久 agent_summary 与独立 agent_id/agent_kind 不一致、旧摘要无法解析或版本无效时保守拒绝；不能猜测历史绑定。

服务端不修改 source payload/hash。旧事件重放仍按原 eventId、sourceSeq、payloadHash 去重；不能把已经排队的 anonymous 改成 owned 后复用同一 eventId。

## 4. 桌面接入事项

1. 本地关联必须由主进程可信当前账户与空间决定。任务和 Agent 归属各自授权；关联 Agent 时完整检查匿名任务、真实子任务、本人已有任务和受限冲突。
2. 在单一 SQLite 耐久事务中完成归属、版本、稳定远程映射、dirty/首次快照以及成功幂等回执。远程失败不能撤销本地归属，也不能创建另一份任务。
3. 单独关联任务不改变 Agent kind，可沿用原快照能力。关联匿名 Agent 后递增版本，并更新它旗下本人已有会话的摘要 dirty。
4. Agent 整组第一次远程启动前确认当前服务环境、owner/scope、deviceId 和新能力。将该 operation 的 remote admission 耐久写入回执后才发网络请求。
5. 未获准且没有能力时显示“等待服务支持”，暂缓该组的目录和任务上传；无关资源继续。不得把新摘要降回 anonymous 或删除旧 outbox 来兼容。
6. 已持久 admission 只对原环境、身份、设备、operation 有效。后续公告关闭时该组仍可继续全部任务和目录重试；不能只放行已有成功子项，也不能把 admission 复用给新操作。
7. Agent 目录 PUT 仍是完整替换：排除待准入的新关联条目时，必须保留 main、已准入条目及其他有效私有 Agent。新内容/新 CAS 基线生成新 publicationId，同次不可变发布重试复用原 ID。
8. 目录与任务历史同步分别展示状态，没有跨接口原子提交。不同账号登录时只能用当前匹配身份上传其 dirty，不借用新账号凭证完成旧账号同步。
9. 旧任务 ID、Agent ID、创建时间、工作目录不变；摘要同步不上传 Agent 记忆、配置或本地文件。

App 只需按版本更新同 `deviceId + agentId` 的 kind，不把 kind 当作永久身份。新建任务可选权限以完整 Agent 目录为准，不能根据会话的 Agent 摘要自行授予。

## 5. 发布、开关与回退

```properties
remote-control.agent-ownership-claim-enabled=${REMOTE_AGENT_OWNERSHIP_CLAIM_ENABLED:false}
```

该开关依赖 `remote-control.agent-summary-enabled=true`，错误依赖组合会在启动校验时拒绝。它不自动改变既有远控、summary、selection 或审批开关；不强制 selection 开启。

先将兼容 merge 部署至全部 4 个服务节点，暂不公告；全部节点可处理提升及旧事件重放后，再统一开启公告。一次能力查询命中新节点不意味着混部旧节点已兼容。无需新增网关、sticky session、Pod、Redis 服务或容器变更。

关闭公告只暂停尚未获准操作的首次远程启用。已处理 owned 数据的服务集群不能直接回退到拒绝 kind 变化的旧 merge；回退版本必须保留兼容补丁。无新增 MySQL 迁移；尚未部署原 Agent 功能的环境仍需原 V89。

## 6. 验证

执行指定纯单元测试（无 MySQL、Redis、应用上下文或外部服务依赖）：

```bash
./gradlew test --offline --tests com.youdao.lobsterai.remote.RemoteAgentSummaryTest --tests com.youdao.lobsterai.remote.RemoteAgentOwnershipCapabilityTest --tests com.youdao.lobsterai.remote.RemoteAgentSessionProjectionTest
```

覆盖高版提升、同版冲突、降级拒绝、迟到旧摘要保持原 hash/seq、持久绑定异常、null 兼容、增量及 import commit 两入口、公告默认关闭和关闭后兼容仍存在。未运行数据库迁移、外部集成测试或部署。
