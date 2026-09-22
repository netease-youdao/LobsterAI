# 2026-09-21 双向任务删除接入

2026-09-22 同步设计更新（代码已实现，未部署）：[当前生效服务同步方案](../../specs/bugfixes/remote-sync-target/2026-09-22-effective-server-sync-design.md) §5 规定删除许可/回执绑定已验证的服务数据身份及会话映射，不能用域名或客户端模式推断等价。旧 `serviceScope` 和签名原文保留；新服务不能替旧服务证明“未执行/未删除”，普通同步 bootstrap 不得复活最终删除的任务。以下现有删除契约不因该设计而放宽。

状态：服务端与桌面代码已实现，待 V101 迁移、部署与真机联调；iOS 未修改。本文与服务器仓库的 `docs/api/mobile-remote-session-deletion-v1.md` 配套，后者是完整字段契约。

## 1. 变更概要

新增 `session_delete_v1`，手机可提交独立持久删除申请。服务端先隐藏任务并建立 pending fence；桌面确认停止、提交本地删除及可信回执后才最终删除远端任务记录。旧 `/commands`、命令 TTL、WS 版本、普通 410 和 source ACK 语义保持不变。

桌面已接入共享删除应用服务、活动 guard、独立控制通道、持久执行证据和回执恢复。删除不会清理 Agent、工作目录或原始文件；手机 UI 仍由 App 团队按契约实现。

## 2. 认证与能力

沿用 `/api/remote/v1` 下 JWT 和 `X-Remote-Device-Credential`，owner/空间由服务器派生。手机必须有目标电脑的 `sessions:control`；桌面只执行自己的精确 device/session/localSession/epoch。缺能力、缺 v2 guard 或新申请开关关闭时，不展示可操作删除入口。

```json
{"capabilities":["session_delete_v1"],"sessionDeletion":{"available":true,"reason":null}}
```

协议支持与 available 分离；available=false 时仍需保留已有事实上报和完成回执核对。不得将普通 SESSION_DELETED 当作本地删除许可。

## 3. 接口

| 调用端 | 方法与路径 | 用途 |
| --- | --- | --- |
| App | POST /sessions/{sessionId}/deletions | 申请，持久 requestId 重试 |
| App | GET /session-deletion-requests/{requestId} | 丢申请响应核对 |
| App/目标桌面 | GET /session-deletions/{operationId} | 操作状态；桌面可读完成回执 |
| App | GET /session-deletions?state=unresolved | 待删除列表，keyset 分页 |
| App | POST /session-deletions/{operationId}/confirm | 明确确认新基线/新授权 |
| App | POST /session-deletions/{operationId}/withdraw | 未发生副作用且无未知许可时撤回 |
| 目标桌面 | GET /devices/{deviceId}/session-deletions | 有界发现 |
| 目标桌面 | POST /devices/{deviceId}/session-deletions/claim | 领取，当前最多 1 条 |
| 目标桌面 | POST /session-deletions/{operationId}/permit | 申请短期执行许可 |
| 目标桌面 | POST /session-deletions/{operationId}/lease/renew | 合法阶段续租 |
| 目标桌面 | POST /session-deletions/{operationId}/reports | 原事实回报，不依赖历史上传成功 |

请求示例（所有版本/序号为十进制字符串）：

```json
{
  "requestId":"124f3dd2-9bbd-47d2-9d4f-d02e1e4ea6bf",
  "deviceId":"desktop_01",
  "expectedControlVersion":"18",
  "expectedDeletionGuard":"12",
  "expectedRunId":"run_01",
  "action":"stop_and_delete"
}
```

```json
{
  "code":0,"message":"success",
  "data":{
    "operationId":"operation_01","sessionId":"session_01","deviceId":"desktop_01",
    "deletionVersion":"1","stateVersion":"1","state":"queued",
    "approvedGuard":{"version":"12","runId":"run_01"},
    "canWithdraw":true,"canConfirm":false
  }
}
```

示例省略时间和可选显示字段。HTTP 200 仅表示受理；只有 state=completed 表示删除收敛，pending 不是回收内容的凭据。

## 4. 桌面实施与 App 待办

桌面已实现：

- 新输入/运行/历史替换推进 guard，自然完成保留该运行 guard；新活动冲突只提示确认，不停止新运行。
- 持久 claim/fence/准备日志，许可有效且精确 guard 匹配时才执行。停止未知则核对，不立即删库。
- 独立删除调度和只回传原事实的 recovery 模式；关远控、历史上传失败或丢响应不阻断本地正常任务。
- `observationOnly` 只观察；同 guard 重新授权后的 `resume.delete_only` 只继承明确的停止证明，不重复 stop。
- `serverTime` 配合单调时钟预算判断许可过期；许可响应 executionAllowed=false 或原 connectionGeneration 不匹配时，只核对、不执行。若原请求从未签发，服务端先封闭旧 claim，再返回绑定 claim/fence/version 的 recoveryProof.permitIssued=false，不能拿普通 404 代替此证明。
- 可信 local/completion receipt 关闭同步流但不提高真实 ACK。源事件/完整快照删除与远程执行采用不同证明路径。

App 待接入：

1. 列表/详情删除入口，运行中明确“停止并删除”；服务端受理后隐藏普通列表，保留待删除入口。
2. 持久 requestId/请求体、operation/stateVersion，原请求重试；新基线需要用户再次确认，不能自动 force。
3. 处理 needs_confirmation、blocked、reconciling，安全撤回；不要连续弹受理和成功两次模态框。
4. 订阅 catalog.changed、能力协商后接收 deletion.changed；前台/重连刷新待办和已知操作，不只依赖 WS。
5. owner/环境隔离及 sessionCacheGeneration，丢弃过期正文/图片回包；最终删除清受管缓存，撤回重新取快照。

## 5. 错误、资源与发布

新增 409：47130 DELETE_STATE_CONFLICT、47131 DELETE_BASELINE_CHANGED、47132 DELETE_CONFIRMATION_REQUIRED、47133 DELETE_WITHDRAW_UNSAFE。普通 47010/SESSION_DELETED 不变。矛盾事实可返回当前 Operation + reportDisposition=conflict，表示证据已留存，不能当作执行成功；旧领取阶段的 blocked 报告可能返回 reportDisposition=superseded，不回退新阶段。

删除 POST 上限 8 KiB；列表默认 20/最大 50、响应 ≤256 KiB；新申请默认每 owner/空间每分钟 20 次、未决 200 条。新申请额度不阻止旧事实核对。

V101 新增 3 张表和 remote_sessions 4 个可空列，未执行。新功能 enabled 与 cluster-ready 默认 true；混部须显式均设 false，所有写节点支持 pending 门禁后恢复 cluster-ready，建立桌面 v2 guard，再开放 enabled 和 App 入口。旧客户端继续使用原协议；有未决操作不能回滚到不识别 fence/回执的版本。

服务端默认只编译主代码和测试源码、不运行测试；桌面验证以本次交付记录为准。迁移、部署、真实账户/断网/多手机/崩溃端到端验收仍待完成，不能将此次代码交付标为已上线。
