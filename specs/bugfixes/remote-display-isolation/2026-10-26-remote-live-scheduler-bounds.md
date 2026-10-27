# 远控 live 扫描调度自激与 Statement 分配修复

日期：2026-10-26。状态：代码已实现，定向回归、真实计时器 smoke、Electron 编译与严格 lint 通过；未提交/发布，原故障 profile 与双平台安装包验收待完成。基线提交 `5eeeea9f13e964561b2bd3da65bde92f6381cacc`。

关联：[展示统计隔离](2026-10-26-remote-display-isolation.md)、[性能诊断日志](2026-10-26-remote-performance-debug.md)。本次只改桌面实现；服务端同步维护事故与约束说明，无 HTTP/WS、认证、手机源码、Portal/Admin 或 MySQL DDL 变更。

## 1. 现场证据与根因边界

19:21:56 启动的主机客户端已包含诊断日志。19:25:55、19:26:21 主循环延迟分别约 6.6s、25.1s。19:30 与 19:31 两次原生 sample 显示主线程持续在 `DrainFinalizerQueue → Statement::~Statement → sqlite3_finalize` 路径，已加载 better-sqlite3 13.0.3；渲染线程主要等待事件。系统报告主进程 footprint 14.3G、换出 13.7G；vmmap 对 Electron PartitionAlloc 分析不完整，不能把全部内存归给某条 SQL。

本机当前 scope 有 1 个 active 会话，16 个 accepted/complete 对象均与本地 revision 相同，displayVersion=1，没有未完成请求。这是无需编码或 HTTP await 的同步快路径。测试/线上日志观察到的 batch/live 分支不同，但缺少测试服当时完整 capabilities/ledger 快照，不能认定某个环境开关关闭；同条件下测试服同样可能触发。

确定的因果链：

1. Publisher 定时器回调清空 `timer` 后进入 tick，同步调用 live。
2. 每个 message 都调用 `ensureDesktopInputJobs`；即使无输入任务变化也进入 `RemoteStore.transaction`。
3. 桌面 `deferredProjection=true`，事务完成会 wake；经 Bridge 转发后创建 200ms timer。
4. tick 尾部再创建 1000ms timer，覆盖句柄但不取消前一个；多条扫描链继续放大。
5. 重复 prepare、无变化写入放大 native Statement 分配/回收，使主循环和 IPC 延迟。

隔离复现用真实 Publisher/live、SQLite/RemoteStore，只替代无关 lane 与已有回执查询；一个 idle 会话、一条 assistant 消息、0 HTTP，虚拟 2.4s 产生 44 tick、45 timers、836 次 prepare。stop 当下仅取消一个 timer；其余回调看到 stopped 后退出。正式回归必须接回真实 wake，不能复用旧测试的 `setWake(() => {})` 盲点。

现场快照与原始复现保存在仓库外 `/tmp/lobsterai-hang-20261026-1929/`，不提交业务日志或凭据。旧逻辑在提交 `251de843` 已存在；诊断日志帮助定位，不应把 span 编号误作 SQL 次数。

## 2. 调度约束

- Publisher 全生命周期最多持有一个周期 timer。200ms 初次/外部唤醒与 1000ms 周期调度走同一入口。
- tick 在调用可能同步触发 wake 的 lane 之前预约下一周期；同轮 wake 合并到已有 timer，不创建第二条链。
- 回调核对自身句柄和生命周期代次，不能清空后来建立的 timer。stop 清理可追踪 timer，重启不恢复旧回调。
- control/live/history 保持各自至多一个在途工作。新调度不能用清空在途标记冒充旧工作已经结束。
- live 每处理 8 个对象或经过 8ms 后通过一个 awaited setImmediate 让出事件循环，session 开始也检查时间预算；这不是单次 SQLite 调用的硬超时。每个 session 开始、当前 session 的 yield 恢复后重新验证 binding、owner、admission、同步关闭/删除标记，恢复后另核对 active/writer/control epoch，避免后续 session 使用让出前的旧候选页。
- send 与 resolveLive 在网络等待前后和持久化前校验生命周期代次；lookup 在 stop/切环境期间返回 404，不得继续旧 POST。同 scope stop/start 也不能接收旧周期的迟到回执；原封存 request/resolutionId 保留给新周期核对。
- 保留原有 sent/encoded 限额、回执核对、幂等 publicationId、失败退避及轮转扫描。协作让出不删除候选、不把待处理状态写成成功，也不无限排队。

## 3. 空事务与分配控制

`ensureDesktopInputJobs` 增加只读预检查：不可能产生输入任务的消息、材料不完整或已有回执直接结束，不建立写事务，不 wake。真正需要补建时进入原 trusted transaction，完整重查 ownership、admission、删除保护、run/附件与回执，再按原规则写入。无候选直接返回 null，不再执行无关权限检查或写事务；真正候选的坏材料/撤权仍失败且不写入。预检查不产生授权，不缓存许可；已有 receipt 按物理行存在保护（包括 JSON null/未知材料），坏 JSON 不触发替换或部分补建，不分配新身份。

