# 已发布产物携带旧失败原因的同步兼容修复

日期：2026-09-23。代码修改涉及 lobsterai-server 和 LobsterAI 桌面端；不涉及 iOS。部署后的恢复情况需通过原会话的同步 ACK 验证。

## 1. 变更摘要

旧桌面端可能把本地 `FINAL_SNAPSHOT_UNAVAILABLE` 等失败原因保留在已经发布成功的 `ready` 产物块中。服务端原先拒绝此组合，导致该会话的有序 outbox 从失败事件起持续积压，后续消息、产物和运行终态无法同步。

桌面端现在只在未发布的占位产物中投影允许的失败原因；已经发布的 `ready` 引用不发送 `reason`。本地任务的失败记录保留，特别是“终态快照不可用”不因后来上传当前文件而被清除，也不会把 `latest` 引用伪装成 `pinned` 引用。

服务端兼容旧队列：只接受白名单内的旧本地失败原因，先校验原消息大小和内容字节数，再在投影副本中去掉已发布产物的 `reason`，重新计算投影的内容字节数。未知原因、非法字段和不完整的已发布引用仍被拒绝。

## 2. 接口与数据示例

接口路径和认证不变：

| 方法 | 路径 | 本次行为 |
| --- | --- | --- |
| POST | `/api/remote/v1/sync/batches` | 对批次中的消息投影执行兼容规范化 |
| PUT | `/api/remote/v1/sync/imports/{id}/parts/{partNo}` | 对导入部分中的消息投影执行相同兼容处理 |

继续使用现有 `Authorization: Bearer <accessToken>`、`X-Remote-Device-Credential` 和 JSON 请求体。请求保留原 `deviceId`、账号/空间、连接代次及同步协议字段，不添加新的请求参数或请求头。

以下仅展示消息 `blocks` 中的产物块，外层批次或导入请求沿用现有 schema。旧客户端已经入队的块可以包含：

```json
{
  "type": "artifact",
  "artifactId": "artifact-1",
  "name": "report.md",
  "mimeType": "text/markdown",
  "sizeBytes": "123",
  "availability": "ready",
  "artifactVersion": "1",
  "assetId": "asset-1",
  "assetVersion": "1",
  "referenceMode": "latest",
  "reason": "FINAL_SNAPSHOT_UNAVAILABLE"
}
```

服务端规范化后的投影、新桌面端创建的新事件使用：

```json
{
  "type": "artifact",
  "artifactId": "artifact-1",
  "name": "report.md",
  "mimeType": "text/markdown",
  "sizeBytes": "123",
  "availability": "ready",
  "artifactVersion": "1",
  "assetId": "asset-1",
  "assetVersion": "1",
  "referenceMode": "latest"
}
```

`originalContentBytes` 仍遵循原协议的计数规则：旧请求提交原消息对应的值，服务端校验后为规范化后的投影重新计算；新桌面端根据不含 `reason` 的新投影生成该值。产物文件的 `sizeBytes` 不变。

成功响应仍为 `{ "code": 0, "message": "success", "data": ... }`，`data` 保留各接口已有 ACK/导入回执字段。复用现有错误码和错误响应结构，认证失败行为不变；本次没有新增 capability 或开关。下述旧 delta 基线不匹配场景改走已有的 47015 快照恢复分支。

旧客户端在该产物块之后还可能发送 `message.delta`，其中的 `originalContentBytes` 仍计算了已经去掉的旧 `reason`。如果字节差额处于已发布产物白名单原因字段的已知上限内，服务端拒绝该 delta，并使用现有快照恢复协议返回 HTTP 409，例如：

```json
{
  "code": 47015,
  "message": "请重新加载会话快照",
  "data": {
    "reason": "RESYNC_REQUIRED",
    "retryable": false,
    "retryAfterMs": null,
    "reasonDetail": "MESSAGE_BASE_MISMATCH",
    "requestId": "request-id"
  }
}
```

这是要求核对基线并恢复快照，不是接受字节数错误的 delta，也不是跳过该事件。桌面沿用 `recoverSyncState`：校验会话/设备身份、epoch、ACK 和未完成导入的回执后，才能进行受控完整快照恢复。完整旧快照仍先校验原始内容字节数和所有产物权限，再规范化投影。未知差额或其他非法 delta 不会因为本次兼容而获准写入。

## 3. 认证和完整性要求

- JWT 账号、空间和桌面设备仍按原规则验证；兼容行为不能跨账号、跨空间或跨设备使用。
- 原事件、`sourceSeq`、`eventId`、原请求哈希和导入部分摘要不被改写。重复事件和重复导入仍按原始内容核对；不能对同一个序号替换 payload。
- 规范化只处理投影副本，不覆盖 outbox 原文。
- 产物所属账号/空间/会话、实际发布版本、asset 身份、文件元数据以及 `pinned`/`latest` 引用绑定仍须通过原校验。
- 消息总大小和原始内容字节数先行校验，去掉旧原因不能让超限或字节数不正确的原消息绕过限制。

## 4. 桌面接入和恢复步骤

1. 先部署并重启修复后的服务端，使接收同步请求的节点具备相同兼容行为。
2. 发布并重启升级后的桌面端，防止继续产生携带旧 `reason` 的新事件。
3. 仍在自动重试的旧队列先使用原事件重试；普通旧消息可直接恢复，遇到上述旧 delta 字节差额时按已有协议核对并恢复完整快照。若当前桌面版本已把该任务标记为隔离，使用现有设备管理中的单任务重试入口。
4. 查看原会话的 ACK 是否越过阻塞序号、积压是否减少，并确认后续消息和运行终态到达手机。不要仅凭设备“在线”判断会话已经恢复。

不要直接删除或重写 outbox，不要手动提高 ACK，也不要为此重新执行原模型任务。只升级桌面端无法修复已经写入的旧非法事件，因此恢复存量队列需要先部署服务端兼容修复。

建议服务端和桌面端配套升级。旧桌面若继续生成包含旧原因的产物流式消息，可能反复触发快照恢复，直到完整的最新快照同步成功；不能保证所有旧队列都只靠原事件直传完成恢复。

本次无需 SQL 迁移、额外环境变量或功能开关，也不要求修改或升级 iOS。
