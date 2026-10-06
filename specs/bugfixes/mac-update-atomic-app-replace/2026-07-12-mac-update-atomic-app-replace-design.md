# macOS 更新非原子替换可能删丢应用修复设计文档

## 1. 概述

### 1.1 问题

macOS 应用内升级的安装替换步骤(`src/main/libs/appUpdateInstaller.ts` 的
`installMacDmg()`)当前实现为:

```ts
await execAsync(
  `rm -rf ${shellEscape(targetApp)} && cp -R ${shellEscape(sourceApp)} ${shellEscape(targetApp)}`,
  300_000,
);
```

普通权限失败后,osascript 提权路径执行的是**同样的** `rm -rf … && cp -R …`。

这是"先删旧、后拷新"的非原子序列:`rm -rf` 成功后,一旦 `cp -R` 失败
(磁盘空间不足、DMG 源读错误、拷贝中途被安全软件拦截),用户磁盘上的
应用已被删除而新版本没有装上。此时:

- 失败发生在后台进程,没有任何系统级 UI;应用还在内存中运行,UI 只弹
  "安装失败",用户不知道磁盘上的 app 已经没了;
- 用户下次启动时应用凭空消失,只能重新下载安装——这是升级路径能造成的
  最差体验;
- 提权路径的重试会再次执行 `rm -rf`(此时已无意义)后再次 `cp` 失败,
  无任何挽回。

与 Windows 的对比(为什么只改 macOS):Windows 端删旧装新发生在 NSIS
安装器内。electron-builder 模板的旧版卸载器用 `un.atomicRMDir` 将旧文件
逐个 rename 到临时目录、失败会 `un.restoreFiles` 回滚;新文件解包失败有
5 次自动重试 + 用户 Retry 对话框,且全程有安装器 UI、安装包保留可重跑。
风险窗口存在但被多层缓解,且属于 electron-builder 固有语义,改动成本与
引入风险远大于收益。macOS 端是 LobsterAI 自己的代码,修复完全可控。

### 1.2 根因

替换序列的操作顺序错误:破坏性操作(删除旧版)先于易失败操作(拷贝
300+ MB 新版)执行,且没有备份和回滚。正确顺序应当是先把新版完整落盘
(staged copy),再用原子 `rename` 换入,旧版仅在新版确认就位后才删除。

`rename(2)` 在同一文件系统内是原子操作,这也是 Squirrel.Mac 等成熟
macOS 更新器采用的标准做法。运行中的 .app 目录被 rename/删除不影响
已运行进程(进程持有 inode),现状的 `rm -rf` 正在运行的自身能成功也是
同一机制,因此换入操作对运行中的应用是安全的。

### 1.3 目标

P0 修复目标:

1. 新版拷贝(最易失败的一步)在触碰旧版之前完成;拷贝失败时旧版完好
   无损,用户可直接重试。
2. 旧版先 rename 为备份,新版原子 rename 换入;换入失败自动回滚备份,
   旧版恢复原位。
3. 提权路径(一次密码框约束)以单条复合命令实现等价序列,内嵌回滚。
4. 任何失败路径的日志能定位到具体失败步骤;错误信息区分"已回滚、当前
   版本未受影响"与"回滚失败、旧版保留在备份路径"。
5. 历史失败留下的 staging/备份残留在下次安装前自动清扫。

### 1.4 非目标

- 不改变挂载/detach 流程(`mac-update-dmg-mount-point` spec 刚重构过,
  本次仅改拷贝替换段,基于该修复后的代码实施)。
- 不更换拷贝工具:`cp -R` 保留现状语义(线上已验证可用);`ditto` 作为
  备选记录,不在本次引入。
- 不改 Windows 安装流程、更新状态机、下载缓存、UI 与 i18n 文案
  (错误详情继续走 `state.errorMessage`)。
- 不引入磁盘空间预检查(`cp` 失败本身已是安全失败,预检查属锦上添花,
  见第 9 节)。

