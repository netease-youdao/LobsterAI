# Windows 安装器辅助进程无控制台窗口设计文档

| 项目 | 内容 |
|---|---|
| 状态 | 已实现；合同测试、本机 NSIS 探针、electron-builder 编译探针待运行（命令见第 4 节）；渠道真机验证待完成 |
| 事故来源 | 2026-09-02 有道词典捆绑渠道（`dictbind-silent` WebSetup）用户反馈 |
| 影响范围 | 全部 Windows NSIS 安装包、Web 安装包、卸载器 |

## 1. 问题

词典捆绑的静默安装包在 Windows 上安装时，用户能看到 PowerShell 窗口反复"拉起又关闭"，
普通用户把它当成病毒行为。窗口全部来自 `scripts/nsis-installer.nsh` 自己启动的辅助进程，
与词典侧无关。一次静默安装启动辅助进程 4 到 9 次，分两类机制：

1. **必现闪窗（所有 Windows 版本）**：旧安装目录异步清理（`customInstall`）和回滚清理
   （`lobsterRollbackOldInstall`）用 NSIS `Exec` 拉起 `powershell.exe -WindowStyle Hidden`。
   `Exec` 是裸 `CreateProcess`，没有 `SW_HIDE`；安装器是 GUI 进程，控制台子进程会先弹出一个
   可见的新控制台窗口，PowerShell 初始化完成后才把它藏起来。用户日志证实 2026.8.28 起每次
   dictbind 覆盖安装都记录了 `old-install-cleanup-scheduled dispatch=success`，即这条路径
   在安装结束时必然执行。
2. **环境相关闪窗**：其余辅助进程（停进程、Skills 备份/恢复、Defender 排除项、tar 解压、
   看门狗）走 `nsExec`。`nsExec` 用 `CREATE_NEW_CONSOLE + SW_HIDE`，传统 conhost 下不可见，
   但 Windows 11（23H2 起默认终端为 Windows Terminal）把控制台移交给 Terminal 时，多个版本
   不尊重 `SW_HIDE`，每次拉起都可能闪出一个 "Windows PowerShell" 窗口。

附带发现：`DetectFreshOrPossibleExisting` 在 `FindNext` 失败后用单独的
`System::Call GetLastError` 读错误码，中间隔着插件加载，读到的是过期值。用户日志里 46 次
`install-preflight-complete` 全部是 `possible-existing`，全新机器也会白跑停进程和 Skills
备份两次 PowerShell。

## 2. 方案

### 2.1 统一的隐藏启动函数

新增 `lobsterExecHiddenProcess` / `un.lobsterExecHiddenProcess`（安装器与卸载器各一份），
用 System 插件直接调用 `kernel32::CreateProcessW`，`dwCreationFlags = CREATE_NO_WINDOW
(0x08000000)`：子进程根本没有控制台窗口，conhost 和 Windows Terminal 都无从显示，与系统
版本无关。这也是 Node `windowsHide` 在 libuv 里的实现方式，应用侧已经在用同一机制。

- `wait` 模式：stdout+stderr 重定向到 `$PLUGINSDIR` 下的临时文件，stdin 来自 `NUL`；
  `WaitForSingleObject` 无限等待（与 nsExec 语义一致），`GetExitCodeProcess` 取真实退出码，
  之后读回输出（上限 4096 字符，保留辅助进程的尾部 CRLF，与 `nsExec::ExecToStack` 一致）。
- `detach` 模式：创建后立即返回，不继承句柄，不做重定向；创建失败时设置 NSIS 错误标志，
  保持原 `Exec` 调用点的 `IfErrors` 判断不变。
- 创建失败时退出码为字符串 `error`，输出为 `launch-failed win32_error=N`，沿用所有调用点
  已有的 `error` 分支（`process-start-blocked`、`legacy-helper-launch-failed` 等）。
- 临时文件不可用时退化为不重定向继续执行：输出只用于诊断，退出码才是判定依据。
- 函数保存并恢复全部寄存器，结果经 `$lobsterHiddenExecExitCode` /
  `$lobsterHiddenExecOutput` / `$lobsterHiddenExecLaunchError` 传递。

三个调用宏复刻原有栈契约，调用点只把 `nsExec::ExecToStack '...'` 改成 `Push '...'` 加宏：

| 宏 | 替代 | 栈结果 |
|---|---|---|
| `LobsterExecHiddenToStack` | `nsExec::ExecToStack` | 先 push 输出，再 push 退出码 |
| `LobsterExecHiddenExitCode` | `nsExec::ExecToLog` | 只 push 退出码 |
| `LobsterExecHiddenDetached` | `Exec` | 不 push；失败时 `SetErrors` |

