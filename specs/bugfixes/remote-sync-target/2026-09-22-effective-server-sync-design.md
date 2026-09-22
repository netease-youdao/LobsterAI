# 远程同步使用当前生效服务的设计

日期：2026-09-22。状态：**客户端与服务端代码已实现，本地验证通过；测试库 V102 已执行，服务尚未部署，生产迁移及跨端验收待完成**。

桌面始终使用当前生效 API 地址同步当前账号有权同步的本地会话。域名和客户端线上／测试模式不再决定会话能否同步；当前服务确认已有数据后续传，权威确认的独立数据集建立新映射并上传完整快照。

本次评估收敛为：**一套活动同步工作集，加旧服务的必要恢复档案；扩展现有注册／状态／导入接口。** 不新增绑定预留接口，不为每个服务长期运行独立同步器，不后台访问已经切离的地址。服务数据身份只用于正确保存进度，不是地址白名单。

## 1. 背景和边界

历史 `sync_environment` 保存 URL，后来过渡修复改存 `production/test`。两者都无法判断实际数据是否连续：同一服务可以有多个域名，同一模式可能连到不同数据库，同一域名也可能发生数据库恢复。

新的规则是请求跟随当前 endpoint resolver，进度跟随服务确认的数据身份。账号归属、远控开关、文件发布范围和本地执行权限保持现有规则。同步不会重跑 Agent，也不会上传原始工作区或凭据。

| 场景 | 行为 |
| --- | --- |
| A、B 两个域名访问同一数据集 | 地址变化使旧请求失效；重新注册确认后保留映射及 ACK |
| 线上／测试开关改变，最终地址未变 | 同步不因模式名变化而失效 |
| 当前地址访问独立新数据集 | 自动归档旧传输状态，建立独立映射、序列和快照 |
| A → B → A | 恢复 A 的原映射、回执及未决操作；根据本地变化补快照 |
| 同数据集 generation 变化、进度回退或 epoch 不一致 | 保留本地记录并报连续性冲突，不当作新空库 |
| 401、超时、普通 404、HTML 响应 | 按认证／网络／协议故障处理，不能触发清零 |
| 服务端会话已删除 | 保留删除状态，不通过快照复活 |
| 切换时本地 Agent 正在执行 | 本地执行继续；旧许可失效，结果只归属原目标，历史可向当前服务同步 |

当前服务的账号必须通过已有可信认证体系，且与会话 confirmed owner/userId/scope 一致。`dataSpaceId` 不是认证凭据；不能凭昵称、邮箱或恰好相同的非统一身份数字 ID 跨账号认领数据。本项目沿用现有统一认证体系，不新增第二套 principal 协议。

## 2. 身份与不变量

- `effectiveApiBaseUrl`：唯一请求地址，沿用现有 endpoint resolver。
- `routeEpoch`：客户端地址或账号上下文变化时推进的进程内版本，含 A → B → A；可复用现有 `accountGeneration`。地址检查还覆盖发送后尚未收到切换通知的窗口。
- `syncTarget = {version:1,dataSpaceId,dataGeneration}`：注册返回并由当前认证服务确认的数据身份；所有同库节点共享，不能从域名、模式或 Pod 推导。
- `targetId`：客户端对数据身份、owner/userId/scope 的稳定散列。旧无此能力的服务使用受状态证据约束的兼容标识。
- 会话绑定：某 target 上的 `localSessionId → deviceId/sessionId/epoch/seq`，存放在活动工作集或恢复档案。不增加独立 binding reservation 或全局 binding 表。

必须保持：

1. 一次只有一个活动目标；旧请求、worker、缓存发布回包不能写入新上下文。
2. 新目标不继承旧目标的 ACK、连接配额、移除状态、文件 ID 或执行许可。
3. 已发 import/batch 的 ID、body、hash 和签名证据保持原样；未知结果先核对原操作。
4. GET state 不是 ACK；NOT_FOUND 不是删除数据或重跑命令的授权。
5. 本地会话、消息、真实执行记录、执行锁、账号归属、安全 journal 是全局事实，不随目标切换撤销。
6. 客户端线上／测试模式与协议 `mode=online/recovery` 无关；后者保留现有语义。

## 3. 最小服务端契约

### 3.1 发现与写入保护

现有 `GET /api/remote/v1/capabilities` 公告 `sync_target_v1`，现有 v1/v2 `POST /devices/register` 增量返回同一 `syncTarget`：

