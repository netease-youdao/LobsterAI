# Agent 续发失败、设置工具状态与控制事实校验修复

日期：2026-11-13。范围：Electron 与服务端；不修改手机 App、Portal、Admin 源码。代码验证记录见文末，未部署。服务端细节见[排查与接入说明](../../../lobsterai-server/docs/integration/2026-11-13-agent-access-and-control-facts.md)，设置协议仍以[原 API 文档](../../../lobsterai-server/docs/api/mobile-agent-settings-v1.md)为准。

## 1. 问题与证据边界

11 月 11 日日志显示，同一任务在 15:14:18 收到用户停止请求，15:14:32 起输入准备反复在 validate 阶段失败，桌面 15:15:32、15:15:33、15:15:38 续发明确抛出 AgentAccessError。原手机链路把此类异常上报为通用 PREPARATION_FAILED，诊断记为 FILE_OPERATION_FAILED，掩盖了 Agent 不可访问的原因。

旧本地数据库触发器会在未经过可信事务更新 owned Agent 后将其隔离；隔离 Agent 无法续发，也不会出现在可见列表。这条机制与现象吻合，但日志没有成功工具调用的命令参数、数据库快照或归属变更审计，不能据此认定模型实际执行了哪条 SQL，也不能证明 Agent 已被删除。没有证据表明本次故障由同步协议版本引发。

排查同时确认两个独立代码缺陷：工具发现重新加载插件时，其运行绑定与网关实例不共享；服务端设置接口对合法实时 run/approval 误用快照哈希校验。后者没有在本次日志中出现 SYNC_IN_PROGRESS 的直接证据，不把它写成本次续发的唯一根因。

## 2. 行为变更

- 桌面输入准备及缓存输入的最终验证，将已知 AgentAccessError.Unavailable 转为现有 AGENT_UNAVAILABLE；保留账号、环境、会话版本和执行前验证。未知存储异常不伪装成 Agent 不可用。
- Agent 归属保护在写入前拒绝不可信的 owned Agent 更新/删除，正式应用更新仍走可信事务；禁止借修复自动解封历史隔离数据或重新分配账号归属。
- 设置插件的网关注册与工具发现共享当前凭据作用域内的运行/写入协调状态；切换回调地址或凭据后旧上下文不可执行，原有运行绑定、一次性审批及写锁仍有效。
- 每轮引擎上下文说明应用管理的身份设置须走正式工具。工具不可用时说明限制并引导设置页，不能用 SQLite、配置文件或投影文件绕过。普通工作区文件编辑保持原行为。
- 服务端在选择控制事实来源时分别验证实时表和 checkpoint；只有快照来源要求 payloadHash，实时记录仍校验正文与 ID、版本、状态及关联字段。checkpoint 缺失或错误哈希仍拒绝。

自定义 Agent 身份的权威数据是应用数据库；正式设置服务先写数据库，再同步 IDENTITY.md 投影。只改 IDENTITY.md 不等价于保存 App 身份设置。本次不增加文件反向覆盖数据库的机制。

## 3. 接口与认证兼容

没有新增端点、请求字段、能力版本或数据库迁移。旧客户端不要求同步升级；既有 JWT、设备凭据、数据空间、generation、账号及 Agent 权限保持不变。

桌面仍使用 `POST /api/remote/v1/input-preparations/{preparationId}/result`，携带原 claim、connectionGeneration 与状态版本。例如失败结果主体（证明字段用原有效值）：

```json
{
  "connectionGeneration": "7",
  "claimId": "<original-claim-id>",
  "claimToken": "<original-claim-token>",
  "expectedStatusVersion": "2",
  "status": "failed",
  "reason": "AGENT_UNAVAILABLE"
}
```

如原流程有 grantVersion，继续携带。`AGENT_UNAVAILABLE` 是已有枚举，服务端沿用原 `{code,message,data}` 响应与准备结果查询协议；不会向远端区分“不存在”“其他账号”“已隔离”，也不会泄露本机路径、归属标识或原始异常消息。

设置相关 GET/POST 路径及请求响应详见原 API。实时 run/approval 修复仅去掉不适用的快照约束，认证、目标绑定、有效运行状态、审批及操作幂等条件仍必须全部满足。

## 4. 消费端行动项与恢复

1. Electron 随版本发布以上修复，并用正式脚本同步/编译本地 OpenClaw 插件；不要只改生成的 vendor 文件。
2. App 无必需协议变更。若目前将所有准备失败统一显示“电脑未准备”，按既有 reason 区分 AGENT_UNAVAILABLE，提示检查电脑上的 Agent 状态。不要对此错误盲目自动重发任务，也不要自动换 Agent。
3. 身份更新只在正式操作确认 applied 后刷新原 Agent 身份页；模型说“已修改”不视作保存成功，实际没有变更应明确告知。
4. 对已发生的隔离事故，保留数据库及 WAL/SHM 一致备份，先只读核对 agents、agent_ownership、会话归属及发布来源；确认原始所有者和内容完整性后再制定定点恢复。不可批量将 quarantined 改回 owned，也不可重建同 ID Agent 来绕过身份保护。

自动同步重试只能处理可核验的瞬时故障，不能替代归属确认。此日志包不含数据库，本次不宣称已恢复该用户的历史 Agent。

## 5. 验证与发布

本轮使用 `/Users/admin/.nvm/versions/node/v24.22.2/bin/node` 验证：

- 13 个定向测试文件、466 项通过：输入准备/错误回传 121 项，归属与启动迁移/配置同步 297 项，设置插件与会话服务 48 项。
- `npm run compile:electron`、所有本轮变更 TypeScript 文件 ESLint（零警告）及 `git diff --check` 通过。
- 独立 AI 安全审查完成；审查发现并修复凭据换代丢失旧写入者栅栏的问题。最终再次复核跨作用域、归属、审批、许可、哈希和旧写入者排空边界，未发现新增绕过。
- 用正式预编译脚本构建临时插件，在独立临时配置/状态中启动实际 pinned gateway-bundle 与 dist：WebSocket 握手、4 个设置 RPC 注册、status.ready、合法绑定/跨 Agent 绑定拒绝、获取/重复租约拒绝、错误 token 释放拒绝、正常释放后重获均通过。无模型请求，SIGTERM 正常关闭。多模块工具发现共享及凭据换代由上述定向回归覆盖；本次网关 smoke 不等价于手机到模型的完整链路验收。临时 profile 缺 systemAgent 导致 memory-core 后台 cron 协调告警，未影响设置 RPC 检查。
- 服务端 `./gradlew compileJava compileTestJava -x test --offline` 通过；按仓库约定未执行服务端测试。

没有修改用户数据库、共享测试或线上数据库，没有完成手机真机端到端或历史 Agent 数据恢复。服务端与桌面可分别发布，功能完整修复需二者升级；保留既有功能开关默认开启约定。回滚不删除归属、准备回执、审批或未决写入证据。未提交、未部署。
