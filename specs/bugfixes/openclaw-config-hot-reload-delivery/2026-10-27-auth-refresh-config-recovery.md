# 同账号资料刷新中断配置交付后的主动恢复

日期：2026-10-27。状态：**代码已实施，14 文件 186 项定向回归、Electron 编译、renderer 类型检查与严格 lint 通过；真实应用及跨平台验收待完成，尚未提交/发布。**

适用项目：LobsterAI Electron。核查基线：`5eeeea9f13e964561b2bd3da65bde92f6381cacc`，工作区包含尚未提交的其他修复。本文件仅记录账号资料刷新与配置恢复的增量；远控调度修复不属于本次范围。

本文补充[账号转换与 Gateway 主动恢复](2026-10-20-account-transition-gateway-recovery-design.md)和[配置应用生命周期](2026-09-23-config-lifecycle-design.md)。账号隔离、认证提交、配置应用证明、工作负载保护和普通停止语义继续有效。

## 1. 现场与证据边界

2026-10-27，本机新任务被提示“所选模型的最新设置还没生效，会在正在运行的任务结束后应用”。以下时间为北京时间，行号来自当日调查时的 `main-2026-10-27.log`；日志会继续追加或轮转，复核时同时使用时间和事件名。

| 时间 | 日志证据 | 能确认的事实 |
| --- | --- | --- |
| 10:28:18.724 | main 第 2288 行 | `server-models-updated` 安排延期配置恢复，沿用 3 秒轮询 |
| 10:28:21.831、10:28:24.970 | main 第 2939–2941、3578–3580 行 | 网关尚在启动，配置交付两次因客户端不可用转入 fallback；不是模型调用失败 |
| 10:28:27.973 | main 第 3807–3809 行 | 第 7 次配置同步开始；重启工作负载检查 `blocksAutomaticRestart=false` |
| 10:28:29.147 | main 第 4453–4454 行 | `config.get` 成功，耗时 419ms；紧接着本地 `read` 阶段失败，耗时 0ms。此时 `state=idle`、`activeTurns=0`、IM 活动会话为 0、`cronBusy=false` |
| 10:28:32.153–32.156 | main 第 4535–4537 行 | 同步以 `Account changed during config synchronization` 失败，结果 `unconfirmed`、`restartScheduled=false`；终态观察仍为空闲 |
| 10:28:54.785、10:29:23.121 | main 第 4558、4628 行 | 两次新任务准入被拒，原因为模型配置 `Pending confirmation`，`Overdue=false` |

网关捕获日志 `gateway-2026-10-27.log` 第 146 行对应成功的 `config.get`，第 163 行记录远端模型目录更新需要网关应用。当次日志没有 `config.apply` 调用记录，主进程诊断也没有进入其阶段。因此 `config.apply failed` 是配置交付模块的通用 fallback 包装；**本次已定位的失败点是取得网关 revision 后的本地配置读取前置校验，不能写成网关拒绝 apply 或服务端模型请求超时。**

截至此次读取的 10:32:39，未发现第 8 次配置同步。之后出现的 cron 在 10:30:00–10:30:01.874 运行，晚于两次准入拒绝，不能据此认定它阻塞了本次最初恢复。

现场没有记录触发此次中断的具体认证 revision 或全部认证入口。错误文本不证明真实切号：`captureOpenClawAccountSnapshot()` 同时比较身份和认证 revision，并要求认证提交已结束；同账号企业资料刷新也会增加 revision。`GetQuota → refreshEnterpriseAccountContext → beginAuthMutation/commitAuthMutation` 是源码可见的触发路径，具体这次来自哪个刷新入口仍需通过定向复现确认。现场结论仅依赖阶段、状态和耗时元数据；未修改真实用户库来验证。

## 2. 问题机制

旧快照拒绝继续交付是正确的安全行为：配置读取、认证状态或归属在等待期间变化后，旧操作不能继续上传或确认成功。问题在于取消后的恢复责任丢失。

1. 延期执行入口先清除已有 timer 和延期原因，再进入配置串行队列。
2. 当前认证状态快照在入队时捕获。配置等待网关 RPC 时，即使 owner 未变，新的认证资料刷新也能使快照过期。
3. `config.get` 返回后重新读取/合并配置，账号 guard 拒绝旧快照。交付函数将异常包装为 fallback；调用方再次检查旧快照并退出，因此没有进入正常的重新排队分支。
4. 外层将错误转为失败结果并释放队列。配置恢复对象仍保留 pending target，但原延期 timer 已清除，也没有新的当前账号操作接管。
5. 新任务准入看到 pending target，继续阻止受影响模型。旧专用提示却把所有 pending 都表述成“存在运行中任务”，现场空闲时因此产生误导。

