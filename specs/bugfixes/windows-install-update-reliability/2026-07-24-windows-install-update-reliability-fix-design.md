# Windows 安装与应用内更新可靠性修复设计文档

| 字段 | 值 |
|---|---|
| 状态 | P0-hotfix 本地实现与构建验证完成，Windows 签名/真机/发布验证待完成；P0.5 与 P1 尚未实现 |
| 文档 Owner | TBD |
| P0-hotfix DRI | TBD（单一工程负责人） |
| 事故版本 | Windows 2026.7.23 |
| 兼容基线 | Windows 2026.7.17 及当前仍可成功的 stock installer 路径 |
| 目标修复版本 | 高于 2026.7.23 的新版本号，TBD |
| 最后更新 | 2026-08-06 |

## 执行摘要

本事故的直接根因是安装器依赖 PATH 解析裸 `powershell`，并把启动失败
错误地解释为 legacy Skills 复制失败。P0-hotfix 只修复最小因果链：

1. 在旧进程停止和旧数据流程前区分 fresh 与 possible-existing；
2. 用同一个可信系统工具 resolver 解析 PowerShell 和 `tar.exe`，不依赖
   PATH，并保留现有 Electron extractor 600000ms hard watchdog；
3. 区分 launch error、timeout、脚本退出码和真实复制失败；
4. 仅在能够证明安全时，于 pre-mutation 失败或成功 rollback 后恢复启动
   旧应用；
5. 对更新安装包先实施输入/最终 URL 的 HTTPS transport policy，不绑定
   尚未稳定的 CDN origin；
6. 普通卸载默认保留 userData；
7. 保持 2026.7.17 首跳、双注册同路径、注册丢失残留和手动换目录等当前
   能成功的兼容 fallback，不把它们统一改成新的中止路径。

P0-hotfix 不引入完整 action planner、secure control journal、ownership
manifest、foreign-content 恢复区或原生 helper。上述能力进入 P0.5/P1；
其中 P0.5 开始实现前，必须先通过权限模型 ADR，确定 current-user
非提权路径与 all-users/Program Files 提权 worker 的边界。完整安装包
鉴真（可信摘要、WinVerifyTrust、发布者和证书链）继续独立立项，但不能
因此推迟 P0 的 HTTPS transport 下限门禁。固定 origin 只有在下载域名
稳定后才可加入；否则应由签名 manifest 解决动态 CDN 的来源鉴真。

P0-hotfix 以“一名 DRI、一个工作周、发布一个新版本号”为硬 timebox。
构建、签名、独立评审和真机验证可以由发布/QA 角色并行协助，但不能移出
这一周的发布门禁。若工作量超出 timebox，先把增强项移至 P0.5；不得通过
跳过 Must 测试或降低安全不变量来赶期限。

### 当前实施快照（2026-07-25）

已完成 P0-hotfix 源码实现、应用侧行为测试、NSIS 合同测试、
`compile:electron`、完整 Vitest，以及本机交叉构建的 `nsis` /
`nsis-web` 未签名安装包。由于当前 Windows 下载 CDN origin 尚未稳定，
P0 不内置固定域名清单；客户端校验输入和最终 URL 的 HTTPS、默认端口、
凭据、fragment 与 `.exe` 扩展名，并记录动态 transport receipt。

以下仍是发布阻断，不能因本地构建通过而勾选完成：

- 正式签名安装包及签名验证；
- Windows 真机 fresh、7.17 首跳、7.23 覆盖、current/all-users、
  UAC 拒绝、PATH 缺失、extractor 冻结/超时和 rollback 矩阵；
- 同一安装 attempt 在当前 admin-manifest 架构下只产生一个 GUID 的日志
  证明；若观察到 `.onInit` 后的新进程，必须先实现显式 GUID handoff；
- 现场 7.23 安装包的源码 commit、SHA-256 与签名溯源；
- 高于 2026.7.23 的正式版本号、灰度和回滚开关。

### 修订记录（2026-08-06）：watchdog 空退出码的哨兵救援

现场事故（2026-08-05/06 用户日志）：同一台机器跨 2026.7.23/7.31/8.5 三个
安装器版本共 11 次安装，Electron extractor 子进程每次都完整成功
（`extract-ok` + 三目录 `verify-ok` + exit 0），但 PowerShell watchdog 的
`$p.ExitCode` 每次读到 `$null`（该机安全软件确定性破坏 .NET 退出码查询，
等待与文件写入均正常）。旧协议把 null 判为 125/127 后，7.24 起的
fail-closed 中止+回滚使该机类永久无法升级。

修订内容（对 `TarExtractOutputValidationFailed` 语义的最小放宽）：

1. `unpack-cfmind.cjs` 在全部预期目录校验通过后、exit 0 前写哨兵文件
   `resources/.unpack-cfmind-ok`（严格强于 exit 0 的成功证据）；
2. watchdog 读到 null 退出码时先查哨兵：存在则写 marker
   `exit-code-null-sentinel-ok` 并 exit 0，不存在维持 127；
3. NSIS 侧 127 分支兜底：哨兵存在记录
   `phase=tar-extract-sentinel-rescue` 后跳回 `TarExtractVerify`，
   不存在走原 fatal 路径；
4. 陈旧哨兵在 extractor 启动前删除，安装提交时清理。

FR-11 边界不变：600000ms hard timeout、terminate/wait 语义、124/125/126
分类全部保留；救援仅覆盖"退出码不可读"这一种歧义结果，且最终提交仍由
`TarExtractVerify` 的磁盘入口校验把关（与"仅凭退出码不得删除恢复素材"
互为对偶）。本修订不替代 P0.5 规划的 start/result journal 结果协议。
合同测试见 `tests/windowsInstallerContract.test.ts`
（`rescues a null watchdog exit code with the extractor success sentinel`）。

## 1. 概述

### 1.1 问题

LobsterAI 2026.7.23 的 Windows 安装器在部分用户机器上无法完成安装。
问题同时出现在以下两类场景：

1. 已安装旧版本，通过应用内更新安装 2026.7.23；
2. 卸载旧版本后，手动执行 2026.7.23 安装包进行全新安装。

安装器统一显示：

```text
The LobsterAI update stopped because user skills could not be backed up.
The previous installation was not replaced.
Please retry the update.
```

现场 `install-timing.log` 的关键记录为：

```text
phase=process-stop-complete exit=error elapsed_ms=47
phase=skill-backup-complete exit=error elapsed_ms=47
phase=skill-backup-failed-abort exit=error action=old-install-preserved
```

同一台机器执行下面的诊断命令时：

```text
where powershell.exe
```

找不到可执行文件，但直接执行系统绝对路径：

```text
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
```

可以正常输出结果。这说明 Windows PowerShell 本身存在且可运行，只是其
目录不在当前进程的 `PATH` 中。

用户还确认：

- 2026.7.17 可以正常安装；
- 2026.7.23 无论覆盖安装还是卸载后重新安装都会失败。

### 1.2 已确认根因

根因由两个问题叠加产生。

第一层是外部程序解析不可靠：

- `scripts/nsis-installer.nsh` 在停止进程、Skills 备份/恢复、资源解压
  回退、Defender 配置和目录清理等位置直接调用裸命令 `powershell`；
- `src/main/libs/appUpdateInstaller.ts` 也通过 `powershell.exe` 启动
  带 `--updated` 参数的提权安装器；
- 这些调用依赖用户或系统 `PATH`，没有统一解析可信的系统绝对路径。

第二层是 2026.7.23 新增的 fail-closed 判断没有区分失败类型：

```text
调用 Skills 备份 PowerShell
  -> nsExec 返回非 0 或 error
  -> 一律解释为“用户 Skills 备份失败”
  -> 在替换旧安装前退出
```

2026.7.17 安装器也存在裸 PowerShell 依赖；应用侧 launcher 会先调用裸
`powershell.exe` 以携带 update-mode 参数，启动失败后再降级为无参数
`shell.openPath`。当时安装器只记录备份退出结果，不会因 `exit=error`
中止。2026.7.23 为防止升级时丢失旧 Skills，新增了
“备份失败即终止”的安全门槛，因此同一台机器上出现了“7.17 能装、
7.23 不能装”的差异。

fail-closed 的数据保护目标是正确的，问题在于：

1. 全新安装也无条件进入旧 Skills 备份；
2. 没有先判断旧安装和旧 Skills 是否存在；
3. 没有区分“PowerShell 无法启动”和“Skills 实际复制失败”；
4. 错误提示默认假设存在上一版本，即使用户已经卸载；
5. 应用重启后不知道安装器的具体失败结果，会继续复用同一个安装包。

### 1.3 当前调用链

应用内更新的主要调用链为：

```text
AppUpdateCoordinator
  -> AppUpdateInstaller 启动 Windows NSIS 安装器
  -> customCheckAppRunning
     -> 停止 LobsterAI / Node 进程
     -> 备份旧安装目录中的 legacy Skills
     -> 判断是否允许继续
     -> 判断安装场景并处理旧安装目录
  -> electron-builder payload 写入
  -> customInstall
     -> 解压资源
     -> 恢复 legacy Skills
     -> 校验新安装
     -> 提交或回滚
     -> 清理旧目录
```

当前顺序中，“安装场景判断”发生在“停止进程和 Skills 备份”之后，
这是全新安装也会失败的直接设计原因。

### 1.4 影响范围

确认受影响的范围：

- Windows 2026.7.23 全量安装包；
- Windows 应用内自动更新；
- Windows 手动覆盖安装；
- Windows 卸载后重新安装；
- 当前用户安装和全用户安装；
- `PATH` 中缺少 Windows PowerShell 目录的机器；
- PowerShell 被企业策略、AppLocker、WDAC 或终端安全软件阻止的机器。

潜在但尚未由本次现场直接触发的风险：

- 停止旧进程失败后继续写入，导致文件占用或替换失败；
- 系统 `tar.exe` 不可用时，PowerShell 解压回退无法启动；
- Skills 恢复阶段再次因 PowerShell 解析失败而触发回滚；
- 全用户安装把诊断日志写入 `C:\ProgramData`，但应用日志导出只查找
  当前用户目录，导致支持侧拿不到真正的安装日志；
- 用户按支持建议卸载时，因为 `deleteAppDataOnUninstall: true` 删除
  `%APPDATA%\LobsterAI` 中的用户数据。

另有用户反馈安装目录中的自建文件夹会在升级后消失。该问题与本事故共用
旧安装替换路径，但属于独立的文件归属和危险删除问题，详见
[Windows 安装目录未归属内容保护设计](../windows-install-root-foreign-content-protection/2026-07-24-windows-install-root-foreign-content-protection-design.md)。
本 spec 只保留不可绕过的跨文档门禁，不在紧急修复中同时实现 ownership
manifest、恢复区和精确卸载。

### 1.5 目标

P0 紧急修复目标：

1. 全新安装不得依赖旧安装、旧 Skills 或 PowerShell 备份流程。
2. `PATH` 中缺少 PowerShell 目录、但系统 PowerShell 存在时，安装和
   应用内更新均能正常完成。
3. 在任何外部程序和破坏性操作前，至少可靠区分 fresh 与
   possible-existing。
4. 只在确实存在旧用户数据且无法安全保护时 fail-closed，并区分
   launch error、timeout、脚本退出码和数据复制失败。
5. 保留 2026.7.23 已有的旧目录回滚、新安装校验以及 Electron 解压器的
   10 分钟 hard watchdog；紧急修复不得把现有兼容 fallback 改成中止。
6. 用户可见错误必须反映真实失败阶段，不再统一显示 Skills 备份失败。
7. 安装器必须自行生成 Windows GUID 格式的稳定 `attemptId`；应用传入的
   ID 只作为可选关联，安全 handoff nonce 必须与 attemptId 分离。
8. legacy Skills 备份、恢复和清理必须限定在本次 `attemptId`，不得复用
   上一次失败遗留的备份。
9. 普通卸载默认保留 userData，安装故障处理不再要求用户先卸载。
10. 修复版使用新的版本号和安装包，不能原地替换 2026.7.23。
11. 增加能复现 PATH 缺失、旧版首跳和 watchdog 超时的 Windows 测试。
12. Windows 更新包输入 URL 和最终重定向 URL 都必须满足 HTTPS
    transport policy；P0 不固定尚未稳定的 CDN origin。
13. 对由可信应用内更新发起的安装，pre-mutation 失败或 rollback 成功后，
    在严格门禁下恢复启动旧应用；静默企业部署不得意外弹出应用窗口。

P0.5 兼容性加固目标：

1. 用启动方式、注册拓扑和目标目录内容三个正交维度选择安装动作。
2. 已验证的单一 LobsterAI 残留可 repair-in-place；合法换目录可
   relocate-reinstall；双注册同路径可在确认 scope 后 reconcile。
3. `/S` 和 `--updated` 在无法唯一确定 source、target 或 scope 时使用
   稳定非零退出码，且 mutation 尚未开始。
4. 通过版本绑定的旧版内置 Skills 清单，在无需备份时减少 PowerShell
   依赖；无法证明无用户 Skills 时仍 fail closed。
5. 接入独立 install-root content guard；未取得安全结果不得删除旧树。
6. 在实现 original SID、ProgramData control/ACL 和双 repair 入口前，
   先完成并批准 Windows 安装权限模型 ADR。

P1 完整可靠性目标：

1. 安装关键链路不再依赖 PowerShell 或用户 `PATH`。
2. 进程停止、legacy Skills 迁移、资源解压和目录清理使用可验证的原生
   能力或签名辅助程序。
3. 应用、启动器和安装器之间建立带 `attemptId` 的安装结果闭环。
4. 同一版本、同一安装包、同一确定性失败不得自动无限重试。
5. 用户 Skills 永久收敛到 userData，安装目录只保存内置资源。
6. 提供独立的“同时删除全部用户数据”入口，并要求用户明确确认。

### 1.6 非目标

本设计不做以下事情：

- 不迁移到 `electron-updater`；
- 不修改更新检查服务的 API 结构和下载 CDN；
- 不重写 macOS DMG 安装流程；
- 不改变 Linux 安装行为；
- 不回退到 2026.7.17 的“忽略备份失败继续安装”语义；
- 不把“永久修改用户系统 PATH”作为产品解决方案；
- P0 不拆分或全面重构整个 `scripts/nsis-installer.nsh`；
- P0 不引入新的原生语言工具链；
- 不删除或弱化现有旧目录回滚、新安装校验和恢复副本保留逻辑。
- 不绕过 AppLocker、WDAC 或企业安全策略；被阻止时应准确失败并保留
  旧安装；
- 不把“关闭杀毒软件”作为产品解决方案；
- 不自动降级，也不自动删除历史 `.old`、`.failed` 或迁移恢复副本；
- 不恢复已被旧卸载器实际删除、且没有任何备份的数据。
- 不承诺用户自行放入 `$INSTDIR` 的文件在升级后仍保留原路径；
- 不把未知 DLL、EXE、脚本、插件或同名文件自动合并回新版本安装目录；
- 不把安装目录定义为受支持的用户数据目录。用户可管理内容应放入
  Documents、用户选择的工作目录或产品明确提供的数据目录。
- P0 不修改更新服务 API 结构、下载 CDN 或发布元数据格式，只增加客户端
  输入/最终 URL 的 HTTPS transport 最低门禁，不固定 CDN origin。
- 不在本 spec 中实现完整 Windows 更新包来源鉴真。现有 attempt SHA-256
  只能识别本地缓存是否变化，不等价于可信服务端 hash、Authenticode
  证书链和预期发布者校验；该安全需求单独立项并与 P0 并行推进。
- 不在本 spec 中扩大、重构或证明 Defender exclusion 的安全边界。
  用户可写路径、永久排除和历史排除回收单独立项；P0 只保持 best-effort
  且不得扩大当前排除范围。

## 2. 现状与安全约束

### 2.1 用户数据归属

| 数据 | 当前权威位置 | 安装器处理原则 |
|---|---|---|
| 用户 Skills | `%APPDATA%\LobsterAI\SKILLs` | 安装和更新不得覆盖或删除 |
| 内置 Skills | `$INSTDIR\resources\SKILLs` | 可随版本替换 |
| legacy 自定义 Skills | 旧版本安装目录中的非内置 Skill 目录 | 仅作为兼容迁移来源 |
| SQLite / 配置 | Electron `userData` | 安装更新不得触碰 |
| OpenClaw state | `userData/openclaw` | 安装更新不得触碰 |
| 已下载安装包 | `userData/updates` | 可复用，但必须带安装尝试状态 |
| 安装器诊断日志 | 当前由 NSIS `$APPDATA` 决定 | 需要统一并可被日志导出发现 |
| 安装目录内容保护结果 | 独立 content guard | 未取得允许结果时不得进入 destructive mutation |

应用正式运行时，用户 Skills 的权威路径已经是
`app.getPath('userData')/SKILLs`。安装目录中的 Skills 备份仅用于兼容
旧版本可能遗留的自定义 Skill，不应成为每次安装的必经流程。

全用户安装时，NSIS 的 `SetShellVarContext all` 会使 `$APPDATA` 指向
`ProgramData`，它不是任意最终登录用户的 Roaming AppData。因此：

