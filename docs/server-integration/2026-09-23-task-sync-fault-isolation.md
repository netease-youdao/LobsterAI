# 同步任务故障隔离：服务端兼容诊断接入

日期：2026-09-23。状态：服务端与桌面代码已实现，未部署。服务端仅编译检查，未执行依赖数据库/Redis 的服务端测试；桌面执行隔离 SQLite 和 mock 网络回归。iOS 源码未修改。

## 1. 变更摘要

保留所有现有 HTTP 路径、认证方式、请求体字段、请求 hash、HTTP 状态码、业务 code、reason、retryable、ACK 与 WS 枚举。新增可选 capability `sync_diagnostics_v1`。新客户端仅在服务公告后按需添加 `X-Remote-Sync-Diagnostics: 1`；无头客户端的错误响应结构保持原样。

目前有明确诊断的出口为 `/api/remote/v1/sync/*` 中的任务 state/batch/import，以及 `/api/remote/v1/sessions/{sessionId}/contents/*` 的回复正文操作；未知错误、未完成设备认证、其他接口可以不返回诊断。不要把 capability 解释为所有错误都必须包含此字段。

回复内容配额在实际失败位置区分账号空间和单任务，不从 HTTP 503 猜测影响范围。定时核对逐候选独立事务，单个候选失败后继续其他候选；仍只核对一致性，不自动归零、改账或扩大配额。

## 2. 沿用接口和可选字段

先读取现有 `GET /api/remote/v1/capabilities`，检查 `data.capabilities` 是否包含 `sync_diagnostics_v1`。此接口原有认证要求不变。

后续同步请求保留原 JWT Bearer、`X-Remote-Device-Credential`、目标身份、投影版本及原请求体；只增加如下可选头：

```http
X-Remote-Sync-Diagnostics: 1
```

例如原正文上传请求：`PUT /api/remote/v1/sessions/{sessionId}/contents/chunks/{sha256}`。请求 body 不添加诊断字段，不改变 text、deviceId、mode、connectionGeneration 的语义及摘要。

账号空间配额计数异常的响应示例（原字段以各接口现有约定为准）：

```json
{
  "code": 47012,
  "message": "回复内容额度待核对",
  "data": {
    "reason": "REPLY_CONTENT_QUOTA_INCONSISTENT",
    "retryable": false,
    "retryAfterMs": null,
    "reasonDetail": null,
    "syncDiagnostic": {
      "version": 1,
      "failureScope": "owner_scope",
      "category": "dependency",
      "recoveryAction": "wait_dependency",
      "retryAfterMs": 900000
    }
  }
}
```

原 HTTP 503 与 code 47012 不变。超额仍为 HTTP 413 / 47012 / `REPLY_CONTENT_QUOTA_EXCEEDED`。单任务额度失败只把嵌套 `failureScope` 改为 `session`。原 `retryable`、原业务 `retryAfterMs` 不被诊断覆盖；嵌套时间仅为低频依赖探测建议。

诊断 schema：

- `version`：当前为整数 1，未知版本整体忽略。
- `failureScope`：`resource / session / owner_scope / device / service / unknown`。当前实际发布以有依据的 session、owner_scope 为主。
- `category`：`transient / data / protocol / permission / dependency / unknown`。
- `recoveryAction`：`retry_same_operation / reconcile_operation / wait_dependency / reauthenticate / manual_review`。
- `retryAfterMs`：可选、非负安全整数。

原 `RESYNC_REQUIRED`、`IMPORT_STATE_CONFLICT`、`SYNC_STATE_NOT_FOUND`、`SYNC_IN_PROGRESS` 只建议核对原操作；`IDEMPOTENCY_CONFLICT`、`SESSION_DELETED` 建议人工/任务级核对。诊断不会授权更换 importId、清 ACK、复活墓碑、重建任务身份或重新执行模型/工具。

## 3. 桌面接入事项

1. 服务未公告能力时不发送该头；服务公告但响应没有诊断时，仍按旧 HTTP/code/reason 与本地操作阶段分类。
2. 把诊断作为补充，不能覆盖更严格的身份、墓碑、ACK、epoch、未知执行结果保护。
3. `owner_scope` 额度依赖只影响该账号空间依赖额度的上传操作，不能显示全站离线；`session` 只影响该任务。
4. 不用 `retryable=false` 推断“永远不能核对”。保留旧字段含义，客户端状态机根据原协议证据安排合法核对和低频探测。
5. 不向旧任务、文件或 WS 枚举添加内部 isolated/cooldown 状态；iOS 无需同步升级。本轮不改 iOS 代码。
6. 请求诊断不改变现有 `only(...)` 严格 body 白名单；不把 scope/recoveryAction 发回服务端作为操作授权。

