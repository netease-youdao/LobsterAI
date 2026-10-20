# 登录、退出及配置变更后的 Gateway 主动恢复设计

日期：2026-10-20。状态：**客户端代码已实施，本地自动化回归通过；真实账号与跨平台安装包验收待完成，尚未发布。**

适用项目：LobsterAI Electron 客户端。源码核查基线：`52088597`。本次实施修改客户端运行时、认证接线与展示层；服务端接口及数据库均不变。

本文是[配置应用生命周期](2026-09-23-config-lifecycle-design.md)的增量设计，同时补齐[登录凭证生命周期](../auth-session-lifecycle/2026-07-23-auth-session-lifecycle-design.md)与[桌面账号隔离方案](../../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-23-desktop-first-fault-containment.md)之间的恢复步骤。原有归属、执行幂等、凭据门禁及配置应用证明继续有效。

## 1. 概述

### 1.1 问题与证据

用户反馈：登录、退出等需要重启 Gateway 的操作没有及时恢复，桌面出现提示或报错后才启动。

修复前基线源码可确认：

| 位置（按符号定位，行号会变化） | 修复前行为 | 后果 |
| --- | --- | --- |
| `main.ts / queueAccountFence` | 关闭凭据 gate，执行普通 `stopGateway()`，隔离 cron，写入账号 fence ready，重新允许凭据访问 | 没有配置、启动和连接恢复的完成步骤 |
| `openclawEngineManager.ts / doStopGateway` | 普通停止完成后设为 `ready`，消息为 `Gateway is stopped` | 截图黄色“开始任务时会自动启动网关”对应停止态，并非 `error` |
| `main.ts / _syncOpenClawConfigImpl` | 非 running/starting 且无子进程时，仅保存目标配置并返回成功 | 登录/退出后的同步不保证网关恢复 |
| `openclawRuntimeAdapter.ts / onClose` | 非主动断连时先让活动任务失败，再安排 2s/5s/10s/15s/30s 退避重连 | 账号停止可被误当成网络故障，启动依赖重连兜底 |
| `main.ts / executeDeferredGatewayRestart` | 每次延期重试都重新传 `restartGatewayIfRunning=true`、`expectedImpact=Restart` | 可能把旧需求登记到新的进程代次，刚启动又重启 |
| `main.ts / RestartGateway IPC` | 将 `running` 或 `ready` 都计作重启成功 | 被账号停止取消的重启也可能返回 success |

本机 `main-2026-10-19.log` 的 15:05:03.842 开始配置硬重启，03.845 才报 `gateway client stopped before handshake completed`，07.088 启动替代进程。该轮最终收敛，不能称为无限重启，也不能与无时间戳的用户截图认定为同一次事件。它证明“报错后看到启动”还可能是重启打断握手的表现。

### 1.2 修复目标

在运行环境健康、账号隔离成功且具有运行意图时，登录、退出、切换账号/企业空间后，由主进程主动完成：

`旧执行停止与隔离 → 账号状态提交 → 最新配置准备 → 启动 → 配置应用确认与连接恢复`

不依赖新建任务、WebSocket 断线、定时错误或用户点击重启。普通配置更新仍尽量热应用；确需重启时，同一个重启需求不能被轮询重复升级。

### 1.3 非目标

- 不取消账号 fence，不将所有 Token 刷新改成硬重启，不恢复旧账号的任务或被隔离的 cron/IM 来源。
- 不改 OpenClaw 上游协议、不升级运行时、不新增服务端接口、MySQL DDL 或 SQLite schema。
- 不重构整个 `main.ts`、认证系统或通用 Gateway 生命周期；下面提出的模块边界只承载本次协调逻辑。
- 不把账号登录成功等同于模型可用或网关就绪；网关恢复失败也不能反向撤销已经成功提交的登录状态。

## 2. 用户场景与功能要求

| 场景 | 期望行为 |
| --- | --- |
| 已运行时登录、退出、A→B 切换 | 立即显示账号运行环境恢复中；安全隔离后主动恢复，无需发送任务 |
| A→B→C，或 A→B→A | 只允许最新转换恢复；同一 owner 字符串不能代替代次校验 |
| 退出后仍有自定义模型 | 清掉套餐/企业账号配置后恢复匿名允许的本地能力；不沿用旧账号模型或自动任务 |
| 已明确停止、退出应用、数据恢复或维护中 | 不被账号变动和后台重试重新拉起；维护完成后按原有显式恢复意图处理 |
| 同账号正常 Token 刷新、GetUser 暂时失败 | 保持原刷新/临时失败语义；不因凭据字符串变化停止网关 |
| 有任务执行时真正切换身份 | 立即撤销旧执行许可，按既有中断/核对流程处理旧任务；不套用普通配置更新的等空闲策略 |
| 普通模型配置变化且有活动工作 | 热应用或沿用工作负载保护等待空闲，5 分钟仅提示逾期，不强杀 |
| 网关启动中又收到模型列表更新 | 先合并最新目标，已经满足的进程重建需求不能被延期轮询重新登记 |

成功标准分为三层：

1. **账号隔离完成**：旧引擎已停止，自动来源已隔离，当前 owner/代次匹配，fence 记录已持久化。
2. **进程就绪**：运行的是被当前恢复操作授权的进程，进程代次和启动输入满足要求。
3. **执行恢复完成**：配置应用有现有 applied/receipt 证据，当前连接握手完成，必要订阅/轮询按原有兼容规则恢复。

