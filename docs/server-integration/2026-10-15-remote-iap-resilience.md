# 2026-10-15 手机远程控制与登录配额故障隔离接入说明

状态：本批代码已实现并完成下述本地验证；尚未部署、变更共享数据库或自动激活任何服务端验收条件。手机 App 源码不在本次范围内。

对应方案：[远控与 Apple IAP 优化总方案](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-10-15-remote-iap-optimization.md)、[RC-01–12 分项方案](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-10-08-remote-control-optimization-plan.md)。共享发布次序与 AI 接口安全审查门禁以总方案为准。本文件描述实际交付，不表示方案全部完成。

## 1. 本批变更

| 项目 | 实际行为 | 安全边界 |
|---|---|---|
| RC-12 核心事务异常 | trusted 标记 SQL、业务 SQL、SQLite 自动回滚失败后均恢复 transaction depth；失效事务不能继续嵌套写 | ownership、运行证据与会话写入仍在原子事务内，不跳过安全写入 |
| RC-01 启动恢复 | 核心初始化失败且主窗口尚未创建时显示原生恢复窗口，可显示日志、重启、退出 | 不创建空数据库，不重置归属，不在恢复窗口运行任务；页面无 preload、脚本或外部导航 |
| RC-04 命令调度 | 对账单飞独立于新命令领取；每批最多两个不同任务并行，同任务在领取和对账间串行 | 领取前仍验证核心恢复/数据库；原始 claim、ACK、执行日志、防重及许可检查保留 |
| RC-04 附件 | 本地输入附件通过独立小型任务记录进入上传流程，不再要求旧历史投影先成功 | 仅独立控制已就绪且账号、设备、会话、run 绑定可信时放宽历史 ACK 依赖 |
| RC-07 状态大小 | availability session 的发布去重 hash 缓存最多 1024 项；保存总记录限制 1 MiB | 不删除原始请求、回执、控制身份、epoch、事实序号或待核对命令 |
| 隔离任务诊断 | 托盘增加“任务安全恢复”，只显示可停止任务数量和日志入口 | 仅当前进程见证过 owner/session/run 且仍匹配隔离行及运行状态的任务可发停止请求；不恢复访问权限 |
| 登录配额故障 | 识别 exchange 响应 quota 内的可选 `quotaUnavailable: true` | 未知总额用 null，不推断免费/零余额；独立明确权益按下文保留 |

## 2. 远控 HTTP 协议保持兼容

客户端继续使用现有 JWT Bearer、设备凭据及同步目标认证，不新增必填参数。以下已有接口路径和 JSON 字段不变：

- `POST /api/remote/v1/devices/{deviceId}/commands/claim`，仍发送 `connectionGeneration`、`limit`（本批为 10）。
- `GET /api/remote/v1/devices/{deviceId}/commands?state=unresolved&limit=20[&cursor=...]`。
- `POST /api/remote/v1/commands/{commandId}/reconcile`，保留原 `claimId`、`claimToken`、`expectedStatusVersion`、`observedExecution` 和 `requestExecutionPermit` 语义。
- `POST /api/remote/v1/commands/{commandId}/ack`，保留 received/applied/rejected 和原始执行绑定。

服务端的逐命令短事务与候选隔离属于内部实现调整，旧桌面仍可使用已有协议。客户端不会因为一次同步失败直接补写 applied、伪造 never-started、重新运行 unknown 命令或跳过服务端重新授权。

单任务对账失败按任务退避，扫描继续推进其他任务。当前账号/连接的认证、设备代次、共享存储类故障会停止当前批次；旧连接迟到的对账响应不得修改新连接游标、退避或断开新连接。当前批次最多两个任务并行不代表所有延迟均消除：公共注册、能力查询、连接认证与核心证据故障仍会影响整个远控通道。

## 3. 独立附件发布

新桌面从用户消息的 `remoteRunId` 与可信 `desktopInputRun` 生成既有 `desktopAsset:{messageId}:{index}` 上传记录。生成过程只操作本地有限数据，不扫描文件或发起网络；实际准备和上传沿用现有文件同步链路。

要求：归属已确认、控制绑定有效、run 历史匹配、同步目标匹配、任务已获准、未关闭同步及未进入删除流程。手机已经准备过的 `preparedSource` 不重复生成桌面附件。既有附件记录即使损坏也不会被无条件覆盖。

独立控制就绪后，旧历史 `needs_snapshot` 或 source/ACK 不一致不再单独阻止可信附件上传。旧服务端/未就绪任务继续沿用原历史 ACK 门禁；本次未改写这些序号，不自动提升 capability 或 readiness。

App 接入无需新增请求字段；仍读取原附件 availability 状态。若后续设计新增附件降级原因或接口字段，须先更新服务端 API 与 App 接入文档再实施，不把本文件当作新增协议已经上线的证明。

## 4. 大记录与容量边界

