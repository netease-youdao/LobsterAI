# 网关陈旧锁与残留进程恢复设计文档

## 1. 概述

### 1.1 问题

9 月 16 日反馈表第 3 行在启动和一键修复时持续报 SQLite maintenance/state ownership 错误，升级 9.14 → 9.15 后仍报告 PID 26040 存活。日志没有这个 PID 的进程创建时间、命令行或原始锁文件，不能确定现场存在活跃的旧网关。

本机使用与现场 SHA-256 一致的两个正式安装包，观察到真实迁移 helper 被终止后留下两个缺少 startTime 的文件锁；模拟 PID 被无关进程复用后，复现相同错误和跨版本持续失败。PID 复用通过修改测试锁字段模拟，未执行实际覆盖安装，不能据此证明现场 26040 的来源。

### 1.2 根因

LobsterAI 旧清理逻辑主要检查 PID 是否存在；OpenClaw 的 Windows 身份查询只有 1 秒，本机捕获了查询超时和 WMIC 不存在。身份不明导致陈旧锁被持续保留。一键修复的 Snapshot 本身需要维护锁，因此原流程不能解除该阻断。

## 2. 用户场景

- 首次启动失败后主动执行一键修复：诊断并恢复陈旧锁，再执行已有的备份、Doctor、状态恢复、配置同步、插件恢复和网关启动。
- 锁指向无关进程：回收确认陈旧的锁，保留该进程。
- 确认属于本数据目录的孤儿网关或迁移进程：有可靠创建身份、父进程已退出、经过保护窗口且网关不健康时，才允许终止。
- 另一实例正在运行、维护进程仍有父进程、身份不可确认：保留所有者和锁，返回诊断；不能通过删除 SQLite 协调文件绕过排他保护。

## 3. 功能需求

1. 仅在用户主动一键修复的维护屏障内增加锁恢复阶段，放在 Snapshot 前；正常启动不运行完整修复。
2. PID 存活不代表仍为原锁所有者。核验创建时间、程序路径、启动入口、锁的 state/config 归属及父进程身份。
3. 异步 Windows 查询具有明确超时；unknown 不当作 dead，不提供任意 PID 强杀入口。
4. 终止必须核验创建时间并通过同一个 Windows 进程句柄终止和等待，防止检查后 PID 复用。
5. 陈旧锁回收沿用固定 OpenClaw 版本的生命周期协调、每个文件锁的 SQLite 协调和 remove-if-unchanged 检查。
6. 保存锁原文、判断依据和结果；数据库快照只在排他状态建立后由既有流程执行。
7. `runStartupMigration` 启动的 state/compatibility 子进程退出可追踪，停止网关时取消本次启动的这些迁移并等待关闭。

## 4. 实现方案

LobsterAI 独立模块负责 Windows 身份查询、受限的进程终止和修复策略；main.ts 仅增加调用。修复 helper 复用原生 acquireGatewayLock，通过版本限定的小补丁提供异步 owner 判断入口，保留默认调用者的锁策略。补丁同时改善 Windows 创建时间读取；不直接修改交付的 vendor 产物。

一键修复：任务占用检查 → 停止本应用网关和启动迁移 → 创建诊断目录 → 所有者诊断/必要时停止孤儿 → 原生锁取得与释放 → 原 Snapshot → Doctor → Recovery → 原配置同步 → Plugins → 网关启动与健康确认。

### 4.1 所有者判断和终止

- Windows 使用异步 PowerShell 查询，单次 15 秒，unknown 最多再查询一次。通过原生进程句柄读取可执行文件和创建时间，CIM 补充参数、父 PID，并交叉验证创建时间。
- 创建时间不匹配视为 PID 复用。旧锁缺少 startTime 时，仅在新进程创建于锁之后（保留 2 秒时钟容差），或能够明确排除其为 OpenClaw 运行时，才判定陈旧。
- 停止孤儿要求：入口与当前打包运行时完全匹配、可执行文件匹配、锁的 state/config 路径匹配、startTime 匹配、父进程已退出或被复用、锁至少存在 30 秒；网关还要求已知端口且两次健康探测失败。缺少任意必要证据均不停止。
- 停止前重读锁和进程身份。终止工具重新打开目标句柄，核验完整 FILETIME 创建身份与可执行文件，再在同一个句柄上终止、等待退出。没有 PID-only 的强杀接口。
- 正常受管网关仍沿用原来的优雅退出流程；无法管理的、满足以上全部条件的孤儿使用受限终止。SQLite 协调文件不手工删除。
- 诊断保存锁原文、进程元信息、决策和终止结果，不保存可能包含凭据的进程 argv。

### 4.2 OpenClaw 补丁和构建

补丁为 `scripts/patches/v2026.8.1/zz-openclaw-lock-owner-recovery.patch`。在原生锁管理中增加可选异步 `inspectOwner`，仅一键修复 helper 使用；实际回收仍发生在原生协调器及 remove-if-unchanged 保护内。其他调用者保留默认所有者策略。

