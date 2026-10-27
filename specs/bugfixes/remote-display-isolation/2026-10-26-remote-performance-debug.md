# 远控与设置窗口卡顿：本地诊断日志增量

日期：2026-10-26。状态：默认启用的诊断埋点已实现，定向回归与日志实际落盘验证通过；正式安装包及原故障机器验收待完成，未发布。

关联设计：[远程同步状态统计隔离与桌面响应性修复](2026-10-26-remote-display-isolation.md)。本增量只涉及桌面本地诊断；无服务端 HTTP/WS 协议、认证、DDL、手机或 Portal 源码变更。

## 1. 现有证据与目标

`lobsterai-logs-20261026-155345` 中主进程 event-loop 最大延迟约 40.16 秒，多类 IPC 与日志回调同时延后。设置按钮本身不等待远程 HTTP。既有日志能证明存在长延迟，不能凭总耗时区分异步等待、主线程同步执行、父进程暂停、GC 或操作系统调度，也不能把该次停顿归因到唯一函数。

新增日志把设置入口、主进程同步段、异步阶段、worker 生命周期和父进程监督延迟放入可对照的时间线。它是有界、尽力而为的诊断，不作为认证、任务准入、ACK、同步成功或 worker 已退出的业务证据。已有 `[RemoteDiagnostics]` 每 60 秒 event-loop 直方图继续保留。

## 2. 日志位置与导出

