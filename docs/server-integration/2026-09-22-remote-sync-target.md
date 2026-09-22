# 当前服务同步目标接入

日期：2026-09-22。客户端与服务端代码已实现，测试库 V102 已执行；生产库未执行，服务代码未部署，UI 与真实多服务跨端验收尚未完成。客户端 51 套测试、786 个用例及 42 个 TypeScript 文件 lint 通过；服务端代码与测试源码编译通过，未执行服务端测试。`sha256` 列恢复问题已修复，隔离真实数据库副本的 11 个会话 A→B→A 演练成功。

## 变更摘要

服务端新增可选能力 `sync_target_v1`，用数据库持久的 `dataSpaceId/dataGeneration` 识别实际目标。域名与 production/test 只决定当前请求地址。接口路径、认证、同步请求体、import/batch 哈希及原有 ACK/删除语义不变，不新增 resolve API。

服务端权威说明：[remote-sync-target-v1.md](../../../lobsterai-server/docs/api/remote-sync-target-v1.md)。桌面采用一套活动同步工作集，切离服务只保留必要恢复证据；不能将这些证据改写为新目标的状态。

## 接口与请求格式

`GET /api/remote/v1/capabilities` 在 `data.capabilities` 中公告 `sync_target_v1`，同时返回：

```json
{
  "syncTarget": {
    "version": 1,
    "dataSpaceId": "449157c2-49d8-4ea7-b8f4-c4c6e4ecbe56",
    "dataGeneration": "1"
  }
}
```

`POST /api/remote/v1/devices/register` 与 `/api/remote/v2/devices/register` 的既有响应也增加相同 `syncTarget`；首次注册和重试一致。注册请求体不变，可在 device capabilities 声明 `sync_target_v1`。`dataGeneration` 为规范正十进制字符串，保持字符串精确比较。

发现当前入口后，注册及后续 remote HTTP 请求固定携带目标头；GET 状态、文件上传、目录发布、控制/删除和 ticket 也适用：

```http
Authorization: Bearer <access-token>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
X-Remote-Data-Space-Id: 449157c2-49d8-4ea7-b8f4-c4c6e4ecbe56
X-Remote-Data-Generation: 1
```

capabilities/注册沿用 JWT 身份认证，不要求 device credential；其他接口保持原凭证与 owner/scope 权限。首次探测新入口不携带旧目标头，避免旧目标阻止发现；注册响应必须与此次发现一致，才可绑定后续调度。新目标不是跨账号授权，不得仅靠碰巧相同的数字 userId 认领内容。

两个头均可缺省，兼容旧客户端；仅一个头或格式错误返回 `400/47019`。已携带预期目标但服务不符返回：

```json
{
  "code": 47039,
  "message": "当前服务数据身份已变化，请重新连接",
  "data": {
    "reason": "SYNC_TARGET_CHANGED",
    "retryable": false,
    "syncTarget": {
      "version": 1,
      "dataSpaceId": "449157c2-49d8-4ea7-b8f4-c4c6e4ecbe56",
      "dataGeneration": "2"
    }
  }
}
```

HTTP 为 409。停止当前调度并重新发现/注册，保留在途操作的 ID/manifest/回执；不能仅替换头后原样向另一个目标重试。能力关闭时，带头请求返回 `426/47009`，不静默忽略校验。普通 404、网络失败或未公告能力均不证明空服务。

新 ticket 在服务端包含数据身份，WS 握手复检；客户端不修改 ticket URL。已有 WS 不周期重读目标，因此数据库恢复必须由运维排空连接、请求和票据，不能在线无协调替换数据集。

新建删除操作在原 `target` 内增加可选 `syncTarget`（与注册格式相同），持久保存创建时身份；桌面 get/claim 返回原值。`serviceScope` 保留创建时 API origin。新客户端先核对该身份与已注册目标，再核对 owner/device/session/epoch，允许同库换域名；没有该字段的旧操作继续要求已核验的持久 scope alias。完成凭证与 target 的 scope 原文仍须严格一致。手机 create 请求、幂等 hash、permit/report 和完成凭证格式不变。旧客户端容忍 target 的额外字段；旧操作和幂等重试不补写该字段，关闭身份能力时维持旧格式。

## 已实现的客户端行为