`sync.success=true`、磁盘写入成功、PID 存在或 WebSocket 握手中的任何一项都不能单独代表第三层完成。可选 IM 平台或远控服务离线不应阻塞健康的桌面执行。

## 3. 状态与职责

### 3.1 三类状态不能混用

| 状态 | 所属模块 | 含义 |
| --- | --- | --- |
| 账号安全 fence | `RemoteAccountTransition`、`remote_account_execution_fence`、凭据 gate | 是否允许新身份接管执行环境 |
| Gateway 实际状态 | `OpenClawEngineManager` | 进程真实的 ready/starting/running/error |
| 账号恢复操作 | 拟新增小模块 `openclawAccountRecovery.ts` | 当前账号转换的配置、启动、连接恢复是否完成 |

保留 fence 标记的现有 `version:1` 与 `pending/ready` 语义。标记 ready 只证明隔离步骤完成，不能改成“网关已经运行”。恢复阶段使用内存状态；崩溃后通过现有启动流程重新核验 fence、准备配置和启动，不凭内存阶段恢复旧任务。

恢复阶段采用有限状态：

`fencing → waiting_auth_commit → preparing_config → starting → confirming → reconnecting → complete`

失败进入 `failed`；被新转换取代进入 `superseded`；无运行意图进入 `stopped`。这些是内部操作阶段，不增加对外 EnginePhase 枚举值。

### 3.2 最小协调器边界

拟新增 `src/main/libs/openclawAccountRecovery.ts`，只负责本次恢复的代次、单飞、取消、阶段和依赖调用顺序；认证、配置生成、进程控制与任务持久化继续留在原模块。对外职责：

- 接收账号变更开始、认证本地提交/回滚完成与 fence 完成事件。
- 合并同一次转换中的多次 token/user/context 通知；接收新的转换时同步使旧操作失效。
- 请求或加入当前恢复、发布操作快照、响应显式停止/维护/退出。
- 提供启动/连接准入校验，阻止后台路径绕过恢复顺序。

`main.ts` 只负责接线，不整体迁移既有认证或配置函数。阶段、原因和取消类别使用集中常量；新增接口命名在实施时与现有共享类型对齐。

每次操作至少绑定：

| 字段 | 用途 |
| --- | --- |
| `transitionId`、`ownerEpoch` | 区分 A→B→A，隔离旧回调 |
| `authMutationRevision` | 区分同一认证操作中的半成品、最终提交及回滚 |
| `owner`（允许 null） | 当前用户、空间及已存在的目标身份校验；null 是退出后的合法身份 |
| `runIntentRevision` | 用户停止、应用退出或维护使旧恢复许可失效 |
| `targetRevision`、`gatewayGeneration` | 配置结果和进程结果不能跨操作确认 |

运行意图优先沿用已有启动/维护意图，不能用停止后的 `phase=ready` 推断用户要求停止。账号变更前正在运行、启动或已有明确启动/重启请求时应恢复；应用冷启动沿用原有自动启动策略。原本明确停止则只完成隔离和配置清理，后续用户显式启动才恢复。连续转换沿用最初有效运行意图，不因中间一次 fence 暂停而丢失它。

## 4. 实现方案

### 4.1 认证的提交边界

当前 Exchange 先写 token/user，再异步处理企业上下文；`activeAuthExchangeIntent=null` 发生得更早，不能代表账号已经稳定。不能直接在 `queueAccountFence().then(...)` 中无条件启动。

实施时明确以下边界：

1. 首次修改身份相关本地状态前，登记 auth mutation revision；现有关键 store listener 仍同步撤销凭据/执行许可并安装 fence，不等认证流程全部结束。
2. 登录提交必须包含 token、user、必需企业上下文、额度门禁归一化和旧账号模型缓存失效。使用现有认证代次校验，企业上下文缺失仍按原认证规则失败。
3. 所有必需状态写完后发布 `authCommitted(revision, owner)`；读取 owner 和确认 revision 必须在同一主进程同步段完成。营销、购买优惠、遥测、远控注册不得成为新增恢复前置条件。
4. 退出、Refresh Token 被明确拒绝、成员资格撤销：完成本地凭据、用户、企业上下文、套餐模型和额度清理后，提交 owner=null。恢复不等待远端 logout HTTP 成功。
5. 登录写入中途失败并回滚旧快照时，回滚作为新的已验证 revision/owner 进入隔离与恢复；不能在 `finally` 中给失败的半成品发布 committed。若后续步骤仍允许回滚已提交账号，该回滚必须创建新转换，不能悄悄覆盖当前恢复。
6. GetUser/企业上下文刷新确实改变 owner/scope 时也进入同一边界；同 owner 的 Token 续期只使用原有刷新协调，不创建账号恢复。
7. 套餐模型列表可在认证提交后异步刷新，但必须校验请求 owner/代次，旧响应不能写入新账号。没有当前账号列表时保留安全的空套餐配置，不能为了启动继续使用旧账号列表；新列表到达后按正常配置应用流程处理。

账号认证结果与引擎恢复结果独立：保持原登录/退出 IPC 的字段和认证语义，主进程安排并观察恢复 Promise；恢复失败发布引擎错误，不吞掉拒绝，也不把已成功登录返回成登录失败。

### 4.2 fence 内只完成停止与隔离

发生真实身份变化时，顺序如下：

