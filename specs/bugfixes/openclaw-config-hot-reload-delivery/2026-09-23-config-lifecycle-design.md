# OpenClaw 配置应用生命周期修复

## 1. 概述

### 1.1 问题

基于 `origin/release/2026.9.23` 的 `8a478bffa`，固定运行时为 OpenClaw `v2026.8.1`。
问题 2 的日志显示，宿主代理端口从 3474 换到 4121 后，部分套餐请求仍访问旧端口；
`config.set` 返回成功时，`configRevisionHash` 与 `appliedConfigHash` 尚不相等。
后续连接失败触发同一 run 的重试，才出现截图中的 `Session transcript keyed user is outside the current turn`。
完整日志时间线、历史提交及证据边界保留在同目录 `2026-09-23-config-lifecycle-research.md`。

### 1.2 根因及范围

宿主把“已保存”当作“已应用”，并同时通过直接写盘和 RPC 两条路径触发 watcher。
旧的无变化提前返回与交付层冷却逻辑不能保证未应用目标继续恢复。
本次修复配置生成、条件交付、应用确认、任务准入与进程恢复这条链路。
不升级整个 OpenClaw，不清除用户历史，不放宽会话幂等检查。
网络错误后的同 run 重试错误是独立上游问题；本次消除配置失配导致的触发源，不能宣称修复任意网络失败的会话重试。

## 2. 用户场景

1. 升级或重开客户端，代理 P1 变为 P2：新任务等待目标生效，实际模型请求抵达 P2。
2. RPC 保存成功但重载尚未完成、失败或被取代：保持待办，后续无配置变化也继续处理。
3. A→B→C 连续变更：旧 B 的完成或失败不能清除最新 C；环境变更要求不会被普通同步冲销。
4. IM、cron 或桌面任务活动期间：延后宿主重启，既有任务可以结束；不因超时强杀活动工作。
5. 其他写入者修改非宿主管理字段：发生 hash 冲突后重新合并意图，保留对方字段。
6. 配置校验拒绝：向调用者报告失败，停止无意义的自动重启；修正配置或手动修复后可恢复。

## 3. 功能要求

- 运行中的配置写入由 Gateway RPC 完成；停止状态的启动文件才允许直接落盘。
- 成功须证明目标身份和运行版本一致；ACK、磁盘无变化、WS 握手均不是独立成功证据。
- 冷却限制实际恢复重启频率，不能丢弃待办。无新设置事件时也要继续恢复。
- Gateway 内部重启与宿主新进程区分处理，环境/插件文件变更要求真实的新进程代次。
- 新模型任务等待配置应用；不将活动任务收尾放入配置等待屏障。
- 最新同步收敛后向 renderer 广播真实状态，解除任务准入失败带来的临时启动遮罩；校验拒绝显示错误。
- 保留密钥引用，不能把 RPC 脱敏结果当作完整配置写回，也不能把脱敏值当通配符。

## 4. 实现方案

### 4.1 准备与所有权

`OpenClawConfigSync.prepare()` 返回目标内容、原始基线及管理区段，不写运行中的 `openclaw.json`。
企业配置在内存中合并。工作区及既有本地同步逻辑保持原有职责。

`openclawConfigTarget.ts` 在最新磁盘基线上重放意图：完整生成的宿主管理区段由宿主负责，
包括模型列表、模型代理地址、agents、MCP、channels 和 bindings 的删除及数组替换。
gateway/plugins 含运行时拥有字段，采用基线、目标、当前值的三方合并；未知顶层字段保留。
即使宿主代理地址相较原始基线未变化，也不能接受其他写入者将其回退到旧端口。
这是受所有权约束的全量 apply；不直接重发带新 hash 的旧快照，也不使用 patch 的数组合并猜测删除语义。

### 4.2 条件交付与确认

顺序为：准备目标 → `config.get` → 重读并合并当前文件 → `config.apply(raw, baseHash)` → 确认应用。
hash 冲突使用现有有界退避，但每次重新取得 revision 并重建 payload。
不再在正常 RPC ACK 后直接释放屏障。

