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