应修复取消后的调度责任，不能删除或放宽账号 guard，也不能把本地文件、PID 存在、握手或 `config.get` 成功当作目标配置已经生效。

## 3. 恢复设计与约束

### 3.1 只为当前账号安排新的配置恢复

对因认证快照过期而结束的配置操作，区分同账号资料刷新和真正身份转换。原操作仍以取消/失败结束；在允许恢复时合并到既有延期恢复路径，由新的操作捕获最新已提交快照、重新准备最新配置并完成应用确认。

补偿的条件与责任：

- 账号身份及账号转换代次仍匹配，不能只比较 owner 字符串；A→B→A 中的旧回调不能为后继账号补排旧工作。
- 当前必须存在已暂存的未确认目标；已应用、明确拒绝或已达到 stall 条件的目标不能被旧取消回调重新打开。本次补偿范围是现场已有 pending target 的中断，不为尚未生成目标的失败凭空创建同步需求。
- 认证提交尚未完成时等待原提交屏障；等待放在不会堵住账号恢复自身配置队列的位置，不持有 fence 等待完整恢复。
- 重新进入配置同步后必须使用新的认证 revision 和当前配置，不复用旧凭据、旧 target 原文或旧 RPC 响应。
- 真正账号/空间变化继续由现有账号 fence 与恢复协调器负责；资料刷新补偿不夺取其职责。
- 应用退出、数据恢复/维护及用户明确停止继续撤销自动运行意图；不得为了清除 pending 提示重新启动已停止的网关。
- 同时发生的新配置、重复认证刷新、旧失败回调只合并为一个当前延期恢复需求，沿用已有串行队列、冷却、重试和 stall 预算，不增加无界 timer 或并行配置交付。

恢复保留已有行为：空闲时尝试当前配置；有真实活动任务时继续等空闲，5 分钟阈值只改变提示，不强杀任务。热应用满足需求时不额外硬重启；确需替换进程时仍核对启动输入与进程代次，不能由一次刷新凭空创建重复重启需求。

调度目标沿用现有 3 秒轮询：认证提交完成、允许恢复且工作负载空闲后，应在下一次可用轮询进入配置恢复。事件循环繁忙、认证网络等待、网关启动和 RPC 超时仍可能延长总耗时；这不是整体 3 秒恢复承诺。恢复原因固定为 `auth-refresh-config-recovery`，沿用已有 syncId/阶段诊断；认证取消不直接归类为 delivery fallback 以升级硬重启。该原因同样遵守 `canRetry()`，不缩短原有冷却、不清失败预算、不新建 explicit restart demand。单一 3 秒 timer 限制派发频率，不代表持续认证刷新下有固定总重试次数；恢复依赖认证最终提交且当前配置可确认。

### 3.2 文案与 IPC 兼容

保留 `configApplyPending=true` 与 `configApplyPendingReason=ModelSettings` 的字段和语义，仅更新 main 与 renderer 对应中英文文案：

- 中文：**所选模型的最新设置尚未确认生效。请稍后重新发送；如有任务运行，配置会在任务结束后应用。**
- 英文：**The latest settings for the selected model haven't been confirmed as applied. Please try sending again shortly. If tasks are running, the settings will be applied after they finish.**

该提示说明生效证据不足，活动任务是有条件的可能因素，不再要求用户停止不存在的任务，也不声称自动恢复一定已经开始。普通启动、普通配置等待及实际逾期工作负载的提示保持现有区分。配置等待仍仅影响任务准入，不把实际 running 的网关改成全局启动遮罩。

## 4. 验收矩阵

下列为本轮要求；未运行项不得标为通过。自动化使用受控 I/O 或隔离 profile，不向真实账号配置注入故障。