## 2. 用户场景

### 场景 1:正常升级(回归)

**Given** 磁盘空间充足、目标目录可写
**When** 用户点击立即更新
**Then** 新版先拷贝为同目录隐藏 staging,旧版 rename 为备份,新版 rename
换入,备份删除,应用以新版本重启
**And** 整个过程用户感知与现状一致。

### 场景 2:拷贝失败(磁盘空间不足等)

**Given** 磁盘剩余空间不足以容纳新版
**When** 拷贝 staging 阶段失败
**Then** 旧版应用从未被触碰,staging 残留被清理
**And** UI 显示安装失败,用户清理磁盘后点重试即可;当前版本可继续使用。

### 场景 3:换入失败自动回滚

**Given** staging 拷贝成功,但 rename 换入失败(极端:目标卷异常)
**When** 安装流程检测到换入失败
**Then** 备份自动 rename 回原位,旧版恢复
**And** 错误信息说明当前版本未受影响。

### 场景 4:权限不足走提权

**Given** 目标目录(如 /Applications)对当前用户不可写
**When** 普通权限序列失败
**Then** 弹出一次系统密码框,提权执行完整的 staging→备份→换入序列
**And** 提权序列内部失败同样回滚,旧版不丢。

### 场景 5:用户取消密码框

**Given** 提权弹窗出现
**When** 用户点击取消
**Then** 报 insufficient permissions,旧版应用完好,状态回 Ready 可重试。

### 场景 6:历史残留自动清扫

**Given** 某次失败在目标目录留下了隐藏 staging 或备份目录
**When** 用户再次点击立即更新
**Then** 拷贝开始前自动清扫本应用的历史残留,不影响本次安装,
不随失败次数累积磁盘占用。

## 3. 功能需求

### FR-1:staged copy + 原子换入序列

普通权限路径按以下顺序分步执行(Node 侧逐条 `execAsync`/`fs` 调用,
每步独立日志):

```text
1. 清扫残留      rm -rf <dir>/.<base>.staging-* <dir>/.<base>.backup-*   (best effort, FR-5)
2. 拷贝 staging   cp -R <sourceApp> <staging>
3. 备份旧版      mv <targetApp> <backup>          (targetApp 不存在则跳过)
4. 原子换入      mv <staging> <targetApp>
5. 删除备份      rm -rf <backup>                  (best effort;步骤 3 跳过则无此步)
```

失败处理:

- 步骤 2 失败:删除 staging 残留,进入 FR-3 提权路径。旧版未被触碰。
- 步骤 3 失败:删除 staging,进入提权路径。旧版仍在原位。
- 步骤 4 失败:立即执行回滚 `mv <backup> <targetApp>`(FR-2),删除
  staging,进入提权路径。
- 步骤 5 失败:仅 warn;新版已就位,备份残留由下次安装的步骤 1 清扫。

### FR-2:换入失败自动回滚

步骤 4 失败且备份存在时,必须先尝试 `mv <backup> <targetApp>` 恢复旧版,
再进入后续处理:

- 回滚成功:日志 warn,说明旧版已恢复。
- 回滚失败(极端情况):日志 error 并在最终抛出的错误信息中包含备份
  完整路径(例如 `previous version preserved at <backup>`),用户/支持
  至少能手动找回旧版。

### FR-3:提权路径单条复合命令(内嵌回滚)

`do shell script … with administrator privileges` 每次调用弹一次密码框,
因此提权序列必须是单条 shell 复合命令,结构为:

```sh
cp -R <src> <stg> \
  && { [ ! -e <tgt> ] || mv <tgt> <bak>; } \
  && { mv <stg> <tgt> || { [ ! -e <bak> ] || mv <bak> <tgt>; exit 90; }; } \
  && { [ ! -e <bak> ] || rm -rf <bak>; }
```

要点:

- 换入失败时命令内部先回滚备份再以特殊退出码 90 结束。实测 osascript
  **不透传**内部退出码(进程退出码恒为 1,错误描述文本本地化),内部
  错误号以 `(90)` 尾缀出现在 stderr,Node 侧据此识别"已回滚";
- 提权尝试使用**新的时间戳**生成 staging/备份名,不复用普通路径残留
  (`cp -R` 到已存在目录会把源拷成其子目录,必须保证 staging 全新);
- 转义链:命令内路径用 `shellEscape`(单引号)包裹;AppleScript 字符串
  层仅转义 `\` 与 `"`(不能复用旧代码的 `escapeForInnerShell`——它会把
  `$` 转成 `\$`,AppleScript 对未定义转义保留反斜杠,会破坏单引号内的
  路径);osascript 以 `execFile` 参数数组调用,不经过外层 shell,因此
  命令中的单引号无需再转义。该链已用无提权 `do shell script` 真实执行
  验证(含空格/中文/`$` 路径与回滚分支);
- 生成该命令的函数独立导出(如
  `buildMacSwapInstallCommand(sourceApp, targetApp, swapPaths)`),
  普通路径与提权路径共用路径生成逻辑,单测直接断言命令结构。

### FR-4:staging 与备份的位置和命名

- 必须与 `targetApp` **同一父目录**:`rename` 只有同一文件系统内才是
  原子操作,同目录是保证同卷的唯一可靠方式(应用可能安装在自定义
  目录或外置卷)。禁止把 staging 放到 userData/updates 再 mv 跨卷。
- 命名带点前缀(Finder 中隐藏)+ 毫秒时间戳,基于目标 basename:
  - staging:`.<AppName>.app.staging-<ts>`
  - 备份:`.<AppName>.app.backup-<ts>`
- 名称不以 `.app` 结尾,不会被 LaunchServices/Finder 识别为应用。
- 前缀模式定义为导出常量,清扫逻辑(FR-5)与生成逻辑共用一处定义。

### FR-5:安装前清扫历史残留

拷贝阶段开始前,列出目标目录下匹配本应用 staging/备份前缀模式的条目,
逐个 `rm -rf`(best effort,普通权限,失败仅 warn 不阻塞):

- 覆盖上次普通路径失败留下的 staging;
- 覆盖上次提权路径失败留下的 staging(普通权限删不掉时忽略,仅日志);
- 覆盖步骤 5 删除失败留下的备份。

### FR-6:分步日志与错误分类

- 每步开始/失败均有 `[AppUpdate]` 日志,失败日志带步骤名与 error object;
- 普通路径失败进入提权前,日志说明普通路径失败于哪一步;
- 最终错误信息(进入 `state.errorMessage` 与弹窗)按结果分三类:
  1. 旧版未触碰(步骤 2/3 失败):现状文案风格,加 `current version
     untouched`;
  2. 已回滚(步骤 4 失败 + 回滚成功 / 提权 exit 90):加 `rolled back to
     current version`;
  3. 回滚失败:加 `previous version preserved at <backup>`。

### FR-7:行为保持项

- 挂载、`.app` 查找、detach、DMG 清理、relaunch/quit 逻辑不变;
- `targetApp` 解析逻辑不变(运行路径以 `.app` 结尾用运行路径,否则
  fallback `/Applications/<bundle>`);
- 拷贝超时保持 300s;提权失败最终错误保持 `Installation failed:
  insufficient permissions.` 开头(coordinator 与既有排障习惯依赖此
  文案风格),后接 FR-6 分类信息。

## 4. 实现方案

### 4.1 代码结构

`installMacDmg()` 中现有 try/catch 两段式拷贝块替换为:

```text
swapInstallMacApp(sourceApp, targetApp)
  ├─ 路径准备:dir/base 解析,staging/backup 命名(导出的纯函数)
  ├─ cleanupSwapLeftovers(dir, base)                    (FR-5)
  ├─ 普通权限分步序列 + TS 回滚                          (FR-1/FR-2)
  └─ catch → 提权单条复合命令(新时间戳)+ exit 90 识别   (FR-3)
```