1. 同步关闭凭据 gate、使旧恢复/连接初始化失效，记录 pending fence；这一过程先于可能失败的可选监听器。
2. 停止旧操作的自动重连、轮询和新任务准入。按 §4.5 为已启动及等待中的任务显式收尾。
3. 将旧连接作为计划停止断开，再调用普通 `manager.stopGateway()`，保留推进 lifecycle generation、取消旧启动/重启的行为。
4. 证明旧子进程实际停止，完成 cron/自动来源隔离，逐 await 复核当前 owner/epoch，成功写 fence ready。此时只结束隔离操作，不在 action 中恢复 `remoteCredentialsAllowed`；认证状态可能还未提交完整。
5. 让 `RemoteAccountTransition.run()` 返回。恢复协调器在其外部等待最新 fence 和匹配的 auth commit，然后进入配置准备。

任务清理异常不能阻止尝试停止旧进程。核心执行证据不明确时继续保持相关 gate；可选投影/通知失败沿用现有隔离策略。不能把进程停止当作外部工具副作用已取消的证明，也不能重新开启被隔离的自动来源。

**禁止两个捷径：**

- 不把普通 stop 改成 `stopGateway({restarting:true})` 以隐藏黄色提示；该参数会改变取消语义，也会让停止态配置写入分支无法使用。
- 不在 fence action 中等待 `syncOpenClawConfig()`、`ensureOpenClawRunningForCowork()` 或完整恢复 Promise；它们依赖同一 fence，可能自锁。

### 4.3 fence 外主动恢复

恢复执行使用单飞操作，按下列步骤推进；每个 await 后、每次副作用前重新校验 owner/epoch、auth revision 和运行意图：

1. 等待匹配的认证本地提交和最新 fence 成功；若被取代，退出旧操作，由最新操作接管。在同一同步段再次核验快照后，才允许恢复 `remoteCredentialsAllowed`。认证过程原有的上下文 HTTP 请求直接使用认证模块，不经被封锁的模型 Token proxy，不能产生“等 proxy 放行才能完成认证”的环。
2. 无运行意图时保留 stopped，不恢复进程；退出应用、数据恢复、维护和 startup block 优先于自动恢复。
3. 进入既有配置串行队列，基于当前已提交账号重新 prepare 最新目标及环境变量；停止态按现有安全规则落盘。不得复用触发 fence 时捕获的旧配置。
4. 校验配置准备结果与目标身份后，调用 manager 的单飞启动。启动前再校验许可；账号在启动期间变化时，由新 fence 取消旧启动，旧操作不得重连或发布成功。
5. 进程运行后先完成仅表示“当前进程已启动”的 `processReady` Promise，再使用现有配置确认流程，核对目标、实际启动输入和代次。确认可能需要 RPC 连接：仅协调器当前操作可先建立受控连接用于确认，此时不开放业务执行/IM 轮询；完整的 `recoveryComplete` 尚未完成。
6. 当前目标确认应用后完成连接握手和必要订阅恢复，再开放业务请求、IM 轮询与既有授权来源，结束恢复投影。若确认用的连接仍有效则复用，不再断开重建。
7. 最终同时满足当前操作、真实 running、配置应用证明及当前连接就绪，才标记 complete。可选平台连接失败只影响该平台，不能无限等所有 IM 服务上线。

“及时恢复”指前置条件满足后直接排入恢复队列，不等待 3 秒配置轮询、WebSocket 退避或用户任务；不承诺登录后一瞬间完成运行时启动。异步模型刷新可在启动前合并，启动后热应用；真实新的环境/插件变化仍可合法要求一次新进程。

### 4.4 启动入口与取消：避免旁路和死锁

必须覆盖：应用启动、`ensureOpenClawRunningForCowork`、IM `ensureCoworkReady`、adapter 的 `connectGatewayIfNeeded`/重连、手动重启及 Quick Repair 的恢复入口。不能只修改登录回调，留下 adapter 直接 `startGateway('channel-sync-ensure-ready')` 抢跑。

