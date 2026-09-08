# OpenClaw 2026.8.1 网关启动与会话迁移修复

升级 OpenClaw 2026.8.1 后，旧 Agent 配置与新的 ownership 规则冲突，QQ 插件与
运行时配置规则不匹配，通用 doctor 修复还可能中断旧会话迁移。这些问题会导致
网关启动失败，或使配置更新进入无效重启。

修复在 LobsterAI 的配置同步、迁移入口和插件打包层完成，不新增 OpenClaw 源码
patch。对于尚未明确原因的文件锁超时和迁移残留，补充只读诊断，保留失败保护。

## Agent 配置拒绝后触发无效重启

配置同步失败时，运行时报告 `agents.ownership=explicit` 与旧的 `default=true`
标记冲突。LobsterAI 原先持续输出旧版 `agents.list`，运行时转换后的配置又与
下一次同步混合。RPC 的 `UNAVAILABLE / CONFIG_VALIDATION_FAILED` 包装也未被
识别为配置拒绝，因而触发无效的兜底重启。

- 输出 keyed `agents.entries` 和显式 ownership，去掉旧 default 标记。
- 指定 system agent、认证继承、会话存储、heartbeat 和 talk 的主 Agent。
- 保留各 Agent 的独立 workspace；为已配置 IM 渠道补主 Agent 兜底路由，
  账户级主 Agent 绑定仍能覆盖平台级自定义 Agent 绑定。
- 企业配置的旧 agents.list 覆盖层转换后再合并，避免重新引入旧标记。
- 配置校验拒绝直接报告错误，不安排兜底重启；通信失败仍沿用既有恢复逻辑。

## QQ 插件与运行时配置规则不匹配

OpenClaw 2026.8.1 内置的 QQ 官方配置规则针对
`@tencent-connect/openclaw-qqbot@2.0.1`，原安装的 `@openclaw/qqbot@2026.7.1`
使用不同收件规则。仅把 `allowFrom: ["*"]` 改成满足 schema 的字段会使旧插件
拒收开放私聊。

- 改用上游该版本官方目录指定的 Tencent 2.0.1，插件 ID 为 `openclaw-qqbot`，
  渠道和安装目录仍为 `qqbot`，账户 ID、secret 环境变量映射保持稳定。
- 显式输出私聊/群聊策略，规范化 OpenID；使用官方
  `openclaw:approval-disabled` 标记表达没有审批授权人，避免空白名单在新插件
  中意外放开访问。开放、白名单、配对和禁用策略分别保留。
- 打包元数据直接指向发布包已有的 `dist/index.cjs`，使用 LobsterAI 现有 SDK
  bridge，跳过只负责查找全局 OpenClaw、创建 SDK 链接的 `preload.cjs`。
  未修改插件 JavaScript 或 OpenClaw 源码。

QQ 开放私聊的完整配置校验仍可能出现要求 `*` 的旧通用警告；schema 接受当前
配置，Tencent 实际收件中间件的开放私聊用例通过。不能为消除警告而加回会被
官方 schema 拒绝的通配符。

## 通用 doctor 改写 QQ 配置导致会话迁移中断

即使输入已通过运行时完整校验的 QQ 配置，通用 `doctor --fix` 仍可能生成不合法
的 QQ 配置并退出 1，导致会话迁移未完成。该行为已在独立 Windows 数据目录中
复现。

启动时改用上游公开的专用入口：

```text
openclaw doctor --session-sqlite import --session-sqlite-all-agents --json
```

该入口由官方实现导入、校验、备份归档及 SQLite maintenance lock，不执行通用
IM 配置修复。仍检查退出码及旧存储残留；失败时阻止启动，不删除或伪造迁移完成
标记。摘要支持结构化迁移问题、ASCII/Unicode 边框中的 stdout 校验错误，避免
被 stderr 的 clobber snapshot 警告掩盖。

## 文件锁超时与迁移残留缺少定位信息

发生 `openclaw.json` 文件锁超时，或 doctor 退出 0 后仍有旧存储残留时，原日志
不足以确定锁持有进程和残留文件，无法区分并发写入、锁回收异常与存储迁移失败。
这些场景的根因尚未确认，新增只读诊断：

- 应用/doctor PID、迁移耗时、各 store 的迁移前后路径、类型、大小及时间戳。
- 规范化后的配置路径、`.lock`/`.lock.reclaim` 状态，锁中白名单字段
  PID/创建时间/进程启动时间及当前 PID 存活检查。
- doctor 失败、超时或退出 0 后仍有残留时的 stdout/stderr 尾部。
- 配置写入前发现锁、RPC 报文件锁超时时记录相同诊断。

不记录配置、密钥、原始锁内容或进程命令行；不自动清锁/删历史数据。PID 存活
只是现场线索，不能排除 PID 复用，需结合时间及其他进程日志判断。

## 验证结果与范围

Windows 集成验证使用独立目录和假凭据，覆盖实际打包 runtime，不包含真实 QQ
连接或模型调用。

- 配置同步/交付、迁移失败与残留、只读锁诊断、QQ 权限、插件打包、SDK bridge、
  Windows payload、网关恢复、内存迁移及企业配置合并的相关 Vitest 覆盖通过。
- 变更 TypeScript 文件 ESLint 和 Electron TypeScript 编译通过。
- 实际运行正式 QQ 安装脚本成功，发布 tarball 与上游目录和 npm 的 integrity 一致。
- 实际 OpenClaw 完整配置校验通过；旧 ownership/default 混合配置被拒绝；重复
  配置同步稳定。Tencent 收件中间件的开放/白名单/拒收和禁用群聊检查通过。
- 使用打包 Electron 可执行文件运行官方迁移，主 Agent、worker 的会话导入成功；
  随后启动实际 gateway bundle，`sessions.list`/`chat.history` 验证原 UUID 和
  用户消息保留，`config.set` 更新 Agent 后得到确认，`agents.list` 返回新值。
  发送旧 default 标记被拒绝，没有安排兜底重启，网关仍健康。
- 共享 `state/sessions/sessions.json` 和已不在配置中的 retired Agent
  存储：官方专用入口成功导入并归档，配置文件字节未改变。使用打包 Electron
  直接加载新 QQ 发布入口成功，导出正确插件 ID 和 register 函数。
- 新 QQ 插件安装目录为 3.72 MiB，旧版为 5.80 MiB（目录实测，不是完整安装包
  大小）；包含新 QQ 插件的完整安装包仍需重新构建和验证。

## 待完成的验收

必须重新构建 OpenClaw runtime/插件并打包，不能仅重编译 Electron 后搭配旧 QQ
插件目录。使用 macOS 实际升级数据的备份副本及真实 QQ 账户验证：

1. 从旧版升级，检查迁移完成、官方归档存在、历史会话/消息可读；重新启动不重复迁移。
2. 新建/修改主 Agent 和自定义 Agent，调整模型、技能及 IM 绑定后确认配置生效，
   不再出现 ownership/default 冲突或由配置拒绝引发的无效重启。
3. QQ 多账户验证开放私聊、白名单内外用户、配对和群聊策略，以及文本/附件收发。
4. 若出现文件锁超时，收集同次启动的 main 和 gateway 日志，保留当时的锁文件及
   进程信息；若迁移后仍有存储残留，按新日志定位具体路径及原因。

Windows 隔离测试通过不等同于 macOS 原机升级或真实 QQ 收发验收通过。