- 安装器不得把 all-users 模式下的 `$APPDATA` 当作用户 Skills 权威目录；
- all-users 的 legacy Skills 只能进入机器级、attempt-scoped 的迁移暂存区；
- 新应用必须在真实用户身份下将已验证数据导入该用户的 userData，或继续
  保留兼容副本直到导入得到确认；
- 迁移后的自定义 Skills 不得长期写回新版 `resources\SKILLs`。

安装目录内容归属和保护策略由
[独立 spec](../windows-install-root-foreign-content-protection/2026-07-24-windows-install-root-foreign-content-protection-design.md)
定义。本状态机只消费其门禁结果。

### 2.2 必须保持的安全不变量

后续实现必须保持以下不变量：

1. 用户确认安装前不得停止进程、重命名目录或执行其他破坏性操作。
2. 全新 payload 写入前，如果确认存在尚未保护的旧用户数据，必须中止。
3. 备份成功不能只依赖退出码，必须能验证备份目标存在且内容完整。
4. 新安装完成不能只依赖解压退出码，必须校验主程序、卸载器、
   `app.asar` 和实际运行时入口；archive/script 只能作为诊断/恢复来源，
   不能替代 ready 校验。
5. 新安装未验证前，旧安装目录不得被删除。
6. 替换后任何受控失败必须尝试恢复旧安装。
7. 回滚失败时不得删除旧目录、备份目录或部分新安装中的任一恢复来源。
8. 异步清理只允许操作本次安装生成的精确备份路径。
9. Defender 配置和旧目录清理失败不得伪装成安装失败。
10. 用户目录中的正式 Skills、SQLite 和 OpenClaw state 不属于安装 payload。
11. 任何会替换已确认旧安装的路径都必须满足“新版本提交成功、旧树恢复
    成功、或明确保留可恢复副本”三者之一。
12. 全新安装失败只能清理由本次 attempt 创建的文件，不得删除安装前已经
    存在、但归属无法确认的目录或文件。
13. 当前 attempt 只能恢复自己创建并验证过的 Skills 备份；历史备份不得
    被后续安装自动采用。
14. 安装场景分类必须先于进程停止、PowerShell/helper 启动、旧卸载器、
    文件重命名和 payload 写入。
15. P0 不得新增任何 destructive cleanup；P0.5 接入内容保护后，任何替换、
    旧卸载器调用或递归删除 `$INSTDIR` 的路径，都必须先取得 content
    guard 的 `safe-to-replace` 或 `foreign-content-protected` 结果。
    根不存在/为空且仅作为 write-only target 时可使用严格的
    `content-guard-empty-write-only-target`；该状态不能为任何
    delete/rename 根放行。
    扫描失败或检测到未保护内容时不得 mutation，详细语义由独立 spec 定义。
16. `attemptId` 只用于关联和命名，不得充当安全授权凭据；所有跨提权
    control/handoff 必须使用独立、至少 128-bit 的 CSPRNG nonce。
17. 回滚成功与旧应用恢复启动是两个独立结果；旧应用拉起失败不得反转已经
    成功的文件回滚，也不得触发第二次 mutation。
18. 更新安装包 URL 未通过 P0 HTTPS transport policy 时，不得下载、缓存、
    提权执行或把不安全原始 URL 交给系统浏览器。

### 2.3 当前测试缺口

`tests/windowsInstallerContract.test.ts` 当前主要验证：

- Hook 顺序；
- 旧目录 rename 和 rollback 关键字符串；
- electron-builder 补丁是否包含必要 Hook；
- Defender 和 payload 阶段日志是否存在。

这些测试不能执行 Windows `CreateProcess`，因此无法发现：

- `powershell` 不在 PATH；
- PowerShell 被策略阻止；
- 全新安装不应进入 legacy Skills 迁移；
- 安装失败后旧应用重复复用同一安装包；
- `$APPDATA` 在当前用户和全用户安装间发生变化；
- Electron 解压 child 被安全软件冻结后是否会在 hard timeout 被终止。

Windows CI 当前会构建安装包，但没有执行“安装 7.17 -> 升级候选版”或
“清空 PowerShell PATH -> 全新安装候选版”的集成验证。

## 3. 安装场景与状态机

### 3.1 正交输入与动作枚举

不能用一个六分类枚举同时表达启动来源、注册表拓扑、目录内容和处理动作。
否则“注册异常但可验证的 LobsterAI 安装”会被统一归入 orphaned/cross-scope
并中止，破坏当前仍可成功的 stock installer fallback。

安装器必须分别记录以下稳定输入：

```text
invocationSource:
  standalone | app-update | unknown

updatedFlag:
  present | absent

uiMode:
  interactive | silent

launcherFallback:
  none | wizard-no-args | unknown

registryTopology:
  none | single-match | single-mismatch | dual-same-path | dual-different-path

targetContent:
  empty | verified-app-only | contains-foreign | contains-unknown | scan-incomplete

sourceResolution:
  none | unique | ambiguous
```

再把输入映射为稳定动作：

```text
fresh-install
update-in-place
repair-in-place
relocate-reinstall
reconcile-dual-registration
blocked-conflict
```

这些值是日志、status、错误分类和测试的稳定判别值，必须由共享常量定义。
`updatedFlag` 与 `uiMode` 正交，`--updated /S` 是合法组合。`--updated`
也不是旧目录归属或删除安全的证明。

`invocationSource` 和 `launcherFallback` 只能来自安装器直接观测到的参数或
受约束的 launcher attempt 元数据。无参数启动不能仅凭时间相近或存在旧
安装推断为 `app-update`：2026.7.17 在裸 PowerShell 启动失败后使用的
`shell.openPath` fallback，与用户双击安装包在安装器侧不可区分，必须
记录为 `unknown`。新应用可在安装结束后做弱关联，但不得回写并伪装成
安装器已经确定的事实。

### 3.2 判定顺序

候选根解析与动作判定必须是只读操作，并发生在任何外部进程启动和破坏性
操作之前。

P0 只需在现有流程前增加不会改变兼容行为的最小 preflight：可靠区分
`fresh-install` 和“可能存在旧安装”，让 fresh 跳过进程停止与 legacy
Skills。完整动作规划属于 P0.5。

P0.5 推荐判定顺序：

1. 读取 `--updated` / electron-builder `${isUpdated}`、`/S` 和手动向导
   等启动来源。
2. 确认本次安装范围：`currentUser` 或 `allUsers`。
3. 同时读取 HKCU、HKLM 的 INSTALL key、`InstallLocation`、UNINSTALL
   key 和 `UninstallString`。`UninstallString` 可反推出旧 source，也是
   existing evidence，不能因为 `InstallLocation` 丢失就忽略。
4. 检查 `$INSTDIR` 及注册路径中的主程序、卸载器和资源目录。
5. 对注册路径、目标路径和当前安装范围做规范化比较。
6. 检查另一注册范围是否存在同路径或不同路径的安装，生成只读
   `sourceCandidates`、target 和 scope 候选。
7. 根据候选动作列出 `rootsToMutate`。每项必须包含规范化物理路径、
   attempt 内唯一 `rootId`、`source|target` 角色和计划操作；旧 source、
   非空且会被覆盖的 target 都是独立门禁对象。`rootId` 由安装器对
   canonical root + role + attemptId 派生，不接受外部输入；需要跨提权
   安全认证时另用 FR-13 的独立 security nonce。
8. 对 `rootsToMutate` 中每个非空根执行独立 install-root content guard
   的早期只读扫描；全新安装的空 target 可显式记为
   `content-guard-empty-write-only-target`。
   只有位于受支持旧 source 的精确
   `resources\SKILLs\<skillName>` 目录，且由 legacy inspector 认定需要
   attempt-scoped 保护时，才可返回中间状态
   `legacy-skill-protection-required`；其他 foreign/unknown 仍直接阻断。
9. 根据 source、target、scope 和逐根门禁结果选择最终动作。
10. 对需替换的动作停止相关进程；停止完成后重新扫描全部 destructive
    roots，因为 shutdown hook 可能在退出时写入安装树。
11. 基于 post-stop 快照保护 exact legacy Skill candidates，复制并校验
    attempt-scoped backup，生成 protection receipt。
12. 紧邻每个 destructive mutation 前逐根执行最终强复验。任一根发生目录、
    属性、reparse 状态或 candidate 字节变化，均须重新规划或中止，不能
    复用另一根、pre-stop 或更早的扫描结果。

动作映射：

| 条件 | 动作 |
|---|---|
| 无注册、目标为空 | `fresh-install` |
| 单注册与目标一致，旧应用 footprint 有效 | `update-in-place` |
| 无注册，但目标是唯一、可验证的 LobsterAI footprint | `repair-in-place` |
| 手动安装或显式 `/D`，注册/UninstallString 旧路径有效且新目标为空/安全 | `relocate-reinstall` |
| HKCU/HKLM 指向同一物理路径，scope 已明确 | `reconcile-dual-registration` |
| 双注册指向不同物理路径，无法确认权威 source | `blocked-conflict` |
| 目录只有未知内容、扫描不完整或未保护内容 | `blocked-conflict` |
| `--updated` 的 source/target/scope 无法唯一确定 | `blocked-conflict` |

“注册项不存在但目标目录非空”不得归类为 fresh。可验证且唯一的 LobsterAI
残留是 repair 候选，不应一律中止；只有归属不明、内容未保护、存在多份
物理安装或无法唯一定位旧树时才 fail closed。

双注册同路径和双注册不同路径不得混为一类：前者物理 payload 只替换一次，
提交后修正 stale registration；后者可能是真实的两份安装。交互模式在
用户明确选择权威 source 后可重新规划并只操作选中安装，另一份保持不变；
静默模式或无法确认时不得自动删除任何一份。

### 3.3 P0.5+ 目标状态机

```text
CandidateRootsResolved
  -> ContentGuardPreflightCompleted
  -> ActionPlanned
  -> PreflightPassed
  -> TargetProcessesStopped
  -> PostStopContentRescanned
  -> LegacyDataProtected
  -> ContentGuardFinalRevalidated
  -> OldInstallStaged
  -> PayloadWritten
  -> NewInstallValidated
  -> Committed
  -> RegistrationReconciled | RegistrationRepairDeferred
  -> CleanupScheduled
  -> Completed
```

允许跳过：

- `fresh-install` 跳过 `TargetProcessesStopped`、
  `PostStopContentRescanned`、`LegacyDataProtected` 和
  `OldInstallStaged`；
- 没有 legacy Skills 时，`LegacyDataProtected` 直接记录为
  `legacy-protection-not-required`；
- 没有旧安装时不执行旧卸载器和回滚。
- 非双注册同路径时，registration repair 记录为
  `registration-repair-not-required`。
- `RegistrationRepairDeferred` 表示 payload 已成功提交，只允许重试注册
  修复，不得重新安装同一 payload。

失败转移：

```text
CandidateRootResolution / ContentGuardPreflight / ActionPlanning / Preflight /
TargetProcessStop / PostStopContentRescan / LegacyDataProtection /
ContentGuardFinalRevalidation
  -> FailedBeforeMutation

OldInstallStaged / PayloadWritten / NewInstallValidated
  -> RollbackStarted
  -> RollbackSucceeded | RollbackFailed
```

P0 不实现完整状态机时，必须保持现行 selected-scope 行为：
`registered-install-missing` 和 `install-location-mismatch` 保留 stock
fallback；双注册同路径在 all-users 路径可进入 stock fallback，而
current-user 路径可能仍走 fast path 并留下 stale HKLM。P0 不修这个历史
缺口，但不得仅因新增分类统一改成中止。P0.5 在事务动作和注册修复验证
完备后再替换这些 fallback。

上图中的 `LegacyDataProtected` 只有在没有待保护 legacy Skills 时才可记
`legacy-protection-not-required`。存在
`legacy-skill-protection-required` 时，早期 preflight 只生成候选计划，
不得在应用仍运行时把该计划当成最终备份输入。必须先停止目标进程，再做
post-stop 逐根重扫，随后完成 FR-9 的逐 source 复制、校验和 protection
receipt，最后由 content guard 强复验并升级为
`foreign-content-protected`。任一 receipt 不完整、快照变化或存在其他
foreign 内容都进入 `FailedBeforeMutation`。

### 3.4 各动作处理规则

| 动作 | 停止旧进程 | legacy Skills | 目录处理 | 失败策略 |
|---|---|---|---|---|
| `fresh-install` | 跳过 | 跳过 | 不适用 | 直接报告安装阶段失败 |
| `update-in-place` | 按目标路径停止并复查 | 有源时保护 | attempt-scoped rename + commit | 失败回滚旧安装 |
| `repair-in-place` | 按目标路径停止并复查 | 有源时保守保护 | 事务替换已验证残留 | 失败还原残留树 |
| `relocate-reinstall` | 停止旧 source 相关进程 | 从旧 source 保护 | stage source，写入新 target | 失败恢复旧 source |
| `reconcile-dual-registration` | 对单一物理路径停止 | 不跨用户猜测导入 | payload 只替换一次，commit 后修注册 | 修注册失败为 `registration-repair-deferred`，只重试注册 |
| `blocked-conflict` | 不停止 | 不自动恢复 | 不 mutation | 稳定错误并保留现场 |

### 3.5 `/S` 与 `--updated` 契约

静默模式不得依赖安装范围页、目录页或 `MessageBox`：

1. source、target、scope 唯一，footprint 有效且 content guard 允许时继续；
2. `dual-same-path` 需要显式 `/currentuser`、`/allusers` 或可信 launcher
   元数据；
3. `dual-different-path`、未知内容、foreign 未保护或旧树无法定位时，在
   mutation 前返回稳定非零退出码；
4. 显式 `/D` 可作为 relocation target，但不能替代旧 source 验证；
5. `--updated` 遇到路径 mismatch 时不得自动解释成 relocation，除非
   launcher 同时提供经过约束的 source、target 和 scope。

## 4. 用户场景

### 场景 1：PowerShell 不在 PATH 的全新安装

**Given** 用户没有已安装的 LobsterAI，Windows PowerShell 系统文件存在，
但 `where powershell.exe` 找不到
**When** 用户运行修复版安装包
**Then** 安装器识别为 `fresh-install`
**And** 不进入旧 Skills 迁移
**And** 不依赖 PATH 查找 PowerShell
**And** 安装成功。

### 场景 2：从 2026.7.17 应用发起升级且没有 legacy Skills

**Given** 旧版安装目录存在，但所有用户 Skills 已位于 userData
**And** 2026.7.17 launcher 的裸 `powershell.exe` 启动失败，降级为
`shell.openPath` 启动安装包且不携带 `--updated`
**When** 修复版安装器以交互向导进入
**Then** P0 识别为有效旧安装并保留现有向导/stock fallback
**And** P0.5 action planner 映射为 `update-in-place`，而不是依赖参数
**And** 安装器停止目标旧进程
**And** post-stop 重扫后 legacy Skills 检查结果为
`legacy-no-extra-skill-directories`
**And** 旧安装被安全替换
**And** 用户 Skills、SQLite 和 OpenClaw state 保持不变。

### 场景 3：升级时存在 legacy 自定义 Skills

**Given** 旧安装目录 `resources\SKILLs` 中存在不属于旧版内置清单的目录
**When** 用户升级
**Then** content guard 仅把 exact legacy Skill paths 标为待保护
**And** 安装器先停止目标安装树相关进程，再重新扫描 legacy candidates
**And** 安装器从对应旧 source 把这些目录复制到本次 attempt 的 staging
**And** 校验备份数量和内容
**And** protection receipt 覆盖全部 candidates 且复验通过
**And** 仅在备份成功后替换旧安装
**And** 新版本启动后这些 Skills 位于正式用户 Skills 根目录或仍有可恢复副本。

### 场景 4：legacy Skills 备份真实失败

**Given** 确认存在 legacy 自定义 Skills，但目标磁盘不可写、空间不足或
复制校验失败
**When** 安装器执行预检
**Then** 在重命名旧目录前中止
**And** 旧安装保持原状
**And** 错误明确显示“旧用户 Skills 备份失败”及日志位置。

### 场景 5：外部辅助程序无法启动

**Given** PowerShell 或未来安装辅助程序被策略阻止
**When** 某个关键步骤需要启动它
**Then** operation result 为 `helper-launch-failed`
**And** shared failureKind 为 `external-program-policy-blocked`
**And** 不得显示为文件复制失败
**And** 如果当前场景没有需要保护的数据，应继续可独立完成的流程
**And** 如果数据风险无法排除，应在破坏旧安装前中止。

### 场景 6（P0.5）：停止旧进程失败

**Given** 旧安装根内任一可执行进程拒绝退出
**When** 用户升级或覆盖安装
**Then** 安装器只处理 executable path 位于 action plan destructive
roots 边界内的进程
**And** 排除当前 installer/helper PID
**And** 验证仍有目标进程时中止
**And** 错误显示“无法停止旧版本”，而不是 Skills 错误。

### 场景 7：安装失败并成功回滚