```json
{"syncTarget":{"version":1,"dataSpaceId":"f31c126d-25a6-4571-a4e3-e756da9d918d","dataGeneration":"1"}}
```

客户端从已认证注册确认身份；发现与注册结果不一致时重试发现，不能写入。新客户端后续请求成对携带：

```text
X-Remote-Data-Space-Id: f31c126d-25a6-4571-a4e3-e756da9d918d
X-Remote-Data-Generation: 1
```

服务端在业务操作前验证共享数据库的当前身份。不匹配返回 HTTP 409、code `47039`、reason `SYNC_TARGET_CHANGED` 和当前 `syncTarget`。覆盖远控 HTTP、文件请求、连接票据及 WebSocket 握手；旧客户端不带新头继续按旧契约运行，不改现有请求体白名单或 import requestHash。

服务端通过 singleton 数据表持久保存身份；正常发布、扩容和多域名入口不改变它。独立可写副本生成新 dataSpaceId；原数据集回滚恢复须在排空旧写入后把 generation 提升至所有历史已发行值之上，不能只对旧备份里的数字加一。即使运维错误未更新世代，逐会话水位和 epoch 核验仍拦截已观察到的回退。

新能力开关默认开启。关闭时旧客户端兼容，新客户端携带身份头的请求不能静默降级；返回协议升级错误。迁移及混部顺序见配套集成文档。

### 3.2 沿用 state 与 import

不新增 `/sync/session-bindings/resolve`。

- `GET /sync/state?localSessionId=...` 读取当前设备映射、protocol/epoch、水位、活动导入和 deleted。
- 独立新 target 的 sessionId 在客户端持久生成，source/ACK/serverSeq 独立初始化。
- 现有 online `POST /sync/imports` 在服务端 owner/device 锁内按 localSessionId 查重并创建映射，使用 expectedSourceSeq/expectedServerSeq CAS；manifest/parts/commit 和回执保持原协议。
- 新建 import 的不可变 ID、sessionId、请求及 manifest 在网络发送前落盘。重复请求返回同一结果，不能重新生成操作绕过冲突。
- recovery transport 不创建新映射；未知活动导入、服务端墓碑和待删除状态不能被空快照覆盖。

## 4. 客户端活动工作集和恢复档案

### 4.1 存储范围

保留一套现有 `remote_sync`、outbox、projection 及工作 KV；只对当前 target 产生同步事件。新增小型目标登记和档案存储由 `remoteSyncTargetStore` 管理，并在 SQLite 事务内切换。

档案包含恢复所需的映射、source/ACK/server 高水位、protocol/epoch、清理水位、投影版本及 revision 边界、不可变未决 import/part 索引、待确认传输状态、删除证明及必要文件引用。为保证首版无损恢复，可保留尚未确认的 outbox 和相关投影字节；它们是恢复材料，不是后台并行工作的第二套同步器。可重建缓存按需刷新，不引入永久多目标完整缓存架构。清理档案必须另有已验证终态依据，不能按切换次数直接丢弃。

核心会话和消息、全局 run/runHistory、inbox 中真实执行结果、inputFence、安全 journal、ownership 和本地删除事实不搬成新目标的执行状态。无论旧目标是否在线，它们都保留。

### 4.2 切换流程

1. 地址或账号上下文变化：推进 epoch，断开旧连接，取消旧快照工作，冻结旧许可，暂停传输。
2. 向当前地址发现能力并注册；校验账号及服务数据身份，不沿用旧连接 removed/quota 状态阻断发现。
3. 同一已知 target 恢复原工作集；不同已知 dataSpace 归档旧工作集并创建新工作集。同 dataSpace 的 generation 改变不能当作新目标清零。
4. 切换事务完成后设置新投影身份、刷新模型／agent/workspace 缓存、获取新连接许可；逐会话核对原未决操作与状态。
5. 新目标仅从本地安全投影建立全量快照；切回旧目标先核对原 import 回执，再根据本地更新补事件或快照。
6. 任何步骤失败都不影响本地聊天，不能删除恢复档案或重跑执行。

档案包含完整性清单（条目数及 SHA-256）；合法空档案也必须有清单。已知 target 的档案丢失或损坏时阻断恢复，不能重新生成映射冒充首次同步。

工作集交换前应停止旧投影发布；已启动 worker 的结果必须同时匹配会话、设备、target 及本地 revision。切换事务使旧 publication 失效，迟到结果不能覆盖新映射。

### 4.3 缓存、输入与历史投影

