**QQ 2.0.1 提前结束网关进程：用户回验后的补充修复**

本次回验已使用 #2632 的 Windows IPC 关闭桥接，但仍触发了崩溃循环保护。以下结论来自 2026-09-09 的本机主进程日志、网关日志和只读查询的 `gateway_boot_lifecycle`，并已用真实 QQ 插件运行时复现。

| 本机时间 | 证据 | 含义 |
| --- | --- | --- |
| 11:49:45–11:49:52 | 网关收到 `SIGINT`，6 秒清理期限后父进程发送 `SIGKILL`。 | 本轮出现一次强制退出，启动记录未完成。 |
| 11:51:10–11:51:11 | 网关收到 `SIGINT`，父进程观察到 `code=0`；对应启动记录的 `completed_at_ms`、`outcome` 均为空。 | 退出码 0 不代表 OpenClaw 完成了清理。 |
| 11:51:37 | 再次收到 `SIGINT` 后以 `code=0` 退出，对应启动记录仍未完成。 | 五分钟内累积了三条新产生的不洁启动记录。 |
| 11:51:45、11:53:42 | `restart-loop breaker tripped: 3 unclean boot(s)`。 | 通道自动启动被抑制；切换模型或重新登录不会立即解除保护。 |
| 11:59:44–11:59:46 | `restart-loop breaker recovered`，随后 QQ `gateway READY`。 | 保护窗口消退后连接自动恢复；不能把此前静默归因于自定义 provider 不可用。 |

当时生成配置中的 QQ 账号、启用状态及 Agent 绑定仍在。本次持续静默的关键故障是退出生命周期与自动启动保护，#2632 的配置保留逻辑没有被本次记录否定。

**遗漏的插件行为**

QQ 插件 2.0.1 的 `src/runtime.ts` / 发布入口 `dist/index.cjs` 在 `setQQBotRuntime()` 时安装了进程信号处理函数。`SIGINT` 和 `SIGTERM` 的处理函数都会先刷新引用索引，再直接调用 `process.exit(0)`。OpenClaw 自己的信号处理函数会启动异步清理；插件的直接退出使它来不及完成通道关闭及 `completeBoot()`。

此前仅在未加载 IM 插件的隔离网关上验证连续启停，未覆盖插件抢先结束宿主进程的情况。新的验证必须同时加载 QQ 插件，并查询启动记录，不能只判断退出码或是否收到 `SIGINT`。

**修复位置与边界**

在 `scripts/openclaw-plugin-preparers/qqbot.cjs` 的现有 QQ 打包适配中处理已锁定的 2.0.1 发布入口：保留 `SIGINT` / `SIGTERM` 的同步刷新，移除插件主动退出进程的操作；额外在 `exit` 时刷新，覆盖 OpenClaw 正常调用 `process.exit()`、不会触发 `beforeExit` 的情况。进程的实际退出继续由 OpenClaw 负责。

适配同时覆盖下载后重新打包和命中已有缓存的同步路径。重复执行不再修改内容；版本或退出处理代码与审查过的形态不一致时明确报错。无需改上游网关或清空用户的启动记录；原有 6 秒超时强制终止兜底保持不变，本补丁不承诺任意长任务能在这个期限内结束。

**验证结果**

- 直接执行真实 2.0.1 发布入口中的退出处理函数：原版收到两种信号后调用 `process.exit()` 两次；适配后主动退出为零，并保留信号及最终 `exit` 的刷新。
- Windows + Electron Node 模式 + 真实 OpenClaw 打包网关：加载原版 QQ 插件时复现 `code=0`、启动记录未完成；加载适配后的 QQ 插件连续启停 4 次，全部 `code=0`、`signal=null`，4 条记录均为 `clean_stop`，无崩溃循环抑制。QQ 账号在隔离配置中禁用，验证的是插件注册及退出行为，没有使用真实账号收发消息。
- `npx vitest run tests/prepare-openclaw-qqbot.test.ts tests/ensure-openclaw-plugins.test.ts tests/prepare-openclaw-host-peer.test.ts src/main/libs/openclawGatewayProcess.test.ts`：39 项通过。插件安装测试输出既有 Node `DEP0190` 提示。
- 改动测试文件的 ESLint、打包脚本的 `node --check` 和 `git diff --check` 通过。本次不涉及 Electron 主进程 TypeScript 改动。

**用户侧再次回验**

使用包含此补丁的分支及重新生成的 QQ 插件运行时。已有运行时的开发环境需要执行 `npm run openclaw:plugins` 同步适配后的插件，再正常退出并重开客户端；只编译 Electron 或切换模型不会更新磁盘上的 QQ 插件代码。完整运行时构建流程已包含该插件同步步骤。

先等当前保护窗口消退或确认日志已出现恢复及 QQ `READY`，发送一个全新的消息编号建立基线。随后按原冒烟文档执行模型缺失/恢复和五分钟内四轮正常启停。每轮既检查新消息收发，也核对当轮启动记录是否正常收尾；出现强制终止时单独记录，不用重配 QQ 或清空状态库掩盖故障。