**Given** 旧目录已经 staged，新 payload 写入或验证失败
**When** 安装器执行回滚
**Then** 旧版本恢复到原路径
**And** 可信应用内更新且非静默时，安装器以原用户身份恢复启动旧应用
**And** 企业 `/S` 且没有可信 relaunch intent 时不弹出应用窗口
**And** 旧应用拉起失败只记录独立警告，不反转已成功的文件回滚
**And** 旧应用重新启动后显示“更新失败，旧版本已恢复”
**And** 不自动重复运行同一安装包。

### 场景 8：安装失败且回滚失败

**Given** 新 payload 写入后失败，旧目录也无法自动恢复
**When** 安装器退出
**Then** 不删除旧备份或部分新安装
**And** 日志和 UI 显示旧备份、部分安装和诊断日志的位置
**And** 禁止自动重试和继续清理。

### 场景 9（P0.5）：全用户安装的 canonical control/log

**Given** 安装模式为 all users，NSIS shell context 指向公共目录
**When** 安装或更新失败
**Then** `.onInit` bootstrap 事件具有可关联的 bootstrap ID
**And** 最终 scope 确定后补记到 ProgramData 的 canonical attempt log
**And** 后续事件只写 canonical 日志
**And** trusted handoff 已绑定 original SID 时，LobsterAI 可同时导出用户
目录和其有权只读的公共日志；无绑定时提示需提权收集
**And** 不把公共 `%APPDATA%` 当作当前用户的正式 Skills 根目录。

### 场景 10：用户卸载但保留数据

**Given** 用户因安装故障卸载 LobsterAI
**When** 用户没有明确选择删除数据
**Then** `%APPDATA%\LobsterAI` 中的 Skills、SQLite 和 OpenClaw state 保留
**And** 修复版重新安装后可继续使用原数据。

### 场景 11（P0.5）：卸载后目标目录仍有残留

**Given** 注册项已经不存在，但目标目录仍包含 LobsterAI 文件或未知内容
**When** 用户重新运行修复版安装包
**Then** 安装器不得把它识别为 `fresh-install`
**And** 唯一、可验证且 content guard 允许的 LobsterAI 残留进入
`repair-in-place`
**And** 未知、扫描不完整或未保护内容进入 `blocked-conflict`
**And** 安装器不得自动删除或覆盖归属不明的文件。

### 场景 12（P0.5）：双注册

**Given** HKCU 与 HKLM 同时存在安装
**When** 用户尝试更新或重装
**Then** 同一物理路径且 scope 已明确时进入
`reconcile-dual-registration`
**And** payload 只替换一次，提交后再修正 stale registration
**And** 两个不同物理路径在选择前进入 `blocked-conflict`
**And** 交互用户明确选择权威 source 后重新规划，只操作选中安装
**And** `/S` 或无法确定的 `--updated` 保持 typed fail
**And** 另一份真实安装不被自动删除或合并。

### 场景 13（P0.5）：手动换目录重装

**Given** 注册项指向有效旧路径，用户在向导或显式 `/D` 选择空的新目标
**When** 用户确认重装
**Then** 安装器识别为 `relocate-reinstall`
**And** 分别记录唯一 source 和 target
**And** 旧 source 进入 attempt-scoped staging，新 payload 写入 target
**And** 失败时恢复旧 source
**And** `--updated` 路径 mismatch 不会在缺少可信 target 元数据时自动
解释为 relocation。

### 场景 14：上一次安装遗留 Skills 备份

**Given** 上一次失败留下已验证或未完成的 Skills 备份
**When** 用户开始新的全新安装或更新
**Then** 新安装生成新的 `attemptId` 和 staging
**And** 只恢复本次 attempt 创建且 manifest 验证通过的备份
**And** 历史备份仅作为人工恢复证据，不会自动串入本次安装。

安装目录自建文件夹的 Given/When/Then、卸载语义和恢复区验收全部移至
[独立内容保护 spec](../windows-install-root-foreign-content-protection/2026-07-24-windows-install-root-foreign-content-protection-design.md)。

## 5. 功能需求

### FR-1：安装动作判断必须前置

`customCheckAppRunning` 进入后必须先执行只读 preflight，再决定是否：

- 停止旧进程；
- 检查 legacy Skills；
- 调用外部程序；
- 重命名旧目录；
- 运行兼容旧卸载器。

preflight 不得修改文件、注册表或进程状态。

P0 至少可靠区分 `fresh-install` 与“可能存在旧安装”，并保持其他现有
fallback 行为。P0.5 再根据启动来源、`--updated`、`/S`、当前 scope、
HKCU/HKLM INSTALL/UNINSTALL key、`InstallLocation`、`UninstallString`、
source/target footprint、路径一致性和 content guard 结果选择 3.1 的
完整动作。该判断必须位于当前
`stopLobsterAIProcesses` 和 Skills PowerShell 调用之前。

### FR-2：全新安装不得执行旧数据保护流程

`fresh-install` 必须满足：

- 不调用停止旧 LobsterAI 的外部命令；
- 不启动 legacy Skills 备份程序；
- 不创建 `skills-backup`；
- 不出现“previous installation”类提示；
- 不初始化旧目录 rollback 状态为已启动。

只有“两 hive 均无可用 INSTALL/UNINSTALL 证据、无法从 `UninstallString`
反推出旧 source，且目标目录不存在或为空”才能进入 `fresh-install`。
如果安装失败，只能清理由本次 attempt 创建并在 manifest 中登记的文件。

### FR-3：可信系统工具解析

P0 必须提供单一、按工具类型返回绝对路径的
`ResolveTrustedSystemTool` 入口。PowerShell 解析顺序为：

1. 32 位安装器运行在 64 位 Windows 时优先检查
   `%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe`；
2. 其余场景检查
   `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，仅在明确
   需要 32 位 PowerShell 时考虑 `SysWOW64`；
3. 确认候选是 Windows 系统目录下的普通文件，不是目录或 reparse point；
4. 不按 PATH 搜索并直接执行同名程序，避免解析到用户可控路径；
5. 记录解析来源、最终路径、文件存在性和失败原因；
6. 所有同步和异步 PowerShell 调用必须复用同一绝对路径结果。

同一个 resolver 还必须覆盖 `tar.exe`：

1. 32 位 NSIS 运行在 64 位 Windows 时，优先解析
   `%SystemRoot%\Sysnative\tar.exe`，避免 WOW64 把 `$SYSDIR` 重定向到
   `SysWOW64`；
2. 其余场景解析真实 `%SystemRoot%\System32\tar.exe`；
3. 存在性检查、能力检查和最终执行必须复用同一个已验证路径，禁止
   “检查 System32、执行 `$SYSDIR`”；
4. tar 不存在或启动失败时才进入现有 Electron extractor fallback，并
   记录独立 typed result。

`scripts/nsis-installer.nsh` 和 `src/main/libs/appUpdateInstaller.ts` 中不得
继续出现没有经过统一解析的裸 `powershell` / `powershell.exe` 运行路径；
NSIS 中也不得直接以 `$SYSDIR\tar.exe` 作为可信 tar 的最终路径。

P0 必须覆盖本次现场：PowerShell 不在 PATH、但可信系统绝对路径存在。
PowerShell 完全不存在或被策略阻止时，fresh install 应跳过 Defender 等
可选能力。如果 system tar 也不可用而需要 Electron 解压 fallback，必须
记录 typed extractor operation failure。P0 不再把 archive/script 存在
视为安装成功：无法在安装阶段完成运行时解压时整体失败并安全回滚，不得
笼统当成成功或卡死。P1 的原生 watchdog 才承诺关键路径完整摆脱
PowerShell。路径不得拼入可解释的 shell 脚本文本，必须通过参数数组、
环境变量或受约束 helper 传递。

### FR-4：外部程序启动错误不得与子进程退出码混淆

raw launch result 必须区分：

```text
helper-not-found
process-start-blocked
process-timeout
process-termination-failed
process-state-unknown
numeric-exit-code
output-validation-failed
```

NSIS 返回的字符串 `error` 必须先单独判断，不能交给数值比较后被当成
退出码 0。

三层命名不得混用：

| 层级 | 示例 | 用途 |
|---|---|---|
| raw launch result | `helper-not-found`、`process-start-blocked` | NSIS/helper adapter |
| operation result | `helper-launch-failed`、`backup-copy-failed` | Skills/进程等领域步骤 |
| shared failureKind | `external-program-missing`、`external-program-policy-blocked`、`external-program-timeout` | attempt、UI、日志 |

raw result 到 operation result、再到 shared failureKind 的映射必须集中测试，
不能由每个调用点自由命名。

P0-hotfix 不引入 durable secure control journal。它必须保留现有
PowerShell `Start-Process`、600000ms hard total timeout、超时终止 child
和等待退出的语义，并在 NSIS adapter 中至少把以下结果分开：
`nsExec=error`、wrapper launch exception、wrapper timeout 控制结果、
numeric child exit、运行时文件验证失败。若为兼容现状保留 numeric `124`
wire value，wrapper 的 timeout 控制分支还必须同时输出一个与 child
退出码分离的固定 marker；只有 marker 与 `124` 同时成立时才可解释为
timeout，任意 child exit 124 仍属于 child failure。P0 不得把 wrapper
改成没有等价 hard timeout 的直接 `nsExec`。

P0.5 的 watchdog 安全加固必须使用不与 child 退出码共用命名空间的结果协议：

1. `nsExec` 自身返回字符串 `error` 时记录 adapter launch error；
2. wrapper 用 `try/catch` 区分 `Start-Process` exception；
3. wrapper 在由安装器内部按 secure canonical control 根和 `attemptId`
   派生的两个独立固定文件中写协议；不得接收任意结果路径。child 创建后
   必须先原子写 `watchdog-start`（含规范化 image path、PID、process
   creation time、受限命令行 digest、attemptId、nonce），再等待，并用
   temp + rename 原子写 `watchdog-result`
   `schemaVersion`、`attemptId`、`kind`、`childExitCode`、
   `win32Error` 和 nonce；
4. `kind` 只能为 `process-start-blocked`、`process-timeout`、
   `process-termination-failed` 或 `child-exit`；
5. hard timeout 后必须 terminate、wait 并验证 child 已退出，验证成功才
   返回 `process-timeout`；
6. 终止或验证失败返回 `process-termination-failed`，在 child 仍可能写
   安装树时禁止 commit、rollback 和 cleanup，保留旧树/staging/诊断并
   引导重启后恢复；
7. numeric `124` 不再作为唯一控制信号，避免与合法 child exit code
   冲突；
8. 最终结果缺失、截断、nonce/attempt 不匹配或字段非法先映射
   `output-validation-failed`，再读取 start journal。只有能证明 child
   从未启动，或已对 journal 中经 identity 验证的 child 完成
   terminate/wait/verify，才可按普通 extractor failure 回滚；否则升级为
   `process-state-unknown`，采用与 termination failure 相同的冻结策略；
9. `process-termination-failed` 和 `process-state-unknown` 必须稳定非零
   退出，终止当前 electron-builder section，禁止 finish/`--force-run`、
   注册提交、自动启动新应用和自动重试。重启后只允许显式受控恢复入口：
   先确认 child 不存在，再按 attempt 元数据检查 source/staging/partial
   target 并执行 rollback 或 repair，不得直接清理现场。

`watchdog-start` 在 attempt 收敛前不得被 final result 覆盖或删除；验证
进程身份时必须组合 PID、规范化 image path 和 creation time，不能只凭
可能复用的 PID。P0.5 安装器 `.onInit` 在普通 fresh/existing 判断前必须检查
同一 product/target 的未收敛 secure control record：

1. 记录仍指向存活或无法排除的 child 时返回 `process-state-unknown`，
   不得进入 stock fallback；
2. 确认 child 已消失后，根据受保护 attempt 元数据检查 source、staging
   和 partial target；
3. upgrade 只在旧 source/staging 关系可证明时 rollback；fresh 只在
   preflight 证明 target 原为空且 attempt ownership marker 匹配时，把
   整个 partial target 原子 rename 到 attempt-scoped quarantine 并保留；
   P0 不递归删除其中内容，rename 失败则继续冻结；
4. 无法证明安全恢复时继续冻结并展示人工恢复信息；
5. 恢复完成后原子写 settled result，才允许显式重试进入普通安装流程。

受控恢复不能从普通日志或命令行猜路径。安装器必须在同一 admin-only
`control\<attemptId>` 下，用 temp + flush + rename 维护独立
`recovery-journal`，并在每次 mutation 前先持久化。journal 至少包含：

```text
schemaVersion
attemptId
productId
targetVersion
action
scope
phase
canonicalSourceRoots
canonicalTargetRoot
stagingRoot
backupRoot
partialTargetRoot
targetWasAbsentOrEmpty
attemptOwnershipMarker
mutationStarted
childIdentity
updatedAt
```

所有路径必须由安装器从已验证 action plan 和固定 attempt 根派生，重启后
再次规范化并验证边界、reparse、ownership marker 与真实文件状态；不得从
任意 CLI path、用户可写 attempt/log 或未验证注册值覆盖。journal 缺失、
损坏、phase 与磁盘状态冲突或 ownership proof 不成立时继续
`process-state-unknown`，不自动 rollback/delete。

### FR-5：进程停止必须按安装路径限定

P0 的 fresh 路径完全跳过进程停止，不扩大现有停止范围。P0.5 对升级、
修复和换目录重装执行以下规则：

- content guard preflight 没有除 legacy Skill candidates 外的阻断内容；
  此时只形成候选计划，不要求也不接受 pre-stop protection receipt；
- 从最终 action plan 取得所有 `destructiveSourceRoots`；换目录重装至少
  包含旧 source，非空且将被覆盖的 target 也必须单独纳入检查；
- 枚举 executable path 位于上述规范化根边界内的所有进程，不使用
  `LobsterAI`、`node`、`python` 名单；
- 路径比较大小写不敏感且带目录分隔符边界；
- 排除当前 installer 和受信任 helper PID；
- 不得仅按进程名杀掉其他安装目录中的进程；
- 停止后按根重新枚举并确认目标进程已退出；
- 无法取得进程路径或验证失败时，在替换旧目录之前保守中止。

目标进程全部退出后，必须按 FR-9 重新扫描、保护 legacy candidates 并
执行 content guard 最终复验。停止进程本身不授权任何文件 mutation；
post-stop protection receipt 缺失或失效时仍然中止。

P0.5 可使用解析后的系统 PowerShell；P1 使用 Restart Manager、Windows
API 或签名 helper，以识别“exe 在树外但加载了树内 DLL”的锁持有者。

### FR-6：legacy Skills 检查必须先判断源目录

P0 保持当前 selected-scope 兼容路径，在启动任何外部程序前先检查：

```text
$INSTDIR\resources\SKILLs
```

源目录不存在时：

```text
status=legacy-source-not-present
```

并继续安装。

P0.5 不得把 `$INSTDIR` 一律当作 legacy source。它必须遍历 action plan
中每个唯一 `destructiveSourceRoot`，检查：

```text
<canonicalSourceRoot>\resources\SKILLs
```

`relocate-reinstall` 的 legacy source 是旧注册/`UninstallString` 解析出的
source，不是新 target；不得从 target 猜测或导入 legacy 数据。检查结果、
backup manifest 和 protection receipt 都必须绑定 canonical source root
与 rootId。任一 destructive source 未检查完整时不得 stage/删除。

### FR-7：legacy Skills 结果必须分类

结果枚举至少包含：

```text
legacy-source-not-present
legacy-no-extra-skill-directories
legacy-no-user-skills
legacy-backup-succeeded
legacy-protection-receipt-issued
legacy-helper-launch-failed
legacy-inspect-failed
legacy-backup-copy-failed
legacy-backup-verify-failed
legacy-restore-failed
```

结果不得只使用 `0` / 非 `0` 两类表达，也不得复用跨领域通用“无须执行”
状态。content guard、legacy migration、registration repair
和通用 phase skip 必须分别使用自己的常量对象与状态字段。

### FR-8：fail-closed 只用于真实或无法排除的数据风险

| 结果 | 是否继续 |
|---|---|
| `legacy-source-not-present` | 继续 |
| `legacy-no-extra-skill-directories` | 继续；只表示没有额外顶层 Skill 目录 |
| `legacy-no-user-skills` | 继续 |
| `legacy-backup-succeeded` | P0 可按既有流程继续；P0.5 只可继续生成/校验 receipt，未放行 mutation |
| `legacy-protection-receipt-issued` | 只可进入 content guard 最终复验；复验前未放行 mutation |
| `legacy-helper-launch-failed` 且源目录不存在 | 继续 |
| `legacy-helper-launch-failed` 且源目录存在、无法判断是否有用户数据 | 中止 |
| `legacy-inspect-failed` | 中止 |
| `legacy-backup-copy-failed` | 中止 |
| `legacy-backup-verify-failed` | 中止 |
| `legacy-restore-failed` | 按旧目录是否可回滚处理 |

禁止把所有 `exit != 0` 统一转换为 `skill-backup-failed`。

P0.5 可为已验证发布来源内置版本绑定的纯文本内置 Skills allowlist，并用
NSIS 原生枚举得出 `legacy-no-extra-skill-directories`。该 fast path
仅在以下
条件全部满足时成立：

1. 注册表或可信安装元数据能唯一确认旧版本；
2. 使用的是对应旧版本真实产物清单，不是新版本当前清单；
3. 所有现存目录均在旧版清单中；
4. 不存在 reparse point、枚举错误或未知目录。

任一条件不满足仍走正常检查或 fail closed。name-only allowlist 不能识别
用户修改或替换了同名内置 Skill 的内容，因此不得把该结果解释为“目录树
与官方 payload 完全一致”。产品把同名内置 Skill 路径视为 app-managed，
升级可替换；如果未来需要保护这类修改，必须引入内容 hash/manifest，而
不是扩大本 fast path 的含义。

该优化只减少 Skills 检查对 PowerShell 的依赖，不能替代进程停止和解压
watchdog，因此不应表述为“PowerShell 完全不可用时升级一定成功”。

### FR-9：legacy Skills 备份必须事务化

P0 保持最小兼容路径，但 P0.5 的候选发现与正式保护必须分成两个时点：

```text
Pre-stop read-only candidate scan
  -> Stop target processes
  -> Post-stop full rescan
  -> Protect and verify exact candidates
  -> Final content-guard revalidation
  -> Mutation