不修改 RemoteStore 的全局事务唤醒规则。它被核心本地写入、其他投影与恢复依赖，本次只去掉已确认的无变化调用源。

recentLiveCandidates 与相关输入/健康辅助查询使用每数据库连接固定大小的 prepared statements 集合：live candidates 固定 6 条，输入辅助固定 4 条，健康辅助最多 7 条（含 schema 与表存在性检查、惰性读语句）。不使用按账号、会话或任意 SQL 增长的全局缓存。只缓存执行计划，不缓存 ownership、消息、ACK 或其他业务结果。连接关闭/替换按 SQLite 生命周期处理，schema 变化不能继续使用无效的派生状态。

同值 tool membership 与健康 ACK 不重复写入。健康记录每次读取现行数据库事实，保留同 revision 的 representation 修正、旧 revision 不覆盖新值和外部更新可见性；表重建/缺失行为有回归约束。不得通过删原数据、重置身份、降低鉴权、跳过 ACK 来减少工作。

## 4. 兼容、范围与性能边界

默认启用修复，无新增服务端功能开关。旧服务端、旧协议和现有客户端持久材料继续兼容；无服务端部署顺序或 MySQL 5.7 升级要求。手机 App 不需要改接口或接入方式，因此不生成无实际接口变化的接入文档。

现有 RemotePerformance/SettingsDebug 的异步、有界、白名单日志继续可用。观察 availability_live、core_write、main_loop 与网络 worker 的独立耗时，不能以没有日志证明没有停顿。

本修复阻断已复现的调度放大和无效分配，协作让出不是抢占执行。单次 SQLite/native 调用、文件系统挂起或 GC 仍不能在主进程内强行中断；本次不承诺整个 RemoteBridge 已迁出主进程，也不能用单次单测证明原故障 profile 或所有平台均通过。

## 5. 验证计划与实施记录

必须覆盖：

| 场景 | 通过条件 |
| --- | --- |
| 真实 Store+wake、单会话已 ACK、零网络、持续空闲 | tick 数与周期相符，timer 始终≤1，stop 后为0，prepare/写入不随重复消息检查放大 |
| lane 同步强制 wake | 即使不依赖空事务优化，仍不能制造第二个timer |
| 新消息/真实附件变化 | 正常补建、提交后唤醒、原回执/版本不丢失，重复调用幂等 |
| 网络/编码在途 | live 不重入，其他 lane 与本地回调可继续 |
| yield/stop/restart/切账号环境 | 旧代次不继续发布、不覆盖新 timer、不提前释放旧在途工作 |
| 权限撤回、删除、坏材料、已有 receipt | 原授权拒绝和身份保护保持；预检查无法授予执行权限 |
| 外部 ACK 更新、schema 改变、独立连接 | 查询结果新鲜，缓存数量固定，关闭库不被复用 |

执行 Node v24.17.0 定向 Vitest、Electron 编译、变更文件严格 ESLint 和 diff 检查。服务端只有文档变更，按约定不执行服务端测试，不访问共享 MySQL/Redis。正式 Windows/macOS 包及原 profile 设置点击、持续内存曲线需在发布验证中记录，不伪造已通过状态。

### 5.1 实际变更

- `remoteAvailabilityPublisher.ts`：单 timer、回调 handle/epoch、防旧网络回包、live 单路协作让出及恢复后资格复核。
- `remoteDesktopInputJobs.ts`：只读筛选和事务内完整复核；全局 RemoteStore.transaction 的原约定保持。
- `remoteLiveCandidates.ts`、`remoteAvailabilityHealth.ts`：固定语句复用、同值写入消除、外部状态/schema 可见。
- 新增 4 个回归文件：`remoteAvailabilityPublisher.scheduling.test.ts`、`.yield.test.ts`、`.lifecycle.test.ts`、`remoteHotPathStorage.test.ts`，合计 **49 项新增测试**。

### 5.2 定向与静态验证

Node v24.17.0 / Vitest 4.1.0，2026-10-26：最终联合 **12 文件、391 项全部通过**（5.28s）。覆盖下列全部真实 Store/SQLite、输入、文件同步、核心隔离、事务与 Bridge 兼容场景。