新增导出(供单测):

- `buildMacSwapPaths(targetApp, timestamp)` → `{ staging, backup }`
- `buildMacSwapInstallCommand(sourceApp, targetApp, staging, backup)` →
  复合命令字符串(供提权路径包装进 osascript)
- staging/备份前缀常量

### 4.2 备选方案评估

| 方案 | 结论 | 原因 |
|---|---|---|
| staged copy + rename 换入 + 备份回滚 | 推荐 | 失败安全点覆盖每一步;rename 同卷原子;Squirrel.Mac 同款思路,改动集中在拷贝段 |
| `cp -R` 直接覆盖(不先删) | 不采用 | 旧版多出的文件会残留,新旧资源混装(asar/Framework 混版)会导致启动崩溃 |
| `rsync --delete` 同步 | 不采用 | macOS 自带 rsync 版本陈旧(openrsync/2.6.9 差异),对 bundle 的 xattr/链接语义引入新变量,收益不比 rename 换入高 |
| `ditto` 替代 `cp -R` | 本次不做 | 与原子性无关;`cp -R` 线上已验证可用,单独评估后再换(见第 9 节) |
| 迁移 Squirrel.Mac / electron-updater | 不适合 | 要求签名 zip 发布链路,范围远超本 bug |
| 安装前磁盘空间预检查 | 本次不做 | staged copy 已把空间不足变成安全失败;预检查是体验优化,见第 9 节 |

### 4.3 关键正确性依据

- `rename(2)` 同一卷内原子;staging/备份与目标同父目录保证同卷。
- `cp -R src dst` 在 `dst` 已存在时会把 `src` 拷成 `dst` 的子目录——
  因此 staging 名称必须每次全新(时间戳)且拷贝前清扫(FR-5)。
- 运行中 .app 的 rename/删除不影响已运行进程(进程持有 inode);现状
  `rm -rf` 自身即依赖此行为,换入方案同理安全。
- 提权命令中 `[ ! -e … ] ||` 守卫处理 targetApp 不存在(fallback 全新
  安装)与备份不存在两种分支。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| targetApp 不存在(fallback `/Applications/<bundle>` 且从未安装) | 跳过备份步骤,直接换入;提权命令由 `[ ! -e … ]` 守卫覆盖 |
| 磁盘空间不足 | staging 拷贝失败,旧版未触碰;提权重试同样失败后报错(known limitation:会多弹一次密码框),用户清理磁盘后重试 |
| staging 拷贝中途失败留下半成品 | 当次立即清理 + 下次安装前 FR-5 清扫双保险 |
| 换入失败且回滚也失败 | 错误信息与日志包含备份完整路径,旧版可手动找回 |
| 备份删除失败 | 新版已就位,仅 warn;残留由下次安装清扫 |
| 应用安装在自定义目录/外置卷 | staging/备份与目标同目录,天然同卷,原子性不受影响 |
| 提权路径失败留下 root 属主的 staging 残留 | 下次安装普通权限清扫失败时仅 warn 跳过,不阻塞安装(残留为隐藏目录,仅占磁盘) |
| 用户取消密码框 | osascript 报 User canceled,按现状归入 insufficient permissions,旧版完好 |
| 时间戳冲突 | 毫秒级 + 每次尝试新生成,可忽略 |
| 拷贝期间用户手动弹出了 DMG 卷 | `cp` 读源失败 → 旧版未触碰的安全失败,与磁盘满同路径 |
| 升级过程中断电/强杀 | 最坏状态为 staging/备份残留 + 旧版仍在原位(rename 原子,不存在中间态);下次安装自动清扫 |
| Windows / Linux | 不走 `installMacDmg()`,不受影响 |