- 外部入口在进入 manager 的 start Promise **之前**检查或加入当前账号恢复；已有恢复时只加入，不能各自启动。原先已经派发的旧任务不能通过加入新恢复变成新账号任务。
- 区分 `processReady` 与 `recoveryComplete`：前者在进程启动后、连接恢复前完成；后者包含连接和配置确认。外部 adapter/IM/WS 完整连接入口在取得 `gatewayClientInitLock` **之前**等待后者；任务准入也等待后者。只有持当前许可的内部确认连接可等待 processReady 并先建立连接，不能开放普通事件处理、业务订阅或轮询。
- adapter 注入 `ensureGatewayStarted(reason)` 替代直接启动 manager；普通外部调用须先通过前述完整恢复门禁，内部确认调用使用受控模式。持有 `gatewayClientInitLock` 时绝不能等待 recoveryComplete，否则协调器的 connect 又等待同一把锁。
- 恢复本体使用内部已验证路径调用低层 manager/config/connection 方法，不反向加入自己的恢复 Promise。RPC 确认连接也使用这一内部路径，避免 `recover → connect → recover`。
- 配置队列内部的 `ensureGatewayRpcClient`、硬重启路径不能等待协调器恢复，否则与恢复等待配置队列形成环。它们只做当前许可的同步检查；fencing/未准备时快速返回“不可用/被取代”，保留或废弃对应 target，再让最新恢复继续。配置队列不能在尚未准备时调用可能隐式启动网关的连接函数。
- manager 内保持进程取消语义，不把动态 `remoteAccountTransition.wait()` 塞进现有 startup prerequisite。否则 fence 内 stop 等待旧 start，而旧 start 又等待 fence，形成循环。
- 配置 prepare 完成后签发当前操作的不可复用启动许可；manager 同步捕获/比较此许可，不等待账号屏障。manager 内的崩溃重试、启动循环也继承原许可，在重要 await 后及最终 spawn 前校验；仅包裹 main 的显式调用不足。许可在账号变化、停止、维护时立即失效，A→B→A 也不能复用。现有 startup prerequisite 超时/失败后可能继续，仅是启动协调，不能作为安全许可。
- 旧启动与连接操作在每个异步准备边界校验捕获许可；新的 fence 必须使它们可取消/失效，不能等长时间的握手失败才释放。
- 同账号资料/额度刷新期间暂不签发新的启动许可；已经签发、仍属于当前身份的进程许可继续有效，保留上一次完整配置及其崩溃重试能力。不能仅因 `authMutationRevision` 变化永久撤销既有子进程许可，也不能临时中断后把无子进程的状态留在 `starting`。真正的重新登录/身份变化通过 owner、账号代次和新 operation 永久撤销旧许可；正在恢复的 operation 遇到认证写入则废弃 preparedRevision、提交后重新准备。配置队列独立校验认证 revision，禁止发布半成品配置。
- 已停止账号完成安全配置准备后，第一次外部启动/人工重启通过 `requestRunning()` 接着执行 start/confirm，不重复 fence，也不先裸启动再补恢复。退出应用或导入备份通过 cancel 撤销整个操作；cancel 后后台请求不能自行恢复运行意图。
- adapter 需要在 `await startGateway`、`await loadGatewayClientCtor`、握手和订阅回调后都校验账号/连接 epoch。仅 `onHello/onClose` 的 client generation 校验不够，旧初始化可能在这些 await 之后才创建新连接。
- fence 同时撤销旧初始化锁的操作所有权；不能取消的模块加载返回后只丢弃结果，旧 `finally` 不能清除新操作的锁。受控连接的业务事件门禁在 complete 前保持关闭，防止等待 processReady 的其他路径抢先推广普通连接。
- 同一身份的手动重启在恢复中加入该操作；恢复已失败时手动重试当前操作。不同身份或更晚的停止/维护使旧手动操作失效，不能返回成功。
- 后台自动拉起与显式运行意图分开；自动重试不能撤销用户停止或清除 startup block。

### 4.5 计划停止与任务、连接的收尾

`disconnectGatewayClient()` 目前会拒绝 pending handshake、清理连接及轮询，但不会完整清理 `activeTurns/pendingTurns`。因此不能仅加一行 disconnect 并吞掉错误：

1. 先冻结旧身份新执行，取消等待中的任务启动、连接初始化和后台重连；识别仍属旧操作的 session/run。
2. 复用既有停止、终态保存、审批/问题解除和 run 核对入口，保证 Promise 恰好结算一次。远程已派发且结果不明的 run 保持 `reconciling` 等现有状态，不伪造成功或安全取消。
3. 本地、匿名、IM、cron、yielded、pending startup/BTW 分别检查；同属旧网关的匿名任务也不能默默遗留 running。不能以恢复为理由自动重放任何旧任务。
4. 连接主动终止采用类型化的本地取消原因（如账号切换/显式重启），向内部等待者返回“操作已被取代/取消”；仅匹配当前主动停止的错误按预期日志记录，不弹通用网络故障，也不启动自动重连。
5. 真正的网络断连、握手超时、加载错误仍走原故障路径；不得通过匹配错误文本或统一 catch 吞掉。
6. 用户任务因切号确实中断时仍展示中断事实；消除的是误报“网关意外故障”，而非隐藏任务结果。

### 4.6 配置目标与重启需求分开

保留 `OpenClawConfigRecovery` 的最新 target、applied 证明、限流、冷却和 stall；将“最新配置内容”与“是否必须产生新进程”分开记录。

重启需求最少包含 `requestId`、`ownerEpoch`、原始原因类别、首次 `requestedAt`、`requiredAfterGeneration` 及启动输入证据。仅下列事件创建或推进需求：

- 新的必须在进程启动时载入的环境、绑定或兼容文件内容变化。
- 原始显式重启请求。
- 按现有策略确认需要执行的配置交付失败恢复。

延期轮询只是重新评估同一个需求，不创建新需求、不更新时间基准、不把当前代次重新设为下限。`executeDeferredGatewayRestart` 携带原需求，不能固定追加 `restart=true/expectedImpact=Restart`；`deferred:` 日志字符串不能决定行为。

“真正的新变化”对照**上一份已经登记的 desired 启动输入/revision**判断，不对照尚未落盘的旧文件，也不使用包含所有热更新字段的 target hash。`modelCompatRestartRequired` 等当前基于磁盘差异的分类在登记需求时须改用这一基线；相同输入重复 prepare 不再创建需求，纯模型热更新不推进 restart-input revision。

合并规则：

| 输入 | 处理 |
| --- | --- |
| 相同需求再次轮询 | requestId、首次时间及 requiredAfterGeneration 不变 |
| 只有最新可热应用 target 变化 | 更新 target，保留原进程需求；不据此要求再产生一个进程 |
| 出现新的进程启动输入变化 | 合并最新输入，按真正变化的时点/输入版本推进要求 |
| 新账号 epoch | 旧目标/需求失效，按新账号准备目标；旧回调不能清除新需求 |
| 有效显式手动重启 | 创建一次操作；并发点击加入同一操作，完成后的新点击才是新需求 |

