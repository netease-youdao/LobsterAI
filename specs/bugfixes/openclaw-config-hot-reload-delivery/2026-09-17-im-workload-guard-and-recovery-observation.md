# IM 准备期配置重启保护与恢复观察设计

## 1. 概述

### 1.1 问题

9 月 16 日反馈第 7 行出现配置 RPC 超时后网关重启，打断正在准备的 POPO 任务。16:02:48 客户端轮询已确认 IM 任务运行中，16:03:15 配置延迟重试失败后仍执行重启；原 SET 在 16:03:18 才返回成功。此前 9 月 9 日修复的是 baseHash 冲突，不覆盖这类超时及工作状态遗漏。

### 1.2 根因与证据边界

`hasActiveSessions()` 只查看 ActiveTurn。原生 IM 的 `sessions.changed/start` 以及 `sessions.list: hasActiveRun=true` 可以早于流事件，不创建 ActiveTurn。两个适配器回放均复现了“会话 running，但重启检查空闲”。现场约 38 秒的 bootstrap/config RPC 慢阶段没有完整复现，不据此修改超时、重试或网关内部执行逻辑。

另有两个特征实验：限流窗口内的独立失败可能没有新的恢复安排；真实网关 GET 可能同时返回相等的旧 revision/applied token。这些仅作为新恢复决策的观察依据，本阶段不修复其调度策略。

基线：2026-09-17 拉取 `origin/release/2026.9.16`，提交 `5273b844767c1b9757cee7b5a4fe78fd9adba9a3`。独立分支 `fix/im-config-recovery-observation`。

## 2. 用户场景

- IM 已进入准备/运行阶段但尚未创建 ActiveTurn，技能等配置触发自动重启：应沿用现有延迟机制等待已知活动结束。
- 生命周期事件丢失，但轮询明确返回 active：同样保护；数据库历史 running 不作为证据。
- 旧任务终态、在途轮询、连接切换、停止或删除会话：不能污染当前运行，也不能无限保留旧 busy 标记。
- GET/SET 超时或恢复被限流：行为保持现状，日志能关联变更来源、同步批次、RPC 阶段、工作观测及新策略的建议。

## 3. 功能需求与范围

1. 新增仅供自动配置重启使用的工作快照。保留 `hasActiveSessions()`、手动修复和前端查询的既有语义，不伪造 ActiveTurn。
2. 仅新发现的、有效期内的原生 IM 活动证据参与实际阻止自动配置重启。未知/过期/断线状态单独记录，新策略对未知状态的等待建议仅观察。
3. 新恢复观察器没有定时器、RPC、磁盘写入或重启能力，调用结果不得接入实际决策。
4. 保持 GET 10 秒、SET 15 秒、hash 退避、十分钟限流、配置落盘顺序、self-restart/IM receipt、退出/修复互斥不变。
5. 不调用 `gateway.suspend.*`，不接管 watcher，不更改运行时 bundle/patch，不新增数据库结构。

## 4. 实现方案

### 4.1 IM 工作证据

在独立小模块中维护有界的 IM 活动证据，适配器仅在既有生命周期、轮询、停止、删除和连接清理入口挂接。生命周期证据沿用 agent timeout + 60 秒有效期；轮询 active 证据有效期为 120 秒，覆盖现有 60 秒最大退避及 RPC 等待。过期证据报告 unknown，不从历史会话状态刷新有效期。

使用轮询开始时的观测版本和每会话变更版本过滤在途旧结果，其他会话的事件不会使本会话的 active 轮询丢失。生命周期和轮询证据分别匹配 run ID，匿名/旧运行终态不能清除另一条新的已知运行。原生 IM 不完全纳入 `hasActiveRun`，因此单独的 false 不能推翻有效的生命周期 start。显式停止、删除、换代清理观测并使旧轮询失效。活动集合和会话版本集合各最多 1,000 项；淘汰停止/删除版本时提升旧轮询的失效水位。输出仅含计数及最多三条不透明关联摘要。

`main.ts` 的配置自动重启检查采用新快照，cron 判忙继续使用原接口。未知状态不在本阶段扩大拦截条件。正常同步、手动重启、修复及前端查询不迁移。

`idle` 仅代表宿主可见证据中没有活动工作，不是网关全局空闲的原子证明。匿名的 active 轮询无法与某个 lifecycle end 可靠关联时，保留到下一次明确 inactive 轮询或 120 秒到期，可能额外延迟配置重启；明确记录这一保护与等待的取舍。

### 4.2 诊断和恢复观察

