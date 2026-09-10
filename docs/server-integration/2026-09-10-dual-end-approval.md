# App 与桌面双端审批接入指南

日期：2026-09-10。状态：**桌面和服务端实现已完成，默认未开放新的双端审批受理，尚未部署或完成手机实机联调**。本文描述当前实现，供桌面和 App 联调。服务端主 spec：[双端审批方案](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-10-dual-end-approval.md)；完整 HTTP/WS 契约：[App 接入文档第 15 节](../../../lobsterai-server/docs/api/mobile-remote-api.md#15-app-与桌面双端审批扩展)。

## 1. 变更摘要与边界

同一任务审批可以在 App 或桌面作“允许本次/拒绝”。桌面主进程统一持久化裁决，Gateway 确认后记录决定，关闭两端对应待办；结果未知时展示核对状态，不能重复批准。

已接通唯一 `ApprovalDecisionService`、持久 SQLite 裁决、真实 Gateway 确认、阶段广播及对应弹窗关闭。手机提交与桌面按钮均进入同一裁决服务；HTTP/IPC 受理、待提交决定或运行状态变化都不能代替运行器确认。

远程范围为有 owner 的同用户同 scope 任务；匿名审批仅本地。审批不改变 Agent/工作区/run 绑定。匿名任务也拥有独立的本地 run 标识及审批生命周期，但不创建云端同步记录；旧匿名审批不能用于后续轮次。系统权限、AskUserQuestion 回答、登录授权、手机永久授权和批量批准不在本期。Portal/Admin 无改动。

## 2. 接口、认证与示例

基础路径 `/api/remote/v1`，沿用：

```http
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
Content-Type: application/json
```

服务器根据 access token 和设备身份获取 owner/scope，不信任客户端 userId。手机还需目标电脑 sessions:read/control grant；桌面同步使用自己的设备身份。WSS 仅使用票据接口返回的短期 URL。

| 方向 | 方法/路径 | 内容 |
| --- | --- | --- |
| App 读取 | GET /capabilities、GET /devices | 服务端和目标桌面能力/在线状态 |
| App 读取 | GET /sessions/{id}/snapshot、GET /sessions/{id}/approvals | 审批快照及 pending 分页，包含 submitting/unknown |
| App 控制 | POST /commands | 原 approval_response，不增新写接口 |
| App 对账 | GET /commands/{commandId} | 原请求结果 |
| 桌面控制 | 原 commands claim/ACK/reconcile | 持久收到、执行证据及未知结果核对 |
| 桌面同步 | POST /sync/batches、原 snapshot import | 沿用 approval.updated 和连续水位 |
| 服务端推送 | 复用 WSS | session.event、command.changed；不按审批新建连接 |

手机提交示例，绝对期限仅作格式示例，真实请求须按 serverTime 计算且最多 30 秒、不晚于审批原期限：

```json
{
  "commandId": "c834dfcf-f8eb-4197-8b6f-ef180f53cc4e",
  "type": "approval_response",
  "deviceId": "dev_pc_01",
  "sessionId": "session_01",
  "expiresAt": "2026-09-10T08:02:40.000Z",
  "payload": {
    "runId": "run_01",
    "approvalId": "approval_01",
    "approvalVersion": "1",
    "operationDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "decision": "approve"
  }
}
```

响应沿用 `{code:0,message:"success",data:Command}`。accepted/received 不是批准；applied + `result.outcome=approval_applied` 才表示本命令决定获确认。桌面拒绝和服务端预检查共用 47007/APPROVAL_STALE；细分 ALREADY_RESOLVED/DECISION_IN_PROGRESS/RESULT_UNKNOWN 只用于提示。无权限47002、离线47001、类别/能力不支持47017、同 ID 改内容47006。完整响应与 CommonError 见 App 第 15 节。

Approval 保留旧字段和 status 枚举，增加可选 resolution：

```json
{
  "approval": {
    "approvalId": "approval_01",
    "runId": "run_01",
    "approvalVersion": "3",
    "title": "允许删除临时报告？",
    "summary": "删除工作区“周报”中的临时报告 draft-report.md，不涉及其他文件。此操作可能无法撤销。",
    "operationDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "remoteAllowed": false,
    "requiresLocalAction": false,
    "expiresAt": "2026-09-10T08:05:00.000Z",
    "status": "approved",
    "resolvedAt": "2026-09-10T08:02:12.000Z",
    "resolution": {
      "phase": "finished",
      "source": "mobile",
      "confirmedDecision": "approve",
      "confirmedAt": "2026-09-10T08:02:12.000Z"
    }
  },
  "controlVersion": "9"
}
```

以上是 approval.updated 的 payload。phase 为 idle/submitting/unknown/finished；source 为 null/desktop/mobile/system/unknown；confirmedDecision/confirmedAt 同时 null 或为已确认决定及时间。来源未知不能猜 mobile。pending 的 resolvedAt=null，confirmedDecision/confirmedAt=null；submitting/unknown 时 remoteAllowed=false，requiresLocalAction 不因此置 true。

若待办先 cancelled/expired/superseded，再拿到匹配原请求、epoch、动作及期限的可靠决定证据，保持 status/resolvedAt 不变，只递增 approvalVersion 补全确认历史；不重开任务或续跑。已有决定和 confirmedAt 不变时，可以在更高版本将 source 从 unknown 补强为已证明的 mobile/desktop；不能覆盖已知来源或相反决定。相同版本不同内容和低版本覆盖都拒绝。

新增 resolution 审批的 status、approvalVersion、resolvedAt 由桌面唯一生成。服务端先收到 run 终态而尚未收到审批终态时，不合成另一份取消结果；App 应立即按 run 终态禁用并移除该 run 的待办，同时保留已知审批事实，等待后续 approval.updated。不要自行改写审批版本、决定或 resolvedAt。旧 v1 无 resolution 审批保留服务端 batch 尾取消兜底；桌面对已发布的 run 优先发送审批关闭事实，再发送 run 终态，兼容跨批次切分。

unknown 分为两种：已尝试决定、来源为 mobile/desktop 等的 unknown 不能因到期或重连回到 idle；启动恢复时没有 submission、需要重新核验的项可以是 unknown/source=null，只有匹配原 Gateway 请求和期限的证据才能以更高版本回 idle。这一恢复不是批准，也不授予原手机命令新的执行许可。

## 3. 已实现的桌面接入点

### 3.1 运行器与远控链路

1. `openclawApprovalBridge` 保留 requested 的 createdAtMs/expiresAtMs 和 resolved 的原动作、决定、时间。`openclawApprovalAdapters` 生成受信任公开描述，不能使用模型或任意插件自报的 remoteSafe。
2. `ApprovalDecisionService` 在既有 SQLite remote_state 保存私有审批记录及 submission 索引；公开 `approval:`、inbox 和 outbox 与裁决状态同步事务提交，SQLite 使用 WAL/FULL。私有执行参数不进入 HTTP/WS 或 renderer 公共 DTO。
3. 手机完成 claim、持久 inbox、received ACK 后才进入 CAS。手机的原 commandId 作为 submissionId，原 approvalVersion/operationDigest 保持不变。占用后版本递增，后续派发验证本 reservation，不能重写原 payload 去匹配新版本。
4. 主进程 beforeDispatch 复核账号、Agent/工作区/run 及原许可。同步 onDispatch 钩子消费首次派发许可，随后持久化 dispatching 并调用 Gateway；迟到 ACK 和已启动任务的 exec 续跑不再受原 15 秒领取许可限制。账号、会话和运行绑定仍保留。
5. 返回值区分 `confirmed`、`known_not_applied`、`unknown`。只有本次决定有明确应用证据才将手机 inbox 标为 applied；其他客户端先作相同决定可以使审批显示 approved，但本次手机命令仍可能 rejected。RPC 超时保留 unknown，不通过普通运行错误事件误将任务标为 failed。
6. reserved 恢复验证原 inbox/claim、完整执行历史和匹配的 Gateway pending 请求；证明从未派发时，原 submission/inbox 固定拒绝、审批以较新版本恢复 idle。回报沿用原 claim，不能使用 runPublished 推断该审批已执行，也不申请替代许可。同 commandId 永远读取原结果。
7. `RemoteStore` 按整组审批计算运行阻塞：真实 run 终态最高，其次 unknown/reconciling、waiting_local、waiting_approval。一个审批完成不能无条件设 running，须由实际运行器事件恢复。无可信期限的本地请求只保留本地阻塞状态，不伪造一个用于手机审批的期限。
8. `RemoteBridge` 等待真实运行器合同及服务端能力交集。Gateway 后续就绪会由既有周期自动重新检查能力；设备协议声明只增不减，关闭新受理仍保留扩展结果投影和在途对账。同一个已发布版本不会因能力变化被追加字段或改写已有 outbox。

本期实际适配：

| 类型 | 手机可处理的范围 |
| --- | --- |
| exec | 工作区内字面量 `rm` 或 `/bin/rm` 删除，最多 32 个相对目标；公开说明递归及不可恢复风险，派发前复核父目录真实路径。复杂 shell、引号、通配、变量、管道、环境覆盖、间接脚本及远程 node 仍回电脑处理 |
| plugin | 当前内置 Codex 插件的 `codex_network_approval`，完整 `Network: http(s)://host[:port]` 单主机请求，支持 allow-once/deny；其他插件请求不自动获得远程资格 |

适配器版本为 `2026.8.1/1`。手机操作限允许本次/拒绝，不提供永久允许、修改后批准或批量决定。摘要超出原 4 KiB/总审批 8 KiB 上限时降为本地处理。

### 3.2 桌面 IPC 与 renderer

既有 `window.electron.cowork` 新增以下能力，均由主进程执行会话/账号可见性检查：

| 方法/事件 | 数据及作用 |
| --- | --- |
| `listPendingPermissions()` | 返回 `{success,items:[{sessionId,request}]}`；request 可含 approval。窗口初始化、重载及账号切换后补齐当前可见待办 |
| `onStreamPermissionState(callback)` | 接收 `{sessionId,state:ApprovalState}`，按 requestId 与版本合并 submitting/unknown/finished，并锁定或关闭对应弹窗 |
| `respondToPermission({...})` | 沿用原 requestId/result，新增 submissionId、expectedVersion、operationDigest；桌面 source 由主进程固定，不信任 renderer 自报来源 |
| 既有 `onStreamPermissionDismiss` | 确定关闭时移除对应 requestId，并关闭该项系统通知，不影响其他任务 |

对应通道为 `cowork:permission:list`、`cowork:stream:permissionState` 和既有审批提交/dismiss 通道。公开 `ApprovalState` 使用 requestId/sessionId，映射到远端 Approval 的 approvalId；不传私有原动作、claimToken 或裁决内部记录。

renderer 在一次点击时生成唯一 submissionId，同版本提交过程中禁用两种决定；IPC 响应未知时保留核对状态，不自动换一个 ID 重发。只有确定未派发且收到较新可操作状态后，才允许用户产生新决定。先绑定状态监听再拉取待办，查询期间已到达的状态不能被旧列表覆盖；账号切换后丢弃旧账号未完成的查询和提交响应。旧 preload 缺少新增 API 时保留兼容行为。

## 4. 已核验的 Gateway 合同与恢复

实现依据桌面 package.json pin `v2026.8.1` 及 `vendor/openclaw-runtime/mac-arm64` 的实际构建产物，不再以先前安装应用的 2026.6.1 行为宣告新版能力。Gateway hello 必须有匹配版本、非空 server.bootId，且 features.methods 同时包含：

- `approval.get`
- `approval.resolve`
- `exec.approval.list`
- `plugin.approval.list`

统一调用 `approval.resolve({id,kind,decision})` 返回 `{applied,approval}`。applied=true 表示本次首次应用，applied=false 合并真实审批结果但不标本次手机命令成功；ACK 与 resolved 事件乱序时合并为同一事实，先到的 resolved 可以先显示已确认决定/source=unknown，再由可靠 ACK 补强来源。

Gateway 断开立即停止开放新的远程决定，重新 hello 后恢复能力核验。恢复查询限定原 bootId、请求标识、动作、创建时间及原期限；get/list 返回空、请求已清理、方法不支持或超时均不能证明未执行。每个 hello 的查询有次数边界，全局最多 4 个并发，单次不超过 5 秒及允许的剩余期限；不调用虚构的永久审批查询接口。

本地旧版本仍可使用经适配的 kind-specific resolve 路径，但不声明双端能力，不从 `{ok:true}` 或显示昵称猜测操作来源。Gateway 结果有保留窗口，重启可能丢失内存；本次没有改造其持久审计。桌面与 Gateway 同时崩溃只能按现有证据恢复，不保证任意工具无条件续跑。

产品 Gateway 握手同时声明 `tool-events` 与 `approvals`，固定运行器客户端协商协议 4。桌面 chat.send（deliver=false）走 webchat 原生 inline 审批：等待决定后继续原 turn，不会先把任务完成再等待用户。

## 5. 兼容、迁移和发布

- 新 capability 为 `approval_dual_control_v1`，须服务端与目标桌面均支持，并满足原 remoteApproval/sessionControl、approval.respond 和设备/会话权限。该扩展不依赖 Agent 两个开关。
- 已新增 `remote-control.dual-approval-enabled=${REMOTE_DUAL_APPROVAL_ENABLED:false}`。远控总开关仍默认 true，新双端审批首次受理默认关闭。关闭此新开关不会丢弃已接受命令、旧审批结果、ACK、回放及核对。
- 未协商扩展时不向旧服务端新增 resolution。首次协商不能改写同版本已发布的旧审批；真实版本推进后才发送扩展字段。已产生扩展状态后，即使关闭新受理也保留 resolution，服务端会保护已知阶段不被旧投影擦除。
- 服务端无新增 DDL，无需 V90，不重跑 V88/V89；复用审批 body、命令和事件表，兼容 MySQL 5.7，无外键。桌面复用 remote_state；旧 pendingDecision 不是已确认决定，不能迁移为批准/拒绝。
- 先在全部 4 个 Pod 部署兼容读写代码、保持新开关关闭，再发布桌面及兼容 App，最后灰度启用。不改变 WS URL、Nginx 路由或部署基础设施。
- 回滚先关闭新受理，保留能识别扩展状态的服务端排空/核对。不能删除未知派发证据，或直接回滚到拒绝 resolution 的旧二进制。去重证据保留按既有任务/命令保留策略执行，未决项不可提前清理。

## 6. 验证与剩余联调

已加入并运行桌面定向测试，覆盖双端竞争、幂等、版本/能力兼容、运行器证据合并、unknown 跨期限、持久 reserved 释放、临时 SQLite 文件关闭重开恢复、单事件跨 HTTP 批次终态顺序、原生定时器下迟到 ACK 的许可消费，以及无 owner/无云端同步记录的匿名任务多轮隔离。桌面类型检查与相关文件静态检查通过。最终合并后 13 个测试文件、142 个测试通过；renderer/Electron TypeScript、所有修改 TS 文件 ESLint 零警告，Vite 生产构建通过。隔离 Electron 已验证实际弹窗与 Redux/service 的锁定、核对提示及目标项关闭；实际 2026.8.1 Gateway 的 exec/plugin 同意与相反决定 4 组并发 RPC 验证通过（只创建审批，未执行对应工具），测试进程已正常停止。

服务端仅执行代码和测试源码编译，按项目约定不运行依赖外部 Redis/MySQL 等服务的测试套件。本次不变更数据库、部署或运行时开关。

上线前仍需新版手机与实际桌面联调，包括摘要显示、允许/拒绝、另一端弹窗关闭、多项审批、手机后台恢复、账号切换、服务端滚动发布和 Redis 通知丢失。单元/合同测试或 Gateway 隔离 fixture 不等同于已完成手机实机验证。