**满足重启需求不能只看 generation 增长或 `startedAt > requestedAt`。** 当前 manager 在实际 spawn 前已经复制 `spawnSecretEnvVars`，两者间还可能有异步准备。必须比较 `getGatewayProcessSecretEnvVars()`、`getGatewayProcessConfigRaw()` 等实际启动输入；配置文件外的插件/兼容状态需要在 prepare/spawn 边界记录可验证的输入 revision，不能仅以时间猜测。

判断顺序：

1. 进程代次满足原需求，且实际环境/启动专属输入匹配，则进程重建需求已满足。
2. 最新 target 的热应用差异单独交付并确认；不能因整体配置存在新模型差异就否定已经满足的环境重建。
3. 实际启动输入陈旧时保留需求，完成安全重启；同 PID 的内部重载不能代替要求新进程的变化。
4. 账号恢复产生的合格进程可满足已有需求，确认后清理对应延期任务；旧延期回调不能再次重启。

保留 3 秒空闲检查、5 分钟仅提示逾期、交付失败恢复 30 秒退避/10 分钟重启冷却及既有 stall。账号安全隔离不受普通工作负载等待策略阻挡；配置重启仍不得中断已知活动工作。参见[恢复熔断设计](2026-10-09-orphan-config-lock-and-recovery-stall.md)。

### 4.7 状态展示、准入和手动恢复

manager 内部始终保留真实状态。面向 renderer 的 GetStatus、OnProgress 和操作响应统一通过展示投影：

- 当前账号恢复未完成时，使用已有 `starting` 阶段表达恢复中，避免 stopped-child 的短暂 ready 显示成黄色懒启动提示。
- 使用可选 `accountRecoveryPending` 字段，保持原字段类型和 phase 枚举。按 2026-10-20 用户反馈，恢复中复用原 Gateway 启动/重启弹窗（`EngineStartupOverlay`），在原说明区域展示“正在切换账号并恢复 AI 引擎”；移除单独的蓝色恢复提示。中英文均通过 i18n。账号整体恢复没有可信百分比，使用原弹窗的等待动画，不展示残留进程进度（例如 100%）。
- 真正失败后复用原 `EngineFailureOverlay`，展示 `error`、实际错误详情和既有重启/快速修复/稍后处理入口；启动弹窗退出，不重复叠加蓝色提示。无运行意图时展示真实 ready，不伪造 running。
- 该投影只用于外部展示和操作结果，不回流到配置同步或 manager 生命周期判断。普通 `configApplyPending` 仍沿用原设计，不将所有热应用等待都显示为全局启动遮罩。
- 恢复时沿用原启动弹窗的交互遮罩；弹窗显隐不额外清空当前账号草稿或历史，恢复完成后继续。失败时可以使用原“稍后处理”入口。保留现有跨账号归属隔离，不跨账号保留旧输入；新任务用现有引擎未就绪响应暂缓，不创建已派发 run、不自动重放。
- 任务准入即使看到真实 manager running，也须检查当前账号恢复是否已完成；“进程存在”不能绕过配置/账号门禁。
- 手动 RestartGateway 仅在当前操作完成、实际 running 且必要连接/配置确认通过时返回 success；ready、superseded 或 blocked 不能算重启成功。保留现有 IPC 名称和返回形状。
- 账号恢复失败时按钮重试整个协调流程；普通独立重启仍走现有流程并加入必要门禁，不能只重启进程后跳过未完成的 fence。

### 4.8 失败、重试及优先级

优先级：应用退出/明确停止/维护或数据恢复 > 最新账号 fence > 最新账号恢复 > 普通配置变更 > 后台重连。

| 失败位置 | 处理 |
| --- | --- |
| fence marker 写失败、旧进程未停止、自动来源隔离不明 | 保持安全 gate 关闭；显示原因，保留现有证据，不能启动新身份 |
| 认证提交失败 | 等待原流程的成功回滚或新的身份提交；不恢复半成品账号 |
| 配置非法 | 依现有拒绝语义显示错误，停止自动重启；修正配置或显式重试 |
| 运行时缺失、startup block、维护 | 不清除保护状态；沿用安装/修复入口 |
| 进程就绪但连接失败 | 保留已满足的进程需求，仅重试当前连接/确认；不能每次连接失败都 stop/start |
| 配置交付持续失败 | 沿用现有退避、冷却、stall；保留 pending，不无限重启 |
| 新账号到来、退出应用 | 立即废弃旧恢复和重试 timer；旧完成回调不可清除新状态 |

同一操作只允许一个自动恢复循环。瞬态恢复采用 1s/5s/15s/60s 四次延迟重试上限，失败后显示可操作状态；沿用更严格的现有启动预算、配置冷却/限流期限，不另开一套更快循环。明确非法配置、核心持久化失败或无法证明隔离时不盲目重试启动。手动重试合并在途操作，遵守现有防连点约束。

四次是本方案的验收目标；当前 fence 使用递增退避并不等于已经实现总次数上限。实现时需明确初次尝试与四次自动重试计数，不能误写为已有保证。

计数属于同一 transition/intent，外层只重试尚未完成的阶段；已满足的 stop/start 不重做，不能通过反复调用 `restartGateway()` 或重新签发同一许可重置内层预算。实际下次时间取外层退避、阶段限流和冷却的较晚期限；startup block、rejected、stall 不被外层自动清掉。将现有 fenceRetry 定时器纳入同一操作的调度/计数，取消被接管的旧 timer；配置恢复保留其原预算，但同一未完成需求不能同时由两个调度者执行。

## 5. 涉及文件与实施顺序