13 处启动点全部改造：停进程循环与幸存者快照、回滚 Defender 清理与残留树清理、Skills 备份、
安装前 Defender 添加/仅查询两个分支、tar 解压、解压看门狗、Skills 恢复、解压后 Defender
再平衡、旧安装目录清理、卸载器 Defender 清理。两处清理命令去掉了不再需要的
`-WindowStyle Hidden` 参数。

### 2.2 减少启动次数

- 解压后的 Defender "trim" 与 "permanent add" 两次 PowerShell 合并为一次
  `defender-exclusion-rebalance-complete`；`/NoDefenderExclusion` 通过子进程环境变量
  `LOBSTERAI_DEFENDER_ADD_PERMANENT` 传入，只跳过添加、不跳过移除，语义与之前一致。
- `DetectFreshOrPossibleExisting` 改为 System 插件枚举（`FindFirstFileW` /
  `FindNextFileW` 带 `?e`），在同一次调用里拿到结束枚举的 Win32 错误码：`ERROR_NO_MORE_FILES`
  (18) 判定为空；`FindFirstFileW` 失败时 2/3/18 判定为不存在或为空。真正的全新安装从此走
  `fresh-install` 分支，跳过停进程和 Skills 备份。

## 3. 安全软件与 Defender 影响

改动不引入新的被拦截风险：

- 进程树、二进制、签名、权限完全不变：仍是签名的安装器拉起系统目录下的
  `powershell.exe` / `tar.exe`，绝对路径、`-NoProfile -NonInteractive -Command`、输入经
  环境变量传递，脚本文本与之前相同，AMSI 扫描的内容没有变化。
- 唯一可见的差异是进程创建标志（`CREATE_NO_WINDOW` 取代 `CREATE_NEW_CONSOLE+SW_HIDE`）以及
  命令行里去掉了 `-WindowStyle Hidden`。`CREATE_NO_WINDOW` 是 Node、.NET、Python 启动隐藏
  子进程的标准方式，不是检测特征；`-WindowStyle Hidden` 反而是恶意 PowerShell 的常见特征，
  去掉后启发式风险只降不升。
- 启动次数减少（合并 Defender 调用、全新安装跳过两次），扫描次数随之减少。
- 输出落到 `$PLUGINSDIR` 的临时文本文件并在读取后删除，属于普通临时文件。

## 4. 验证

- `tests/windowsInstallerContract.test.ts`：新增"launches every helper without a console
  window"（脚本中不再出现 `nsExec::` / `Exec`；启动函数使用 `CREATE_NO_WINDOW`；13 个
  `Push '"$lobsterTrusted...Path"` 之后紧跟启动宏）和"rebalances Defender exclusions in
  one helper launch"；更新 tar、PowerShell 路径、fresh-install 判定相关断言。
- `release/nsis-console-probe/`（gitignored）：用 electron-builder 自带的 NSIS 编译四个探针
  安装器，在窗口监听脚本下静默运行，对比 `nsExec`、`Exec` 与新启动函数的可见窗口、退出码、
  输出捕获、detach 行为，以及新旧 fresh-install 判定在空目录/非空目录/不存在目录下的结果。
- `release/nsis-compile-probe/run.sh`（gitignored）：给 electron-builder 一个假的
  `--prepackaged` 目录，让它按补丁后的模板生成真实的 `installer.nsi` 并用 makensis 编译
  安装器和卸载器两遍，验证整个 include 能编译通过。产物只用于编译验证，绝不能运行。
- 运行顺序：`npm run verify:installer-patches`（含合同测试）→
  `bash release/nsis-console-probe/run.sh` → `bash release/nsis-compile-probe/run.sh`。
- 渠道真机：在默认终端为 Windows Terminal 的 Windows 11 上运行 dictbind-silent 包，
  期望零个新可见窗口；`install-timing.log` 中 `process-stop-complete`、
  `skill-backup-complete`、`defender-exclusion-rebalance-complete`、`tar-extract-complete`、
  `old-install-cleanup-scheduled` 的退出码与改动前一致。

## 5. 风险与回退

- 启动函数是唯一的新运行时代码路径；任何创建失败都映射到既有的 `error` 分支，不会产生
  新的失败类型。
- 输出捕获走文件而非管道，不存在管道缓冲死锁；无限等待与 nsExec 一致，看门狗仍由
  PowerShell 侧的 600 秒超时保护。
- 回退方式：还原 `scripts/nsis-installer.nsh` 与合同测试即可，不涉及应用侧代码与数据。
