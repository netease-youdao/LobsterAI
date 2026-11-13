# App Agent 设置：桌面与服务端接入

日期：2026-11-05。状态：服务端、Electron 代码已实现，未部署；手机 App 源码不在本任务范围。完整协议以 [服务端 API](../../../lobsterai-server/docs/api/mobile-agent-settings-v1.md) 为准，页面设计见 [Spec](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-11-05-mobile-agent-settings.md)，App 行动项见 [接入说明](../../../lobsterai-server/docs/integration/2026-11-05-mobile-agent-settings.md)。

2026-11-13 更新：新版桌面已移除额外手机/Agent/分区授权操作，自动同步同账号有效访问；两个桌面列表新增可选分页，手机请求字段不变。本次变更以[同账号访问接入说明](2026-11-13-mobile-agent-settings-same-account.md)为准，下文验证记录为 11 月 5 日历史结果，不代表本次简化已部署。

2026-11-13 可靠性修复：Agent 访问失败分类、写入前归属防护、插件多实例状态共享及服务端实时控制事实校验，见[排查与接入说明](2026-11-13-agent-access-and-settings-recovery.md)。本次没有新增 App 必填参数或协议版本。

## 1 变更概述

作用域固定为当前电脑、当前 Agent。模型和协作名单可直接保存；身份、长期记忆、关于你只读，通过同目标会话中的受控工具修改。桌面是配置事实源，服务端只传递受授权操作并保留结果。原会话命令、认证、模型覆盖、旧 grant 权限和旧 API 语义均保留。

不做 App 全文编辑、任意路径文件访问、账号间工作区合并或自动上传已有记忆。main 使用本机共享文件，按同账号有效连接及内部绑定按需访问；非 main 依据现有 Agent 归属隔离。

## 2 端点、认证和消息格式

完整前缀 `/api/remote/v1`。请求使用现有 `Authorization: Bearer <accessToken>`、`X-Remote-Device-Credential: <调用设备ID>.<deviceKey>`、`X-Remote-Data-Space-Id`、`X-Remote-Data-Generation`。服务端从认证派生 owner/scope；手机不得使用电脑凭据。

| 调用者 | 方法与路径 | 用途 |
| --- | --- | --- |
| App | GET `/devices/{d}/agents/{a}/settings-capabilities` | 能力、权限、限额 |
| 桌面 | GET `/devices/{d}/agent-settings-access-candidates` | 同账号有效手机及现有控制 grant，支持可选 cursor 分页 |
| 桌面 | GET `/devices/{d}/agent-settings-access` | 绑定恢复/撤销核对，支持可选 cursor 分页 |
| 桌面 | POST `/devices/{d}/agents/{a}/settings-access` | 新版桌面自动同步合法分区权限 |
| 桌面 | POST `/agent-settings-access/{bindingId}/revoke` | 撤销绑定 |
| App | POST `/devices/{d}/agents/{a}/settings-operations` | read 或 model/collaboration update |
| 桌面 | POST `/devices/{d}/agent-settings-operations/claim` | 领取 App 操作，conversation 不走此队列 |
| 桌面 | POST `/agent-settings-operations/{id}/permit` | 唯一写入许可 |
| 桌面 | POST `/agent-settings-operations/{id}/result` | 原连接结果 |
| 桌面 | POST `/agent-settings-operations/{id}/settle` | 旧连接/重启最小结算 |
| 原手机/原电脑 | GET `/agent-settings-operations/{id}` | 查询原操作 |
| 原手机/原电脑 | GET `/devices/{d}/agent-settings-operations?unresolved=true` | 分页恢复未决操作 |
| 桌面 | GET `/devices/{d}/agents/{a}/conversation-settings-access?commandId=...&runId=...` | 从真实命令派生原手机/授权，不接受模型指定 |
| 桌面 | POST `/devices/{d}/agents/{a}/conversation-changes` | 登记摘要及来源，不上传拟写正文 |
| 原手机 | GET `/devices/{d}/agents/{a}/conversation-changes?commandId=...` | 查询该会话修改的真实回执 |

响应沿用 `{"code":0,"message":"success","data":{...}}`。ID/version/epoch 的字符串类型、必填字段、完整示例及 reason 表均见 API，不能匹配中文 message 或自行转换协议类型。