| 工作包 | 文件/符号 | 修改范围 |
| --- | --- | --- |
| A：恢复协调 | 新增 `src/main/libs/openclawAccountRecovery.ts` 及定向测试 | 代次、运行意图、单飞、取消、阶段和四次重试上限；小模块，不迁移整个认证系统 |
| B：认证与主进程接线 | `src/main/main.ts`：Exchange/GetUser/clearLocalAuthSession、queueAccountFence、启动/重启入口 | 认证提交信号、fence 外恢复、启动入口准入、统一状态投影 |
| C：计划中断与连接 | `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`，必要时 `remote/sessionCommandService.ts` | 旧任务收尾、类型化取消、初始化 epoch、受控确认连接与业务轮询分离 |
| D：重启需求与启动许可 | `src/main/libs/openclawConfigRecovery.ts`、main 的 deferred/config queue、`openclawEngineManager.ts` | 稳定需求及输入证据，轮询不重新升级；启动循环与崩溃重试校验许可，保留普通 stop 行为 |
| E：状态与交互 | main/renderer 的 `OpenClawEngineStatus` 声明、`cowork` service、`CoworkView`、i18n | 可选字段保持一致、恢复提示、手动成功判定与草稿保留 |
| F：验收 | 既有 manager/recovery/adapter/main/auth 定向测试与 Electron 实机 | 按下节验证完整接线及正反例 |

实施顺序为 A/B/C 联合打通账号恢复，再完成 D 防止恢复后重复重启，最后 E/F 验收。A/B/C 不应分拆发布为“先屏蔽断连错误，稍后补任务收尾”。每一步检查取消与凭据门禁，没有只改 UI 就算修复的阶段。

模块提取仅是本方案提出的实现边界，尚未执行。无需新增远控功能开关；即使远控关闭，账号与网关协调也属于本地核心。若实施中确需开关，默认开启，关闭只能恢复旧可用性行为，不能关闭账号隔离。

## 6. 验收标准

### 6.1 自动化回归矩阵

以下为完整验收矩阵，已执行的自动化与本机冒烟范围见 §8，未列入证据的实机组合仍待执行；不能用单个纯函数断言替代主进程完整接线验证。

| ID | 输入/故障注入 | 必须断言 |
| --- | --- | --- |
| G01 | running、无 WS 时登录/退出 | 无用户任务仍主动恢复；stop/config/start/confirm/connect 顺序正确 |
| G02 | 已有 WS 和本地/远程活动任务时切号 | 无意外断连兜底触发；旧 run 正确中断或待核对，Promise 结算一次，不重放 |
| G03 | token/user 已写、企业上下文 Promise 未完成 | 立即隔离，但不配置/启动半成品 owner |
| G04 | 登录部分写入后失败/回滚 | 只恢复最终验证的快照，旧操作不能释放新 gate |
| G05 | A→B→C、A→B→A | B/旧 A 的异步结果被丢弃，最新运行意图不丢失 |
| G06 | 同账号 Token 刷新、GetUser 5xx | 不创建无关 fence/restart，不清理仍有效登录态 |
| G07 | logout HTTP 超时 | 本地清理提交后恢复不等待 HTTP；旧 token/模型不可用 |
| G08 | 延迟旧账号模型/额度响应 | 不污染当前配置；当前账号模型稍后返回可正常热应用 |
| G09 | stop/start、构造器加载、握手、订阅各 await 处切号 | 不创建过期 client，不启动旧账号轮询，不发布 stale complete |
| G10 | stop 与旧 startup 并发 | stop 可完成；不存在 start 等 fence、fence 等 start 的循环 |
| G11 | 自动重连、IM 启动、任务提交、手动重启同时到达 | 加入同一恢复，启动次数受控，无低层旁路 |
| G12 | 恢复期间显式停止/退出/维护 | 旧操作和 timer 不复活进程，不清 startup block |
| G13 | 原本明确停止或无运行意图 | 更新账号配置但不自动拉起，UI 不宣称重启成功 |
| G14 | fence 落盘失败、cron 隔离失败、子进程停止超时 | 不放行新身份；新恢复可重新核验，不能吞错宣布完成 |
| G15 | 每个阶段崩溃后重开 | 重新核验持久 fence，配置重新生成，无旧任务自动重放 |
| G16 | 停止态 env 变化，启动中仅模型列表更新，多次 3 秒轮询；磁盘仍旧但 desired 兼容输入相同 | 重复 prepare/轮询不新建需求，原需求代次不推进；实际输入已满足后不再硬重启，只确认最新 target |
| G17 | env 复制后、真实 spawn 前再改 env | 识别新进程实际旧输入，不能仅凭 generation 增长放行 |
| G18 | 启动后真正新 env/插件输入变化 | 保留新的真实进程需求，不能为减少重启漏应用 |
| G19 | 同 PID 内部重启、旧 target receipt、旧需求回调 | 均不能错误满足/清除当前进程需求和应用证明 |
| G20 | 已知 IM/cron/桌面工作繁忙，普通配置重启逾期 | 保留排队，5 分钟不强杀；账号身份切换仍立即安全隔离 |
| G21 | 配置拒绝/限流/持续交付失败、连接单独失败 | 正确区分拒绝、pending、stall；无新无限重启循环 |
| G22 | GetStatus、OnProgress、操作返回交错到达 | 恢复中不闪 ready；失败可重试；内部真实状态不被展示投影污染 |
| G23 | 手动重启被账号切换取消，或最终仍为 ready | success=false/被取代；不会出现成功但网关停止 |
| G24 | 恢复中提交任务、失败后重试 | 复用原启动/失败弹窗；弹窗显隐不额外清空当前账号草稿，无重复派发、无 continue(temp-id)，准入恢复后新提交正常 |
| G25 | 远控关闭、可选同步/IM 服务不可达 | 本地账号恢复照常完成；不依赖远控在线或全部平台上线 |
| G26 | 四次瞬态自动重试耗尽、新转换/人工重试 | timer 有界且唯一，内层预算和累计启动次数不重置，冷却不绕过；新转换可恢复，旧 timer 不干预 |
| G27 | adapter 已持有旧初始化锁，同时恢复需连接 | 旧初始化失效、旧 finally 不清新锁；外部连接在取锁前等 complete，无自等待或提前业务事件 |
| G28 | 配置队列内 RPC 或硬重启与账号恢复同时发生 | 过期内部操作快速返回，无 config queue/recovery 互等，不隐式拉起未授权进程 |
| G29 | manager 内崩溃重试或 startup loop 捕获旧许可后切号 | 最终 spawn 前拒绝旧许可；新身份恢复也不使旧许可重新有效 |
| G30 | fence 已完成、认证企业上下文仍挂起，以及相反顺序 | 两者均成功且快照仍匹配前不恢复 credential gate；内部确认连接完成前不开放业务 |