模型、agent catalog、workspace、输入准备及连接状态按 target 隔离。在途缓存任务还校验 epoch，防止 A → B → A 接受第一轮 A 的迟到结果。新目标重新发布模型和 agent 目录，旧 workspace/model/asset ID 不能自动作为新服务引用。

历史消息保留文本，但旧服务的 commandId/runId 外键、远程资产 ID 和未决 approval/question 不携带执行权投影到新服务。仍可从本地安全读取的文件按新服务上传规则重新发布；不可读取的远程附件只保留可说明的历史内容，不伪造新资产已上传。旧服务原映射和未决操作仍在档案中恢复。已验证的 legacy target 升级为权威身份时，同时迁移 scoped settings、inbox 和输入操作的路由键，保留原操作正文和哈希。

inbox 去重使用 `(targetId, commandId)`，真实执行记录及本地运行锁保持全局。切换后旧运行结束可记录原 inbox 结果，但不向新服务发送旧 ACK。旧 prepared/executing/unknown 命令不会因为新服务发现相同本地会话而自动再执行。

GC 和 import spool 清理必须同时查看活动与档案引用；有未决 import、输入、文件任务、删除证据引用的文件不能因目标非活动而删除。

## 5. 连续性与恢复判定

记 H 为本地 source 上界、A 为持久 ACK、S 为服务端 lastSourceSeq、Q 为本地已确认 serverSeq、T 为服务端 lastSeq、P 为源事件清理水位。

同一流要求设备／会话／owner 相符、protocol/epoch 有原始回执支持，且 `A ≤ S ≤ H`、`T ≥ Q`。GET 状态不推进 A；batch 仍按原事件重放获得 ACK，import 按原 ID 查询终态回执。

| 证据 | 处理 |
| --- | --- |
| 原未决 import 已 committed | 验证原 ID、manifest、epoch、source 边界后原子确认；先于流 epoch 比较 |
| 原 import uploading | 继续原操作或取得已验证 abort/expired 终态后重建 |
| 事件仍完整且 A+1 > P | 按原事件顺序增量发送 |
| 源窗口已清理，但已证明同一流 | 保持 epoch，按 S/T CAS 上传当前快照；边界 N 满足 S ≤ N ≤ H |
| 同一绑定 S<A、S>H、T<Q 或 epoch 无回执支持 | 冲突，保留 outbox/档案，不能假造 ACK |
| 从未发布、无未决 import，v1/ACK=0，精确 HTTP404/code47038 | 允许首次 online import |
| 已知绑定丢失、v2 映射404、普通404 | 不清零；需恢复原流 |
| 权威确认的独立新 dataSpace | 使用新的独立工作集和首次快照 |
| deleted 或待删除 | 走原删除核对，不能重建复活 |

新建删除操作的 target 增量携带可选 syncTarget，客户端按当前已验证的数据身份核对同服务新域名下的删除请求；原 serviceScope 保留，旧操作不补写字段，终态回执仍与原证明严格匹配。删除许可、签名回执、serviceScope 不改写。旧环境字符串仅可经账户、设备、会话及服务端状态证据建立本地别名关系，不能借域名归类给新目标授予删除权。本地删除事实全局有效，切回旧目标时也不能恢复本地已删会话。全局执行禁令仍有效；只关闭已经取得删除证明的那条远端映射。切回尚未收到删除的旧映射时，先核对原 import，再以原 epoch/CAS 上传仅包含 session.deleted 的快照，不复制其他服务的删除 ACK。

## 6. 旧数据与旧服务兼容

迁移覆盖 URL、production/test 和尚未绑定的空环境记录。不按域名白名单或客户端模式批量推断身份。

- 首次认领已发布 legacy 工作集，逐会话验证服务端 device/session/epoch/水位；先处理原 pending import 回执。只改变可变路由索引及本地证据别名，不重写不可变操作体和签名。
- 未发布本地会话可直接绑定。已知未发布需无设备绑定、ACK/serverSeq 为零、v1、无 epoch 和无 pending import；本地已生成 projection/source 事件不等于服务端已经收到。
- 首次升级先在原有服务完成状态核验与数据身份认领，再自动切换到其他已确认的独立 dataSpace。若原服务尚无身份记录、设备映射丢失或设备变更，保留原工作集并要求恢复；新 deviceId 本身不能证明是独立新库。
- 无 `sync_target_v1` 的旧服务：已存在映射经原 state/receipt 证据可继续；无法可靠识别独立新库时保持原记录并报告需升级。已知权威目标不能静默降级成无身份服务。
- 历史安全日志、全局执行事实和删除凭据不按 URL 或模式迁移成新的执行许可。

