# 新旧同步切换冻结恢复（2026-10-28）

## 变更摘要

旧导入异步制包期间，新同步通道可能已经接管会话。桌面须在持久保存迁移导入及冻结之前重查归属，避免旧 begin 被 WRITER_TAKEOVER 拒绝后，新通道因 migration_frozen 一并停住。已有卡住记录通过原身份与未分配证明核对恢复，不重建会话、不重跑任务。

现场 Excel 任务证据、详细边界、验证及发布状态见服务端[完整接入说明](../../../lobsterai-server/docs/integration/2026-10-28-remote-writer-takeover-recovery.md)。

## 接口与认证

无新增服务端接口、能力或字段。沿用 `POST /api/remote/v1/sync/imports` 核对原 importId 及固定业务请求，`GET /api/remote/v3/sync/state` 核对同一 writer。只有原 begin 的 HTTP 409 / code 47006 / reasonDetail WRITER_TAKEOVER 可以证明该原请求未分配；不能泛化到其他冲突或普通 404。原回执已存在时优先返回原状态，不能按未分配处理。

state 查询的精确 HTTP 409 / code 47003 / reason DEVICE_NOT_READY / reasonDetail CONTROL_BASELINE_REQUIRED 仅证明原 writer 存在但尚未就绪，仍需原导入未分配证明；不能将其视作 active 或执行许可，不能生成新 activation/writer 替换原身份。

完整请求/响应、公共上下文见[同步 API](../../../lobsterai-server/docs/api/mobile-remote-api.md)和[v3 API](../../../lobsterai-server/docs/api/remote-availability-v3.md)。保留 `Authorization: Bearer`、`X-Remote-Device-Credential`、sync target/data generation 与当前连接代次校验。身份、目标、删除围栏及原操作核对不能被重试按钮或恢复标记替代。

## 客户端行动项

- 升级桌面修复版本；已有冻结记录也需核对原请求，不能通过清空本地数据库、删除导入记录或重建 writer 恢复。
- 恢复在同一核心事务中归档完整原 saved import 与证明、移除活动导入指针、解除冻结；保留 manifest、spool、源记录及 ACK。归档不能覆盖，损坏时停止 spool 清理。身份冲突、已分配操作或未知结果保持安全阻断。解除冻结只允许继续新通道同步，不代表服务端已接收结果。
- 手机继续读取原消息和运行终态；不得用超时推断成功或重复下发原任务。需要补拉/重新订阅时沿用主 API 第 9 节。本次不修改手机源码。

## 发布与验收

本项无需新增服务端部署或数据库迁移前置条件，兼容已实现 WRITER_TAKEOVER 的旧服务；与其他改动合包时仍遵循各自发布要求。MySQL 5.7、旧接口语义和现有开关不变，Portal/Admin 无动作。

隔离任务验收必须覆盖并发接管、已卡住后重启、上下文切换、不同 writer、非 takeover 错误、原请求未知、写入失败回滚，以及恢复后原终态和最终回复获得可信同步回执。未完成手机真机验证前，不把本地已解冻等同于现场已解决。