```

pre-stop 扫描只能决定是否需要停进程和保护，不能生成允许 mutation 的
receipt。停进程后的重新扫描必须覆盖 shutdown hook 可能新增或修改的内容。

正式备份流程必须：

1. 每个 source 使用包含本次 `attemptId` 和 `rootId` 的唯一 staging 和
   backup 目录，物理结构为 `<attemptId>\<rootId>\...`；
2. 不先删除上一次已验证备份；
3. 复制候选 legacy Skills；
4. 对 exact candidate 子树校验完整相对路径集合、目录/文件数量，并强制
   计算每个文件的 SHA-256（或等价强字节摘要）；“关键文件”或可选摘要
   不能作为完整性证明；
5. staging 校验成功后原子替换本次正式备份；
6. 失败时清理未完成 staging，但保留既有有效备份；
7. 日志记录检测数量、复制数量和验证数量；
8. 只有恢复或迁移验证完成后才能删除备份。
9. 为本次备份写 manifest，至少包含 `attemptId`、来源路径、旧版本、
   Skill 名称列表、创建时间、文件统计和校验结果。
10. 恢复时验证 manifest 与当前 `attemptId` 一致，禁止采用固定
    `skills-backup` 或历史 attempt 目录。
11. cleanup 只能接收并删除当前 manifest 中的精确路径，禁止通配符清理。
12. P0.5 只能根据 post-stop 重扫确认的 exact legacy Skill candidate 生成
    protection receipt，至少绑定 `attemptId`、rootId、canonical source、
    guard snapshotId、精确相对路径集合、备份目标、逐文件强摘要、文件
    统计和校验结果。
13. content guard 必须确认 receipt 覆盖该 source 下全部 legacy candidate、
    不覆盖其他 foreign 路径且目录快照未变化，才把该根升级为
    `foreign-content-protected`；receipt 不等于通用 foreign 保护能力。
14. 紧邻 mutation 前，重新计算每个 post-stop candidate source 文件的
    强摘要并与 receipt/backup 比较；任一字节不一致都使 receipt 失效并
    进入 `FailedBeforeMutation`，即使 size/mtime 没变化。

旧 `skills.config.json` 缺失或损坏时，不得假定所有目录都是内置目录；
应采用保守策略保护所有无法确认归属的候选目录。

如果 legacy Skill 与新内置 Skill 或正式用户 Skill 同名，不得静默覆盖或
丢弃。实现必须保留冲突副本，记录 `already-present`、`same-content` 或
`name-conflict`，并让应用在真实用户上下文完成最终导入。

### FR-10：安装目录替换与回滚语义保持

P0 是过渡版本：保留当前 fast rename/rollback 以及 selected-scope stock
fallback，不扩大 destructive 行为，也不对 stock fallback 新增其本来没有的
事务承诺。

P0.5 进入事务替换前必须按 action 证明 source eligibility：

- `update-in-place`：同 scope 注册 source 与 target 匹配；
- `repair-in-place`：无注册，但 target 是唯一可验证 LobsterAI footprint；
- `relocate-reinstall`：旧 source 与新 target 都唯一且分别验证；
- `reconcile-dual-registration`：两个注册项指向同一物理 source，scope 明确。

进入 P0.5 替换流程后必须保持：

- 切换当前目录到 `$PLUGINSDIR` 后再 rename；
- `MoveFileW` 返回值和真实 Win32 错误码；
- rename 后源目录消失、备份目录存在的双向验证；
- payload、新主程序、卸载器、`app.asar` 和实际运行时入口校验；
- 受控失败调用统一 rollback；
- 回滚失败时不删除任一恢复来源；
- 只有 `committed`，且 P0.5 install-root content 状态为
  `safe-to-replace` 或 `foreign-content-protected` 后，才清理本次
  精确旧目录中的 app-owned 内容。

P0.5 的 `StageOldInstall` 调用失败时：若 `MoveFileW` 未发生且 source
验证未变化，可在 mutation 前 typed fail；若 move 已成功但后置双向验证
失败，mutation 已发生，必须立即进入 rollback。两种情况都不得降级到无
完整旧树回滚的 destructive stock uninstaller。上述保证适用于四个事务
action，不能只覆盖 `--updated`。`blocked-conflict` 不得进入替换。
rollback 开始前不得删除唯一恢复源；rollback 失败后不得继续清理旧树、
失败树、Skills 备份或诊断状态。

### FR-11：资源解压 watchdog 语义必须保留

现有 PowerShell wrapper 不是普通启动包装，而是为“安全软件冻结新落盘
Electron extractor”增加的既有回归保护。任何替换方案必须保持：

1. 600000ms hard total timeout，不是“无输出 idle timeout”；
2. 超时后 terminate、wait 并验证 child 已退出；
3. FR-4 的 `helper-not-found` / `process-start-blocked`、
   `process-timeout`、`process-termination-failed` 和 numeric child exit
   code 独立分类；
4. 超时或失败后保留 archive 和诊断/人工恢复 script，但二者存在本身
   不是首启可恢复或安装成功的充分条件；
5. 运行时入口存在且验证通过时才判定 ready；
6. P0 中 extractor 启动失败、超时、非零退出或运行时验证失败都返回稳定
   非零安装结果：确认 child 已退出后，升级沿用并验证既有旧版本回滚；
   fresh install 不新增递归删除、quarantine 或恢复区协议，只按现有安装
   失败边界保留可用诊断 artifact；
7. current-user 和 all-users 均不得依赖非提权首启原地解压，尤其禁止通过
   放宽 Program Files ACL 解决；
8. P0.5 中 child 终止失败或结果使 child 状态未知时按 FR-4 的 secure
   journal 保留现场，不得并发 rollback/cleanup，也不得启动部分新应用。

NSIS `nsExec /TIMEOUT=` 收到输出会重置计时，不能单独证明满足 hard total
timeout。方案分期：

- P0：保留现有 wrapper 和 10 分钟 hard timeout/terminate/wait 语义，
  调用统一解析的可信 PowerShell 绝对路径，并在 adapter 层区分
  launch error、wrapper timeout、numeric child exit 和验证失败；不得为
  追求“去 PowerShell”改成可能永久阻塞的直接 `nsExec`，也不产生新的
  recovery-pending 成功结果；
- P0.5：引入 FR-4 的 secure start/result/recovery journal、
  terminate/wait/identity verify、unknown-state freeze 与 fresh
  quarantine；
- P1：使用 `CreateProcessW + WaitForSingleObject(600000) +
  TerminateProcess` 或签名 helper，移除该关键路径的 PowerShell 依赖，
  在安装提交前完成并验证解压。

### FR-12：非关键操作必须 best-effort

以下失败不得阻断已经可用的新安装：

- 添加、查询或删除 Defender exclusion；
- 删除已经提交后的旧目录；
- 清理历史诊断日志；
- 清理不再使用的临时 staging。

这些步骤必须记录 `skipped`、`launch-failed` 或 `cleanup-deferred`，并由
后续启动或下一次安装按精确路径重试。

“best-effort”只表示清理失败不反转已经成功的安装。P0.5 接入独立
content guard 后，未取得允许结果时必须保留旧树；P0 只能保持现有清理
边界，不得新增或放宽递归删除。

### FR-13：建立安装尝试闭环

每次安装尝试必须确保存在稳定 `attemptId`：

1. 安装器可接收经过严格格式校验、且不包含路径的可选 app attempt ID；
2. 未收到时必须由安装器自行生成；
3. 7.17 首跳、手动安装和 `/S` 均不得依赖 launcher 传入；
4. P0 直接生成 Windows GUID；NSIS 推荐通过
   `System::Call 'ole32::CoCreateGuid'` 获取，并按规范 UUID 文本编码。
   PID + tick 只能出现在诊断字段，不能作为 ID 或随机性来源；
5. 同一 ID 贯穿日志、Skills staging、旧树 backup、rollback 和 status。
6. ID 必须在 `.onInit` 第一条 bootstrap 日志之前生成；任何 inner/UAC
   relaunch 必须转发并复用，`customCheckAppRunning` 只 ensure/reuse。

`attemptId` 是关联标识，不是安全 secret。P0.5 开始，任何跨提权
watchdog/control/handoff 还必须独立生成至少 128-bit CSPRNG
`securityNonce`，使用 Windows CSPRNG（例如 `BCryptGenRandom`；经封装并
测试的系统随机 API 亦可），不得从 attemptId、PID、时间或路径派生。
nonce 只进入 admin-only control record，不进入普通日志或用户可写
attempt 文件；inner/UAC worker 复用受保护 handoff 中的 nonce，不自行
替换。

阶段边界必须显式：P0 只落地 GUID 生成、跨 relaunch 复用和现有日志关联；
下面的 durable phase/outcome、secure control、quarantine 与 recovery
闭环属于 P0.5/P1，除非条目另行标注。P0 不得为了“先写齐状态”引入
`recovery-required`、fresh quarantine 或 ProgramData control journal。

当前 P0 构建仍使用 `RequestExecutionLevel admin`：Windows 在执行任何
NSIS 指令、进入 `.onInit` 之前完成 manifest 提权，因此常规路径没有一个
先生成 attemptId、随后再被 UAC inner process 替换的外层 NSIS attempt。
修复版仍必须在 Windows 真机日志中证明这一点：同一次安装只能出现一个
GUID。若生成模板或 UAC 插件实际产生 `.onInit` 之后的新进程，则发布阻断，
必须显式转发并复用原 GUID，不能用“通常不会 relaunch”作为豁免。未来若
权限模型 ADR 把 current-user 安装改为 `asInvoker`，跨进程 handoff 必须在
该架构变更前落地。

attempt 关联：

```text
schemaVersion
attemptId
targetVersion
installerHash
invocationSource
appUpdateSource
updatedFlag
uiMode
launcherFallback
registryTopology
targetContent
sourceResolution
action
installScope
phase
outcome
failureKind
rollbackStatus
contentGuardResults
registrationRepairStatus
installerExitCode
win32Error
startedAt
updatedAt
logPath
```

推荐阶段：

```text
started
candidate-roots-resolved
content-guard-preflight-completed
action-planned
preflight-complete
target-processes-stopped
post-stop-content-rescanned
legacy-data-protected
content-guard-final-revalidated
old-install-staged
payload-installed
new-install-validated
committed
registration-reconciled
registration-repair-deferred
mutation-frozen
rollback-succeeded
rollback-failed
completed
```

安装完成结果：

```text
succeeded
succeeded-registration-repair-deferred
failed-partial-quarantined
recovery-required
```

`succeeded-registration-repair-deferred` 表示 payload 已提交但注册信息
仍待收敛，不是完整终态。runtime 未完成解压或验证时不得进入成功结果；
P0/P1 都必须在提交前把运行时准备完成，或返回失败/回滚。

`recovery-required` 是已知、持久的 mutation-frozen 结果：attempt 已记录
`process-termination-failed` 或 `process-state-unknown`，现场未 commit、
未 rollback、未 cleanup，只允许 FR-4 的受控恢复入口消费。
`failed-partial-quarantined` 表示 fresh install 的 partial target 已整体
rename 并保留，安装失败但不再占用原 target。

失败/取消终态：

```text
preflight-failed
rollback-succeeded
rollback-failed
uac-declined
interrupted-unknown
```

阶段、终态和失败类型必须通过共享常量定义，不得在主进程、renderer 和
安装器桥接代码中重复裸字符串。

### FR-14：确定性失败不得自动无限重试

本 FR 的 durable retry suppression、repair-only、recovery-only 和
quarantine 消费逻辑属于 P0.5/P1。P0 只保持现有 ready 状态兼容，不新增
持久恢复状态，也不能把已知安装失败伪装成成功。

应用或 launcher 恢复 attempt 状态时：

- `succeeded`：清除 ready file 和对应 attempt 记录并展示成功；
- `succeeded-registration-repair-deferred`：payload 已提交，不重新执行
  安装。P0.5 只有在用户明确触发受限、可提权的 repair-only 入口时才修复
  stale registration，不得由非提权 app 静默后台重试；
- `recovery-required`：禁止普通安装重试、stock fallback、自动启动和
  cleanup；下一次显式运行先进入受控恢复。upgrade 恢复成功后转
  `rollback-succeeded`，fresh quarantine 成功后转
  `failed-partial-quarantined`；P1 只有在完整验证新安装后才可转
  `succeeded`；
- `failed-partial-quarantined`：展示隔离路径，不自动删除；用户明确重试
  可创建新 attempt，隔离目录由后续 content guard/manifest 或人工处理；
- `preflight-failed`：保持安装包但进入明确失败状态，只允许用户主动重试；
- `rollback-succeeded`：展示旧版本已恢复；
- `rollback-failed`：禁止自动重试；
- 没有终态：标记 `interrupted-unknown`，先执行恢复检查，再允许用户
  主动重试。

应用下载路径中，相同 `targetVersion + installerHash + failureKind` 不得
自动重新运行。standalone/manual 安装的 `installerHash` 可以为空，不使用
该自动重试合同；进入 app attempt 前必须有 hash。
服务器发布更高版本或安装包 hash 变化后，可以重新进入下载/安装流程。
`uac-declined` 是用户取消，不计入确定性安装失败，但也不得在没有新的
用户操作时立即自动弹出 UAC。

P0.5 registration repair-only 入口必须：

- 按 hive 分成两个执行入口，不能让始终 `requireAdministrator` 的 NSIS
  同时写原用户 HKCU；
- HKCU repair 由原始用户上下文中的非提权 app/asInvoker helper 执行，只
  写固定 LobsterAI 用户级 key；不得经过可能切换账户的 UAC worker；
- HKLM repair 才使用用户明确触发的提权 NSIS/worker，只写固定机器级 key，
  且禁止顺手修改当前提权账户的 HKCU；
- 两个入口都只接受固定 repair operation、严格格式的 `attemptId` 和
  scope，不接受任意注册路径或安装路径；
- 从当前已验证的 LobsterAI payload、固定产品 ID 和 canonical 安装根
  自行推导注册值；
- 只修注册，不执行 payload、旧树清理、Skills 迁移或 content mutation；
- 成功后收敛状态，失败保持 deferred 并给出人工处理入口。

### FR-15：安装器错误模型

共享失败类型至少包含：

```text
action-ambiguous
update-url-untrusted
external-program-missing
external-program-policy-blocked
external-program-timeout
uac-declined
process-stop-failed
legacy-skill-discovery-failed
legacy-skill-backup-failed
old-install-stage-failed
legacy-uninstaller-failed
content-guard-blocked
payload-install-failed
runtime-extract-failed
runtime-extract-timeout
runtime-extract-termination-failed
runtime-extract-process-state-unknown
legacy-skill-restore-failed
new-install-validation-failed
rollback-failed
interrupted-unknown
```

用户可见文案由 `failureKind + action + rollbackStatus` 决定，不直接
展示原始内部错误作为标题。content guard 的细分失败类型由独立 spec 定义。
`old-app-relaunch-failed` 是 rollback 后的 warningKind，不得覆盖
`rollback-succeeded` 终态。

### FR-16：日志路径必须稳定且可导出

分期边界：

- P0-hotfix 保留现有 current-user/all-users 日志落点，修复覆盖写问题并让
  每条关键事件携带 GUID attemptId；不新建 secure control、original SID
  ACL 或跨账户 canonical handoff；
- 以下 ProgramData `control`/`logs` 分离、bootstrap 补记、original SID
  ACL 和提权 collector 契约属于 P0.5/P1，且必须等待权限模型 ADR 批准。

日志必须包含：

```text
attempt_id
bootstrap_id
installer_version
invocation_source
updated_flag
ui_mode
launcher_fallback
registry_topology
target_content
source_resolution
action
install_mode
phase
status
failure_kind
exit_code
win32_error
elapsed_ms
```

P0.5+ 目标路径规则：

- 当前用户安装：固定 `%APPDATA%\LobsterAI\Installer`；
- 全用户安装：固定 `%ProgramData%\LobsterAI\Installer`；
- 不论最终 scope，任何驱动提权 commit/rollback 的 watchdog/control 状态
  都固定写 `%ProgramData%\LobsterAI\Installer\control\<attemptId>`，
  绝不写普通用户可修改的 `%APPDATA%`；
- 应用内更新 attempt 结果：由非提权的用户态 launcher 写入当前用户
  `userData/updates/attempts`；
- 日志导出发现用户目录和 ProgramData 候选目录；只读取当前 token 有权
  访问的日志，无 trusted original SID ACL 时明确提示需提权收集。

`.onInit` 时最终 scope 可能尚未确定，但 `attemptId` 和 `bootstrapId`
必须在第一条日志之前生成。允许先在当前用户目录写最小 bootstrap 日志。
最终 scope 确定后：

1. current-user 以用户目录为 canonical；
2. all-users 以 ProgramData 为 canonical，不依赖提供 UAC 凭据的管理员
   profile；
3. 把 bootstrap 事件复制或补记到 canonical attempt log；
4. 后续事件只写 canonical 日志；
5. 两处日志都记录关联 ID，导出时可合并且不重复。

ProgramData 下必须分离控制状态与可导出日志：

```text
%ProgramData%\LobsterAI\Installer\control\<attemptId>\
%ProgramData%\LobsterAI\Installer\logs\<attemptId>\
```

两条路径都由提权安装器创建并验证，路径链不得包含 reparse point，owner
和写 ACL 只允许 `SYSTEM`/Administrators。`control` 包含 watchdog 结果、
nonce 和安全决策，标准用户不得写且不要求可读；安全根创建/ACL 校验失败
时，任何依赖该控制文件的关键步骤必须在启动 child 或 mutation 前中止。

`logs` 只含已脱敏诊断。只有 trusted launcher handoff 已绑定 original SID
时才给该 SID 最小只读权限；UAC 使用另一管理员凭据不改变绑定。无可信
original SID 的 standalone/all-users 安装不猜测用户，也不向
`Authenticated Users` 放宽读取：安装可继续写管理员可读日志，但普通应用
日志导出只能说明公共诊断不可访问并显示路径。P0 不为此新增提权收集器；
P1 的签名 collector 可在用户明确授权后只读打包脱敏日志，不能读取或修改
`control`。日志目录校验失败但不承载控制信号时，可退回 bootstrap 日志并
继续，不能把不可信预置目录当作 canonical status 根。

日志必须按 `attemptId` 使用独立文件，或使用不可覆盖的主索引指向
attempt 日志；不得再用 `w` 模式覆盖上一次 `install-timing.log` 或
`skill-migrate.log`。current-user 和 all-users 使用可区分的归档名。
每次外部程序调用记录解析路径、文件存在性、CreateProcess/Win32 错误和
数字退出码，但不得记录 Skill 内容、token、API key 或其他凭据。

不得允许提权安装器接收任意 `--status-file=<path>` 并以管理员权限写入，
以免形成任意路径覆盖风险。安装器只接收不包含路径的 `attemptId`，或由
非提权 launcher 负责写用户态结果。

### FR-17：用户可见文案与 i18n

至少需要区分：

- 全新安装失败；
- 无法启动系统安装辅助程序；
- 无法停止正在运行的旧版本；
- 发现旧 Skills 但无法完成备份；
- 新版本安装失败，旧版本已恢复；
- 新版本安装失败且自动回滚未完成；
- 用户取消 UAC；
- content guard 阻止 mutation，并跳转到独立 spec 定义的准确提示；
- 同一安装包上次已经失败，需要修复环境或等待新版本。

Renderer 文案必须加入中文和英文。NSIS 自身文案也必须根据安装场景选择，
不得在 `fresh-install` 中出现“previous installation was not replaced”。

### FR-18：卸载默认保留用户数据

由于正式用户 Skills、SQLite 和 OpenClaw state 都位于 userData：

- 普通卸载默认保留 `%APPDATA%\LobsterAI`；
- “删除应用”和“删除全部用户数据”必须是不同动作；
- 完全删除数据必须有明确确认；
- 应用内更新和修复安装不得要求用户先卸载。

P0 必须把当前 `deleteAppDataOnUninstall: true` 的默认行为改为保留
userData。P1 再提供独立、明确确认的“同时删除全部用户数据”卸载 UX。

### FR-19：P0.5 跨 spec 内容保护门禁

详细功能、恢复区、ownership manifest、卸载精确删除和验收已移至
[Windows 安装目录未归属内容保护设计](../windows-install-root-foreign-content-protection/2026-07-24-windows-install-root-foreign-content-protection-design.md)。

本状态机只保留不可弱化的接口契约：

1. 每个被替换、旧卸载器处理或递归删除的根必须取得
   `safe-to-replace` 或 `foreign-content-protected`；只有不存在/为空且
   仅写入的 target 可记录
   `content-guard-empty-write-only-target`；
2. `legacy-skill-protection-required` 只允许进入 FR-9 的 exact candidate
   备份/校验，receipt 复验前仍不得 mutation；
3. `foreign-content-detected`、`scan-incomplete`、
   `inventory-unavailable` 或 `manifest-untrusted` 必须进入
   `FailedBeforeMutation`；
4. 任何 stock fallback 都不得绕过该门禁；
5. content guard 失败不能被 best-effort 清理语义覆盖。

### FR-20：P0 更新 URL 最小安全策略

P0-hotfix 必须在客户端建立唯一的 Windows 安装包 URL policy，并在更新
协调器取得 URL 与下载入口分别调用，避免未来调用点绕过：

1. 只允许 `https:`；
2. 拒绝 URL username/password、fragment、非默认 HTTPS 端口、不可解析
   URL 和非 Windows installer 扩展名；
3. P0 不固定 production/test CDN origin。任意 origin 只有满足同一
   transport policy 才可继续；该结果不等价于官方来源鉴真；
4. 下载前校验输入 URL；Windows 下载必须使用 `redirect: 'error'` 禁止
   HTTP 重定向，避免依赖 Electron `session.fetch()` 明确不可靠的
   `response.url`。发生重定向时必须中止并删除本次未完成临时下载；
5. transport receipt 绑定当前 policy version，并记录相同的 input/final
   origin，表示本次下载未接受 HTTP 重定向；该 origin 不得被当作签名或
   固定 allowlist；
6. 拒绝后返回稳定 `update-url-untrusted`，不得下载、提权执行，也不得把
   接口返回的原始不可信 URL 交给系统浏览器；
7. 支持侧如需降级，只能打开产品内置、由代码固定的官方下载页；
8. 发布前通过真实 production/test 下载验证输入 URL 满足 transport
   policy、下载无需 HTTP 重定向，并记录实际 origin 供排障。

该门禁只是 P0 下限，不是完整安装包鉴真。可信服务端摘要或签名 manifest、
每跳 redirect policy、WinVerifyTrust、证书链、预期 Publisher 和时间戳
继续由独立 package-authenticity spec 定义，并作为后续发布安全门禁。
在稳定自有下载域名或签名 manifest 落地前，不宣称 P0 能防止更新接口或
下载源本身被攻陷。

### FR-21：失败后安全恢复启动旧应用

P0-hotfix 必须把“文件状态恢复”和“恢复启动旧应用”分成独立结果。只有
满足以下全部条件时，才可使用 `ExecShellAsUser`（或等价原用户 launcher）
启动恢复后的旧版：

1. 本次 invocation 具有可信 app-update handoff，或有明确且受约束的
   `--force-run`/`--updated` relaunch intent；无参数 standalone、来源为
   `unknown` 或用户双击安装包不得推断；
2. 失败发生在 mutation 前且旧树未变化，或 rollback 已验证成功；
3. 旧主程序位于 action plan 的 canonical old source，普通文件、非
   reparse point，且旧 LobsterAI footprint 验证通过；
4. outcome 不是 `recovery-required`、`process-state-unknown`、
   `process-termination-failed` 或 `rollback-failed`；
5. 恢复启动时不得继续传 `--updated`，避免旧版把失败的更新误认为成功。

静默矩阵：

| invocation | 是否恢复启动旧版 |
|---|---|
| interactive + trusted app-update/relaunch intent | 满足上述门禁时允许 |
| `/S` 且无可信 relaunch intent | 禁止 |
| `/S --force-run` + trusted handoff + 可确认交互用户会话 | 满足上述门禁时允许 |
| `/S --force-run` 但无 trusted handoff 或无交互用户会话 | 禁止 |

旧应用拉起失败只记录 `old-app-relaunch-failed` 和 Win32 error，不能把已经
成功的 rollback 改成 `rollback-failed`，也不得再次 mutation 或自动重复
安装。手动安装、企业部署和 2026.7.17 无参首跳在缺少可信 handoff 时，只
展示/记录“旧版本已恢复”，由用户自行启动。

## 6. 方案设计

### 6.1 P0：下一版安装器止血

P0-hotfix 修改保持集中，不对 1200 多行 NSIS 文件做结构拆分，不引入
durable secure control、完整 action planner 或新恢复区。由一名 DRI 在
五个工程日实现 timebox 内完成代码，测试、签名和发布门禁另计。

推荐顺序：

```text
.onInit before first log:
  EnsureInstallerAttemptGuid
  InitializeBootstrapDiagnostics

