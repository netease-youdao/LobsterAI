# 新同步链路任务删除兼容修复（2026-10-28）

## 变更摘要

服务端不再将新同步会话是否可删除等同于旧 `syncProtocolVersion=2` 标记。已完成可信控制基线的新会话，在桌面协商支持 `session_delete_control_v1` 后返回原 `deletionGuard`。已接管但 fenced、控制未就绪或身份不完整时仍拒绝删除；有效旧 v2 保留原能力路径。

桌面从已验证的激活响应或当前 writer 状态补齐稳定 epoch，同时保存对应控制绑定；只补空值、不覆盖冲突，不推进 source/ACK 水位，不改原历史迁移证明。删除仍走原 claim、permit、本地事务和回执校验。

根因、兼容矩阵及手机接入要求见服务端[完整说明](../../../lobsterai-server/docs/integration/2026-10-28-remote-control-deletion.md)。

## 接口与认证

- `GET /api/remote/v1/capabilities` 新增可选能力 `session_delete_control_v1`。仅在本次服务端响应包含它且支持 `session_delete_v1` 时，桌面才在原设备登记/更新中声明；不从持久缓存推断旧服务支持。
- `POST /api/remote/v3/sync/mode-activations` 沿用原响应的 `sessionId`、`writerGeneration`、`streamEpoch`。已有 active 本地记录缺 epoch 时，沿用 `GET /api/remote/v3/sync/state` 核对同一会话、writer、controlEpoch、连接代次及 active/controlReady，再保存身份。
- 手机仍调用 `POST /api/remote/v1/sessions/{sessionId}/deletions`，例如 `{"requestId":"<UUID>","deviceId":"<desktopId>","expectedControlVersion":"18","expectedDeletionGuard":"12","expectedRunId":"run_01","action":"delete"}`。响应仍为 `{code,message,data:Operation}`；`state=completed` 才表示完成。

设备接口继续使用 `Authorization: Bearer <accessToken>`、`X-Remote-Device-Credential: <deviceId>.<deviceKey>`；写请求使用 `Content-Type: application/json`。v3 请求保留原 sync target 校验。所有权限由原账号、scope、目标设备、控制授权和执行许可决定，新能力本身不授予权限。

详细请求/响应见[删除 API](../../../lobsterai-server/docs/api/mobile-remote-session-deletion-v1.md)和[v3 同步 API](../../../lobsterai-server/docs/api/remote-availability-v3.md)。

## 客户端行动项

1. 桌面使用修复版本；已有 active 会话也会核对和补齐身份，无需删除本地数据或重新创建任务。
2. 手机沿用原 `session_delete_v1`、服务端 available、设备能力、授权和非空 deletionGuard 判据，刷新可信列表/快照。缺 guard 时不能强行解除置灰；本次不修改手机源码。
3. guard 冲突需刷新并重新确认；运行中的任务仅在用户明确选择后走 `stop_and_delete`。未知结果保留原 requestId 核对，不重复创建。

## 发布与验收

先完成所有服务端实例升级，再发布新桌面。混合版本集群中，能力查询与设备登记可能命中不同节点；旧节点仍会拒绝新能力。旧手机无必填字段、错误码或认证变化。无 SQL、DDL 或数据迁移，兼容 MySQL 5.7；现有删除开关和安全就绪条件保持。

使用隔离任务验证新会话、升级前已有会话、旧 v2、能力缺失、仅只读授权、离线恢复、guard 变化、账号/环境切换、epoch 冲突及本地保存失败。检查手机申请、原电脑执行与最终回执，不能仅凭按钮可点判定成功。工作区检查不替代安装包与手机端到端验收。