补丁还将 Windows 创建时间查询从 CIM 改为 `.NET Process.StartTime`，网关锁调用预算由 1 秒调整为 5 秒；失败仍返回未知身份，不能保证任何负载下都可获得 startTime。构建脚本检查补丁已接入，否则拒绝生成 helper。

### 4.3 涉及文件

| 文件 | 改动 |
| --- | --- |
| `src/main/libs/openclawWindowsProcess.ts` | Windows 身份查询及按句柄核验终止 |
| `src/main/libs/openclawLockRecovery.ts` | 手动修复策略、原生锁接入、诊断记录 |
| `src/main/libs/openclawGatewayLock.ts` | 保留并校验锁内创建身份、归属、角色和端口 |
| `src/main/libs/openclawStartupStateMigration.ts` | 跟踪本进程启动的 state/compatibility helper，取消后等待 close，补充 PID/退出日志 |
| `src/main/libs/openclawEngineManager.ts` | 停止网关时调用上述受管 helper 取消接口 |
| `src/main/main.ts` | 在既有手动修复 Snapshot 前增加 LockRecovery 阶段 |
| `scripts/openclaw-gateway-repair.mjs`、`scripts/bundle-openclaw-startup-migration.cjs` | 打包和派发新阶段；保留原 Snapshot/Recovery/Plugins 实现 |
| `scripts/patches/v2026.8.1/README.md`、`src/main/libs/openclawPatches/v20260801UpgradeDecisions.test.ts` | 补丁说明、保留清单与升级决策检查 |
| `src/shared/openclawEngine/repair.ts`、renderer repair/i18n | 新阶段常量及中英文错误映射 |
| 相邻 `.test.ts`、`tests/openclawLockRecovery.runtime.test.ts`、`tests/helpers/openclawLockOwner.fixture.mjs` | 决策、取消、真实 Windows 原生租约与既有修复链路回归 |

## 5. 边界情况

| 情况 | 策略 |
| --- | --- |
| PID 已退出或可靠创建身份不匹配 | 原生排他保护下回收陈旧锁 |
| 无关存活进程 | 只有可靠身份足以排除 OpenClaw 所有者时回收锁，绝不终止 |
| 锁缺少 startTime | 可判断退出、明显无关或创建于锁之后；不得仅凭 PID 终止 |
| 同安装目录的其他健康实例 | 保护活跃父进程与健康网关 |
| 查询失败或权限不足 | 记录 unknown，拒绝扩大清理范围 |
| 锁被并发替换 | 重新判断新的完整身份，由原生 remove-if-unchanged 防止误删 |
| SQLite 协调仍有真实持有者 | 拒绝进入备份与修改阶段 |
| 备份、Doctor 或后续阶段失败 | 保留原有错误阶段与诊断，不能把锁恢复成功当整体修复成功 |

## 6. 验收标准和记录

基线：从远端最新 release/2026.9.16 的 5273b844767c1b9757cee7b5a4fe78fd9adba9a3 创建独立 worktree，分支 fix/openclaw-lock-owner-recovery。不修改原工作区和真实用户数据，不自动提交。

### 6.1 环境与验证范围

- 主实现 worktree：`D:/github/LobsterAI-lock-owner-recovery`。
- OpenClaw 独立源码 worktree：`D:/github/openclaw-lock-owner-recovery`，固定 v2026.8.1（`ea806575e6450e4d1efdfc72c19f04be982a1b9b`）；原有 39 个补丁加本次补丁，共 40 个补丁从干净基线重放成功。
- 在本 worktree 的物理 runtime 副本中重新打包 4 个 startup/repair helper。Doctor 和网关主体使用基线已有 v2026.8.1 bundle；本地未重新打包完整发行安装包。正式构建时新补丁会进入对应运行时。
- Electron 使用当前 worktree 编译后的 main/preload/renderer，userData、HOME、APPDATA、TEMP 均为独立验收目录。未使用真实账号发送模型请求或 IM 消息。
- Windows 普通非 detached 子进程在父进程退出时会随作业结束。孤儿正例由测试父进程使用 detached 模式创建，取得真实原生 SQLite 租约后退出；这是受控恢复验证，不是对现场安装器来源的证明。

### 6.2 代码与既有数据链路检查

| 检查 | 结果 |
| --- | --- |
| 所有变更 TS/TSX 的 CI 同规则 ESLint | 通过，0 错误、0 警告 |
| `npm run compile:electron` | 通过 |
| `npm run build` | 通过；保留已有的 Browserslist、动态导入和大 bundle 提示 |
| 相关 Vitest 回归 | 9 个文件通过，115 项通过；2 个文件、15 项可选运行时测试因未开启环境变量而跳过 |
| `npm test -- v20260801UpgradeDecisions` | 提交前补齐新补丁保留清单与说明，18 项补丁集合/升级决策检查通过；该文件 ESLint 通过 |
| 既有 `openclawGatewayRepair.runtime.test.ts` 的显式运行时验收 | 通过：真实 v1 SQLite 升级至 v15、原始备份仍为 v1、历史审计记录保留、插件恢复及重复执行验证 |
| `git diff --check` | 通过 |