customCheckAppRunning:
1. ReuseInstallerAttemptId
2. DetectFreshOrPossibleExisting including INSTALL and UNINSTALL evidence
3. If fresh-install:
     skip process stop
     skip legacy Skills
     skip old-install staging
4. Else:
     DetectLegacySkillsSource with native existence check
     ResolveTrustedSystemTool(PowerShell)
     StopTargetProcessesUsingCurrentCompatibleFallbackPaths
     InspectAndBackupLegacySkills when applicable
5. StageOldInstall only under existing verified eligibility
6. ResolveTrustedSystemTool(tar) before extractor selection
7. installApplicationFiles writes the candidate payload
8. customBeforeRegistryAddInstallInfo runs extractor watchdog, restores the
   current-attempt legacy Skills backup, and validates the complete new tree
9. registryAddInstallInfo / shortcuts / file associations
10. customInstall finalizes commit and schedules exact old-backup cleanup
11. On safe failure, conditionally relaunch verified old app
```

关键改动：

1. 安装器自行生成/复用 GUID `attemptId`；不能等待 app 传参，且不把它
   当作 security nonce。
2. 把最小 fresh/existing 判断提到进程停止和 Skills 备份之前。
3. 全新安装使用 NSIS 原生跳转直接跳过整个备份脚本。
4. 新增统一系统工具 resolver；PowerShell 与 tar 的检查和执行分别复用
   同一个带引号绝对路径，覆盖 Sysnative/System32。
5. `nsExec` 的 `error`、hard timeout 和数值退出码分开处理。
6. 把 Skills 备份的 fail-closed 从“任何非零”改为 FR-8 矩阵。
7. 停止进程失败使用独立错误，不复用 `$R2` 后显示 Skills 文案。
8. Defender 和提交后清理失败只记录日志，且不扩大 exclusion。
9. Electron extractor 保留现有 600000ms hard watchdog、terminate/wait
   语义，wrapper 改用可信 PowerShell 绝对路径并分开 adapter launch
   error、wrapper timeout、child exit 和验证失败；禁止换成没有等价总
   超时的直接 `nsExec`。secure journal/unknown-state recovery 属于 P0.5。
10. `src/main/libs/appUpdateInstaller.ts` 使用系统绝对 PowerShell 路径并
    保留 UAC 取消识别。新 launcher 若在 fallback 前已创建受约束 attempt
    元数据，可记录 `invocationSource=app-update`、
    `launcherFallback=wizard-no-args`、`uiMode=interactive`；安装器收到的
    无参启动本身只能记录 `unknown`，不能凭猜测伪装成 update-mode。
11. legacy Skills staging、manifest、恢复和清理绑定当前 `attemptId`。
12. 普通卸载默认保留 userData；P0 保留现有日志路径并确保 attemptId
    可关联，不在 hotfix 中新建 ProgramData control/ACL 体系。
13. 添加静态契约，禁止新增未经过 resolver 的裸 PowerShell。
14. 更新 URL 在协调器和下载入口执行 FR-20 的输入/最终 HTTPS transport
    双重校验，不固定 CDN origin。
15. pre-mutation 失败或 rollback 成功后，按 FR-21 门禁恢复启动旧应用；
    无可信 intent 的 silent/manual 安装不拉起。
16. 在 electron-builder 模板增加通用
    `customBeforeRegistryAddInstallInfo` hook：资源解压、Skills 恢复和新树
    校验在注册表写入前完成；原 `customInstall` 只在注册/快捷方式完成后
    finalize、标记 committed 并清理本次精确 old backup。
17. Windows 启动恢复、缓存复用和最终提权执行前重新验证 ready installer
    的 transport receipt；缺少新策略 receipt 的旧缓存 fail closed。该
    receipt 不证明官方来源。最终提权前再次校验文件 hash，校验失败删除
    缓存并要求重新下载。

P0 不引入完整动作状态机、payload ownership manifest、foreign content
恢复区或原生 helper。`registered-install-missing`、
`install-location-mismatch` 必须保留当前 fallback；双注册则保持
selected-scope 现行路径：all-users 可进入 stock fallback，current-user
可能仍走 fast path 并留下 stale HKLM。P0 不修该历史缺口，但不能因
preflight 新增一刀切 abort。

tag `2026.7.17` 的 Windows launcher 先调用裸 `powershell.exe` 携带
update-mode 参数；`ENOENT` 等非 UAC 拒绝失败会降级为无参数
`shell.openPath`。因此 PATH 损坏的首跳会进入向导式安装；修复版安装器
必须在参数缺失时仍能处理有效旧安装。正式发布二进制仍需用 commit/hash
验证，不能只根据源码 tag 推断现场包。

P0 解决：

- 本次现场“PowerShell 不在 PATH、系统绝对路径可用”；
- 全新安装错误进入升级备份；
- launch error 被误判为 Skills 复制失败；
- extractor watchdog 的同类 PATH 风险；
- 后续版本 launcher 的同类 PATH 风险；
- 普通卸载误删 userData。

P0 不保证以下问题已经解决：

- PowerShell 被完整移除或策略彻底阻止时的所有升级和 extractor fallback；
- 注册拓扑异常的完整事务修复；
- 安装目录自建内容保护。

#### P0.5：兼容性与内容门禁

P0.5 的架构冻结及任何涉及权限边界的实现开始前，必须先批准
“Windows 安装权限模型 ADR”。ADR 至少决定：

- current-user/LocalAppData 路径是否恢复为 asInvoker、由原用户处理
  HKCU、用户日志和用户恢复；
- all-users/Program Files/HKLM 哪些固定操作进入受约束提权 worker；
- Defender exclusion 是否拆成独立、可选、best-effort 的提权操作；
- original SID、ProgramData control ACL、HKCU/HKLM repair-only 入口中
  哪些仍是必要能力，避免在权限边界未定时先建一套可能废弃的机器。

P0 继续保留当前 `RequestExecutionLevel admin`，不得在止血版直接删除。

P0.5 单独实现并评审：

1. 3.1 的正交输入和动作映射；
2. `repair-in-place`、`relocate-reinstall` 和
   `reconcile-dual-registration`；
3. 按 action plan 的全部 `destructiveSourceRoots` 边界枚举进程；
4. 版本绑定的旧版内置 Skills allowlist fast path；
5. 独立 install-root content guard。
6. `Scan -> Stop -> Rescan/Protect -> Final Revalidate -> Mutation` 顺序；
7. secure watchdog/control journal 与 unknown-state recovery。

P0.5 中的纯逻辑 action planner、writer 审计、historical inventory
取证和测试矩阵可与 P0 并行准备；任何 privileged bootstrap、original
SID、ACL、ProgramData control/recovery journal 或 repair worker 的最终
设计与实现必须等待权限模型 ADR 批准。P0.5 应拆成不同 spec/PR 和独立
测试报告，默认不与 P0-hotfix 绑定发布；只有两阶段各自门禁均通过时才可
进入同一候选包。若 P0 先单独发布，发布说明必须明确安装目录自建内容风险
尚未修复，不能宣称 Windows 安装问题已经全部解决。

### 6.2 PowerShell 调用分类

| 当前用途 | P0 | P0.5 | P1 |
|---|---|---|---|
| 停止旧进程 | 系统绝对 PowerShell，保持现有行为 | 按 action plan 的 destructive roots 枚举全部 exe | Restart Manager / 原生 helper |
| legacy Skills 检查和备份 | 源目录前置判断 + 绝对 PowerShell | 版本绑定 allowlist fast path | 原生 helper |
| legacy Skills 恢复 | 绝对 PowerShell + rollback | 同 P0 | 导入正式 userData |
| Defender exclusion | 绝对 PowerShell，best-effort，不扩大范围 | 同 P0 | 独立安全 spec |
| Electron 解压 watchdog | 绝对 PowerShell wrapper + 600000ms hard timeout | P0 语义 + secure journal、unknown-state freeze | 原生 hard watchdog |
| 旧目录异步清理 | 失败保留并记录 | 受 content guard 约束 | helper 精确清理 |
| 应用内提权启动安装器 | 绝对 PowerShell；app-side 记录 fallback，安装器无 handoff 时记 `unknown` | 同 P0 | 用户态原生 launcher |
| 卸载时 Defender 清理 | best-effort | 同 P0 | 独立安全 spec |

### 6.3 P1：签名 Windows 安装辅助程序

P1 推荐引入一个体积小、随安装包签名的 Windows helper，而不是继续在
NSIS 中实现复杂的进程枚举、JSON 解析和事务复制。

helper 的职责：

1. 枚举 executable path 位于 action plan 全部 destructive source 根内
   的进程，并结合 Restart Manager 发现加载这些安装树文件的外部锁持有者；
2. 终止并验证目标进程退出；
3. 检查旧 Skills 清单并事务备份；
4. 校验备份结果；
5. 恢复或导入 legacy Skills；
6. 在 content guard 已允许后，对本次 attempt 的精确旧路径执行清理；
7. 用户态 launcher 通过 `ShellExecuteEx(runas)` 启动 NSIS、等待退出并
   写入 attempt 结果；
8. 为 Electron extractor 提供 hard total timeout 和 child termination；
9. 返回稳定退出码和结构化诊断。

安装目录 foreign content 扫描、ownership manifest 和恢复区由独立 spec
定义。两个设计可以复用同一个签名二进制，但必须保持不同的受约束子命令、
路径根和验收，不得因为复用 helper 而合并安全边界。

helper 安全要求：

- 发布构建必须签名；
- 只接受受支持的子命令；
- 删除/停止操作只允许作用于规范化后的 LobsterAI 安装根；
- 拒绝空路径、盘符根、用户 profile 根和包含不受信任重解析点的目标；
- 枚举和迁移时不得跟随 junction、symlink、mount point 等 reparse point；
- 跨卷迁移使用 copy + verify，不能把 copy 返回成功当作完整迁移；
- 同名恢复目标不得覆盖，空间不足、锁定文件、ACL 拒绝读取必须在旧树
  删除前失败；
- 不接受提权上下文中的任意输出文件路径；
- 所有路径使用 Windows Unicode API；
- 结构化输出不得包含 token、凭据或用户文件内容。

### 6.4 用户态更新 launcher

当前应用调用 PowerShell `Start-Process` 后，只能确认安装器已经启动，
随后 app 退出；它无法等待安装器终态。

P1 中推荐由非提权 helper 负责：

```text
LobsterAI
  -> 写 userData attempt record
  -> 启动非提权 launcher helper
  -> LobsterAI 退出
  -> helper 使用 ShellExecuteEx(runas) 启动 NSIS
  -> helper 等待 NSIS 退出
  -> helper 写 userData attempt 终态
  -> 成功时由 NSIS/launcher 启动新版本
  -> 失败时 launcher 重启旧版本