- 技能通知携带固定来源枚举、批次 ID、合并事件数；不携带文件内容或用户路径，不改变通知时机。
- 同步日志增加 sync ID、排队/总耗时、来源批次；交付日志逐次记录 GET/SET、attempt、阶段耗时、超时预算、配置与 revision 的不透明关联摘要。
- 原生 RPC wire ID 暂不从客户端内部提取；宿主日志使用明确标注的逻辑 attempt ID，不冒充服务端 request ID。不为诊断增加配置 RPC 或文件读取。
- 失败及重启决定时输出连接/进程代次、tick 年龄、ActiveTurn/IM/cron 工作快照。重复的定时检查按状态变化记录，避免每三秒 INFO。
- 纯观察策略区分已接受和已应用、busy 和 unknown、安排恢复和被限流；输出 `observationOnly=true` 与实际动作，保留现有返回值、异常与调度。
- 正常诊断及可重试的 hash conflict 用 DEBUG；失败汇总以及达到对应 RPC 超时预算 80% 的慢请求用 WARN。不记录原始配置、密钥、提示词、路径或原始 session key。指纹使用进程级随机密钥 HMAC，不输出排序 JSON，也不跨域比较 gateway token。
- 使用 `peekCronJobService()` 和 `getGatewayProcessGeneration()` 直接读内存，避免日志读取初始化服务、解析 runtime 文件或读取 token。宿主 CPU/RSS 是整个进程在该时间窗口的统计，不归因于网关进程或某个同步函数。

网关内部 bootstrap 子阶段、写锁和迟到 ACK 的精确 wire 关联仍需后续运行时诊断，本阶段日志明确保留这一限制。

## 5. 边界情况

| 场景 | 本阶段处理 |
|---|---|
| start 后轮询 false | 有效 lifecycle 继续保护 |
| 旧 run end / 匿名 end / 在途旧 poll | 不清除新的已知运行 |
| 长任务超过观测有效期 | 标为 unknown；保留现有实际恢复政策，观察策略建议等待证据 |
| 断线、停止、删除、绑定缓存清理 | 清理相关标记，旧 poll/旧连接事件不能复活标记 |
| SET 超时后迟到成功 | 只记录未确认，不增加重试、不宣布已应用 |
| 十分钟限流丢待办 | 记录实际未安排与建议保留待办的差异，不修复调度 |
| 环境变量、外部 IM 状态需要 respawn | 不允许观察策略取消现有重建需求 |
| 诊断回调异常 | 旁路隔离，不能改变交付结果或调度 |

## 6. 验收标准

- 覆盖两个原始 IM 漏判回放，以及终态、旧 run、在途 poll、过期、取消、删除、重连和桌面任务共存。
- 对比开启/关闭诊断时 GET/SET 参数、调用次数、hash 退避、返回值与重启安排一致；覆盖诊断回调抛错、敏感值不输出、容量边界。
- 验证观察策略只产生日志，不新增恢复副作用；配置正常交付和原有四组 96 项基线继续通过。
- 运行相关 Vitest、所有改动 TS 的 CI 等价 ESLint、`npm run compile:electron`。
- 使用隔离网关验证启动、正常配置交付和日志关联；人工故障注入仅用于验证保护/诊断，不称为现场慢请求的端到端复现。
- 记录未覆盖的真实 POPO 账号/跨平台场景。回退本补丁无需数据迁移。

## 7. 实施与验证记录

### 7.1 实施范围

2026-09-17 完成第一阶段，工作目录 `D:/github/LobsterAI-im-config-recovery-stage1`，实施分支为 `fix/im-config-recovery-observation`。

| 文件 | 改动 |
|---|---|
| `src/main/libs/agentEngine/openclawImWorkloadTracker.ts` | 有界 IM 活动证据、按会话过滤旧轮询、过期 unknown、分别匹配 lifecycle/poll 终态 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 在原事件/轮询和清理入口挂接，新增配置重启专用快照；旧连接事件按代次丢弃；不修改原 `hasActiveSessions()` |
| `src/main/libs/openclawConfigObservation.ts` | HMAC 摘要、结构化日志、无副作用的恢复规则观察；没有执行器或恢复定时器 |
| `src/main/libs/openclawConfigDelivery.ts` | 可选同步诊断回调，记录实际 GET/SET 阶段、尝试、超时预算和 ACK revision 摘要；回调失败隔离 |
| `src/main/main.ts` | 仅三个自动配置重启检查位置使用新判忙；关联同步/来源/排队耗时，记录实际动作与观察建议 |
| `src/main/skills/skillChangeDiagnostics.ts`、`skillManager.ts` | 固定来源枚举、通知批次、watcher 合并计数；保留原通知筛选、debounce 和 renderer IPC |
| `src/main/libs/openclawEngineManager.ts` | 仅增加读取进程代次的纯 getter，不改 start/stop/restart |
| `src/main/ipcHandlers/scheduledTask/cronJobServiceManager.ts`、`index.ts` | 只读 peek 接口，不为诊断创建 CronJobService |

新增五个测试文件：`openclawImWorkloadTracker.test.ts`、`openclawConfigRestartWorkloads.test.ts`、`openclawConfigObservation.test.ts`、`openclawConfigDelivery.diagnostics.test.ts`、`skillChangeDiagnostics.test.ts`。既有保护性测试未放宽或删除。