测试落点包括 `remoteAccountTransition.test.ts`、`main.remoteStartup.test.ts`、认证生命周期测试、`openclawEngineManager.restart.test.ts`、`openclawConfigRecovery.test.ts` 和 adapter 测试。新增协调器纯逻辑测试之外，必须用真实 main 接线或受控依赖 harness 验证调用顺序、owner/配置内容、实际派发次数和迟到回调；不得只断言函数调用一次。

### 6.2 实机验收与性能

- Windows、macOS 的真实 Electron + pinned Gateway，分别覆盖普通登录、退出、自定义模型、个人/企业空间切换和有任务场景；Linux 涉及进程停止的路径至少补一次冒烟。
- 在隔离测试 profile 中验证有/无 WS、连续切号、维护/退出竞争、启动中模型更新；保留 PID/进程代次、阶段日志和实际模型请求归属证据，不修改真实用户数据做故障注入。
- 录屏验证账号操作开始后复用原 Gateway 启动弹窗，中间不闪黄色懒启动提示、不重复显示蓝色提示；恢复成功关闭弹窗，失败复用原错误与重试入口，当前账号草稿和有权历史不因弹窗显隐丢失。
- 记录 `authCommitted + fenceComplete → prepareStart` 调度延迟、stop/start/confirm/connect 各阶段耗时和进程次数。空闲本机前两项都满足后，恢复排队目标 ≤1s（待测），不能存在人为 3s 轮询等待；总耗时沿用现有进程/握手预算，不设无法保证的统一“秒开”承诺。
- 纯模型更新对照组不得多一次宿主硬重启；新环境输入确需重启的对照组必须最终匹配实际输入。

实施后执行客户端定向 Vitest、`npm run compile:electron`、涉及 renderer 时的构建/类型检查，以及改动 TypeScript 文件的 ESLint。默认不执行服务端测试。实际执行结果和未完成的实机验收见 §8。

## 7. 诊断、兼容性与发布

只在状态变化、完成或失败时记录 `[AccountGatewayRecovery]` 结构化事件：转换 ID、账号 epoch、认证 revision、阶段、有限原因、耗时、网关代次、重启需求 ID、启动次数和是否被取代。不记录 token、key、原始配置、正文或明文用户身份；轮询日志降为 debug，不逐轮增加高频 info。

兼容性要求：

- 服务端认证/API、错误码、MySQL 5.7 和数据库定义均不变，无迁移、无部署先后依赖；Portal、Admin、手机 App 无需同步升级。
- 保留认证 IPC、EnginePhase、fence v1 和现有持久 run 语义。新增可选展示字段须同步 main、preload/renderer 类型，缺省时仍能消费原状态。
- 普通 stop 继续取消在途启动/重启；普通 sync 在无进程时继续只保存配置。主动恢复由新的协调入口承担。
- 配置 generation、receipt、工作负载保护和 stall 保持原约束；不把重启作为所有配置问题的默认修复。

发布前需完成 G01–G30 与跨平台实机记录，重点检查账号恢复次数、启动后额外重启次数、任务中断终态及实际模型归属。按客户端正常发布渠道交付，不在未验收时将本文状态改为“已完成”。回退仅涉及客户端构建；没有新增存储格式，但仍需验证旧构建读取 fence/run 记录的原有兼容性，不删除记录或任务历史来回退。

## 8. 实施与验证记录

### 8.1 已实施（2026-10-20）