```

这样：

- UAC 仍由系统处理；
- launcher 能拿到真实 NSIS 退出码；
- 用户态 attempt 文件不需要由提权安装器写入；
- 旧应用重启后可以区分已知失败和未知中断；
- 可彻底移除应用侧 PowerShell launcher。

兼容性说明：

- 从 2026.7.17/2026.7.23 之前版本升级到修复版时，旧应用不包含新 helper；
- 因此修复版安装器本身必须先做到自包含和不依赖 PATH；
- 用户成功安装修复版后，后续更新才能使用新的 launcher 闭环。

### 6.5 legacy Skills 一次性迁移

P0 保留“安装前备份、安装后恢复”的兼容策略，但修正场景和外部程序解析。

P0.5 可由修复包携带经过正式产物核验的 2026.7.17、2026.7.23 等旧版
纯文本内置目录 allowlist。NSIS 用原生 `FindFirst`/`FindNext` 与
`FileRead` 做 conservative comparison；只有旧版本唯一、目录全部命中、
无 reparse point 且枚举完整时，才能不启动 PowerShell 并返回
`no-extra-skill-directories`。

旧安装中的 `skills.config.json` 损坏不自动使 repair installer 自带的
版本化 allowlist 失效；两者是不同信任来源。只有 repair installer 自带
allowlist 缺失/损坏、旧版本未知、枚举失败或发现额外目录时，才不能使用
fast path。不能拿修复版自己的新清单推断旧版归属，也不能用目录名结论
声称同名内置 Skill 内容未被用户修改。

发现额外目录时，P0.5 legacy migration 与 install-root content guard
必须通过 FR-9 receipt 协作：backup/verify 发生在任何安装树 mutation 前，
receipt 只为精确 candidate paths 提供保护证明；guard 复验通过后才允许
继续。不能由两套模块分别把同一目录判成“已保护”和“foreign 阻断”。

P1 将 legacy Skills 迁移到正式用户根：

```text
旧安装 resources\SKILLs
  -> 识别非内置或归属不明目录
  -> staging 备份与校验
  -> 导入 userData\SKILLs
  -> 冲突处理
  -> 写 legacy-skills-migrated-v1 marker
  -> 保留备份直到新应用确认
```

冲突规则：

- 正式用户根已有同名 Skill 时不得覆盖；
- 内容一致时记录 `already-present`；
- 内容不一致时保留正式用户版本，并把 legacy 版本保存在可恢复目录；
- 旧内置清单损坏时采用保守保护，不把目录直接丢弃；
- 完成 marker 写入前不得删除旧备份。

应用内更新可由旧应用在当前用户上下文先执行迁移；手动覆盖安装和极老版本
升级由安装 helper 兜底。

all-users 模式不得把 `$APPDATA` 解释为某个用户的正式 Skills 根。此模式的
legacy 数据先进入：

```text
%ProgramData%\LobsterAI\Installer\legacy-skills\<attemptId>\<rootId>
```

并携带已验证 manifest。新应用随后在实际登录用户身份下导入
`userData\SKILLs`；导入得到确认之前，机器级兼容副本不得自动删除。

### 6.6 安装目录未归属内容保护

该问题已拆分为
[Windows 安装目录未归属内容保护设计](../windows-install-root-foreign-content-protection/2026-07-24-windows-install-root-foreign-content-protection-design.md)。

本设计只定义调用边界：

```text
ResolveCandidateRoots
  -> BuildRootsToMutate
  -> InvokeInstallRootContentGuardPreflightForEachRoot
  -> PlanFinalAction
  -> StopProcesses
  -> RescanInstallRootContentForEachRoot
  -> ProtectLegacySkillCandidatesAndIssueReceiptWhenRequired
  -> FinalRevalidateInstallRootContentGuardForEachRoot
  -> StageOldInstall / InvokeLegacyUninstaller