相关 Vitest 命令：

```powershell
npm test -- openclawEngineManager openclawGatewayProcess openclawGatewayRepair openclawStartupCompatibility openclawStartupProcess openclawLockRecovery.test openclawRepair.test
```

### 6.3 本机 Electron 一键修复验收

2026-09-17 15:02:04 至 15:08:18（UTC+8），通过 Electron 本地调试接口调用 `window.electron.openclaw.engine.repairGatewayState()`。这是设置页一键修复使用的同一个 preload IPC 入口和真实 main 流程，没有替换修复处理器。未使用鼠标、键盘点击，不包含按钮焦点或视觉布局验收。

已确认：原网关 PID 27892 收到 SIGINT 后以 code 0 退出；LockRecovery、Snapshot、Doctor（code 0）、Recovery、配置同步、Plugins、重新启动与客户端连接完成；最终返回 `success: true`、`status.phase: running`。随后 `/healthz` 与 `/startupz` 均为 HTTP 200，分别报告 live 和 started。

备份目录包含 `original/`、snapshot manifest、各阶段 report、Doctor 日志/结果和锁诊断；未将新阶段成功代替整体成功。

本机验收证据根目录：`C:/Users/yangwn/.codex/artifacts/lobsterai-lock-owner-recovery`。

- `electron-profile/repair-result-1.json`：真实 IPC 返回值。
- `cdp-repair-1789628898044.json`、`electron-health.json`：后台调用和健康探测。
- `electron-profile/appdata/LobsterAI/openclaw/repair-backups/2026-09-17T07-02-08-316Z-18CKZp/`：实际备份和阶段报告。
- `build.log`：完整构建输出。

### 6.4 新增 Windows 实机回归

显式开启的命令：

```powershell
$env:LOBSTERAI_TEST_LOCK_RECOVERY='1'
$env:OPENCLAW_LOCK_RECOVERY_SOURCE='D:/github/openclaw-lock-owner-recovery'
npm test -- openclawLockRecovery.runtime
```

覆盖：无关存活 PID 的两个旧锁回收且进程保留、连续执行原有修复阶段；活跃维护进程保留；即使文件元数据误导也不能越过真实 SQLite 所有权；完整身份不匹配的终止被拒绝；具备可靠身份的真实孤儿被终止后取得原生租约并继续既有阶段。

一次与整包构建同时进行的合并测试出现超时、原生锁 startTime 缺失，未计作通过。无关进程测试还存在 180 秒后自行退出的问题，已将测试进程存活时间改为 900 秒，覆盖两轮 Doctor 的超时预算。

最终独立复验于 2026-09-17 15:10:18 开始，耗时 391.75 秒，1 个文件、3 项测试全部通过：

| 实机场景 | 观察结果 |
| --- | --- |
| 旧维护锁指向无关存活 PowerShell，无 startTime | 两个锁回收，进程仍存活；原 LockRecovery/Snapshot/Doctor/Recovery/Plugins 连续两轮通过 |
| 原生维护所有者仍活跃 | 返回 active，PID 与锁保持不变；随后故意制造创建时间不匹配，仍被实际 SQLite 生命周期协调器拒绝，未执行数据快照 |
| 真实 detached 孤儿持有原生租约 | 错误完整创建身份的终止被拒绝；等待真实 30 秒保护窗口后，停止 PID 36408，回收两个锁，原 Snapshot/Doctor/Recovery 均通过 |

完整输出为 `runtime-tests-final.log`，运行目录索引为 `runtime-fixtures-final.json`。对应三个隔离目录分别为系统临时目录下的 `lobster-lock-runtime-nZG9ZO`、`lobster-lock-runtime-LBU68f`、`lobster-lock-runtime-66Tadj`；诊断和备份保留供复核。

测试夹具还设置了有限存活时间，避免断言或身份查询失败后留下无限期运行的测试孤儿；测试后移除生成到 runtime 的 fixture。验收 Electron 经原窗口关闭 IPC 正常退出（code 0），本任务 Vite 服务已停止，测试运行时文件已清理。

### 6.5 仍需保留的限制

- 不能证明现场 PID 26040 的实际进程身份、是否由自动更新产生，也未执行覆盖安装复现。
- 旧锁没有 startTime 且仍指向疑似 OpenClaw 进程时，不能安全自动终止；保留诊断并拒绝进入后续修复。
- helper 生命周期跟踪覆盖共用 `runStartupMigration` 的 state/compatibility 路径，不宣称所有历史 cron/session/memory 迁移都已统一到该接口。
- 验收覆盖 Windows 和隔离数据目录的真实修复链路；未进行其他操作系统实机验收或安装包发布。
