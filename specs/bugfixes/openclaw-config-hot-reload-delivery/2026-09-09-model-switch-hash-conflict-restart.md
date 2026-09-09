# 切换模型时配置 hash 冲突引发 Gateway 重启

## 问题简述

切换 Agent 默认模型时，OpenClaw 返回尚未刷新的配置 hash，导致配置下发重试失败并触发 Gateway 兜底重启；即使配置随后热加载成功，重启仍会执行，造成短暂服务中断。

## 已确认的复现

基线为 `feat/openclaw-v2026.8.1` 的 `ff07ecf67`，上游版本为 `v2026.8.1`。

- QA macOS 日志：2026-09-09 10:56:26 切换主 Agent 模型为 Kimi K3；两轮配置同步各重试一次，均发生 hash 冲突。10:56:27 热加载成功，10:56:32 仍执行延迟重启。
- Windows 实机：15:36:04 通过 `gateway / config.get` 读取配置；15:36:42 在首页切换主 Agent 模型为 DeepSeek V4 Pro。83ms 内下发失败并排队重启；15:36:45 发起重启，15:36:48 热加载完成后仍收到 SIGINT，PID 从 16756 变为 25776。
- Windows 操作时没有运行中的任务，多任务并发不是必要条件。

## 原因

LobsterAI 先写 `openclaw.json`，随后通过 `config.get → config.set` 提交配置。上游 `src/gateway/config-get-response.ts` 在 watcher 激活时缓存读取结果，只有配置接受、运行时版本或插件注册版本变化才会使缓存失效；缓存命中不会重新读取文件。

因此，文件已变更但 watcher 尚未处理完成时，`config.get` 仍提供旧 hash，而 `config.set` 按最新磁盘内容校验并拒绝请求。旧实现立即重试一次，仍可能命中相同的旧 hash，随后直接排队重启。排队后没有再次确认 RPC 下发是否恢复。

## 修复范围

修复在 LobsterAI 集成层完成，不修改上游源码或运行时补丁。

- hash 冲突采用有界退避：500ms、1000ms、2000ms、4000ms、4000ms；RPC 自身仍沿用原有超时。等待总计最多 11.5 秒，不含 RPC 耗时。
- 每次尝试重新读取 Gateway hash 和最新文件内容，保留 watcher 迁移或其他写入者在等待期间产生的配置变更；继续使用 `baseHash` 乐观锁。
- 纯配置下发失败导致的延迟重启，在执行前再次尝试下发，即使本次同步没有产生文件差异。成功则结束该重启请求；配置无效则报告错误；仍不可交付时保留兜底重启。
- 重查不再排队另一次兜底，也不额外消耗重启限流次数。
- 若等待期间出现环境变量、IM 或插件等必要重启请求，提升并保留该请求原因，避免被后续配置下发成功抵消。现有活跃任务排空逻辑保持生效。

`config.set` 成功表示 Gateway 接受其管理的配置写入并安排 reload follow-up；不能仅凭缓存中的 `config.get` hash 判断最新文件已生效。

## QA 回归步骤

1. 完全退出再启动 LobsterAI，等待启动同步完成，主 Agent 使用模型 A。
2. 在任务中要求调用 `gateway`，参数为 `{"action":"config.get","path":"agents.defaults.model"}`，只读配置。确认实际执行了该工具调用。
3. 等任务结束，回到主 Agent 首页的空白任务输入框，将默认模型改为同一服务商下另一个可用模型 B。
4. 等待配置完成同步。预期即使出现短暂 hash 冲突，也最终出现 `mode=rpc`、`restartScheduled=false`，Gateway PID 和客户端连接保持不变。
5. 按相同步骤再次预读，再切回模型 A。已有会话中的模型覆盖选择不是本场景的主要触发入口。

修复前兜底重启有 10 分钟限流；重复对比旧版本时，应完全重启应用或等待限流窗口结束。

## 验证记录

- 修改的三个 TypeScript 文件通过 CI 同规则 ESLint，零错误、零警告。
- `npm run compile:electron` 通过。
- 配置下发、配置影响分类、运行时配置生成、Gateway 进程控制四组 Vitest 共 145 项通过。
- 使用本机 pinned Windows Gateway、独立临时配置/状态目录及编译后的配置下发函数，连续执行 A → B → A。两轮分别捕获 2 次和 1 次真实 hash 冲突，最终均 `mode=rpc`；PID 均为 3912，断连数为 0，排队重启数为 0，并观察到热加载成功日志。下发耗时分别为 11745ms、5538ms，包含真实 RPC 耗时。
- Windows 桌面实机于 2026-09-09 重新启动开发实例后复测：16:00:27 通过 `gateway / config.get` 预读配置；16:00:48 切换主 Agent 默认模型并触发同一 hash 冲突；16:01:03 重试一次后 `mode=rpc`、`restartScheduled=false`，下发耗时 14228ms；16:01:11 后续 `app-config-change` 同步及热加载也成功。
- 桌面复测期间 Gateway 保持本次启动的 PID 8072，切换模型后没有强制重启、进程退出或重连记录，确认该复现路径的异常重启已修复。