| 平台 | 默认目录 |
| --- | --- |
| Windows | `%APPDATA%\LobsterAI\logs\` |
| macOS | `~/Library/Logs/LobsterAI/` |
| Linux | `~/.config/LobsterAI/logs/` |

实际目录以当前构建的“打开日志文件夹”结果为准；日志 API 的 `getPath` 指向当前主日志。

- `main-YYYY-MM-DD.log`：已有 `[RemoteDiagnostics]` 及其他主进程日志。
- `remote.log`、`remote.old.log`：JSON Lines，包括新增 `[RemotePerformance]`、`[Renderer][SettingsDebug]` 和已有 `[RemoteSync]`、远控遥测。
- 设置 → 关于 → 导出日志：已有 `getRecentMainLogEntries()` 同时选择最近 7 天 mtime 范围内的 `main-*.log`、`remote.log`、`remote.old.log`；无需增加单独导出入口。

导出按当时文件大小读取快照，未显式等待远控日志队列排空；末尾尚未写盘的记录可能不在包内。条目读取失败会报告 `missingEntries`，轮转和保留窗口也可能让记录缺失。导出没有出现某事件，不能证明该事件没有发生。导出包仍含其他历史日志，新增埋点的字段白名单不意味着整个包都已脱敏。

主日志行时间为本机墙钟，`remote.log.timestamp` 是 ISO UTC；主日志日期文件名由 UTC 日期生成。跨文件分析先统一时区，不按文件名推断故障发生的本地日期。

代码入口：[logger.ts](../../../src/main/logger.ts)、[日志导出](../../../src/main/libs/logExport.ts)、[远控异步日志队列](../../../src/main/remote/remoteLogSink.ts)。

## 3. 设置入口：Renderer 与 main 消费时间对照

通过已有 `window.electron.log.fromRenderer('debug', 'SettingsDebug', JSON.stringify(fields))` 发出，无新增 IPC 或请求参数。主进程对这个固定 tag 单独校验并写入异步远控队列；有效、无效和限流消息均不进入已有 console/electron-log 同步文件入口，没有同步 fallback。固定字段如下：

| 事件/字段 | 含义 |
| --- | --- |
| `settings.open_requested` | `App.handleShowSettings` 的设置打开分支开始；不覆盖早退到独立远控页面的分支。它是处理函数开始时间，不是操作系统捕获鼠标按下时间。 |
| `settings.frame` | 设置显示对应的 `useEffect` 后执行到一次 `requestAnimationFrame` 回调。只证明获得一帧回调机会，不证明已真实绘制、可见或内部查询已完成。 |
| `sequence` | 当前 Renderer helper 生命周期内递增序号；重载后可重置，不能跨窗口、跨启动视作全局唯一 ID。 |
| `rendererDateNow` | Renderer 记录事件时的 `Date.now()` 毫秒。 |
| `mainReceivedDateNow` | 主进程接收此条消息时的完整 `Date.now()` 毫秒；保留 epoch 精度，不截成性能耗时上限。 |
| `durationMs` | 同一 Renderer 的 `performance.now()` 差值；打开事件为 0，frame 为从打开处理函数到该回调的经过时间。 |

`remote*.log` 的 `[Renderer][SettingsDebug]` 含主进程消费 `log:fromRenderer` 时记录的 `mainReceivedDateNow`。墙钟稳定时，`mainReceivedDateNow - rendererDateNow` 可提示消息传递/排队/主进程处理延后；时钟校准或日志落盘时间不能直接算成业务执行时间。两个事件的 `durationMs` 使用单调时钟，适合判断 Renderer 自身是否迟迟拿不到 frame 回调。

Renderer 单次打开最多 2 条，每 60 秒最多接纳 20 次打开（最多 40 条）；主进程另以单调时钟限制总共 40 条/60 秒，只解析最多 512 字符的 JSON，duration 限定 0–24 小时并保留两位小数。关闭、重开和 effect 清理取消未执行的 rAF，迟到回调和同一 token 的重复回调不再记录。日志、时钟或 rAF 失败均不影响设置窗口。未记录设置选项、名称、notice、tab 文本或业务内容。

主进程阶段的 `spanId` 与 Renderer `sequence` 没有一一映射协议。只能按时间窗口和阶段对照，不能把任意相邻主进程耗时归给某次点击。`Settings.tsx` 原有 auto-launch 的 `console.log` 不是本链路的替代品，不保证进入导出主日志。

实现：[Settings helper](../../../src/renderer/services/settingsOpenDiagnostics.ts)、[主进程异步接收器](../../../src/main/remote/remoteSettingsOpenLog.ts)、[App 入口与 effect](../../../src/renderer/App.tsx)。

## 4. 主进程阶段与字段

`remote.log` 中 `message` 为 `[RemotePerformance]`，`fields` 按白名单生成：

- 通用：`stage`、`event`、`pid`（记录来源进程）、`monotonicMs`；`spanId` 仅在相应 span/sync 记录中存在，同样不是跨启动全局 ID。
- 完成：`outcome` 为 `succeeded / failed / cancelled / unknown`，`reason` 为固定枚举；`syncMs` 是同步调用段经过时间，`elapsedMs` 是整个异步/生命周期阶段经过时间。
- Worker：`workerPid`、`exitCode`、`rssBytes`、`exitWaitMs`、`killToExitMs`；不得把来源 `pid` 误作 child PID。
- 队列/监督：`queueWaitMs`、`workerWaitMs`、`requestMs`、`transportMs`、`replyDeliveryMs`、`lastAliveAgeMs`、`checkIntervalMs`、`watchdogDelayMs`、`recoveryRemainingMs`、`activeCount`、`queuedCount`。
- 限流：`suppressed` 和 `globalSuppressed`；`summary` 另含 `count`、`syncCount`、`spanCount`、`failed`、`syncMaxMs`、`spanMaxMs`。计数可能同时包含一个业务阶段的同步调用与异步 span，不能相加当作业务请求量。

| 关注对象 | `stage` | 解释 |
| --- | --- | --- |
| 主线程回调延迟 | `main_loop` / `event_loop_lag` | 1 秒采样 tick 相对计划时间的延后；含有界 `active`、`recentSlow` 摘要。 |
| 设置本地读取 | `settings_state`、`remote_state`、`state_notify` | 本地状态及广播；本轮状态快照读取不应等待远程请求。 |
| 开机启动设置 | `auto_launch`、`settings_preference_read`、`auto_launch_native` | 分离整个 IPC 同步处理、偏好读取和 `app.getLoginItemSettings()` native 调用。 |
| 临时目录预览 | `settings_temp_preview`、`settings_temp_candidates` | 前者含异步目录扫描等待，后者圈定同步候选目录查询。总 preview 慢不等于主线程连续阻塞。 |
| 远控调度 | `remote_initialize`、`remote_configure`、`bridge_account`、`bridge_dispatch`、`remote_loop` | 初始化、配置和调度；具体子阶段以已发出的记录为准。 |
| 同步工作 | `registration`、`capabilities`、`write_settings`、`connect`、`command_recovery`、`command_claim`、`history_sync`、`history_prepare`、`availability_control`、`availability_live`、`availability_history`、`core_write` | 对照同步段与整体阶段，避免把网络等待或读库等待统称为服务器故障。 |
| 展示快照 | `display_snapshot`、`display_worker` | 上下文变更、过期、取消、统计 worker 生命周期。unknown 不代表同步完成。 |
| 其他子进程 | `network_worker`、`projection_worker`、`live_worker`、`import_worker`、`worker_retirement` | `spawn / ready / exit / watchdog / recovery_started / recovery_completed / span` 按实际生命周期存在，不要求每个 worker 都产生所有事件。 |
| 网络调度 | `network_queue`、`network_request` | 排队与发入 worker 后完成的阶段拆分；请求失败可结合已有 `[RemoteSync]` 的安全状态字段和 requestId。 |

`network_request.queueWaitMs` 是此前父进程队列等待，`workerWaitMs` 是派发至父进程收到 child `FetchStarted` 的时间，`requestMs` 从父进程收到开始通知算至父进程处理终态。它们包含 IPC/父进程调度影响，并非服务端纯处理耗时；这几个指标不应机械相加解释为服务端耗时。

新增的 `transportMs` 由 child 单调时钟计算，覆盖 fetch 开始到读体/JSON 校验结束；流式下载还包含消费 credit 等待，因此不是服务端纯处理时间。终态 IPC 可选携带该值与内部 `sentAtEpochMs`；父进程派生 `replyDeliveryMs`，表示发送终态到父进程处理之间的墙钟差，包含 IPC/序列化/调度影响，受系统校时影响。原始 `sentAtEpochMs` 不写日志。父进程只采纳有限、非负、不超过 24 小时的耗时；旧 worker 缺少字段或提供异常值时直接忽略，业务响应不变；尚未到达终态的超时/退出可能没有这些字段。对照 child 耗时与回包延迟可减少将主进程停顿误判成网络慢的风险，不能只凭一个差值判定原因。

网络 watchdog 每 1 秒检查，正常 alive 超时阈值 8 秒。父监督检查间隔超过 2 秒且 alive 已超时，可给当前 child 一次固定 8 秒恢复观察窗；仅当前 child 的真实 alive 重置，连续父延迟不会无限续窗。`reason=parent_delay` 说明父监督本身迟到，不证明 child 死亡；`parent_recovered` 说明重新处理到真实 alive。kill 请求成功也不等于退出确认，应结合退出/retirement 和相关耗时。

实现与最终字段白名单：[remotePerformanceLog.ts](../../../src/main/remote/remotePerformanceLog.ts)、[网络 Transport](../../../src/main/remote/remoteNetworkTransport.ts)、[HistoryJob](../../../src/main/remote/remoteHistoryJob.ts)。

## 5. 采样预算与不可证明的范围

- 同步段成功耗时达到 50ms、异步 span 成功耗时达到 1000ms 才单独记录；失败不受该耗时阈值约束，但仍受限流。异步包装的 `sync` 只涵盖初次调用返回 Promise 前的同步代码，不自动测出所有 `await` 之后的同步代码。
- 1 秒 tick 漂移达到 200ms 才记录 `event_loop_lag`；每 60 秒按 stage 汇总。每个 stage/event 每 10 秒最多一条，全部性能事件每 10 秒最多 64 条。最多跟踪 64 个 active span，lag 快照最多列 8 个 active 和 8 个 recentSlow；超额通过 `activeDropped` 表示，不无限保留。同步与异步各保留最近 8 项慢/失败记录，lag 优先列出最近 60 秒的同步记录，避免停顿后批量异步完成挤掉同步线索。
- 远控日志单行小于 4096 字节，否则替换为 `remote.log.truncated`。队列最多 1024 项，普通日志在 768 项限流；单次 pump 最多 16 条；最多两个各 10MiB 文件。写盘失败进入 30 秒退避并计丢弃，不回落到 console 或阻塞业务。
- 已有快速成功请求/开始日志仍按 requestId 做约 1% 确定性采样；慢成功（至少 1 秒）和批次成功另有保留规则，仍可能受队列容量影响。已有诊断还可能去重，不能按日志条数计算真实请求量。
- `[RemoteDiagnostics]` 的 60 秒直方图分辨率为 50ms，`eventLoopP99Ms` 与 `eventLoopMaxMs` 仍有价值。`null` 是没有有效采样，不能写成 0；正常 p99 也可能掩盖少数长停顿，应同时看 max。

长 `span` 只证明经过时间。长 `sync` 与同窗口 event-loop 延迟更支持被圈定同步段参与停顿，但仍可能包含 GC、进程暂停或调度停顿。`active` 只是 tick 恢复后观察到的未结束阶段，不是 CPU 栈。没有慢日志可能是阈值、限流、覆盖不足、写盘失败或进程未恢复，不能证明没有卡顿。

永久死锁、无限同步循环、进程被强杀时，同进程 tick 和结束日志可能永远无法执行。本日志不能保证定位这类故障，不能替代现场进程采样/CPU profile 或原故障机器的 Electron 实测，也不能承诺采集所有耗时。

## 6. 现场排查步骤

1. 记录版本、平台、点击本地时间与时区；保留同一次启动前后至少一个 60 秒诊断窗口。正常复现一次并导出，不连续点击制造额外负载。窗口无法响应时，直接取本地日志目录中相关文件。
2. 解压日志到仓库外目录，先找设置 sequence，再查同窗口的 loop 延迟、同步段、异步阶段及 worker 生命周期。主日志和 remote JSON 时间统一到同一时区。
3. 先辨别 Renderer frame 是否延迟、main 消费 Renderer 事件是否延迟；再查本机 `auto_launch_native`、`settings_temp_candidates`、`settings_state`，并对照远控/存储同步段。
4. 请求超时或 WS 异常另外查已有远控事件的 `requestId`、错误码/状态码。只有出现真实可用的 requestId 才跨服务端检索，性能 `spanId` 不代替请求 ID。网络 span 慢与 main loop 正常可以并存。
5. 若只看到大 lag 而没有对应同步段，记录为“未归因”，保留进程采样作为后续证据；不据此删身份、重建数据库、重复提交任务或判定服务端失败。

示例命令（将路径替换为本次解压目录；只读，不上传）：

```bash
LOG_DIR='/tmp/lobsterai-debug-logs'
rg -n '\[RemoteDiagnostics\]' "$LOG_DIR" -g 'main-*.log'
rg -n '\[Renderer\]\[SettingsDebug\]|settings\.open_requested|settings\.frame' "$LOG_DIR" -g 'remote*.log'
rg -n '\[RemotePerformance\]|remote\.log\.(dropped|truncated)' "$LOG_DIR" -g 'remote*.log'
rg -n '"stage":"(main_loop|auto_launch_native|settings_temp_candidates|settings_temp_preview|settings_state|core_write)"' "$LOG_DIR" -g 'remote*.log'
rg -n '"stage":"(network_worker|network_queue|network_request|worker_retirement|display_worker|projection_worker|live_worker|import_worker)"' "$LOG_DIR" -g 'remote*.log'
rg -n '"event":"(event_loop_lag|summary|watchdog|recovery_started|recovery_completed|exit)"|parent_delay|parent_recovered|"suppressed":' "$LOG_DIR" -g 'remote*.log'
rg -n 'Request failed|remote\.request\.completed|httpStatus|requestId' "$LOG_DIR" -g 'remote*.log'
```

诊断报告至少列出：版本/时区、点击 sequence、Renderer 单调 elapsed、main 消费时间差、loop p99/max、相关 sync/span、worker PID/退出证据、丢弃/限流情况，并分开写“日志事实”“可能解释”“尚需采样”。不要粘贴整包或任何凭据/业务内容。

## 7. 隐私与业务不变项

新增性能日志仅允许固定枚举、数值和布尔字段；不接收 URL、SQL、目录、账号、设备名称、原始异常堆栈、请求/响应正文、token、密钥、会话消息或提示词。Renderer 两条事件仅固定时序字段。日志出错不得改变原返回值、原异常、取消语义、worker 退出确认或限额。

日志中的成功是相应技术阶段完成，不是远控数据已经同步、安全恢复成功或执行权限已满足。账号/环境切换、未知快照和不可恢复身份继续由原业务安全条件决定，不能从显示数据或日志回填授权。

## 8. 验证记录与待验收

已执行（Node v24.17.0；PATH 指向 `/Users/admin/.nvm/versions/node/v24.17.0/bin`）：

```bash
npm test -- src/main/remote/remotePerformanceLog.test.ts src/main/remote/remotePerformanceLog.integration.test.ts src/main/remote/remoteNetworkTransport.test.ts src/main/remote/remoteNetworkWorker.test.ts src/main/remote/remoteHistoryJob.test.ts src/main/remote/remoteBridge.test.ts src/main/remote/remoteAvailabilityPublisher.test.ts src/main/remote/remoteStore.test.ts src/main/remote/remoteDisplaySnapshot.test.ts src/main/remote/remoteDiagnostics.test.ts src/main/remote/remoteLogSink.test.ts src/main/remote/remoteSyncLog.test.ts src/main/remote/remoteSettingsController.test.ts src/renderer/services/settingsOpenDiagnostics.test.ts
npm test -- src/main/remote/remoteDisplayResponsiveness.test.ts --maxWorkers=1 --no-file-parallelism
npm test -- src/main/remote/remoteSettingsOpenLog.test.ts --maxWorkers=1 --no-file-parallelism
npm run compile:electron
npx tsc --noEmit -p tsconfig.json
```

联合回归 **14 文件、359 项通过**；真实子进程故障与响应性另 **5 项通过**；设置日志异步接收器另 **4 项通过**，本轮合计 **368 项**。最终 Electron 编译及前端 TypeScript 检查通过。严格 ESLint（`--report-unused-disable-directives --max-warnings 0`）先检查 35 个已变更 TypeScript 文件，再检查新增接收器、测试与更新后的 main.ts，均零警告；`git diff --check` 通过。

验证覆盖：原返回值/异常、日志失败隔离、单调时钟与限流、active/recent 有界、stop 后旧 span 失效、设置 rAF 取消与重复回调、真实 worker timing、旧/异常 timing 兼容、12ms child 请求与 29s 父进程处理延迟的区分，以及 timeout/取消后等待 child 退出再释放槽位。真实文件集成测试使用 `RemoteLogQueue → createRemoteFileWriter → remote.log`，确认 sync/span/lag 不被请求采样吞掉，最大摘要 payload 小于 3500 字节、日志行小于 4096 字节且不被截断，原始 URL/body/token 等不落盘。临时目录清理，不使用用户 profile 或外部服务。

设置日志接收器另验证字段白名单、完整 epoch、无效固定 tag 不 fallback、主进程限流及队列/时钟异常吞掉；已有其他 Renderer 日志入口保持原行为，不能据此声称整个应用已无同步日志写入。

日志导出入口及远控日志收集路径已静态复核；实际落盘测试不等于 Electron ZIP 导出或设置点击实机验收。本轮未修改服务端、外部接口或数据库，也未执行服务端测试。早前隔离修复发现的两项既有环境/打包失败见关联 spec；本轮没有修改或放宽它们的断言。

现场/发布待验收：正式 Windows/macOS 安装包、原故障 profile 的设置点击；主进程慢同步段、异步网络等待、child 慢/退出、父监督暂停与磁盘写日志失败场景；核对导出含两个远控日志及允许字段，确认无新增业务失败和无限日志增长。跨进程 Node 测试不能替代 Electron 实机 Settings 验收，未执行的项目不得标为通过。

19:30 现场采样后的进一步修复：[远控 live 扫描调度自激与 Statement 分配修复](2026-10-26-remote-live-scheduler-bounds.md)。该增量覆盖此前展示统计/网络隔离之外的本地扫描调度链。