## 7. 验收与交付

客户端自动化至少覆盖：

1. 同库多域名、同模式不同库、仅模式变化但地址相同。
2. A → B → A 和 response body 延迟；旧 epoch 不能写入。
3. 新库独立快照、不继承 ACK；回旧库恢复原未决 import 的原字节。
4. 同库 generation 变化、state 回退、server ahead、epoch 冲突不清零。
5. 404/401/网络失败不触发错误 bootstrap，远端 deleted 不复活。
6. 旧命令不向新目标 ACK、不重新执行；真实本地运行事实保留。
7. 缓存／输入／文件引用按 target 隔离，历史投影无旧执行外键。
8. URL/mode 数据认领需要证据，账号不同不能认领。
9. 档案 import spool／文件引用受 GC 保护，切换事务失败完整回滚。

服务端验证：新增字段向后兼容、头成对验证、错库/世代拒绝、票据握手保护、同库多节点身份一致、原 import CAS/删除保护不回归。遵循服务端仓库约定默认只编译及编译测试源码，不运行依赖外部 MySQL/Redis 的测试。

交付顺序：显式关闭服务端身份能力 → 服务端迁移及全部入口受控部署 → 确认 writer 身份一致后开启能力 → 桌面发布 → 多域名/独立库/切回/删除/活动运行跨端验收。能力默认开启，混部前必须显式关闭，详见[接入与发布说明](../../../docs/server-integration/2026-09-22-remote-sync-target.md)。开发完成不等于已部署；未升级服务器只使用上文兼容路径。任何实际迁移、部署和用户数据库修复操作需按发布流程执行，开发验证使用隔离数据库副本。

### 7.1 本次实现与验证记录

- 客户端：目标身份与路由 epoch 校验、单活动工作集及事务归档恢复、legacy 证据认领、目标内缓存与输入隔离、旧执行结果归属、附件独立重传、删除传播和档案 GC 保护均已实现。
- 服务端：持久身份表、现有 capabilities/register 扩展、HTTP 目标头校验、票据与 WS 握手校验、删除 target 增量身份字段均已实现。未新增 resolve 接口。
- 自动回归：`npm test -- src/main/remote src/shared/remote --maxWorkers=2`，51 套、786 个用例通过；42 个修改的 TypeScript 文件通过 CI 同规则 ESLint；`npm run compile:electron` 通过。
- 隔离数据库演练：对当前桌面数据库的只读备份执行 legacy 认领及 A → B → A，11 个会话的核心内容、outbox/projection 字节和原设备／会话／ACK／epoch／清理水位完整恢复。演练发现的 `sha256` 列名校验问题已修复，并补充包含中文、emoji 和换行正文的回归。演练中的服务端状态来自副本夹具，仅验证存储不变量，不冒充真实服务器连续性证明。
- 服务端：`./gradlew compileJava compileTestJava -x test --offline` 通过；按仓库约定未运行服务端测试。测试库 V102 已按下述记录执行；未执行生产 SQL、部署或身份轮换。
- 尚待验收：Mac 锁屏导致开发版 UI 操作未完成；真实多服务、手机端及数据库迁移后的端到端验收须按发布步骤进行。自动测试和副本演练不替代这些验收。

### 7.2 测试库迁移执行记录

2026-09-22 19:36（Asia/Shanghai），按用户授权在 `application-test.properties` 指定的 writer `test-lunadb-writer.corp.yodao.com:13306`、数据库 `lobsterai_server` 执行 `V102__remote_sync_target.sql`。执行前确认节点可写、目标表不存在；仅创建身份表并初始化记录，没有修改既有业务表。

- 脚本 SHA-256：`82e36fa4adecd88d2570d1e11987b77b0c3d2f8e4b60365adeaeda55b32ff6a8`。
- 执行后唯一记录：`singleton_id=1`、`dataSpaceId=e94fd9f2-b679-11f1-9d04-246e966b55e0`、`dataGeneration=1`，`updated_at=2026-09-22 19:36:54.681`。
- 四列类型、非空约束、主键、InnoDB 引擎及字符排序规则均与迁移一致；`SHOW WARNINGS` 为空。
- 此记录仅证明测试库 V102 已落地；未部署服务、变更功能开关、操作生产库或旋转已有身份，亦未重复执行 DDL 验证幂等性。