## 4. 配置与发布

`remote-control.sync-diagnostics-enabled=${REMOTE_SYNC_DIAGNOSTICS_ENABLED:true}`，Java 默认同为 true。设 false 仅停止公告/附加新诊断，不改变旧同步和额度安全校验。功能开关开启不视为 JWT、存储、数据集身份或全节点安全能力验收已满足。

本轮无新增 MySQL DDL，仍需满足原远控功能的既有迁移与部署证明。可先上线服务端，再上线桌面。新旧服务节点混用时字段可缺省；`sync_target_v1` 等原安全能力的部署门禁不变。浏览器 CORS 未扩宽；Electron 不需要因此修改全站跨域策略。

## 5. 服务端运维观察

固定维度 Metriclog：

- `remote.sync.failure.<固定 operation>.<scope>.<category>`：已分类业务错误；无诊断头也可计数。
- `remote.sync.transaction.success/error`：同步事务总耗时，包含事务完成。
- `remote.sync.lock.owner/session/import/quota.success/error`：锁获取调用耗时，包含 SQL 执行和往返，不能等同 MySQL 内部纯锁等待。
- `remote.sync.quota.check.owner_scope/session.consistent/inconsistent/skipped/error`：每候选额度核对耗时与结果。
- `remote.sync.import.duplicate/expired`：已确认重复导入 begin 与过期事实。

指标名不带 userId、sessionId、importId、文件名或自由错误文字；受控核对日志只记录范围、必要 ID、错误类型，不含正文、凭据或堆栈。原 HTTP/正文操作吞吐与耗时指标继续保留。

额度核对每小时最多处理 10 个候选，使用主键游标轮转；候选失败也推进本节点游标，下轮继续后面的候选，到末尾再回绕。每候选独立事务超时 10 秒，保留 owner→session→quota 的锁序，未修改同步请求事务时限。游标是节点内调度提示，节点重启从首项重新开始；它不是额度正确性证明。

## 6. 验证与局限

新增/补充测试源码覆盖：无头响应等价；显式 opt-in 只增加嵌套字段；认证/功能开关/未知错误默认省略；指标故障不改变响应；真实账号/任务配额范围；单候选回滚后继续；失败游标推进和回绕；能力与旧协议格式。

按项目约定本地不执行服务端测试；使用 `./gradlew compileJava compileTestJava -x test --offline` 编译业务与测试源码。正式环境仍需执行回归与滚动版本、真实配额异常、锁竞争观察，编译不等于运行通过。

## 7. 桌面实现与上线事项

- 历史同步按任务独立捕获、最多两路并发；坏 JSON、回复内容或恢复异常不阻断健康任务。投影 worker 不阻塞已有 outbox，文件在独立通道逐分块轮转。
- 新 SQLite 调度表 `remote_sync_task_state` 保存退避、服务端 Retry-After、修复和手动重试预算；准入表/原始证据表保护 legacy 任务。初始化为增量创建，无需执行服务端 SQL。
- 临时错误从 30s 起退避，连续五次进入至少 15min 冷却；配额依赖低频核对。原 ACK/epoch/operation ID 保持，未知数据只隔离当前任务；重新连接不清全部失败记录。
- 同一错误类别最多一次未解决自动重建，单任务最多两次/24h，最多八个未解决类别；重启/手动操作不重置。已被可信删除的原流不自动恢复。
- 设备页新增可选计数与最多 20 条任务异常摘要。内部 `RemoteConfigureRequest.retrySessionId` 只在当前账号 epoch、任务准入与预算通过时可用；它不是服务端新接口。文件级退避保留已有文件 syncState。
- 首次旧库认领超过 2000 行、8MiB 总文本、1MiB 单条或 100ms 协作预算会回滚整理并暂停自动同步，保留连接与本地任务；已知目标重连不做全历史扫描。大旧库后台分批迁移未包含在本轮。
- 未核验旧档案存在时不切换到另一个目标数据集；原始档案没有自动 TTL，未知引用只阻止 GC 删除。不得手动清表、删档案或提升 ACK 来解除暂停。
- 可先发布服务端再发布桌面；旧兼容服务也可获得桌面本地隔离，不要求 App 升级。真实环境应验证坏任务旁的健康任务 ACK、断网重启、手机命令/停止/审批、本地保存和大型内容的内存/主线程延迟。
- 回滚桌面必须使用认识新准入记录的兼容构建，不能假定旧二进制可安全处理新工作集。关闭诊断开关不会关闭身份/删除/执行保护。

完整设计与实际边界：`lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-23-task-sync-fault-isolation.md`，尤其 §14。部署后能力和运行效果需重新验收，本地通过不等于线上问题已恢复。