1. 新增 `src/main/libs/openclawAccountRecovery.ts`。单一 operation 持有隔离、认证提交、准备、启动、确认和释放状态；四次有限自动重试复用已成功的隔离/配置准备，人工重试与正在运行的自动重试合并。取消和后继账号操作使旧回调失效。
2. `main.ts` 的 Exchange、GetUser、退出及企业上下文刷新增加独立认证 revision；回滚使用新 revision。同账号 token 刷新无需硬重启；同账号重新登录的账号代次变化也会触发新恢复，避免已完成 operation 的旧许可阻塞今后启动。额度同步在企业上下文提交之后调度。
3. 账号监听同步关闭旧凭据与 adapter 连接，串行 fence 仅执行普通 stop、cron 隔离及持久标记；其外主动执行配置准备、启动、配置专用握手、应用证明和业务连接释放。停止态保持准备好的配置，外部显式需要网关时接续恢复。
4. manager 使用同步启动许可；启动循环及崩溃重试在异步边界和 spawn 前核验；保存真实子进程的配置、环境及输入 revision。保留普通 stop 的取消行为、既有启动熔断和配置冷却/stall。
5. adapter 增加 prepare/confirm/finish、初始化取消及 PID/代次核验；旧任务按既有本地停止、远程 reconciling 语义收尾，不重放未知派发。配置队列内部连接不等待完整恢复，不隐式启动。
6. 延期重启保留原需求 ID/代次/首次请求时间，按实际启动输入满足需求；3 秒轮询、磁盘旧差异及纯模型热更新不重复登记硬重启。
7. renderer 使用可选 `accountRecoveryPending`，按用户反馈复用原 Gateway 启动/失败弹窗；已移除首次实现的蓝色恢复提示。弹窗显隐不额外清空当前账号草稿，阻止提前提交。较早的 GetStatus 响应不能覆盖新的进度事件。手动重启不再把 `ready` 当作成功；旧账号修复失败不能改写新账号 manager 状态。

实现中的安全身份由 boot ID、owner epoch、auth account generation 和 owner hash 共同组成；认证 revision 独立控制写入完成与配置快照。运行取消由 operation 的 AbortController/cancel 状态及 manager lifecycle generation 实现，没有新增数据库或远程协议字段。

### 8.2 自动化验证

环境：macOS arm64、Node.js 24.17.0、Vitest 4.1.0；基于工作区代码，未提交或发布。

| 检查 | 结果与范围 |
| --- | --- |
| 合并定向 Vitest | **19 suites，638 passed、1 skipped**。跳过项是原有 Windows 专属测试；包含 manager、adapter、认证、配置交付/延期恢复、账号 fence、renderer 草稿准入与状态竞态 |
| 真实 main 接线 harness | `main.accountRecovery.test.ts` 7 项、`main.authRecovery.test.ts` 7 项、`main.configRestart.test.ts` 6 项、`main.remoteStartup.test.ts` 12 项；从实际 main AST/入口执行，外部 I/O 受控，不复制生产编排 |
| Electron TypeScript | `npm run compile:electron` 通过 |
| 变更文件 ESLint | 所有新增/修改 TypeScript、TSX 文件，零错误、零警告 |
| Renderer | `npm run build` 通过（TypeScript、renderer、Electron bundle 与缩略图构建）；构建输出依赖 eval、重复 sourcemap、Browserslist/CJS API 等非阻断警告，本次未扩改依赖 |

回归覆盖认证提交先/后于 stop、缺企业上下文/持久化失败回滚、退出清理、迟到 profile/context/配置回调、同账号重新登录、连续换号、停止态接续启动、启动许可撤销、同账号刷新时的已有启动/崩溃重试、连接初始化竞争、未知远程终态保留、稳定需求及真实输入确认、冷却/stall、人工重试和旧状态响应。上述自动化不能替代真实账号模型请求归属、整套 G01–G30 安装包矩阵与录屏验收。

合并命令为 `npm test -- --silent=true` 加本次 19 个测试文件；完整参数及输出保存在本机 `/tmp/lobsterai-gateway-recovery-spec/final-test.log`。ESLint 输出为同目录 `final-lint.log`。未执行服务端测试；服务端无代码/API/数据库变更。

### 8.3 macOS 实机冒烟与发布门槛

在 `/tmp/lobsterai-gateway-smoke-20261020` 隔离 appData/userData/home、独立网关端口，使用真实 Electron 和 OpenClaw 2026.8.1。保留原用户实例和 Vite，未使用真实登录凭据。

首次冒烟确认真实启动、config.get 应用证明、手动重启 IPC 和 15 秒稳定窗口；该次使用中间编译产物。最新编译产物（北京时间 14:47:36）的独立复跑同样通过：Gateway PID 23615 / generation 1 → 手动重启返回 success=true → PID 23748 / generation 2，随后 15 秒保持该 PID/代次。启动及重启后的配置确认分别耗时约 1245ms、461ms；这不是登录恢复的整体耗时。结果保存在 `result.latest.json` / `console.latest.log`。Electron 23595 和两个测试 Gateway 均已退出，18790 端口已释放；原开发实例未受影响。

仍待发布验收：真实个人/企业账号登录退出、自定义模型请求归属、任务中切号、UI 录屏、Windows 安装包和 Linux 停止路径。当前不把 G01–G30 或跨平台实机矩阵全部标记为完成；没有生产部署或数据库操作。

### 8.4 展示方式调整（2026-10-20）

用户要求复用原 Gateway 重启弹窗。本次仅调整 `EngineStartupOverlay`、`EngineFailureOverlay` 与 `CoworkView` 的展示分支，沿用原布局、等待动画、错误详情及重试入口；账号恢复协调器、取消/隔离、配置确认与任务准入保持现有实现。原 638 项回归和实机冒烟是前一轮证据；本轮展示变更验证结果单独记录，不重复声称执行完整矩阵。

本轮验证：4 个 renderer 定向测试文件共 **31 项通过**；`npx tsc --noEmit` 与 5 个修改组件/测试文件的零警告 ESLint 通过。覆盖原启动弹窗复用、等待动画不显示残留 100%、成功/失败后退出启动遮罩、失败弹窗重试入口以及任务准入/状态竞态。未重复执行 Gateway 实机或服务端测试。
