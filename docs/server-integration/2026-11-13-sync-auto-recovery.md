# 桌面同步自动恢复：服务端接入与消费指南

日期：2026-11-13。**状态：代码及本地验证已完成；未部署。** 本轮包含自动恢复、可选诊断和桌面本地元数据迁移；真实部署与混部验收另行记录。手机 App、Portal、Admin 无本轮源码改动要求。

完整状态机、调度和安全重试预算以[自动恢复主 Spec](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-11-13-sync-auto-recovery.md)为准；新增可选诊断字段的唯一契约表见[服务端 API 第 11 节](../../../lobsterai-server/docs/api/remote-sync-retention-v2.md#sync-auto-recovery-diagnostics-20261113)。[服务端接入指南](../../../lobsterai-server/docs/integration/2026-11-13-sync-auto-recovery.md)说明服务端实施职责。

既有[任务隔离接入](2026-09-23-task-sync-fault-isolation.md)与[四条任务人工恢复记录](2026-11-13-mobile-sync-recovery.md)仍分别保留历史事实。四条人工恢复成功不是本方案的自动恢复验收，历史 400/426 的原始原因尚未完全证实。

## 1. 变更摘要与默认行为

新版桌面默认给可核验的任务级错误安排有界自动核验，包括缺少细分诊断的旧 400/409/426；不要求用户先打开设置页、手工点重试或授予额外权限。用户关闭同步或远控后仍遵守原停止规则，不擅自开启内容发布。

服务端在现有 `sync_diagnostics_v1` 的错误对象中增加可选提示，**它们只是识别失败点的增强项**。新桌面连接支持现有 state/import 恢复接口的旧服务时，也要根据原 HTTP/code/reason、操作阶段和本地不可变证据完成有界核验；更老服务缺必要能力时，保留协议与进度并提示限制，不能强制降级。

本方案不新增云端 repair/reset/retry API、MySQL DDL 或手机协议。原 HTTP 路径、认证、JSON 请求 body 白名单、字段类型、原 ID/hash、错误码/reason/retryable、ACK 和 WS 枚举不变，不把诊断或客户端声称的恢复资格发回服务端作为授权。

自动恢复只恢复同步，不重新执行 Agent、模型、工具、命令、审批或问答。核验成功只是取得事实，仍需满足原协议条件才能续传、补确认或限次重建。

## 2. 既有接口与认证

能力发现和首次设备注册使用各自既有认证规则。桌面同步请求继续使用 JWT Bearer、当前桌面设备凭据和原 transport 校验；已协商 `sync_target_v1` 时发送成对目标身份头，投影版本按既有协商设置。

```http
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <desktopDeviceId>.<deviceKey>
X-Remote-Data-Space-Id: <dataSpaceId>
X-Remote-Data-Generation: <dataGeneration>
X-Remote-Projection-Version: <negotiatedProjectionVersion>
X-Remote-Sync-Diagnostics: 1
```

最后一项仅在服务公告现有 `sync_diagnostics_v1` 后按原规则发送，不要求首次注册前已持有设备凭据。能力未公告、旧节点没有诊断、字段缺失均不阻断合法的基础核验。手机不能使用电脑凭据调用桌面同步接口。

下表仅列 legacy/v2 恢复复用的接口，前缀为 `/api/remote/v1`：

| 方法与路径 | 原请求与恢复用途 |
| --- | --- |
| `GET /capabilities` | 复用全局能力刷新；一次响应不能证明全节点兼容 |
| `POST /devices/register` | 原 body；确认当前设备与目标，不授予全部历史任务恢复资格 |
| `GET /sync/state?localSessionId=...` | 或原 sessionId 查询；核对映射、协议/epoch、水位、activeImport、fence、deleted |
| `GET /sync/imports/{importId}` | cursor/limit 沿用原分页；核对原 manifest、状态、期限、提交水位与分片摘要 |
| `POST /sync/imports` | 原 begin body；仅在原恢复条件已满足时创建导入 |
| `PUT /sync/imports/{importId}/parts/{partNo}` | 原不可变 payload/hash；续传不修改已发送分片 |
| `POST /sync/imports/{importId}/commit` | 原 manifestHash、状态版本及协议/传输字段 |
| `POST /sync/imports/{importId}/abort` | 原状态版本及协议/传输字段；不得假定远端未提交 |
| `POST /sync/batches` | 原流的 events、ID/hash、水位及协议字段 |

成功响应仍为 `{"code":0,"message":"success","data":{...}}`，不新增通用“恢复成功”响应。完整原协议见[同步保留 v2 API](../../../lobsterai-server/docs/api/remote-sync-retention-v2.md)。`syncProtocolVersion=2` 不是 HTTP 路径版本、WS protocolVersion 或 projectionVersion。

`GET /sync/imports/{id}` 会在归属验证后调用原 `expireOne`，可能确认过期并执行原过期收尾；因此“状态核验”不是远端数据库严格只读的承诺。它不会因此创建新导入或执行模型/工具。

## 3. 可选诊断的消费

现有 `data.syncDiagnostic.version=1` 与 failureScope/category/recoveryAction/retryAfterMs 语义不变。拟增加可省略的 cause、stage、requiredCapability；类型、固定枚举与产生依据只维护在[API 契约](../../../lobsterai-server/docs/api/remote-sync-retention-v2.md#sync-auto-recovery-diagnostics-20261113)，桌面不得自行扩展含义。

```json
{
  "syncDiagnostic": {
    "version": 1,
    "failureScope": "session",
    "category": "data",
    "recoveryAction": "manual_review",
    "cause": "projection_invalid",
    "stage": "projection_validation"
  }
}
```

此例对应已实现的可选响应增量，原 code/message/reason/retryable 不变。requiredCapability 只有失败点确实要求某个现有能力时才返回；未知字段本身不能证明缺少能力。

未知诊断版本整体忽略；version=1 的未知可选字段忽略，未知枚举或类型错误只让该提示失效。字段缺失不能被解释为成功、允许重建或永久禁止核验。现有客户端主要消费 failureScope/retryAfterMs，新版桌面已校验 cause/requiredCapability；stage 作为说明，不单独授予恢复资格。

提示不能覆盖身份、权限、目标、真实删除 fence、不可变请求或未知执行结果保护。回复入口在认证前产生的版本拒绝仍可能没有诊断，不为诊断改变认证顺序。诊断和日志不回显正文、任务标题、任意输入字段名、文件路径、凭据、签名 URL 或完整请求体。

## 4. 桌面实施事项

1. **保存失败与原操作。** 保留 owner/scope、设备/目标、任务映射、协议/epoch、import/event ID、manifest/hash、封存分片和 ACK。失败不能触发清队列、重建设备、自动登出或重新执行任务。
2. **独立采证，再走原恢复。** 核验函数只采集有界事实，不直接调用 `manualRetry()` 或可能提前 POST 的 `syncSession()` 冒充查询。原未决 import 优先于替代快照；分片分页未完成不把缺席项当作未接收。
3. **按真实状态处理。** committed 只通过原可信回执补确认；uploading 核对后续传原包；expired/aborted 明确匹配且来源/映射/预算可信时，才沿原流程创建新快照。404、超时、无权限、空结果或未知状态均不能当作 expired。state 水位不能直接伪造本地 ACK。
4. **区分可修复事实与冲突。** 运行/控制版本需核对可信来源，不将版本盲目加一；同 ID 不同摘要不换 ID 绕过；引用缺失不填空正文。已发送内容保持不可变，仅允许主 Spec 白名单中的新派生操作。
5. **持久预约与公平调度。** 使用主 Spec 的并发、速率、退避、证据去重、CAS 与重建预算；重启、重连、能力振荡和重复点击不重置预算。查询预算与原 `reserveRepair()` 重建预算分开计量，同一次重建不能重复扣取或另获额度。
6. **复用约 45 秒的全局能力刷新。** 由能力刷新触发时，仅相关能力变化唤醒核验；首次错误、原操作期限、指定修复策略等其他触发按主 Spec §4.1 执行。不为每条失败任务轮询。能力摘要不是全节点部署证明，也不是更改 dataGeneration、放宽门禁或重置隔离的依据。
7. **每次异步返回后复核上下文。** 重新核对账号 epoch、同步开关、目标、设备、准入、删除、lane 和原操作摘要；迟到结果不能确认另一账号、writer 或流。持久化失败时停止新恢复写入，不以内存成功代替落盘。
8. **展示以真实进展为准。** 总览、详情与菜单共用健康解释；核验排队/等待、正在核验、正在同步、需要处理和已同步须有明确依据。设备在线、GET 200、内部 ready 或请求 accepted 都不是内容已同步；正式回执前保留失败信息。只读展示 worker 不调度核验。

默认预算、时间目标、人工间隔与各阶段证据条件以[主 Spec 第 4–6 节](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-11-13-sync-auto-recovery.md)为唯一详细规则，不在接入文档另维护一套数值。

## 5. v3、持久化与回滚边界

legacy/v2 自动恢复必须通过当前 admission 与 `legacyHistoryAllowed`。v3 activation 已落盘、已经激活、正在接管或控制账本无法确认时，禁止退回 legacy；不能通过新建旧 import 或重放旧 writer 消除失败。已激活 v2 同样不得降为 v1。

v3 继续使用[既有 v3 API](../../../lobsterai-server/docs/api/remote-availability-v3.md)及 control/live/history/file 各 lane 的账本、writerGeneration、controlEpoch、historyGeneration 和原回执。不得用 `/api/remote/v1/sync/state`、legacy import 回执或其他 lane 的成功确认当前 v3 进度。本方案不触发 v1/v2→v3 模式迁移，不把迁移当作修复。

本地持久化实现仅添加有界核验元数据，不改原 phase/ACK/epoch/封存请求。已有 v3 `availability_faults` 含 positional INSERT，不能直接加列破坏旧兼容桌面；不足的核验字段按主 Spec 使用附加表。跨库不假设原子事务，各 lane 执行前继续按权威账本 CAS。预算和证据去重参与原目标档案与删除生命周期，不因切账号、重启或开关暂停清空。

**HTTP 向后兼容不等于任意旧桌面二进制可安全回滚。** 支持的回滚包必须认识现有 admission、目标身份、v2/v3 fence 和不可变操作，再验证新增可选元数据可忽略。发布前验证升级→未决操作/失败→兼容构建回滚→再次升级；不承诺回退到更早、不识别这些保护的版本。再次升级不能把旧版本改写普通调度字段当作预算未消费。

## 6. 配置、发布与验收

自动恢复默认开启且无额外授权。服务端既有 `remote-control.sync-diagnostics-enabled` 默认 true；显式关闭只停止可选提示，不影响合法的旧协议核验。如果实现新增止损开关，同样默认开启；暂停只停止新的自动预约/修复，不删除原操作、预算或隔离记录。涉及服务端开关时 Java 默认值与 `.properties` 环境变量回退保持一致。

桌面基础恢复和服务端诊断可独立发布。新旧服务混部可以缺少提示，原 syncTarget、retention、v3 全节点安全门禁保持；回滚仍须认识已激活协议和原回执。无需新增 MySQL 表、字段、索引或回填，保持 MySQL 5.7 和旧服务兼容。

实施验收须覆盖：新桌面旧服务无诊断、400/409/426 首次有界核验、原 committed/uploading/expired/unknown、引用及运行版本冲突、已发请求不可变、真实删除 fence、切账号/目标、预算跨重启、坏任务旁健康任务继续、v3 不回流、支持范围内本地回滚，以及实际状态经展示 worker 到 UI 的完整路径。完成后独立审查接口与恢复安全性；当前四条人工恢复不能替代这些验证。

实际实现、命令及安全复审结果集中在[主 Spec §13](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-11-13-sync-auto-recovery.md#13-2026-11-13-实施记录)。桌面新增共享恢复预算、legacy 查询协调器、v3 lane 核验和统一状态展示；服务端只追加可选诊断。未执行 MySQL 变更、服务端测试或部署，未提交代码。

当前保守边界：不明无原 import 错误、普通 404、缺失本地分片、错误 writer/epoch、迁移冻结和未知远端结果均不能触发重建。已知 immutable 冲突及缺可信细分的旧 47006，不能借 expired/aborted 换 ID；可验证的原 committed 回执仍可补确认。bootstrap 分片恢复核验父操作和原封存证据，随后仅续传原请求，父状态不当作分片 ACK。


2026-11-13 本地结果：桌面定向回归 17 文件、478 项通过，Electron 编译、renderer 类型检查和相关 ESLint 通过；服务端业务与测试源码编译通过，按约定未执行服务端测试。独立安全复审发现的问题已修正，详见主 Spec §13。

共享传输恢复证明已接入：同账号、目标、设备先发生真实临时失败，再取得同上下文可信 HTTP 成功时推进持久 epoch；缓存、连续成功、普通重连和重启不产生新证明。它只允许无确定结论的耗尽轮次申请下一轮核验，不解除确定错误、不代替回执，也不重置原预算。
