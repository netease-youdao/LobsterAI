# Agent 关联失败创建记录修复（2026-10-29）

## 变更摘要

桌面曾将子 Agent 创建被拒绝后保存的临时名称当成真实 Agent 权限依赖，导致原本可关联的匿名 Agent/任务被 `NOT_ASSOCIABLE` 拦截。现在仅对 `status=error, session_key IS NULL, child_cowork_session_id IS NULL` 的未建立执行记录跳过该 Agent 依赖检查；父任务及全部真实关系继续校验。

该缺陷已通过真实追踪器与内存 SQLite 链路复现；现场旧日志没有记录失败分支，尚不能据此断言截图中的所有关联失败都属于此缺陷。详细证据、范围与验证见[修复 Spec](../../../lobsterai-server/docs/specs/mobile-remote-control/bugfix-2026-10-29-agent-association-failed-spawn.md)。

## 接口与前端动作

无 HTTP API 变化。沿用 `window.electron.ownership.preview/commit/getResult`、原请求/响应类型、`NOT_ASSOCIABLE` 错误码和确认流程。Renderer 不传目标账号；账号与空间仍由主进程获取。

用户升级桌面后重新点击“关联账号”，预览允许时再确认；不自动关联、不清空任务或历史记录。真实跨 Agent 子任务来自尚未关联的外部匿名根任务时，仍需先关联根任务整组，再关联 Agent。其他账号/scope、隔离记录或异常关系依旧整体拒绝。

## 安全与诊断

- 不跳过父任务可见性，不转移既有归属，不忽略运行中或有真实执行 key/子会话的记录。
- `session_key` 纳入预览指纹，提交仍在原事务中重算范围与计划，防止迟到结果改变授权范围。
- `[Ownership] Association blocked` 增加固定内部 reason；不记录标题、账号、正文、受限对象 ID 或数量。诊断异常不改变业务错误码。
- 公共 UI 继续保留通用冲突提示，不暴露隐藏对象信息。

## 发布与兼容

仅桌面源码变化，服务端仅文档更新；无手机、Portal、Admin 代码或 MySQL 迁移。无需正式服、测试服同步发布。历史符合条件的记录由新校验直接处理，不做批量认领或用户数据库修补。安装包发布及现场失败 Agent 复验仍需另行完成。