| 编号 | 场景 | 验收条件 | 状态 |
| --- | --- | --- | --- |
| R01 | `config.get` 等待期间，同账号资料刷新开始并提交 | 旧操作在 guard 退出；新的当前快照自动恢复；无需发送新任务触发 | 通过：真实交付函数在第 7 次 deferred config.get 后取消，认证提交后自动确认并放行模型准入（RPC/时钟受控） |
| R02 | 资料刷新仍在提交中 | 不交付半成品配置，不占用导致账号恢复自锁的队列；提交后可继续 | 通过：认证提交中两类 timer 均不派发；等待提交早期失败仍保留恢复需求 |
| R03 | 多次刷新、重复取消与新配置同时到达 | 单一恢复调度，最新目标生效，无重复硬重启或旧目标覆盖 | 通过：重复取消保持一个 interval，新队列优先，重新生成最新目标且不额外 stop |
| R04 | A→B、A→B→A 或企业空间变化 | 旧回调不能补排/确认旧身份配置；原 fence 和新账号恢复拥有执行权 | 通过：新用例覆盖 owner 转换及 reset 后旧回调；既有账号恢复/连续转换回归同时通过；真实账号切换待验收 |
| R05 | 真实桌面/IM/cron 活动工作 | 不强杀；保持延期恢复，工作排空后能继续 | 通过：新增 busy 场景与既有 workload tracker 回归；真实桌面/IM/cron 联合场景待验收 |
| R06 | 停止网关、退出应用、数据恢复/维护与取消竞争 | 不被旧配置补偿重新拉起；不写入迟到成功状态 | 通过：退出、数据恢复、维修屏障及已停止 PID-null 分支；实际 Stop 按钮/OS 生命周期待验收 |
| R07 | 正常热应用与已确认目标 | 原 applied 证明有效；取消回调不重新打开已完成目标；无额外进程替换 | 通过：确认后 pending 与 timer 清除，正常热应用无额外进程替换 |
| R08 | 明确配置拒绝、冷却或 stall | 不用新取消补偿绕过现有拒绝/重试上限 | 通过：rejected/stalled/cooldown 在 5 分钟回调也不派发；原恢复预算回归通过 |
| R09 | main/renderer 中英文 ModelSettings 文案 | 两端一致，说明“尚未确认”；活动任务表述为条件；原状态映射不变 | 定向状态测试 4/4 通过（含新增中英文 2 项）；未作实机文案验收 |
| R10 | macOS 真实应用与隔离 profile | 空闲刷新竞争后自动收敛，新任务可发送，日志含当前应用确认；不以测试 mock 代替实机结论 | 待验收 |
| R11 | Windows/Linux 涉及路径冒烟 | 准入文案、认证刷新恢复和停止意图一致；记录具体构建与结果 | 待验收 |

## 5. 诊断与发布

现场复核优先关联 `syncId`、阶段、有限取消原因、认证 revision 是否改变、进程代次、`workloads` 与应用确认结果。不要打印 token、API key、原始配置、认证 payload、提示词或任务正文；账号关联使用已有脱敏字段。`Account changed` 文本本身不能替代身份转换证据。

确认恢复时同时查看：旧同步已终止、新同步使用当前账号状态、目标应用证明成立、任务准入不再因该目标 pending 被拒绝。单独看到 `config.get`、running、日志停止报错或重启成功都不足以判定修复完成。日志采样缺失也不能证明不存在活跃工作。

本次无服务端 HTTP API、认证协议、MySQL DDL、SQLite schema 或手机源码变更；没有服务端部署先后依赖。回退为客户端构建回退，不删除 pending/fence/任务数据，不绕过认证校验。发布前需回填定向自动化、编译、严格 lint 与实机复核结果；未完成的跨平台验收明确保留。

## 6. 实施与验证记录

### 6.1 实现

- `main.ts`：新增独立的 config recovery generation，账号 fence/reset 时推进，防止 A→B→A 或旧 timer 回调接管新恢复。认证等待前和正式入队后分别捕获 generation，避免等待跨越账号转换后错误丢弃当前账号操作。
- `scheduleInterruptedConfigRecovery()`：正式同步因旧账号快照失效退出、或等待认证提交提前失败时，只有同 recovery generation、最新 sync generation、仍有 pending 且非 rejected/stalled 的操作可保留重试。真正账号恢复协调器活动时由其接管，退出/数据恢复不补排；手动修复可以保留需求但不派发。
- `canRunDeferredGatewayRestart()`：3 秒 interval 与 5 分钟 timeout 共用认证提交、配置队列、维修、账号恢复活动、待确认目标、rejected/stalled、终止及 `canRetry()` 检查。timer 回调还校验自身 handle 和 reset generation，不能执行已取消回调。
- 延期重试通过原配置串行队列捕获新快照、重新 prepare 当前配置，不重放旧 target、旧 RPC 回执或凭据。保留原 requestedAt、restart demand、鉴权及 applied 证明。已停止进程仅按原 bootstrap 路径准备下次启动文件，不由本修复主动启动。
- main/renderer 中英文文案均已更新，IPC 字段、类型和状态映射不变。