确认同时要求：`valid=true`，非空 `configRevisionHash === appliedConfigHash`，且快照属于当前目标。
目标身份证据为去除写入来源元数据后的内容相等，或当前提交的持久化 receipt hash 与快照 hash 相等。
receipt 仅适用于它提交的原始目标；确认期间目标变化后不能复用旧 receipt。
保存 hash 和应用 hash 属于不同令牌域，不能互相比较。确认过程中宿主进程代次变化则重新确认。

超时、断线和 superseded 均按“结果未定”处理，先只读确认；不立即重发或宣布成功。
真实校验拒绝按失败返回，不自动重启。

### 4.3 待办与准入

`openclawConfigRecovery.ts` 持有最新目标、校验错误、真实进程重建要求及恢复节流。
它的生命周期长于一次 RPC 或队列任务；旧目标的完成不能清除新目标。
现有串行队列继续负责调用次序，等待屏障会追上后来排队的目标并检查剩余待办。
冷启动先生成文件，ready 后仍确认目标；普通磁盘 no-op 也会检查是否真的应用。

恢复在重连和空闲轮询边界继续；先重新交付/确认，再考虑宿主重启。
恢复重启最多每 10 分钟一次，持续失败的检查至少退避 30 秒；原生限流的 `retryAfterMs` 更长时遵守该期限，且限流本身不触发重启。待办保留。
主动环境/插件变更不受配置恢复冷却抑制。手动修复等待当前写操作结束，但可接管停滞待办。

### 4.4 进程生命周期

`restartGateway` 的 `beforeStart` 回调在旧子进程确认退出后、启动新进程前发布目标启动配置。
启动准备失败会变成可见引擎错误。真实新进程使用递增代次验证；同 PID 的内部重启不能满足环境继承要求。
适配器通过原生 `shutdown.restartExpectedMs` 判断内部重启意图，结合宿主主动停止和子进程存活状态，
不再仅因 WS 1012 就认定内部重启。握手只触发后续确认。

活动任务保护继续沿用现有桌面、cron 和原生 IM 观测；5 分钟仅提示逾期，不强杀。
未知工作负载的策略沿用既有集成，本次没有将原生暂停/强制排空 API 替换进宿主。

## 5. 上游依据与升级清理