`availability_sessions.body` 写入前限制 1 MiB；`records` 只用于减少重复事实发布，最多保留 1024 个合理长度的 hash 条目。删除旧 hash 可能增加重复发布，由已有业务幂等性处理；不会赋予执行或归属权限。

对历史 1–8 MiB 且结构有效的记录，只在 SQLite 投影中移除 `records` 缓存，再验证其余控制身份、序号、状态并持久化紧凑值。原始大 JSON 不进入 JavaScript，但 SQLite 解析仍有主线程开销。非缓存字段不能超出 1 MiB。

超过 8 MiB、身份/结构损坏以及非缓存事实过大的记录仍安全隔离，不能自动修复；其他任务继续可用。保存更新也检查 sidecar 增量容量与回执预留。

尚未交付：按表规范化拆分、无限历史规模支持、receipt/object 的证明驱动回收、核心安全版本墓碑回收、完整容量告警和长期负载验收。不得手动清空这些证据来绕过空间门禁。

## 5. 隔离任务恢复入口

托盘 → **任务安全恢复**：默认显示说明、当前账号可安全提交停止请求的任务数量、日志入口。无可验证运行时不显示停止按钮，不显示任务标题、会话内容或标识符。

可信停止需要同时满足：

1. 当前进程在真实派发前记录过账号、session 和 run 的绑定。
2. 当前账号与该内存绑定一致；持久隔离行仍指向同一账号与 scope。
3. 当前 run 与绑定一致且未终结，运行引擎认为该 session 仍活动。
4. 用户确认前后账号/账号代次未变化；每个停止动作前再次验证。

同一原有停止 IPC 可在普通授权失败时进入上述严格的 stop-only 检查。重启后没有本次进程证明、换账号、换 run、归属不一致或损坏均拒绝。停止只发送请求，不写虚构终态、不恢复 ownership、不允许批准工具/续聊/删除、不创建新的会话内容访问能力。未知任务继续隔离，由后续专门恢复流程处理。

## 6. exchange 登录降级响应

服务端仅在认证 exchange 组装配额时允许部分独立结果。`quotaUnavailable` 位于 **quota 对象内部**，是可选 boolean；缺失时原行为不变。登录与 JWT 签发仍须正常认证成功。

示例（省略其他现有登录字段）：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "quota": {
      "quotaUnavailable": true,
      "freeCreditsTotal": 300,
      "freeCreditsUsed": 20
    }
  }
}
```

桌面归一化为 `subscriptionStatus: "unavailable"`、`creditsLimit/creditsUsed/creditsRemaining: null`，显示配额暂不可用。已有同账号的可信 profile-summary 展示可保留；切换账号会清除，不把上一个账号数据带入。独立 `/api/user/quota`、profile-summary 保持严格失败，不返回 partial 覆盖可信缓存。

权益处理：

- `mediaGenerationEntitled` 明确为 boolean 时以该字段为准；缺失时只有明确 `hasPaidCredits === true` 可保留已有独立媒体资格语义。它不代表完整付费余额。
- 分享和部署仅接受各自明确 `shareEntitled === true`、`deploymentEntitled === true`；不从 partial `subscriptionStatus` 推断。
- 字段缺失不授权；`quotaUnavailable` 也不是权限或支付凭据。所有实际额度、购买和授权仍由服务端严格检查。

旧桌面可继续登录，但不能完整理解未知额度展示，需升级才能避免把缺失会员状态归为免费。服务端不得为迁就旧显示而伪造 Apple 免费/零额度。旧版本限制由发布说明明确列出。

## 7. 验证与发布

本批定向验证覆盖：trusted 标记进入/退出失败、SQLite 自动回滚、真实核心 DDL 失败恢复入口、恢复窗口导航隔离、旧历史异常时附件上传、错误账号拒绝、超大缓存压缩/权威字段不丢、A ACK 挂起时 B/C 执行、同任务串行、当前 401 停领、旧连接迟到 401 不断开新连接、隔离任务 stop-only 边界以及 quotaUnavailable 兼容。

2026-10-15 本地验证：17 个定向测试文件、405 个测试通过；`npm run compile:electron`、`npx tsc --noEmit`、修改文件 ESLint 与 `git diff --check` 均通过。启动恢复窗口使用真实 Electron 独立进程成功渲染并截图检查，无内容溢出；托盘隔离恢复对话框完成定向自动测试，未进行完整原生交互巡检。生产网络断开、真机 App 联调、磁盘满/进程强杀及长期容量测试仍是发布验收项。本批未运行服务端测试、未访问手机 App 源码、未修改共享数据库、未部署。

发布遵循总方案 S0→S4：先保持旧接口可用，再验证兼容结构与桥接，最后依据真实验收激活协议/容量治理。新增开关默认值不等于凭据、证据、权限或 readiness 已满足。AI 安全审查发现的问题必须修复并复核；本批审查已修旧连接迟到对账影响新连接的问题。
