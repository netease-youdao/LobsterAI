# 远程控制 Agent 摘要、目录和指定 Agent 执行接入

日期：2026-09-10。服务端与本仓库桌面代码已实现；尚未部署，V89 未执行。App 界面不在本仓库，须单独按完整 App 文档接入。Portal/Admin 无需修改。

## 变更与认证

既有 `/api/remote/v1` 上增加 Agent 目录；会话摘要增加 `agent`，新建命令可固定 Agent 和工作区。协议仍为 v1，HTTPS 发命令，一条 WSS 复用所有会话。连接票据、ACK、事件水位和断线补传规则不变。

普通 HTTP 请求继续带 `Authorization: Bearer <accessToken>`、`X-Remote-Device-Credential: <deviceId>.<deviceKey>` 和 `Content-Type: application/json`。账号及个人/企业 scope 由可信身份派生，不能在 body 传 owner。GET 要求当前手机对目标电脑有 read 授权；创建命令另要求 control 授权及设备在线。PUT 仅已登记的该电脑本人可调用，并验证 WS connectionGeneration。

## 能力与 App 改动

App 取服务端与目标电脑的 `session_agent_v1`、`agent_catalog_v1`、`agent_selection_v1` 交集。显示选择器还需电脑 `session.create`、目录 ready、Agent enabled/workspaceAvailable 和设备在线。缺能力时保留旧 main 流程；用户已经选定 Agent 后禁止静默改成 main。

1. 选电脑后 `GET /api/remote/v1/devices/{deviceId}/agents`。返回整个有界目录，无分页。
2. `GET /api/remote/v1/sessions?deviceId=...&agentId=...` 可按电脑及 Agent 筛选；cursor 与筛选绑定。
3. 列表/详情用 `session.agent` 显示来源。为空时显示来源未知，不猜 main。
4. 新建用下面选择参数；继续会话仍只发送 text，不能改 Agent/cwd。
5. 收到现有 catalog 订阅的 `catalog.changed` 且 `resource=agents` 后重新 GET。前台恢复、WSS 重连和约 45 秒刷新都核对目录；通知不是可靠数据库。
6. 缓存按 user/scope/deviceId/agentId 隔离；切账号清理视图和待返回请求。版本号按十进制字符串处理。

目录响应示例（包装仍为 `{code:0,message:"success",data:...}`）：

```json
{"deviceId":"pc_01","catalogVersion":"5","lastPublicationId":"96b42e3c-1291-4ec8-9ce9-0ab9fb247f85","defaultAgentId":"main","syncStatus":"ready","syncedAt":"2026-09-10T08:00:00.000Z","items":[{"agentId":"main","name":"主 Agent","icon":null,"kind":"default","version":"2","enabled":true,"defaultWorkspaceId":"workspace_main_1","workspaceAvailable":true,"unavailableReason":null},{"agentId":"agent_a","name":"周报助手","icon":"📋","kind":"owned","version":"7","enabled":true,"defaultWorkspaceId":"workspace_a_2","workspaceAvailable":true,"unavailableReason":null}]}
```

首次未发布返回 pending、items=[]、catalogVersion="0"、syncedAt/lastPublicationId=null。最多 200 项、256 KiB；匿名 Agent 不在选择目录中。离线可读缓存，不能据此认为可执行。

## 指定 Agent 新建

`POST /api/remote/v1/commands`：

```json
{"commandId":"04a1792e-a07e-4dde-a1c6-46768b9e7c5c","type":"create_session","deviceId":"pc_01","expiresAt":"2026-09-10T08:00:45.000Z","payload":{"text":"整理本周项目周报","agentId":"agent_a","expectedAgentVersion":"7"}}
```

`agentId`、`expectedAgentVersion` 成对出现，版本来自目录项 version，不能用 catalogVersion。workspaceId 可省略，由服务端固定所选 Agent 的默认映射；显式传入必须相同。受理响应仍为既有 Command，显式选择时附加：

```json
{"executionTarget":{"agentId":"agent_a","agentVersion":"7","workspaceId":"workspace_a_2"}}
```