1. 使用当前 endpoint resolver 地址发现并注册，核对能力、target、账户和设备；生效 URL 或认证上下文改变推进进程内 route epoch；单独 mode 名变化不影响同步，使旧回包不能写入新活动状态。地址、token 和目标头在派发时一次捕获。
2. 同一 dataSpace/generation 先用既有 state 和原回执确认 device/session/localSession/协议/epoch 连续性，再增量；GET 水位不直接推进 ACK。同目标多入口不重复全量。
3. 只有已确认独立的新 dataSpace，且恢复记录不表明曾绑定该目标，才初始化独立活动工作集。精确 `404/47038/SYNC_STATE_NOT_FOUND` 后，使用既有 online import 的原子创建与 S/T CAS 完成首次快照；recovery 模式不能创建映射。不得拿旧目标 ACK 或 pending import bytes 作为新目标的基线。
4. 同一 dataSpace 的 generation 改变、已知目标原映射消失、远端回滚或未知执行/删除事实，暂停该会话并核对。generation 变化不授权清零、换 sessionId 或绕过墓碑。
5. 原 SavedImport 优先按原 importId/manifest/目标 epoch 恢复，只有确认 aborted/expired 才重建。增量重放要求完整连续的原事件且首项 `A+1>P`；窗口过期仅在同流基线可信时用原 epoch 快照恢复。batch 没有独立持久回执查询接口，不能把普通 state 当成 batch ACK。
6. 切离时保留原 device/session/epoch、原未决操作及最小终态证明；停止旧服务后台调度。切回先核对这些记录，再生成当前内容快照。旧签名 `serviceScope`、payloadHash、许可和执行日志保持原文。
7. 无新能力的旧服务仅运行已有、可用 state/回执证明连续性的映射。未知服务不能靠普通 404 触发历史 bootstrap。本地聊天和已运行任务继续。

已有远端历史首次迁移到权威身份时，必须先连接原服务，用原设备逐会话核验映射、epoch 和水位，并优先恢复原 import 回执。原设备变更/丢失、原服务不可确认或已知目标档案缺失/损坏，都进入恢复冲突；不能把安装 ID 变化或某个 URL 的 404 当成独立新库证明。已核验的 legacy target 升级时迁移目标内设置及路由键，保留操作原文与哈希。

快照仍遵守文件可发布范围、现有安全投影及只读历史规则；不能复制旧目标的可执行 command、审批或输入 preparation 权利。`deleted=true`、未决删除、未知 activeImport、`S<A`、`S>H`、`T<Q` 均不能落入盲目全量分支。

## 发布、迁移与验证

发布时先显式设置 `REMOTE_SYNC_TARGET_ENABLED=false`，再应用 `sql/V102__remote_sync_target.sql` 并升级全部 HTTP、文件与 WS 入口；确认所有节点从 writer 读取同一身份后，统一开启公告，再发布依赖本契约的客户端。开关默认 true，因此混部/迁移前必须显式关闭；只升级一个节点不足以保证其他节点执行目标头。关闭能力会拒绝已携带目标头的请求，不能把它作为新客户端继续写入的降级通道。

singleton 身份行从 writer 读取；迁移通过 `CREATE TABLE IF NOT EXISTS` 与 `INSERT IGNORE` 保留已存在身份，本次没有重跑 DDL 验证幂等性。独立可写副本分配新 dataSpaceId；同逻辑数据集恢复保持 ID，并将 generation 设为高于历史所有已发行值。世代高水位必须来自外部审计记录，不能在旧备份值上简单加 1。轮换前排空 HTTP、WS 和票据；本次仅在测试库首次创建身份，没有执行轮换或恢复运维。

### 测试库 V102 执行记录

2026-09-22 19:36:54 +08:00，已按授权在 `application-test.properties` 对应 writer `test-lunadb-writer.corp.yodao.com:13306`、schema `lobsterai_server` 执行 `V102__remote_sync_target.sql`。执行前确认 MySQL `5.7.33-36-log` 可写，`remote_sync_target` 表不存在。迁移文件 SHA256 为 `82e36fa4adecd88d2570d1e11987b77b0c3d2f8e4b60365adeaeda55b32ff6a8`。

执行后 4 列、主键、InnoDB 引擎及排序规则校验通过，`SHOW WARNINGS` 为空；唯一身份记录为：

```json
{"singleton_id":1,"dataSpaceId":"e94fd9f2-b679-11f1-9d04-246e966b55e0","dataGeneration":"1","updated_at":"2026-09-22 19:36:54.681"}
```

未改已有业务表，未做身份轮换，未重复执行 DDL。本地执行证据：`/tmp/lobster-v102-migration-report.json`。生产库未执行；测试库建表不代表服务代码已部署或能力已完成跨端验证。

### 自动验证与待验收项

客户端最终自动回归为 51 套测试、786 个用例通过，包含新增 `sha256` 恢复回归；42 个 TypeScript 文件 lint 通过。实际桌面数据库副本演练发现恢复列名校验误拒绝合法 `sha256` 列，现已改为按实际表结构验证列名。隔离真实数据库副本的 11 个会话 A→B→A 演练成功，`contentAndEventBytesUnchanged=true`、`originalProgressRestored=true`。验证使用隔离副本，没有修复用户原始数据库。

Mac 当前锁屏，CUA 无法完成 UI 手工验收；真实多服务部署验收也尚未完成。数据库副本演练不等于 UI 或跨服务部署验收通过。

服务端 `./gradlew compileJava compileTestJava -x test --offline` 已通过，包含 9 个新增身份协议回归测试和 3 个删除目标兼容测试源码，按服务端 AGENTS 约定未执行测试。两个入口同库/不同库、同 URL 换库、恢复世代、切回、丢 ACK、删除与文件仍需受控部署后的跨端验收。当前仅测试库 V102 已执行，生产库未执行，服务代码未部署。