```bash
export PATH=/Users/admin/.nvm/versions/node/v24.17.0/bin:$PATH
npm test -- src/main/remote/remoteAvailabilityPublisher.test.ts src/main/remote/remoteAvailabilityPublisher.scheduling.test.ts src/main/remote/remoteAvailabilityPublisher.yield.test.ts src/main/remote/remoteAvailabilityPublisher.lifecycle.test.ts src/main/remote/remoteHotPathStorage.test.ts src/main/remote/remoteInputProjection.test.ts src/main/remote/remoteFileSync.inputs.test.ts src/main/remote/remoteDeliveredFileSync.test.ts src/main/remote/remoteCoreIsolation.test.ts src/main/remote/remoteTransactionSafety.test.ts src/main/remote/remoteBridge.test.ts src/main/remote/remoteDisplayHealth.test.ts
npm test -- src/main/remote/remoteLiveProjectionJob.test.ts --maxWorkers=1 --no-file-parallelism
npm run compile:electron
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/remote/remoteAvailabilityPublisher.ts src/main/remote/remoteAvailabilityPublisher.scheduling.test.ts src/main/remote/remoteAvailabilityPublisher.yield.test.ts src/main/remote/remoteAvailabilityPublisher.lifecycle.test.ts src/main/remote/remoteDesktopInputJobs.ts src/main/remote/remoteLiveCandidates.ts src/main/remote/remoteAvailabilityHealth.ts src/main/remote/remoteHotPathStorage.test.ts
git diff --check
```

真实 child lifecycle 另 **3/3** 通过；最终 Electron 编译、全部 8 个变更 TypeScript 文件严格 lint 零警告、diff 检查通过。Renderer 未变更，不重复运行无关 UI 测试。服务端未运行测试。

关键定量回归：

| 场景 | 修复前/后证据 |
| --- | --- |
| 强制同步事务 wake，2.4s 假时钟 | 旧代码失败：44 tick；修复后3 tick、1个周期timer、stop后0，不依赖输入预筛优化 |
| 真实Store/ACK、空闲60s | 60 tick、1个周期timer、0 HTTP；stop后0、重复start/重启均不多出调度链 |
| 非user/无输入候选 | 预热后1000轮（每轮多个候选）0新增prepare/写入/transaction/wake |
| 已有真实附件receipt | 100次重复检查0写入/transaction/wake，原上传身份字节不变 |
| 70条消息的64窗口 | 固定6次prepare后100轮0新增prepare/写入，外部消息变化仍可见 |
| 相同健康ACK及统计 | 1000轮0新增prepare/CREATE/写入，revision/representation与外部DDL/回滚仍按当前事实处理 |
| yield/网络在途 | 不重入，已封存请求与ACK保留；8对象/时间预算可让出；撤回、删除、重绑、后续session与同scope重启不沿用旧许可 |

上述 prepare 数量仅针对被明确测量的模块/fixture，不代表整个应用所有 SQL 已缓存。fake clock 不等于实际 CPU 延迟或长期 RSS 证明。

### 5.3 真实事件循环补充测量

仓库外 `/tmp/lobsterai-live-smoke-20261026/` 保存脚本、配置、原始 result.json 与 run.log。使用真实 Node timer、内存 SQLite、16个已ACK对象和真实三个lane，3300ms内 **4 tick / 0 HTTP**；283次10ms定时器中的本地SQL读写回调，执行耗时P95 **0.295ms**、P99 **0.343ms**、max **0.391ms**；timer漂移P95 **2.394ms**、P99 **6.519ms**、max **8.225ms**。停止后50ms观察无新增tick。core+ledger共551次prepare计数包含fixture准备工作。

Node RSS起始101,842,944、观测峰值103,596,032、结束89,063,424 bytes；没有强制GC。该3.3s单次测量不是内存泄漏排除、对照性能增益、生产SLA或Electron UI实测；只补充“真实时间下本地回调可继续”的证据。

```bash
node node_modules/vitest/vitest.mjs run --config /tmp/lobsterai-live-smoke-20261026/vitest.config.mjs --maxWorkers=1 --no-file-parallelism
```

### 5.4 既有失败与交付边界

扩大回归时 `remoteBridge.polling.test.ts:247` 的 `backs off failed command reconciliation without blocking reply synchronization` 失败：claim次数预期1、实际2。使用 `git archive HEAD` 导出的未修改基线 `5eeeea9f13e964561b2bd3da65bde92f6381cacc`，同一Node24/node_modules、单worker筛选该用例，得到相同失败；未改或放宽断言。首次并行回归的 `remoteLiveProjectionJob.test.ts` 100ms child成功预算用例亦超时；原断言不变，当前独立串行3/3与基线筛选该用例均通过，记录为并发负载下时序失败，不宣称已修复其稳定性。

```bash
node node_modules/vitest/vitest.mjs run src/main/remote/remoteBridge.polling.test.ts src/main/remote/remoteLiveProjectionJob.test.ts --maxWorkers=1 --no-file-parallelism -t 'backs off failed command reconciliation|kills a hung child on budget'
```

本轮实现和验证已完成，尚未提交、构建/发布正式安装包，未重启原故障进程或修改其业务库。原profile运行新构建后的设置点击、长时间RSS曲线以及Windows/macOS安装包验证仍待完成。先前spec记录的其他既有环境/打包失败仍按原记录，不混同本轮通过结果。