模型选择 value 示例：

```json
{"modelRef":"opaque-model-ref","modelVersion":"3","thinkingLevel":null}
```

文本 read 的 value 为 `{"text":"..."}`，带 revision/documentState/readAt/sourceUpdatedAt。App 不发送文本 update；服务端拒绝伪造 source/type 绕过。conversation prepare 只发送 operationId、实际 command/run/toolCall、section、expectedRevision、proposedDigest、changeKind、approvalId 与绑定/连接信息。所有 actual text changes 均需真实一次性审批。

## 3 本次桌面实现

| 代码 | 责任 |
| --- | --- |
| `src/main/libs/agentSettings/` | 生产 factory、固定文件读取、SQLite 配置、revision、加密 journal、物理 Agent/分区未决保护、落盘和只读恢复 |
| `src/main/remote/remoteAgentSettingsAccess.ts` | 本地绑定、撤权、账号/数据目标/epoch 隔离 |
| `src/main/remote/remoteAgentSettingsProtocol.ts` | 领取、不可变原请求、许可、结果、历史结算与能力刷新 |
| `src/main/remote/remoteAgentSettingsIpc.ts` | 既有主窗口 IPC 校验；新版自动同步不要求原生授权确认 |
| 设备管理设置页面 | 11 月 13 日移除独立手机/Agent/权限授权操作 |
| `src/main/libs/agentSettingsConversation/` | 实际运行来源、具体变更审批绑定、会话工具宿主 |
| `openclaw-extensions/lobster-agent-settings/` | 可信工具策略、自动记忆写锁协调、受控工具、持久化脱敏 |
| `src/shared/cowork/agentSettingsPrivacy.ts` | 工具实时事件与历史回填脱敏，防正文进入旧会话同步 |

`main.ts` 只接线：构造生产服务、连接 RemoteBridge/MCP 宿主和配置确认，并保护既有记忆/Bootstrap 写入口。AgentManager 更新与删除同样受保护，原本地编辑方式保留。

文件对应：main 身份用主工作区 `IDENTITY.md`，非 main 以 SQLite `agents.identity` 为源并同步其 `IDENTITY.md` 投影；每个 Agent 的 `MEMORY.md` 和 `USER.md` 独立定位，不回退到 main。SOUL/AGENTS/TOOLS/HEARTBEAT/BOOTSTRAP/每日记忆不通过本页暴露。预设 Agent 的身份保留现有只读限制。

模型修改 Agent 默认配置，显式会话模型覆盖保留；未固定模型的会话遵循原继承行为。协作修改完整 `subagentAllowAgentIds`，只接受当前可见、有效、同所有者候选；隐藏失效引用转电脑整理。

## 4 App 行动项

1. 固定当前 owner/环境/电脑/Agent，先查能力和绑定；新版桌面自动为同账号有效连接同步绑定，无需额外授权。无绑定时有界刷新并检查连接/升级，旧桌面保留原授权兼容行为。
2. 模型/协作通过独立操作保存，持久化原 ID/hash；只有 applied 才成功，断网查询原操作，revision 冲突刷新重选。
3. 文本点击子页再读取，只在前台内存展示，安全 Markdown/纯文本；无编辑、保存、上传和清空按钮。
4. “通过对话修改”生成普通会话草稿，不自动发送，不附完整文件或私密身份参数。原草稿不覆盖，忙任务不取消。使用同电脑同 Agent 会话，普通命令仍按原 DTO 发送。
5. 跟踪实际本次 create/send commandId，包括澄清后的新命令；审批使用现有卡片，实际修改范围须完整展示。无 operation/no_change 不当保存成功；applied 后重新读取确认 revision。
6. 后台、切身份/设备/环境、撤权、离开子页清理正文；HTTP 是事实源，WS 仅提示。无能力/离线/读取失败不当空文件。

普通本地会话和连接旧服务的远控会话不暴露新设置工具。主进程仅在已就绪的真实远控命令派发前登记 exact sessionKey/runId，工具工厂与描述缓存按当前运行隔离；运行结束清理登记。模型参数不具备登记能力，不能利用失败响应把未知来源解锁为本地。