观察器当前是纯规则函数，没有真正的恢复待办/版本收敛控制器。`verify-applied` 和 `retain-pending` 等字段仅为建议；前者不增加确认 RPC，后者不修复既有限流行为。后续阶段不得直接将这些建议接入执行器，仍须实现并验证目标版本、强制重建要求及原生空闲保护。

### 7.2 自动验证

在上述 worktree、Node `v24.15.0` 下执行：

```powershell
npx vitest run openclawImWorkloadTracker openclawConfigRestartWorkloads openclawConfigObservation openclawConfigDelivery skillChangeDiagnostics skillManager channelSessionRunStatus openclawRuntimeAdapter openclawConfigImpact openclawImConfigRestart openclawEngineManager.restart --reporter=dot

$changedTs = @((git diff --name-only -- '*.ts'), (git ls-files --others --exclude-standard -- '*.ts')) | ForEach-Object { $_ } | Where-Object { $_ }
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 $changedTs
npm run compile:electron
git diff --check
```

实际 Vitest 调用使用这 12 个测试文件的完整路径，结果 **12 个文件、460 项通过**（22.47 秒）。包含原四组 96 项基线、完整适配器和技能管理回归。修改文件 ESLint **0 error / 0 warning**，Electron 编译通过，diff whitespace 检查通过。

关键新增断言：

- 两个原始漏洞回放现在均得到 `activeTurns=0`、旧 `hasActiveSessions=false`、新配置工作快照 `busy`；匹配终态/明确 inactive 后释放。
- 旧/匿名终态不能清除新的已知运行；另一会话事件不会丢掉本会话的 active 轮询；停止、删除、缓存清理、断线和旧连接事件不能恢复旧标记。
- 生命周期过期、轮询过期和缺失 live flag 返回 unknown；历史数据库 running 不创建 busy；两个集合及日志样本都有容量边界。
- 正常、GET 超时、SET 超时、hash conflict、invalid config、客户端不可用六种场景，分别比较无诊断、有诊断、诊断回调抛错：RPC 参数、调用次序、模拟时钟时间、文件读取次数、结果和重启安排一致。
- 人工注入客户端 15 秒超时、38 秒迟到 resolve：只有原有一次 fallback，迟到 resolve 不增加日志终态、RPC 或恢复动作。这是故障注入验证，不是现场 38 秒慢请求复现。
- 限流窗口内的独立失败仍按原行为不安排恢复，但明确输出 `rate-limited/unconfirmed`；没有新增定时器。相等的旧 revision token 加 SET ACK 只输出 accepted。
- 诊断序列不包含合成密钥、原始 token 或配置内容；技能 watcher 仍只在原 debounce 后通知一次。

初轮新测试发现测试夹具缺少 channel/subagent 删除依赖，补齐夹具后通过；没有为此改动产品删除逻辑。

### 7.3 Windows 隔离网关验证

使用现有本机 `v2026.8.1` runtime，独立临时 state、workspace、端口和合成网关 token；禁用插件、IM 和 cron，无真实模型/IM 凭证。将本 worktree 的交付与观察模块打包为临时测试入口，启动真实网关后连续切换合成技能配置两次。

最终一轮结果：

- 两次交付分别 **5,069 ms / 4,566 ms**，均 `mode=rpc`、`restartScheduled=false`。
- 总调用序列严格为 `config.get → config.set → config.get → config.set`；超时预算保持 10,000 / 15,000 ms。
- 记录 16 条宿主交付诊断，含 host PID、sync ID、逻辑 attempt ID、GET/SET 原生 raw revision 的 HMAC 摘要；ACK 后仍仅报告 accepted。
- 合成 IM lifecycle 证据在交付期间为 busy，匹配终态后释放。此处使用真实跟踪模块，**没有连接真实 POPO 账号，也不等同于完整桌面应用的端到端验收**。
- 网关在两次交付后保持同一 PID 运行；测试结束已清理子进程。没有执行 suspend、额外配置读取或自动重启，没有改动 vendor 内容。

本机原始输出与临时验证入口位于 `%USERPROFILE%/.codex/artifacts/lobsterai-20260916-investigation/`：`stage1-tests.txt`、`stage1-lint.txt`、`stage1-compile.txt`、`stage1-gateway-smoke.cjs`、`stage1-gateway-smoke-result.json`、`stage1-gateway-smoke-output.txt`。

### 7.4 剩余限制及发布前人工检查

尚未验证真实 POPO 账号、macOS/Linux 生命周期和完整 Electron UI 操作链。发布前在测试账号中：发送有明显准备阶段的 IM 任务，同时修改技能设置；核对新的工作快照为 busy、配置重启延后，任务终态后按原流程继续；另检查手动停止/删除、重新连接及与桌面任务并行。

此补丁不证明现场 bootstrap 的慢点已解决，也不保证未知工作状态或跨进程检查窗口的安全。日志能定位变更来源类别、RPC 阶段和宿主判忙依据；精确 wire ID、超时后迟到 ACK、网关内部 schema/secret/bootstrap 子阶段仍需下一步运行时诊断。回退本补丁无需数据迁移。
