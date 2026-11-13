# 远程会话测试/生产环境隔离（2026-10-29）

## 变更摘要

修复桌面切换服务数据空间后，自动为相同账号的全部本地历史建立新同步映射、重新发布 Agent 目录的问题。来源服务归属与当前同步目标分别检查；创建或主动关联时记录来源，不能在另一环境登录后自动改写归属。

服务端无业务代码、API 字段、认证、错误码、功能开关或 MySQL DDL 变更。手机 App、Portal 和 Admin 源码不修改。

## 接口与示例

沿用 GET `/api/remote/v1/capabilities`、POST `/api/remote/v1/devices/register`（支持时用 v2）、POST `/api/remote/v1/sync/imports`、现行 v2/v3 同步接口、PUT `/api/remote/v1/devices/{deviceId}/agents`。请求 JSON 与幂等身份不变，不增加自报来源环境字段。

已协商同步目标能力的请求仍携带：

```http
Authorization: Bearer <current-environment-access-token>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
X-Remote-Data-Space-Id: <confirmed-data-space-id>
X-Remote-Data-Generation: 1
```

capabilities 和注册的既有响应字段示例：

```json
{"code":0,"message":"success","data":{"syncTarget":{"version":1,"dataSpaceId":"example-production-space","dataGeneration":"1"}}}
```

示例省略其他原有字段。发现请求不携带旧目标头；注册不需要设备凭据。完整请求体、响应体和版本能力见[服务端接入说明](../../../lobsterai-server/docs/integration/2026-10-29-remote-environment-isolation.md)与[同步目标 API](../../../lobsterai-server/docs/api/remote-sync-target-v1.md)。

## 桌面行动项

- 来源使用创建/关联时的实际服务地址及核验后的数据空间；远控关闭时也记录，不能只在首次上传时取当前环境。UI 测试模式开关不能代替实际服务身份。
- 会话历史、实时内容、Agent 目录及远程执行/删除准入必须遵守来源边界；默认 Agent 可保留，历史会话仍逐条检查。
- 保留切回原目标所需的设备、会话、epoch、操作 ID、ACK 和未决证据；来源不明的旧记录保留本地等待核验，不能清空后重传。
- 同库已核验入口别名保持连续性；同数据空间 generation 变化继续遵守原恢复门禁。

## 认证要求

沿用 access JWT、账号状态、个人/企业空间、设备凭据与授权校验；相同数值 userId 不代表跨环境同一身份。数据空间 ID 不是凭据，Portal Cookie 不能替代远控认证。旧服务端能力协商和全部缺省目标头的旧客户端语义保留。

## 发布与限制

升级会上传数据的桌面客户端后生效，不需要服务端发布或 MySQL 迁移，兼容 MySQL 5.7 与旧服务。旧桌面仍可能重新上传测试历史，不能只靠手机刷新解决来源问题。

本次不删除已经复制到生产库的记录；服务器原协议没有可靠来源字段，不能按标题或日期自动清理。需要清理时另行核验账号、设备、会话 ID，避免误删本地任务和未决执行证据。

手机 App 后续核查环境切换后的缓存、分页游标、订阅及迟到请求隔离；当前任务仅在服务端文档交接，不更改手机源码。真实双环境/手机联调尚未完成；本地验证及接口安全审查见服务端实施记录。

## 2026-11-13 自动化来源接入增补

状态：桌面源码修复完成，定向回归、编译、严格 lint 和独立安全复核通过。源码与修复前回归确认：旧 cron／IM 来源绑定只保存 owner，在测试环境创建但尚无会话的自动化，可能在切换生产后首次生成会话时误用生产来源。截图只能证明用户观察到的现象，尚不能确认其具体记录由该路径上传。

新自动化在异步创建／配置开始前捕获 owner、实际路由和已核验的数据空间，绑定时原子保存为既有 SQLite 来源旁表中的 `kind='source'`。`bound_automation` 会话继承原 source 来源，不按首次运行或收到消息时的当前环境补记；等待期间切服／切账号不得改变原快照，也不覆盖已有来源。

历史只有 owner、来源未知或冲突的 source 使用不可认领标记（本地 `route=''`）。保留原本获准的本地执行，远程发布仍须满足来源、owner／scope 和目标准入；不补当前环境，不清旧映射、ACK 或未决证据，不自动迁移／删除已上传云端存量。

绑定拒绝自动认领已有匿名 source；仅残留 origin 而缺少 owner 记录时，无论 origin 是当前账号还是其他账号，均拒绝隐式恢复归属。来源与 owner 绑定原子保存，失败整体回滚。

本轮使用 Node 24.22.2，18 个测试文件、779 项全部通过，包含 11 项真实存储新增回归及 2 项 handler 异步切换用例。Electron 编译退出码为 0；本轮 9 个 TypeScript 文件严格 ESLint（`--report-unused-disable-directives --max-warnings 0`）通过。独立安全复核完成，发现的问题均已修正，无未解决项；具体验证命令见下方实施记录。

服务端 API、HTTP/WS 字段、认证、错误码、能力公告和 MySQL DDL 均不变，兼容旧服务及 MySQL 5.7；不改手机 App 源码。升级实际上传数据的桌面端后，再验收测试创建→生产首次产生会话、创建等待中切服／切账号、切回原服务、未知／冲突历史及本地执行。当前未发布、未操作现场、未完成双环境真机验收；截图所示存量的实际来源仍缺现场日志证明，不自动清理已上传云端数据。详见[服务端实施记录](../../../lobsterai-server/docs/operations/2026-10-29-remote-environment-isolation-review.md#2026-11-13-增补自动化来源晚于创建时绑定的缺口)。