## 5 失败恢复与隐私

- prepare HTTP 发送前持久化原请求和来源。服务端返回丢失时复用原 operationId/hash/body，不新建操作；审批事实传播最多等待 3 秒，只重试同一意图。
- 发过许可的未知结果不再次写入。core journal 先落盘再写文件/SQLite；真实写后读回和必要配置确认完成才 applied。已写后断网不误报“未保存”。
- 旧连接只能结算。服务端返回的 recoveryToken 仅可用于 settle，permit/result 不接受；手机不取得任何执行凭据。未决物理写入锁跨账号/epoch 保留，确认恢复也不依赖原会话继续活跃。
- 所有文本变化需明确一次性审批，digest 绑定实际来源、授权、版本和完整候选摘要。超过精确预览上限（片段 1800 UTF-8 字节/说明整体 512 字符），或网关清洗改变预览时，转电脑处理。
- 完整正文仅通过受保护读取和当轮工具上下文提供；插件持久化、桌面实时事件及历史回填移除整份参数/结果。用户主动输入、普通助手转述、必要审批片段仍按既有会话权限和保留策略管理，不能把设置 read TTL 当所有聊天副本的清理承诺。
- 本机外部编辑器/先前启动进程不被描述为已受操作系统沙箱保护；固定路径/文件类型/链接校验、revision 和工具协调负责本实现边界。

## 6 发布与回滚

服务端先应用 `sql/V132__remote_agent_settings.sql`（仅两张新表，MySQL 5.7、数字自增 id、utf8mb4、无外键、显式 MyBatis 映射），全量部署后再开放新端。混部显式关闭新功能；旧服务/客户端原协议不变。

服务端 `REMOTE_AGENT_SETTINGS_ENABLED` 默认 true。部署系统必须提供稳定的 `REMOTE_AGENT_SETTINGS_ENCRYPTION_KEY`（Base64 32 字节 AES 密钥），不能生成默认密钥或明文降级。缺表/密钥时不宣告能力。正文 5 分钟清理；最小终态回执至少 7 天，conversation 另要求源 run 可信结束 24 小时；未决不自动清成成功。

桌面使用正常版本化 OpenClaw 构建，同时应用 `scripts/patches/v2026.8.1/openclaw-agent-settings-memory-lock.patch` 和 `openclaw-agent-settings-tool-run-context.patch`，并同步/编译本地插件。该补丁暴露 memory-core 已有写锁，覆盖 Dreaming 等自动记忆写入；插件等待最多 10 秒、持有最多 15 秒。插件配置需 `hooks.allowConversationAccess=true`，固定版本 Agent 列表通过 SDK `listAgentIds` 解析，不依赖旧 `agents.list` 字段。

旧运行时缺写锁时 readiness=false，不能手动放开宣告；新服务能力也必须已就绪。回滚保留新表及未决回执处理能力，先停止受理再收敛 applying/reconciling，不删除未知结果。

## 7 原实现验证记录（2026-11-05）

服务端编译：`./gradlew compileJava -x test --offline` 通过；按约定未执行服务端测试、未连接共享测试数据库、未执行迁移。

桌面使用 Node 24 执行新增模块和受影响审批/MCP/配置同步回归：19 个测试文件、333 项全部通过。另通过 `npm run compile:electron`、`npm run build` 与变更文件 ESLint。运行时在 `/tmp` 独立 profile/配置启动，验证实际网关插件与写锁；没有使用用户现有账号或 live gateway。实际共享 memory 锁在设置租约期间阻塞自动 writer，释放后继续；错误令牌、并发租约、伪造来源均拒绝，真实 agent_end hook 清除限制。新增远控登记、factory 可见性、描述缓存隔离也在真实网关验证通过（remote 可见，缓存命中后 local/缺 runId/其他 session 均隐藏）。临时网关已关闭。

独立 AI 安全审查已执行并修正幂等权限、不可执行恢复凭据、跨身份未决锁、写锁超时、工具正文泄漏及不确定回执等问题。真实 MySQL 5.7/生产 MyBatis、手机真机、跨端断网崩溃与集群混部仍需发布前验收；不将本地模拟测试当已部署证据。