手机先持久原 commandId/body，超时按原 ID 查结果和重试，不能按新目录重写已提交请求。服务端保存原 body/hash 及独立 execution_request，桌面 inbox 保存同一执行目标。accepted 不等于开始执行：桌面准备及运行器启动前会再次校验，Agent 变化时返回 rejected，不能切换目标。

错误：47027 目录 CAS 冲突（桌面重新 GET/对账）；47028 Agent 不可用（NOT_SELECTABLE/DISABLED/DELETED/WORKSPACE_UNAVAILABLE/BINDING_MISMATCH）；47029 Agent 版本变化。按完整响应的 reason/reasonDetail 处理，保留草稿，由用户重新确认生成新 commandId。

## 桌面发布与本地改动

`PUT /api/remote/v1/devices/{deviceId}/agents` body：

```json
{"publicationId":"96b42e3c-1291-4ec8-9ce9-0ab9fb247f85","expectedCatalogVersion":"4","connectionGeneration":"12","items":[{"agentId":"main","name":"主 Agent","icon":null,"kind":"default","version":"2","enabled":true,"defaultWorkspaceId":"workspace_main_1","workspaceAvailable":true,"unavailableReason":null}]}
```

成功 data 为 `{deviceId,publicationId,catalogVersion,syncedAt}`。每次完整快照恰好一项 main；publicationId+原规范化 body 持久化后发送。超时先用 GET 的 lastPublicationId 对账；同 ID 同内容幂等，变内容返回47006。重连只更新 connectionGeneration，不改变原目录内容/expectedCatalogVersion。目录变化不修改 settingsVersion，不触发逐次 WS 重连。

本仓库入口：`src/main/agentOwnership.ts`、`agentManager.ts`、`remote/remoteAgentCatalog.ts`、`remote/remoteBridge.ts`、`remote/remoteStore.ts`、`remote/sessionCommandService.ts`。main 负责提供可信 owner、所选 Agent 工作目录及执行许可复查。Agent 名称/图标为最小摘要，不上传 systemPrompt、模型凭证、配置、记忆或真实路径。

新增私有 Agent 归创建账号；未登录/旧 Agent 为本机匿名共享，main 公共。匿名任务从不上传；本人在匿名 Agent 下新建的归属任务允许带最小摘要并续聊。删除前检查外账号/隔离任务以及数据库和运行器中的在途任务，拒绝时不先 stop。主进程统一会话/文件可见性过滤，renderer 在账号变化时清空私有视图并丢弃旧响应。

## 发布与回滚

1. 在目标 MySQL 5.7 执行服务端 `sql/V89__remote_agent_catalog.sql`；不重跑 V88。本次没有执行任何数据库变更。
2. 新增一张目录表、remote_sessions 三列和索引、remote_commands.execution_request；无外键。schema.sql 同步用于新库，线上不要用它重建库。
3. 全部 4 个 Pod 部署兼容代码，两个 Agent 开关保持 false；原 `remote-control.enabled` 不变。
4. 部署新版桌面，开启 `remote-control.agent-summary-enabled=true`，确认摘要/目录后再开启 `remote-control.agent-selection-enabled=true`；App 依能力显示入口。
5. 关闭选择能力仅停止新受理，不能中断既有命令 ACK/核对。等待扩展命令及 outbox 恢复完成；不要直接回滚到不认识扩展字段的旧二进制或删除本地归属表。

完整字段、上限、恢复和联调矩阵：服务端 `docs/api/mobile-remote-api.md` 第 14 节、`docs/specs/mobile-remote-control/feature-2026-09-10-remote-agent-selection.md`。

## 验证记录

桌面 27 个相关测试文件、511 项测试通过；renderer/Electron TypeScript、48 个变更文件 ESLint 和 Vite 构建成功。独立临时 profile 窗口启动与匿名 Agent 列表 IPC 烟测通过。服务端仅 compileJava/compileTestJava 成功，按要求未运行测试。未执行数据库迁移、实际部署、真实手机联调或容量压测。