```

扫描、版本 allowlist、ownership manifest、恢复区、reparse point、普通
卸载精确删除和 `MyData\sentinel.txt` 验收均由独立 spec 负责。可靠性实现
不得自建第二套归属规则；P0.5 及以后不得在 stock fallback 中绕过门禁。
换目录重装必须分别保存旧 source 与新 target 的扫描结果和快照；任何将被
删除、rename 或覆盖的非空根未通过门禁时，整个动作在 mutation 前失败。

### 6.7 安装尝试数据模型

建议在共享模块定义：

```ts
interface WindowsInstallAttempt {
  schemaVersion: 1;
  attemptId: string;
  bootstrapId: string | null;
  targetVersion: string;
  installerHash: string | null;
  invocationSource: WindowsInstallerInvocationSource;
  appUpdateSource: AppUpdateSource | null;
  updatedFlag: boolean;
  uiMode: WindowsInstallerUiMode;
  launcherFallback: WindowsLauncherFallback;
  registryTopology: WindowsRegistryTopology | null;
  targetContent: WindowsInstallTargetContent | null;
  sourceResolution: WindowsInstallSourceResolution | null;
  action: WindowsInstallAction | null;
  installScope: WindowsInstallScope | null;
  phase: WindowsInstallPhase | null;
  outcome: WindowsInstallOutcome | null;
  failureKind: WindowsInstallFailureKind | null;
  rollbackStatus: WindowsInstallRollbackStatus;
  contentGuardResults: Array<{
    rootId: string;
    rootRole: 'source' | 'target';
    canonicalRoot: string;
    plannedMutation: WindowsInstallRootMutation;
    inventoryKey: string | null;
    status: InstallRootContentGuardStatus;
    snapshotId: string | null;
    legacyCandidatePaths: string[];
    protectionReceiptId: string | null;
  }>;
  registrationRepairStatus: WindowsRegistrationRepairStatus;
  installerExitCode: number | null;
  win32Error: number | null;
  logPath: string | null;
  startedAt: string;
  updatedAt: string;
}
```

所有判别值使用共享 `as const` 对象并派生类型。

NSIS 内部可以继续使用 key-value 日志，但与 app 交换的 attempt 记录必须
是版本化、自描述和原子写入的 JSON。

### 6.8 错误展示映射

| 动作 | failureKind / status | rollback | 用户信息 |
|---|---|---|---|
| 全新安装 | `external-program-missing` | 不适用 | 安装组件缺失，请重新下载安装包 |
| 全新安装 | `external-program-policy-blocked` | 不适用 | 安装组件被系统策略阻止，请联系管理员 |
| 升级 | `process-stop-failed` | 不需要 | 无法关闭旧版本，旧版本未被替换 |
| 升级 | `legacy-skill-backup-failed` | 不需要 | 旧 Skills 无法安全备份，旧版本未被替换 |
| 升级/重装 | `content-guard-blocked` | 不需要 | 使用独立内容保护 spec 的准确文案 |
| 升级 | `payload-install-failed` | succeeded | 更新失败，旧版本已恢复 |
| 升级 | `new-install-validation-failed` | succeeded | 新版本校验失败，旧版本已恢复 |
| 升级 | 任意 | failed | 自动恢复未完成，恢复文件已保留 |
| 任意 | `recovery-required` | not-started/frozen | 安装现场已安全冻结，请重启后执行受控恢复 |
| 全新安装 | `failed-partial-quarantined` | 不适用 | 安装失败，未完成文件已隔离保留 |
| 安装完成 | `registration-repair-deferred` | 不需要 | 应用已更新；注册信息需在下次明确授权或人工操作时修复 |
| 应用内更新 | `uac-declined` | 不适用 | 已取消管理员授权，可重新安装 |
| 重启恢复 | `interrupted-unknown` | unknown | 上次安装未完成，请查看安装日志 |

原始路径、Win32 错误和底层输出进入日志和可展开详情，不直接替代本地化主文案。

### 6.9 日志设计

安装日志继续保留阶段耗时，但改为 attempt-specific 文件。每一行必须携带：

```text
attempt_id=<id>
bootstrap_id=<id>
action=<action-or-unknown>
phase=<phase>
status=<status>
```

示例成功序列：

```text
phase=action-planned action=fresh-install invocation_source=standalone updated_flag=absent ui_mode=interactive
phase=target-processes-stopped status=phase-skipped reason=fresh-install
phase=post-stop-content-rescanned status=phase-skipped reason=fresh-install
phase=legacy-data-protected status=legacy-protection-not-required reason=legacy-source-not-present
phase=content-guard-final-revalidated status=content-guard-empty-write-only-target
phase=payload-installed status=success
phase=new-install-validated status=success
phase=committed status=success
phase=completed status=success
```

上述每一行实际还必须包含 `attempt_id`、`installer_version` 和
`install_mode`；示例为便于阅读省略重复字段。

P0.5 升级存在 legacy Skills，且受信 launcher 元数据明确记录了 fallback：

```text
phase=candidate-roots-resolved status=success roots=1
phase=content-guard-preflight-completed status=legacy-skill-protection-required candidates=2
phase=action-planned action=update-in-place invocation_source=app-update updated_flag=absent ui_mode=interactive launcher_fallback=wizard-no-args
phase=preflight-complete status=success
phase=target-processes-stopped status=success
phase=post-stop-content-rescanned status=success
phase=legacy-data-protected status=legacy-protection-receipt-issued copied=2 verified=2
phase=content-guard-final-revalidated status=foreign-content-protected receipts=1
phase=old-install-staged status=success
phase=payload-installed status=success
phase=new-install-validated status=success
phase=committed status=success
phase=completed status=success
```

2026.7.17 在裸 PowerShell 启动失败后通过无参 `shell.openPath` 发起
fallback 首跳时，同一序列必须改记
`invocation_source=unknown launcher_fallback=unknown`；即使应用侧可
根据旧 ready state 做弱关联，也不得把日志改写成确定的 `app-update`。

content guard 的细分日志格式、隐私规则和 recovery manifest 由独立内容
保护 spec 定义；本日志只记录门禁结果和关联 ID。

### 6.10 代码边界

P0 预期修改：

| 文件 | 责任 |
|---|---|
| `scripts/nsis-installer.nsh` | 最小 fresh/existing 前置判断、GUID attemptId、PowerShell/tar resolver、失败分类、保留 watchdog、旧应用安全 relaunch |
| `src/main/libs/appUpdateInstaller.ts` | 应用侧系统 PowerShell 解析、启动日志和下载入口 URL policy |
| `src/main/libs/appUpdateInstaller.test.ts` | Windows launcher 解析与 fallback 测试 |
| `src/main/libs/appUpdateCoordinator.ts` | Windows installer 输入/最终 URL HTTPS transport policy |
| `src/main/libs/appUpdateCoordinator.test.ts` | 动态 CDN、输入/最终 URL 与拒绝降级测试 |
| `tests/windowsInstallerContract.test.ts` | NSIS 顺序、裸 PowerShell、fail-closed 和 hard watchdog 契约 |
| `src/renderer/services/i18n.ts` | 必要的更新失败分类文案 |
| `electron-builder.json` | 普通卸载默认保留 userData |

P0.5 预期修改：

| 文件/模块 | 责任 |
|---|---|
| `scripts/nsis-installer.nsh` | 正交输入、动作规划、repair/relocate/reconcile、仅 HKLM 的受限 repair-only worker |
| app/main 或 asInvoker helper | 在原始非提权用户上下文执行固定 HKCU repair-only |
| 旧版 Skills allowlist 构建输入 | 版本绑定 conservative fast path |
| 进程停止模块 | 按 action plan 的 destructive roots 枚举全部 exe |
| install-root content guard | 由独立内容保护 spec 约束 |
| `src/main/main.ts` | 权限 ADR 批准后实现 ProgramData 日志发现、ACL 约束和显式提权收集 |
| Windows 集成测试 | 双注册、残留重装、换目录和 silent typed failure |

P1 预期修改：

| 文件/模块 | 责任 |
|---|---|
| `src/main/libs/appUpdateCoordinator.ts` | attempt 生命周期、失败恢复、重复安装抑制 |
| `src/shared/appUpdate/constants.ts` | attempt/status/failure 常量与类型 |
| `src/renderer/components/update/` | 分类错误和明确重试行为 |
| Windows helper 新模块 | 进程、Skills、受约束清理、hard watchdog、提权 launcher、显式提权日志 collector |
| `patches/app-builder-lib+24.13.3.patch` | 仅当新增/调整模板 Hook 时同步更新 |

P1 如需拆分大型 NSIS 文件，候选边界：

```text
scripts/nsis/installer-action-plan.nsh
scripts/nsis/installer-diagnostics.nsh
scripts/nsis/legacy-skills-migration.nsh
```

P0 不进行该拆分，避免紧急修复引入额外模板和宏作用域风险。

### 6.11 FR 实现与验证追踪

| FR | 阶段/级别 | 主要实现位置 | 主要验证 |
|---|---|---|---|
| FR-1–2 | P0 / Must | `nsis-installer.nsh` | fresh/existing 顺序合同、7.17 真机升级 |
| FR-3 | P0 / Must | NSIS resolver、`appUpdateInstaller.ts` | PowerShell PATH 缺失、Sysnative tar |
| FR-4 | P0 最小分类；P0.5 secure protocol | NSIS watchdog adapter/control | launch/timeout/exit 合同、冻结故障注入 |
| FR-5 | P0.5 / Must | 进程停止模块 | 多安装根、不误停、拒绝退出 |
| FR-6–9 | P0 最小兼容；P0.5 完整保护 | NSIS legacy migration | stop 后重扫、逐文件摘要、历史 attempt |
| FR-10–12 | P0 / Must | NSIS stage/rollback/watchdog | payload 失败、回滚、600000ms watchdog |
| FR-13–17 | P0 GUID/文案；P0.5/P1 闭环 | NSIS、shared constants、main/renderer | GUID/nonce 分离、typed UI、日志 |
| FR-18 | P0 / Must | `electron-builder.json` | 普通卸载保留 userData |
| FR-19 | P0.5 / Must | 独立 content guard 接口 | foreign-content spec 验收 |
| FR-20 | P0 / Must | `appUpdateCoordinator.ts`、`appUpdateInstaller.ts` | 动态 CDN、输入/最终 URL transport policy |
| FR-21 | P0 / Must | NSIS rollback/relaunch | trusted/unknown、interactive/silent 矩阵 |

## 7. 失败模型与边界情况

| 条件 | 检测 | 行为 | 数据安全 | 重试 |
|---|---|---|---|---|
| PowerShell 不在 PATH，但系统文件存在 | 绝对路径存在 | 使用绝对路径 | 不影响 | 正常 |
| PowerShell 完全不存在，fresh install | resolver 失败 | system tar 成功时继续；否则 typed fail，partial target 整体隔离保留，不依赖首启写安装树 | 无旧数据丢失 | P1 原生 helper |
| PowerShell 完全不存在，升级 | resolver 失败 | 即使 allowlist 证明无 user Skills，也必须同时满足进程和解压路径；否则替换前中止 | 旧安装完整 | P1 helper |
| 注册项不存在但目标有可信残留 | footprint + 唯一 target | P0 保留 stock fallback；P0.5 `repair-in-place` | 可回滚 | 正常或主动重试 |
| 注册旧路径、手动选择空的新目标 | source/target 验证 | P0 保留 stock relocation；P0.5 `relocate-reinstall` | 失败恢复 source | 正常 |
| HKCU/HKLM 同路径 | 双注册 + scope | P0 保持 selected-scope 现行路径；P0.5 替换一次并修注册 | P0 current-user 可能留 stale HKLM，P0.5 收敛 | 注册修复可单独重试 |
| HKCU/HKLM 不同路径 | 双注册 + footprint | 选择前 `blocked-conflict`；交互选择后只处理权威 source | 未选中安装保留 | `/S` typed fail 或交互选择 |
| content guard 非允许结果 | 独立模块 | `FailedBeforeMutation` | 旧树不变 | 按独立 spec |
| 无旧 Skills 目录 | NSIS 原生存在性检查 | 不启动迁移 helper | 不适用 | 正常 |
| 旧 `skills.config.json` 损坏 | 解析失败 | 若 repair installer 的版本 allowlist 可信，仍可 conservative compare；否则保护未知目录 | 不丢额外目录 | 保护成功后继续 |
| repair installer 自带 allowlist 缺失/损坏 | 构建期/运行时校验 | 禁用 fast path，无法检查则 fail closed | 旧树不变 | 修复包 |
| 历史 Skills 备份存在 | manifest attemptId 不匹配 | 不自动恢复 | 历史副本保留 | 不影响本次 |
| legacy Skills 复制失败 | helper/脚本结果 | 替换前中止 | 旧安装完整 | 用户处理磁盘/权限后主动重试 |
| 停止旧进程失败 | 进程重新枚举 | 替换前中止 | 旧安装完整 | 关闭占用后主动重试 |
| 旧目录 rename 失败 | MoveFileW + Win32 error | P0 保持现行 fallback；P0.5 mutation 前 typed fail，不降级 destructive uninstaller | P0 现有语义，P0.5 源不变 | 视错误 |
| payload 写入失败 | electron-builder Hook | 回滚旧目录 | 备份保留 | 主动重试 |
| 新安装校验失败 | 文件/运行时校验 | 回滚旧目录 | 备份保留 | 主动重试 |
| rollback 失败 | 源、备份、部分目录检查 | 停止清理并展示路径 | 所有恢复源保留 | 禁止自动重试 |
| Defender 配置失败 | 非零/launch error | warn，继续 | 不影响用户数据 | 不需要 |
| 提交后旧目录清理失败 | dispatch/result | 标记 deferred | 新旧均可恢复 | 下次精确清理 |
| watchdog 无法终止或确认 extractor child | terminate + wait + verify/journal | outcome=`recovery-required`，停止 commit/rollback/cleanup | 保留旧树、staging/partial 和诊断 | 仅受控恢复 |
| 安装器被强杀 | attempt 无终态 | `interrupted-unknown` | 检查旧/备份/部分目录 | 不自动重复 |
| 同一安装包确定性失败 | version/hash/kind 一致 | 保持错误状态 | 不变化 | 仅显式重试 |
| 全用户日志在 ProgramData | installMode | 导出候选公共目录 | 不影响 | 不适用 |
| 用户名/路径含中文、空格、单引号 | Unicode API/参数数组 | 不拼接不安全命令行 | 不影响 | 正常 |
| 安装目录为自定义或共享路径 | 注册路径 + content guard | 不因路径匹配就整树删除 | 由独立 spec 保证 | 正常或安全中止 |

## 8. 备选方案评估

| 方案 | 结论 | 原因 |
|---|---|---|
| 遇到 `exit=error` 直接继续 | 不采用 | 会重新引入真实 legacy Skills 丢失风险 |
| 要求所有用户永久修改 PATH | 不采用 | 安装器不应依赖用户环境修复，企业环境也不可控 |
| 只把备份调用改成 PowerShell 绝对路径 | 不完整 | 后续停止进程、恢复、解压、清理仍有同类风险 |
| P0 统一绝对路径 + 最小 fresh 前置判断 | 采用 | 改动集中，解决当前现场且不改变兼容 fallback |
| P0 同时实现完整场景机、manifest 和恢复区 | 不采用 | 紧急版回归面过大；拆入 P0.5/独立 spec |
| 版本绑定 Skills allowlist | P0.5 采用 | 可证明无额外顶层 Skill 目录时减少 PS 依赖，但不能替代整个 helper |
| 使用纯 NSIS 实现所有进程/JSON/复制逻辑 | 不推荐长期使用 | 宏复杂度、可测试性和 Unicode/错误处理成本高 |
| 签名原生 helper | P1 推荐 | 可测试、可签名、可返回稳定错误、可移除关键 PowerShell |
| 迁移到 electron-updater | 不采用 | 范围远超本问题，且不能自动解决 legacy Skills 和自定义 NSIS |
| 原地替换 2026.7.23 安装包 | 不采用 | 客户端会复用缓存 hash/文件，发布追踪也不可审计 |

## 9. 测试计划

### 9.1 单元与静态契约测试

`windowsInstallerContract.test.ts` 增加：

1. 最小 fresh/existing 检测在进程停止和 Skills 备份之前。
2. `fresh-install` 存在显式跳过路径。
3. INSTALL/UNINSTALL key、`UninstallString`、非空残留和双注册任一证据都
   不会归类为 `fresh-install`。
4. legacy Skills 源目录检查发生在外部程序启动之前。
5. 安装脚本中不存在未经过 resolver 的裸 PowerShell 调用。
   32-bit NSIS/64-bit Windows 的 tar 检查和执行均使用同一 Sysnative
   resolver 结果，不直接执行 `$SYSDIR\tar.exe`。
6. `nsExec` 字符串 `error` 在数值比较前处理。
7. helper 未找到、策略阻止和脚本数字退出码彼此独立。
8. 只有 FR-8 中的实际风险状态进入 fail-closed。
9. Skills 恢复只接受当前 `attemptId` 的有效 manifest。
10. rollback、commit 和精确清理契约保持不变。
11. Defender 和提交后清理是 best-effort。
12. `fresh-install` 文案不包含 previous installation。
13. 普通卸载配置不会自动删除 userData。
14. P0 保留 registered-missing、location-mismatch 和 selected-scope
    dual-registration 的现行控制流，不新增一刀切 abort。
15. extractor wrapper 使用 resolver 结果并保留 `600000` hard timeout。
16. timeout 路径 terminate、wait 并验证 child；终止失败使用独立分类，
    不并发 commit/rollback/cleanup。
17. extractor 未在安装阶段完成并通过运行时校验时返回失败；archive/script
    只能用于诊断或受控恢复，不能把失败提升为成功。
18. P0 使用与 child exit code 不冲突的固定 marker 区分 start exception、
    hard timeout、child exit 和 termination failure；带 nonce 的结构化
    start/result journal 属于 P0.5。
19. 安装器在 `.onInit` 首条日志前生成并跨 relaunch 复用 attemptId。
20. rollback 成功后 relaunch 门禁覆盖 explicit/unknown、interactive/silent
    矩阵，且 relaunch 失败不改变 rollback 终态。
21. 模板顺序满足
    `installApplicationFiles < customBeforeRegistryAddInstallInfo <
    registryAddInstallInfo < customInstall`；前置阶段不得 committed/cleanup，
    后置阶段必须先验证 prevalidation success。

content guard 的静态契约由独立安装目录内容保护 spec 定义。

P0.5 的 contract backlog 单独覆盖 relocation source、legacy protection
receipt、HKCU/HKLM repair-only 权限入口、secure control record、rootId、
逐文件强摘要、`recovery-required` 持久化、fresh quarantine，以及
post-stop rescan / final revalidate 顺序；这些断言不得伪装成 P0 已交付。

`appUpdateInstaller.test.ts` 增加：

1. 优先解析系统 PowerShell 绝对路径。
2. PATH 缺失时仍可构建并启动 update-mode installer。
3. UAC 取消仍映射稳定错误。
4. PowerShell 不可用时 fallback 不会让 app 先退出后无安装器。
5. 新 launcher 在 app-side attempt 中记录
   `launcherFallback=wizard-no-args`、`uiMode=interactive`；无可信 handoff
   的安装器侧字段保持 `unknown`，不报告 update-mode 成功。
6. 路径包含空格、中文、单引号和 shell 元字符时参数正确。
7. 2026.7.17 的裸 PowerShell 启动失败后，
   `shell.openPath` fallback 进入向导式兼容路径。
8. P1 后 launcher helper 能保留全部参数并写入 attempt 终态。

`appUpdateCoordinator.test.ts` 增加：

1. 已知 `preflight-failed` 不恢复为自动重试 Ready。
2. 同一 version/hash/failureKind 不自动再次安装。
3. 新版本或新 hash 可以重新进入更新流程。
4. `rollback-succeeded` 和 `rollback-failed` 映射不同状态。
5. 没有终态才使用 `interrupted-unknown`。
6. 成功更新后 attempt 和旧 ready file 被清理。
7. `uac-declined` 不计入确定性安装失败，也不会自动重复弹窗。
8. `succeeded-registration-repair-deferred` 只允许用户触发 repair-only
    提权入口，不自动重装或静默弹 UAC。
9. `recovery-required` 不恢复为 Ready；只允许 recovery-only 流程。
10. `failed-partial-quarantined` 展示隔离路径，普通重试不会清理该目录。
11. Windows installer 输入 URL 只允许符合 transport policy 的 HTTPS
    `.exe`，但不固定 CDN origin。
12. 最终 redirect URL 再校验；不满足 transport policy 时返回
    `update-url-untrusted`，不落盘、不提权执行且不打开原始 URL。

### 9.2 Windows 安装集成测试

必须在 Windows runner 或专用 VM 中实际运行安装器，而不是只检查字符串。

核心矩阵：

| 初始状态 | PowerShell | legacy Skills | invocation / UI | 附加条件 | 期望 |
|---|---|---|---|---|---|
| 无旧版本 | 正常 | 无 | standalone / interactive | system tar 正常 | 成功 |
| 无旧版本 | 不在 PATH、绝对路径可用 | 无 | standalone / interactive | system tar 正常 | 成功 |
| 2026.7.17 | 不在 PATH、绝对路径可用 | 无 | 7.17 app / interactive | 旧 launcher 裸 PowerShell 失败后无参 `shell.openPath` | 向导兼容成功；安装器 provenance 记录 `unknown` |
| 2026.7.17 | 不在 PATH、绝对路径可用 | 无 | 修复包 `--updated` / interactive | 默认目录 | update-mode 成功 |
| 2026.7.17 | 不在 PATH、绝对路径可用 | 无 | 修复包 `--updated /S` / silent | 默认目录 | 成功、无阻塞弹窗 |
| 2026.7.17 | 不在 PATH、绝对路径可用 | 有额外目录 | app-update / interactive | 备份区可写 | 备份、恢复/迁移、成功 |
| 2026.7.17 | 正常 | 有额外目录 | app-update / interactive | 备份目录拒绝写入 | 替换前中止，旧版完整 |
| 2026.7.17 | 正常 | 无额外目录 | app-update / interactive | 旧 `skills.config.json` 损坏、repair allowlist 有效 | conservative compare，不误报用户目录 |
| 2026.7.17 | 正常 | 未知 | app-update / interactive | repair allowlist 缺失/损坏 | 禁用 fast path，正常检查或 fail closed |
| 无旧版本 | 文件被移除/策略阻止 | 无 | standalone / interactive | system tar 可用 | 成功，可选操作降级 |
| 无旧版本 | 文件被移除/策略阻止 | 无 | standalone / interactive | 任意 scope；system tar 不可用 | 提交前 typed fail；不依赖普通用户首启写安装树 |
| 2026.7.17 | 被策略阻止 | 有额外目录 | app-update / interactive | 无 native helper | P0 替换前中止，P1 helper 成功 |
| 已卸载、userData 保留 | 正常 | 正式 userData Skills | standalone / interactive | 目标空 | 安装成功，用户数据仍可用 |
| 无注册、目标有唯一可信残留 | 正常 | 任意 | standalone / interactive | guard 允许 | P0 保持兼容；P0.5 repair 成功 |
| 注册旧路径、新目标为空 | 正常 | 任意 | standalone `/D` / interactive | source/target 唯一 | P0 stock relocation；P0.5 事务 relocation |
| 注册旧路径含 legacy Skill、新目标为空 | 正常 | 有额外目录 | standalone `/D` / interactive | P0.5 relocation | 从旧 source 备份并出 receipt，不把新 target 判 no-source |
| 两个 selected source 含同名 legacy Skill | 正常 | 有额外目录 | repair workflow / interactive | P0.5 多根保护 | 按 rootId 隔离备份，无覆盖 |
| HKCU/HKLM 同一物理路径 | 正常 | 任意 | `/allusers` / interactive | scope 明确 | P0 stock fallback；P0.5 替换一次并修注册 |
| HKCU/HKLM 同一物理路径 | 正常 | 任意 | `/currentuser` / interactive | scope 明确 | P0 保持现行 fast path并记录 stale HKLM 风险；P0.5 reconcile |
| HKCU/HKLM 不同物理路径 | 正常 | 任意 | `--updated /S` / silent | source 不唯一 | mutation 前稳定非零退出 |
| HKCU/HKLM 不同物理路径 | 正常 | 任意 | standalone / interactive | 用户选择权威 source | 只操作选中 source，另一份不变 |
| 2026.7.17 | 正常 | 历史 attempt 备份 | app-update / interactive | 新 attempt | 不采用历史备份 |
| 2026.7.17 | 正常 | 有额外目录 | app-update / interactive | UAC 使用另一管理员凭据 | ProgramData staging，不当作管理员 Skills |
| 双注册同路径、HKCU repair deferred | 正常 | 无 | app-update / interactive | UAC 使用另一管理员凭据 | HKCU 由原用户非提权入口修复，不写管理员 HKCU |
| all-users standalone | 正常 | 无 | standalone / interactive | 无 trusted original SID handoff | control 仅管理员；logs 不放宽 ACL，应用提示需提权收集 |
| 另一目录有运行中 LobsterAI | 正常 | 无 | standalone / interactive | 覆盖目标目录 | 不误停另一目录进程 |
| 2026.7.17 | 正常 | 无 | app-update / interactive | UAC 拒绝 | 旧版可运行，不计确定性失败 |
| 已验证旧安装 | 正常 | 任意 | explicit `--updated --force-run` / interactive | pre-mutation fail 或 rollback success | 以原用户身份拉起旧版，不传 `--updated` |
| 已验证旧安装 | 正常 | 任意 | standalone `/S` / silent | 无 trusted relaunch intent | 旧树保留/恢复，但不弹应用窗口 |
| 已验证旧安装 | 正常 | 任意 | `/S --force-run` / silent | P0 无 secure handoff | 旧树保留/恢复，但不弹应用窗口；secure handoff 后移 P0.5 |
| 无旧版本 | 正常 | 无 | standalone / interactive | system tar 不可用 | 绝对 PS wrapper 完成，hard watchdog 生效 |
| 无旧版本 | 正常 | 无 | standalone / interactive | 任意 scope；extractor child 冻结且成功终止 | 600000ms terminate/wait/verify，typed fail，不提交部分安装 |
| 无旧版本 | 正常 | 无 | standalone / interactive | extractor child 无法终止 | P0 记录 `process-termination-failed` 并冻结本次 commit/rollback/cleanup；持久化 `recovery-required` 与跨重启恢复属于 P0.5 |

install-root content 的专项矩阵移至独立内容保护 spec；本矩阵只验证各安装
动作在门禁非允许结果时进入 `FailedBeforeMutation`。

每个适用的核心场景至少覆盖下列维度；current-user 与 all-users 预期不同时
必须像 runtime recovery 用例一样拆成独立断言，不能强行复用同一成功期望：

- 当前用户安装；
- 全用户安装；
- 默认安装目录；
- 自定义含空格、Unicode 和 shell 元字符路径；
- 中文用户名；
- Defender 开启；
- 正式签名安装包。

### 9.3 故障注入

需要可控制地模拟：

- 外部程序 launch error；
- 进程拒绝退出；
- Skills staging 不可写；
- Skills 复制中断；
- 备份验证数量不一致；
- old install rename 失败；
- payload copy 失败；
- 新安装缺少 `app.asar`；
- runtime 和恢复 archive 同时缺失；
- Electron extractor 启动失败；
- Electron extractor child 冻结且不退出；
- Electron extractor child 终止请求失败或 wait 后仍存活；
- child 已启动后 wrapper 异常，result 缺失/截断/nonce 不匹配；
- rollback rename 失败；
- 提交后清理失败；
- content guard 返回非允许结果；
- 用户在 bootstrap 后切换为 all-users scope；
- 安装器退出但不写终态；
- UAC 取消。
- legacy protection receipt 缺路径、跨 rootId 或 snapshot 不匹配。
- legacy candidate 在备份后被改成相同 size/mtime 的不同字节。

每个故障必须断言：

1. 是否发生破坏性操作；
2. 旧安装、备份和部分新安装分别在哪里；
3. 最终 failureKind；
4. 是否允许自动重试；
5. 日志是否包含 attemptId 和真实错误；
6. watchdog timeout 是否 terminate/wait/verify child；两个 scope 是否都
   typed fail/回滚且不产生 pending；child 状态未知时是否冻结后续 section；
7. bootstrap 和 canonical attempt log 是否可关联。

### 9.4 构建和质量门禁

至少运行：

```text
npm test -- windowsInstallerContract
npm test -- appUpdateInstaller
npm test -- appUpdateCoordinator
npm run compile:electron
npm run dist:win
```

涉及的 TypeScript 文件必须通过 CI 同款 changed-file ESLint。

还需要：

- `nsis` 和 `nsis-web` 均完成 makensis；
- `patches/app-builder-lib+24.13.3.patch` 可 reverse/apply；
- 安装器和新增 helper 使用正式签名；
- `git diff --check`；
- 发布前真实 Windows 机器完成一次全新安装和一次 7.17 升级。

### 9.5 日志验收

每次真机测试必须保留：

- app main log；
- 当前 attempt 的 install timing 日志；
- 当前 attempt 的 skill migration 日志；
- attempt 结果；
- 安装器退出码；
- 最终安装版本；
- 旧目录/备份目录是否存在。

不得只以“安装窗口消失”或“主程序可以启动”作为成功标准。

## 10. 发布与兼容策略

### 10.1 2026.7.23 处置

1. 停止向 Windows 客户端继续推送 2026.7.23。
2. 不覆盖 CDN 上同版本安装包。
3. 保留问题安装包和 hash，便于追踪现场。
4. 临时 PATH 注入不是通用支持方案。普通非提权 CMD 启动
   `requireAdministrator` 安装器时，提权进程可能由系统重新构造环境，
   不能承诺继承父会话临时 PATH。只有同时满足以下条件才可作为已经验证的
   现场应急步骤：

   - 用户先打开标题明确为“管理员：命令提示符”的已提权 CMD；
   - 支持侧已在同类 Windows 真机验证该路径；
   - 安装包版本、SHA256 和签名已核对；
   - 绝对路径 PowerShell 可运行，且不是被策略阻止。

   在该已提权窗口中执行：

   ```bat
   set "PATH=%SystemRoot%\System32\WindowsPowerShell\v1.0;%PATH%"
   where powershell.exe
   "D:\Download\LobsterAI Setup 2026.7.23.exe"
   ```

   最后一行只作为路径示例，必须替换为用户实际安装包路径。若不能确认
   CMD 已提权或真机验证结果，不应向用户承诺该 workaround。该方案不得
   永久修改系统 PATH，也不能作为长期修复。
5. 不要再把“先卸载旧版”作为统一建议；若临时方案失败，保留当前可运行
   版本和用户数据，收集本次 attempt 日志，等待新版本号修复包。
6. 当前 checkout 的 `package.json` 仍是 `2026.7.17`，而现场安装器标为
   `2026.7.23`。实施前必须确认 7.23 对应的源码 commit、构建任务、
   安装包 SHA256 和签名证书，不能仅凭界面版本号推断代码来源。
7. 对曾在安装目录创建文件的用户，运行尚未接入 content guard 的现有
   更新器或卸载器前，
   先把自建内容复制到 Documents、工作目录或其他安装目录之外的位置并
   验证副本；当前 7.23 不能保证这些内容得到保留。

### 10.2 修复版发布

修复版必须使用新版本号，例如 2026.7.24 或更高：

1. 构建正式签名安装包；
2. 在 PATH 缺少 PowerShell 的 Windows 真机完成全新安装；
3. 从 2026.7.17 app 发起并完成向导式兼容升级；
4. 验证 legacy Skills 和 userData；
5. 验证 system tar 失败时 hard watchdog 仍有 600000ms 总时限；
6. 验证普通卸载保留 userData；
7. 验证 production/test 合法更新链路允许动态 HTTPS CDN；非 HTTPS、
   非默认端口、非法扩展名和不安全最终 redirect 均在下载/提权前拒绝；
8. 验证 trusted interactive 更新失败后按门禁拉起旧版，而 standalone
   `/S` 不意外弹出应用窗口；
9. 验证 P0 现有 all-users 日志仍可生成并携带 attemptId；ProgramData
   canonical control/log、trusted SID ACL 和提权 collector 延至权限 ADR
   通过后的 P0.5/P1；
10. 把发布版本、源码 commit、安装包 hash、签名和验证报告绑定归档；
11. 小流量 Windows canary；
12. 观察安装失败分类和支持日志，再扩大推送。

如果 P0.5 content guard 与 P0 进入同一候选包，还必须同时通过独立内容
保护 spec 的 P0.5 验收；两份测试报告分开归档。

### 10.3 回退

如果修复版出现新的安装回归：

- 更新服务停止返回该 Windows 版本；
- 不删除用户端已有旧版本；
- 不要求用户卸载；
- 发布更高版本号的新修复包；
- 对已知 deterministic failure 禁止继续自动重试。

## 11. 验收标准

### 11.1 P0-hotfix 验收

#### Must（发布阻断）

- [ ] Windows PowerShell 不在 PATH、但系统绝对路径存在时，全新安装成功。
- [ ] 同一环境下从 2026.7.17 app 发起、经向导路径升级成功。
- [ ] `fresh-install` 不启动进程停止和 legacy Skills 备份。
- [ ] 目标目录有残留、双注册或跨 scope 时不误判为 `fresh-install`。
- [ ] registered-missing、location-mismatch 和 selected-scope
      dual-registration 的现有控制流没有因 preflight 变成新的中止。
- [ ] legacy Skills 源不存在时不启动备份 PowerShell。
- [ ] 存在 legacy Skills 时，备份和校验成功后才替换旧安装。
- [ ] Skills 备份带当前 attempt manifest，下一次安装不会自动采用历史备份。
- [ ] 没有 app attempt 参数时，安装器在 `.onInit` 首条日志前自行生成，
      跨 relaunch 全程复用 attemptId。
- [ ] 真实备份失败发生在旧安装替换之前，旧版本完整。
- [ ] 进程停止失败显示独立错误。
- [ ] `nsExec` 的 `error` 不再被显示为文件复制失败。
- [ ] 所有关键 PowerShell 调用使用统一可信绝对路径。
- [ ] 安装脚本和应用 launcher 均不存在未解析的裸 PowerShell 调用。
- [ ] 32-bit NSIS/64-bit Windows 使用 Sysnative 解析 tar；检查和执行复用
      同一可信路径，不直接执行 `$SYSDIR\tar.exe`。
- [ ] 新 launcher 的 app-side attempt 可记录 `wizard-no-args`；7.17 无参
      首跳在安装器侧记录 `unknown`，不会伪装为已确认 update-mode。
- [ ] Electron extractor 保留 600000ms hard total timeout。
- [ ] extractor 未在安装阶段完成并通过运行时校验时，P0 返回失败并安全
      处理：upgrade 沿用并验证旧版回滚；archive/script 存在不会被误报
      为成功，且 P0 不新增递归 cleanup/quarantine。
- [ ] current-user 与 all-users 都不依赖非提权首启写安装树，且不通过
      放宽 Program Files ACL 绕过。
- [ ] Defender 和提交后清理失败不阻断已可用安装。
- [ ] 现有旧目录 rollback 和 commit 校验契约全部通过。
- [ ] 全新安装错误文案不引用 previous installation。
- [ ] 普通卸载默认保留用户 Skills、SQLite 和 OpenClaw state。
- [ ] 输入和最终 redirect URL 都满足 HTTPS transport policy，且更换
      HTTPS CDN origin 不需要客户端名单变更；拒绝时不下载、不提权执行
      且不打开不安全原始 URL。
- [ ] trusted interactive 更新在 pre-mutation 失败或 rollback 成功后按
      FR-21 拉起旧版；manual/unknown 和无 trusted intent 的 `/S` 不拉起。
- [ ] relaunch 失败不改变 `rollback-succeeded`，也不触发再次 mutation。
- [ ] `nsis`、`nsis-web` 和正式签名 Windows 真机验证通过。
- [ ] 现场 7.23 安装包已绑定源码 commit、SHA256 和签名记录。
- [ ] 修复版使用新版本号发布。

#### Should（不降低 Must 的前提下随 P0 交付）

- [ ] app-side attempt 尽可能记录可信 launcher fallback/provenance；无法
      证明时保持 `unknown`。
- [ ] 日志包含 resolver 来源、最终工具路径、URL policy 分类和旧应用
      relaunch 结果，且不记录不可信完整 URL query。

### 11.2 P0.5 验收

- [ ] Windows 安装权限模型 ADR 已批准，再开始 SID/ACL/control/repair
      实现。
- [ ] 启动方式、注册拓扑和目标内容分别记录，再映射为稳定 action。
- [ ] 无注册但唯一可信残留可 `repair-in-place`，失败可回滚。
- [ ] 手动或显式 `/D` 换目录可 `relocate-reinstall`，失败恢复旧 source。
- [ ] 双注册同路径在 scope 明确时只替换物理树一次并修正 stale registration。
- [ ] 双注册不同路径在选择前 typed fail；交互选择后只操作权威 source。
- [ ] commit 后注册修复失败只产生 `registration-repair-deferred`，不会
      重装 payload。
- [ ] HKLM deferred repair 只能由用户触发受限 repair-only UAC 入口；
      非提权 app 不承诺后台静默修复。
- [ ] HKCU deferred repair 只在原始非提权用户上下文执行；提权 worker
      即使使用另一管理员凭据也不会写该管理员的 HKCU。
- [ ] `/S` 和 `--updated` 不依赖交互页或阻塞 MessageBox。
- [ ] 进程枚举覆盖 action plan 中每个 destructive source root 内的全部
      exe，且不误停另一安装目录。
- [ ] 版本绑定 Skills allowlist 只在旧版、枚举和目录集合均可信时返回
      `legacy-no-extra-skill-directories`。
- [ ] legacy/content 顺序为 scan、stop、post-stop rescan/protect、final
      revalidate、mutation；pre-stop receipt 不能放行。
- [ ] content guard 接口满足独立内容保护 spec，所有 fallback 均不能绕过。
- [ ] secure control/result 使用独立 128-bit CSPRNG nonce，而不是
      attemptId、PID 或 tick。
- [ ] child 终止失败或状态未知使用 secure journal 持久化为
      `recovery-required`，普通重试被阻断。
- [ ] fresh partial quarantine、ProgramData `control`/`logs`、original SID
      ACL 和 repair-only 权限边界符合已批准 ADR。

### 11.3 P1 验收

- [ ] 安装关键链路在 PowerShell 完全不可用时仍能完成。
- [ ] 进程停止只影响 action plan 的 destructive roots 及 Restart Manager
      证明的相关锁持有者。
- [ ] legacy Skills 最终迁移到正式 userData Skills 根。
- [ ] 用户态 launcher 能获取 NSIS 终态并写 attempt 结果。
- [ ] P1 原生 helper 在 commit 前完成并验证运行时解压，失败时安全回滚。
- [ ] 已知安装失败不会自动重复同一 version/hash 包。
- [ ] 失败 UI 区分预检、备份、payload、验证和 rollback。
- [ ] 全用户和当前用户安装日志都能被应用日志导出。
- [ ] 完全删除用户数据需要明确确认。
- [ ] Windows CI 实际执行全新安装和旧版升级矩阵。

## 12. 推荐实施顺序

### 阶段 0：发布操作

1. 暂停 2026.7.23 Windows 推送。
2. 固化现场日志、安装包版本和 hash。

### 阶段 1：P0 安装器修复

1. 安装器自生成并跨 relaunch 复用 GUID attemptId；保留现有日志落点，
   不在 P0 新建 ProgramData canonical control/ACL 体系。
2. 最小 fresh/existing 判断前置，全新安装跳过旧数据流程。
3. 统一 PowerShell/tar 的 Sysnative/System32 resolver，替换裸
   PowerShell 和 `$SYSDIR\tar.exe` 最终执行路径。
4. 拆分 legacy Skills 结果和 fail-closed 策略。
5. 保留 Electron extractor 600000ms hard watchdog/terminate/wait 语义，
   在 adapter 层拆分启动、timeout、child exit 与验证失败。
6. extractor 未在安装阶段完成并验证时保守失败/回滚，不新增
   recovery-pending 成功状态。
7. 实施更新 URL 输入/最终 HTTPS transport 双检，不固定 CDN origin。
8. 实施 FR-21 的失败后旧应用安全 relaunch 与 silent 矩阵。
9. 修正文案和 launcher 降级状态。
10. Skills staging、恢复和清理绑定当前 attempt。
11. 取消普通卸载默认删除 userData。
12. 保持现有 fallback，不引入异常注册状态的新 abort。
13. 增加合同、TypeScript 单测和 Windows 真机测试。
14. 发布新版本号修复包。

### 阶段 1.5：P0.5 兼容性加固

1. 先批准 Windows 安装权限模型 ADR。
2. 实现正交输入和 action planner。
3. 实现 repair、relocate 和双注册同路径 reconcile。
4. 按 action plan 的 destructive roots 枚举全部进程。
5. 按 scan、stop、post-stop rescan/protect、final revalidate、mutation
   顺序接入 Skills 和独立 install-root content guard。
6. 加入版本绑定 Skills allowlist fast path。
7. 实现 secure watchdog/control journal 与受控恢复。
8. 按 ADR 增加受限、用户触发的 registration repair-only 提权入口。
9. 定义 `/S`、`--updated` 的稳定退出码和无交互行为。
10. 独立完成兼容矩阵与内容保护 spec 验收。

### 阶段 2：更新 attempt 闭环

1. 增加共享 attempt/status/failure 模型。
2. 应用内更新持久化 attempt。
3. 安装结果回传。
4. 抑制同包确定性失败的自动重试。
5. renderer 展示分类错误。
6. 统一日志导出。

### 阶段 3：原生 helper 与 legacy 数据收敛

1. 引入签名 Windows helper。
2. 替换进程停止、Skills 迁移、hard watchdog 和目录清理的 PowerShell。
3. 引入用户态 UAC launcher。
4. legacy Skills 一次性迁移到 userData。
5. 在支持版本覆盖后删除不再需要的 legacy Skills 兼容逻辑。

### 阶段 4：卸载数据策略

1. 增加明确的完全删除入口和确认。
2. 验证完全删除与普通卸载的差异化体验。
3. 验证重新安装后的 userData 恢复体验。

安装目录 foreign content 的 manifest、恢复区和精确卸载按独立 spec 的
阶段推进，不与“删除 AppData”选项捆绑。

## 13. 相关设计与外部参考

- [Windows 安装目录未归属内容保护设计](../windows-install-root-foreign-content-protection/2026-07-24-windows-install-root-foreign-content-protection-design.md)
  独立定义 content guard、ownership manifest、恢复区和精确卸载。
- `specs/bugfixes/windows-update-vbscript-deprecation/2026-05-26-windows-update-vbscript-deprecation-fix-design.md`
  已移除 VBScript launcher，但明确把整体去 PowerShell 留给后续需求；
  本设计承接该边界。
- `specs/bugfixes/mac-update-atomic-app-replace/2026-07-12-mac-update-atomic-app-replace-design.md`
  定义了先保护旧版本、再写入、验证后提交和失败回滚的同类安全原则。
- `specs/features/data-migration/2026-06-09-data-migration-backup-restore-design.md`
  定义了 staging、内容校验、结果 marker 和失败回滚的数据迁移原则。
- `specs/bugfixes/windows-update-package-authenticity/`（待单独立项）
  应定义可信更新元数据、服务端期望 SHA-256、WinVerifyTrust/Authenticode
  证书链、预期发布者、时间戳和 release CI 签名门禁。attempt hash 不是
  来源鉴真。
- `specs/bugfixes/windows-defender-exclusion-hardening/`（待单独立项）
  应定义安装目录 ACL/可写性、最小临时排除、永久排除收敛、旧排除回收、
  企业 opt-out 和杀软冻结真机回归测试。
- [Why elevated processes do not inherit a non-elevated parent environment](https://devblogs.microsoft.com/oldnewthing/20130703-00/?p=3903)
  说明普通 CMD 临时修改 PATH 后再触发 UAC 不能作为可靠继承合同。
- [Windows application development best practices](https://learn.microsoft.com/en-us/windows/apps/get-started/best-practices)
  建议将用户创建内容放在 Documents 等可保留位置，并要求安装/卸载透明地
  管理文件。
- [MSIX containerization overview](https://learn.microsoft.com/en-us/windows/msix/msix-containerization-overview)
  将安装文件视为只读 package，应用状态与二进制分离，更新原子替换 package。
- [Windows Installer RemoveFiles action](https://learn.microsoft.com/en-us/windows/win32/msi/removefiles-action)
  以已登记组件为默认删除边界；其他文件需要安装器作者显式声明。
- [NSIS RMDir reference](https://nsis.sourceforge.io/Reference/RMDir)
  明确警告卸载器递归删除整个 `$INSTDIR` 不安全。