| 上游 | 固定版状态 | 本次选择 / 后续清理 |
| --- | --- | --- |
| [#129321](https://github.com/openclaw/openclaw/pull/129321)：应用 receipt | v2026.8.1 已包含 | 使用 apply 的应用契约，不再将 set 当作应用接口 |
| [#131180](https://github.com/openclaw/openclaw/pull/131180)：排除发起配置 RPC 的 root work | v2026.8.1 已包含 | 复用原生能力，不重复打补丁 |
| [#142169](https://github.com/openclaw/openclaw/pull/142169)：所有写入者的候选观察缓存失效 | v2026.8.1 未包含，v2026.9.5 已包含 | 回迁提交 `37dbd0aac6556ea9a63f045cabec91963d0571b3` 的生产改动 |
| [#138112](https://github.com/openclaw/openclaw/pull/138112)：扩大原生热重载 | v2026.9.5 包含 | 后续整体升级验证，可减少重启；不拆取部分 reload 规则 |
| [#145983](https://github.com/openclaw/openclaw/pull/145983)：并发写入 receipt | v2026.9.5 包含 | 升级后重验并发源版本与 receipt，不放宽目标核验 |
| [#121022](https://github.com/openclaw/openclaw/pull/121022)：重启与 RPC 回应时序 | 调研时仍开放 | 保留断线后确认；不能假设重启型 apply 的回包必达 |
| [#154792](https://github.com/openclaw/openclaw/pull/154792)：更多服务生命周期热重载 | 调研时 main 已合并，v2026.9.5 未包含 | 后续升级再评估，非本次回迁范围 |

契约参考：[Config RPC](https://docs.openclaw.ai/gateway/configuration/config-rpc)、[Embedding](https://docs.openclaw.ai/gateway/embedding)。
本次版本补丁为 `scripts/patches/v2026.8.1/openclaw-config-candidate-cache-invalidation.patch`。
只适配原提交生产代码上下文；新版上游测试已换 harness，不一并迁入旧版本。
升级含 #142169 的版本后移除此补丁，验证 agent 创建/修改/删除和外部文件编辑在慢重载期间仍返回新 revision，
同时保留真实 stale baseHash 拒绝、未应用不能冒充 applied 的反例。
宿主应用屏障、所有权合并和环境进程要求属于集成契约，不能因为移除缓存补丁而一起删除。

## 6. 边界与验收

基础回归覆盖：ACK 未应用、超时后实际成功、旧相等 revision、脱敏 receipt、目标变化、hash 并发、MCP 删除、
A→B→C、冷却待办、环境新进程、启动文件发布顺序、原生 shutdown 意图。

实操使用独立工作树、独立 appData/OpenClaw 状态及端口；通过 Electron 主进程调试和 renderer CDP 操作客户端。
不使用 computer-use，不接管系统键鼠，不操作其他任务实例。重建运行时及实操避让优先级更高的插件任务。
用本地合成模型端点注入旧端口与延迟/失败，并观察客户端实际会话、Gateway revision、端点请求和进程代次。
仅有单测或直接调用交付函数不能计为客户端验收通过。

### 6.1 基础验证（2026-09-23）

- 定向 Vitest：9 个文件，546 项通过、3 项跳过；包含交付、应用确认、目标合并、恢复状态、配置生成、企业覆盖、进程重启及运行时适配器。
- 修改文件 ESLint：零错误、零警告；`npm run compile:electron` 通过。
- `npm run build` 通过。后续实操使用包含最终修改的客户端产物。
- 新版本补丁在独立 v2026.8.1 源码树应用，Windows 适用补丁 57 项成功（目录包含 58 项跨平台补丁）。
- 上游 `config-get-response.test.ts`、`server-reload-managed-secrets.test.ts`：13 项通过。
- 扩展尝试 `config-reload.test.ts` 时出现文件监听/日志断言失败及 120 秒超时，已停止该组；尚未做无本补丁的对照，因此不能将其写成已通过或断言为既有问题。

验证输出保存在本机隔离目录 `C:/Users/yangwn/AppData/Local/Temp/codex-config-lifecycle-20260923`。
### 6.2 客户端实操

- Electron 主进程调试接口与 renderer CDP 驱动，独立 appData、独立运行时，合成账号/模型服务；未使用 computer-use 或系统键鼠。
- 正常 `deepseek-flash` 会话已从界面发送并收到响应，实际请求经过本地套餐代理到达 `/api/proxy/v1/chat/completions`。
- 保持一条真实流式会话运行，代理端口由 61250 切换至 53475，并注入只返回 ACK、不执行 apply 的传输反例。
  目标仍待应用，磁盘及 Gateway 保持旧端口；界面发起的新任务返回“正在应用配置”，模型端点没有收到该请求，原任务继续运行。
- 解除注入并允许原流式会话结束，未触发新的设置事件；空闲恢复自动应用新端口，pending 清除，两个应用 revision 一致，PID 36160 / 进程代次 1 未变。
- 端侧补充修复：后台热应用完成后显式广播收敛状态。复验端口 57511→55729，pending 自动清除、遮罩自动消失，PID 22536 / 代次 1 不变；随后从界面新建任务收到模型响应。
- 被拒绝的首次请求只存在于临时 UI，会话尚未入库。恢复后在原失败页发送新请求会重新创建真实会话，不能向主进程提交临时会话 ID。已通过实际界面复验，收到 `CONFIG_QA_RETRY_OK` 模型响应；未自动重放此前被拒绝的请求。
- 本轮 renderer 相关回归：3 个文件 48 项通过，修改文件 ESLint、完整 `npm run build` 通过。
- 首轮 GitHub CI：5,562 项测试通过、1 项失败（新补丁未加入审核清单）、163 项跳过；已补齐清单，本地对应 19 项测试通过，后续以 PR 最新 SHA 的 CI 为准。
- 三模型请求、丢回包确认、校验拒绝及修正、外部写入缓存、忙碌保护、连续目标变化、真实进程重启和限流恢复均已完成客户端验收。详细矩阵、证据和复跑方法见 [验收记录](2026-09-23-config-lifecycle-acceptance.md)。合成模型不证明生产套餐服务的可用性。

证据：`01-baseline-state.json`、`01-baseline-ui.json`、`01-baseline.png`、`02-ack-unapplied-state.json`、
`02-blocked-ui.json`、`02-blocked.png`、`03-idle-recovery-state.json`、`model-requests.jsonl`，均在上述隔离目录。
