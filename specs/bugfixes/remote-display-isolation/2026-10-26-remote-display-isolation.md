# 远程同步状态统计隔离与桌面响应性修复

日期：2026-10-26。状态：代码已实现，本地定向回归及真实子进程故障验证通过；未发布，原故障机器与正式安装包验收待完成。

## 问题与范围

`lobsterai-logs-20261026-155345` 的主进程 event-loop 最大延迟约 40.16 秒，多类 IPC/日志回调同时延后。设置按钮自身没有等待远程 HTTP，但远程状态广播、诊断和设置查询共用 Electron 主进程；原 `RemoteBridge.state()` 会同步执行跨库统计、逐会话查询及历史请求解析/哈希。异步网络不等于同步统计也被隔离。

日志没有 CPU profile，不能认定这些统计是该次 40 秒停顿的唯一原因。本轮修复可由代码证明的阻塞路径，以及 V4 白名单缺口和父进程停顿后的 worker 误判风险。对应跨端设计：`lobsterai-server/docs/specs/mobile-remote-control/bugfix-2026-10-26-desktop-responsiveness-isolation.md`。

## 实现约束

1. `RemoteBridge.state()`、其设置广播与诊断读取只组合内存数据，不访问数据库、不启动 worker、不等待网络。账号展示使用提交事件更新的 `getDisplayOwner`；业务授权继续使用原 `getOwner` 和原始证据。保活偏好、初始化失败时的设置意图也由内存视图提供。
2. `remoteDisplayHealthWorker` 在独立子进程内只读打开核心库、control/history sidecar，启用 `query_only`，核对 sidecar 身份；不实例化会建表或迁移的 Store，不写 ACK、版本、journal，不联网。
3. `RemoteDisplaySnapshot` 同时只允许一个采样任务，每 5 秒刷新，结果保存最多 15 秒。同一上下文合并读取；过期、失败和未完成时计数为 null，不伪装为 idle/synced。UI 使用“同步状态暂不可用”。配置持久化成功后立即更新本机显示，统计稍后补齐。
4. 上下文包含账号/范围、API 路由、account generation、sync target、device、远程环境及安全状态。切换或关闭时立即清缓存，异步取消旧任务；迟到结果不可覆盖新上下文。取消后必须等旧 child 确认退出才释放槽位。
5. 硬超时 5 秒，合作预算 4.5 秒，SQLite busy 50 毫秒，IPC 结果 64KiB，JS old heap 96MiB。old heap 不是 native RSS 硬上限。大范围、坏记录、身份不一致、缺失权威表返回未知；任务 issue 最多 20 项，超出计数预算明确 truncated。
6. 进行中的 control 请求和失败退避由已有有界内存集合覆盖快照，防止只读统计漏掉瞬态故障而显示空闲。文件健康本来就是内存值，继续直接读取。
7. 网络 watchdog 使用单调时钟。父监督循环延迟后给当前 child 一次固定 8 秒观察窗；只有该 child 的实际 alive 才重置，不伪造心跳、不无限延期。真实退出及重启预算保留。
8. 网络 worker 仅新增 HTTPS GET `/api/remote/v4/devices/{id}/commands/unresolved` 的精确白名单。V1–3、大小/方法/重定向约束和 Bridge capability 回退保持原语义。

## 兼容与安全

无服务端 HTTP/WS、错误码、认证或 MySQL 变更；兼容 MySQL 5.7，无服务端升级顺序要求。手机 App、Portal、Admin 无需改动。`RemoteSyncHealth.statisticsUnavailable` 是桌面本地 IPC 的可选展示字段，缺省仍沿用旧行为。

历史原身份恢复策略不变；不换密钥、不清数据、不转移任务权限。统计结果不参与执行、审批、任务准入、ACK 或重试授权。为避免只读 worker 建表，任务展示与 admission 的纯读取算法提取共享，原业务入口仍重查当前权威数据。

本轮没有把完整 RemoteBridge/controller 迁出主进程。最小持久事实及其他业务调度仍沿用原实现，不能据此承诺任意磁盘或所有同步业务路径均无阻塞；剩余现场长停顿需 CPU/同步栈证据定位。

## 验证与交付状态

验证使用 Node v24.17.0。真实子进程 CPU 忙、5 秒无限循环终止、超大回复、退出、SQLite 独占锁等场景中，父进程持续响应 loopback HTTP 和 timer；超时任务在 PID 消失后才释放槽位。独占锁释放后统计恢复，测试库摘要不变。实测与完整命令记录在共享 spec §10。

定向回归覆盖内存状态、配置即时保存、账号/环境切换、原身份失败、授权拒绝、历史 ACK、V1–4 路由、父 watchdog 停顿与实际 worker 打包路径。最终联合回归 12 文件、340 项通过；真实子进程故障测试另 5 项通过。`npm run compile:electron`、`npx tsc --noEmit -p tsconfig.json`、26 个变更 TypeScript 文件严格 ESLint（零警告）和 `git diff --check` 通过。

额外环境回归 43 通过/1 既有失败，打包回归 8 通过/1 既有失败：分别为 `remoteBridge.environment.test.ts:390` 的 deferred admission 断言，以及原 projection→immutable import 的 `REMOTE_IMPORT_CONTEXT_CHANGED`。两者在独立 `/tmp` 导出的未修改 HEAD `251de843dbcf9a03d9819ca4847dce65bdc8fcb4` 源码和相同 node_modules 上复现，不是本轮引入；未修改或放宽这些断言。新增统计 worker 的真实 Vite/asar 用例通过。

未执行服务端测试；无服务端代码变更。未构建或发布 Windows/macOS 安装包，未在原故障 profile 上操作设置窗口。Node 子进程隔离测试不能替代 Electron 点击延迟、持续真实任务、大量历史会话和正式安装包验收。

后续诊断增量：[远控与设置窗口卡顿：本地诊断日志](2026-10-26-remote-performance-debug.md)，记录默认 debug 埋点、异步落盘、网络/主线程耗时区分及复现排查步骤。

19:30 现场采样后的进一步修复：[远控 live 扫描调度自激与 Statement 分配修复](2026-10-26-remote-live-scheduler-bounds.md)。该增量覆盖此前展示统计/网络隔离之外的本地扫描调度链。