## 6. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/main/libs/appUpdateInstaller.ts` | 拷贝替换段重构为 staged swap;新增路径/命令构建导出函数与前缀常量 |
| `src/main/libs/appUpdateInstaller.test.ts` | 新增 swap 序列、回滚、提权命令结构用例 |
| `specs/bugfixes/mac-update-atomic-app-replace/2026-07-12-mac-update-atomic-app-replace-design.md` | 本设计文档 |

预期不改动:

- `src/main/libs/appUpdateCoordinator.ts`(失败回 Ready 状态机复用)
- 挂载/detach 相关代码(`mac-update-dmg-mount-point` 修复成果)
- UI 组件与 i18n

## 7. 测试计划

### 7.1 单元测试

路径与命令构建纯函数:

1. `buildMacSwapPaths`:staging/备份与 targetApp 同父目录、点前缀、
   不以 `.app` 结尾、含时间戳;
2. `buildMacSwapInstallCommand`:含 `cp -R`→备份守卫→换入→回滚→
   `exit 90`→备份清理的完整结构;路径含空格/中文时转义正确。

流程级(mock `exec` + `fs`,沿用现有 macOS describe 的 mock 设施):

1. 正常路径命令序列断言:清扫 → cp staging → mv 备份 → mv 换入 →
   rm 备份,顺序正确;
2. cp staging 失败:未出现任何针对 targetApp 的 mv/rm;staging 清理被
   调用;随后进入 osascript 提权命令;
3. mv 换入失败:回滚 `mv backup target` 被调用;
4. targetApp 不存在:备份步骤跳过;
5. 提权路径:osascript 命令包含复合序列;提权失败抛
   `insufficient permissions`;
6. 既有挂载/detach 用例回归不变。

### 7.2 静态检查与编译

```bash
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/appUpdateInstaller.ts src/main/libs/appUpdateInstaller.test.ts
npm test -- appUpdate
npm run compile:electron
```

### 7.3 macOS 手动验证

1. 正常升级回归:完整走"下载 → 立即更新 → 以新版本重启",确认
   `/Applications` 无残留隐藏目录;
2. 拷贝失败安全性:用只读目标目录(或 `chflags`/权限模拟)使 staging
   拷贝失败,确认旧 app 原封不动、可继续使用、重试可用;
3. 提权路径:以不可写 `/Applications` 的普通用户账户走升级,确认一次
   密码框完成安装;取消密码框后旧 app 完好;
4. 残留清扫:手工在目标目录放置匹配前缀的假 staging/备份目录,再走
   一次升级,确认被清扫。

## 8. 验收标准

- [ ] 安装序列中,旧版应用在新版完整落盘(staging 拷贝成功)之前不被
      触碰;`rm -rf 目标app && cp -R` 序列从代码中移除。
- [ ] staging 拷贝失败时旧版完好,UI 报安装失败且可重试。
- [ ] 换入失败自动回滚备份,旧版恢复原位;回滚失败时错误信息包含备份
      路径。
- [ ] 提权路径一次密码框完成完整序列,内嵌回滚,取消密码框旧版完好。
- [ ] staging/备份与目标同目录、隐藏命名;历史残留下次安装前自动清扫。
- [ ] 每步失败有独立日志,错误信息区分未触碰/已回滚/回滚失败三类。
- [ ] 既有挂载/detach/Windows 测试全部通过;触及文件 CI 同款 eslint
      零警告;`npm run compile:electron` 通过。

## 9. 后续迭代

1. **磁盘空间预检查**:staging 拷贝前比较 DMG 内 .app 体积与目标卷
   剩余空间,不足时直接给出明确文案(需要新增 i18n),把"拷贝到一半
   失败"变成"秒级友好提示"。
2. **`ditto` 替代 `cp -R`**:`ditto` 对 bundle 的 xattr/ACL/资源叉保留
   更符合 Apple 推荐,单独验证签名校验(`codesign --verify`)通过后再
   切换。
3. **换入后完整性校验**:换入前对 staging 执行 `codesign --verify
   --deep` 快速校验,提前拦截拷贝损坏,避免换入后才发现新版起不来。