### 6.2 自动化验证

2026-10-27，Node.js **v24.17.0**、Vitest **4.1.0**。先在改实现前复现失败：真实 main 函数第 7 次 deferred 同步被同账号 refresh 打断后，pending=true，但 interval 为 0（期望 1）；原 6 项同文件测试仍通过。

最终新增 **18 项回归**：配置恢复文件新增 16 项（连同原 6 项共 22/22）；中英文提示新增 2 项（状态文件共 4/4）。最终联合 **14 文件、186 项全部通过**，耗时 6.82s：

```bash
export PATH=/Users/admin/.nvm/versions/node/v24.17.0/bin:$PATH
npm test -- src/main/main.configRestart.test.ts src/main/main.accountRecovery.test.ts src/main/main.authRecovery.test.ts src/main/libs/openclawAccountRecovery.test.ts src/main/libs/openclawConfigRecovery.test.ts src/main/libs/openclawConfigDelivery.test.ts src/main/libs/openclawConfigAdmission.test.ts src/main/libs/openclawConfigRecovery.restart.test.ts src/main/libs/openclawConfigApplication.test.ts src/main/libs/openclawConfigDelivery.diagnostics.test.ts src/main/libs/openclawConfigTarget.test.ts src/main/libs/openclawImConfigRestart.test.ts src/main/libs/agentEngine/openclawConfigRestartWorkloads.test.ts src/renderer/services/openclawEngineStatus.test.ts
npm run compile:electron
npx tsc --noEmit -p tsconfig.json
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/main.ts src/main/main.configRestart.test.ts src/main/i18n.ts src/renderer/services/i18n.ts src/renderer/services/openclawEngineStatus.test.ts
git diff --check
```

Electron 编译、renderer 类型检查、全部 5 个本轮 TypeScript 改动文件严格 lint（零警告）和 diff whitespace 检查通过。最终日志位于仓库外 `/tmp/lobsterai-auth-refresh-final-tests.log`、`/tmp/lobsterai-auth-refresh-final-compile.log`、`/tmp/lobsterai-auth-refresh-final-lint.log`。

恢复测试从实际 main.ts 抽取并执行配置函数，使用真实 `OpenClawAccountRecovery`、`OpenClawConfigRecovery`、`deliverOpenClawConfigToGateway` 与准入判定。网关 RPC、进程管理、时钟、文件 I/O 使用受控夹具；这证明状态与调度行为，不代表实际 Electron/Gateway、认证服务器或用户 profile 已验收。配置 timer 与活动账号恢复操作的组合没有单独注入测试，原账号恢复套件另行覆盖协调器行为。

### 6.3 扩展检查的基线失败

额外运行以下两个文件得到 **15 失败、8 通过**：

```bash
npm test -- src/main/main.remoteStartup.test.ts src/main/main.remoteInitialization.test.ts
```

`main.remoteStartup.test.ts` 有 4 项失败（桥启动、账号变动后的 power/bridge 事件）；`main.remoteInitialization.test.ts` 有 11 项失败（预期 identity 分类但收到 dependency_unavailable 等）。在仓库外导出的未修改 HEAD `5eeeea9f13e964561b2bd3da65bde92f6381cacc`、相同 Node24/node_modules 下运行同两文件，同样 **15 失败、8 通过**。已核对该副本全部 2412 个 src 文件 Git blob 与 HEAD 一致；基线日志 `/tmp/lobsterai-main-init-baseline-5eeeea9f.log`。本轮未修改或放宽这两组断言，不把它们归入 186 项通过结果，也不宣称全量测试已通过。

### 6.4 交付边界

本轮改动仅桌面代码及对应 spec；服务端关联事故文档同步记录，无接口、数据库或手机源码变更，未执行服务端测试。未提交、未构建/发布安装包，未重启或修改原故障进程、用户配置及业务库。运行中的桌面进程需加载新构建后复核；R10/R11 的真实应用及跨平台验收仍待完成。
