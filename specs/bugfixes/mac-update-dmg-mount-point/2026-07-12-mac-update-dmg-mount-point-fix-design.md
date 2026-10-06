# macOS 更新 DMG 挂载点解析失败修复设计文档

## 1. 概述

### 1.1 问题

用户(2026.7.3 → 2026.7.7,arm64 Mac)应用内升级时报错:

```
安装失败
Failed to determine mount point from hdiutil output
```

点击"重试"永远失败,重启应用后依然失败,用户被卡死在无法升级的死循环中,只能手动下载安装包。

报错抛自 `src/main/libs/appUpdateInstaller.ts` 的 `installMacDmg()`:

```ts
const mountOutput = await execAsync(
  `hdiutil attach ${shellEscape(dmgPath)} -nobrowse -noautoopen -noverify`,
  60_000,
);
const lines = mountOutput.split('\n').filter((l) => l.trim());
const lastLine = lines[lines.length - 1];
const mountMatch = lastLine?.match(/\t(\/Volumes\/.+)$/);
if (!mountMatch) {
  throw new Error('Failed to determine mount point from hdiutil output');
}
```

### 1.2 日志证据

来自用户 2026-07-07 / 2026-07-08 的 main 日志:

1. **DMG 文件完整**:333,418,647 字节与下载时 Content-Length 一致,且每次安装前
   `resolveMatchingReadyFile` 的 ready file 校验均通过。排除下载损坏/截断。
2. **`hdiutil attach` 退出码为 0**:若命令失败,`execAsync` 会抛出带 stderr 的
   `Command failed` 错误;日志中是纯的 `Failed to determine mount point`,
   说明命令成功返回,只是 stdout 里没有以 `\t/Volumes/...` 结尾的行。
3. **时间模式**:首次尝试(下载完成 0.7s 后)attach 耗时约 1s 后失败;此后两天内
   十余次重试(含应用重启后)全部在 70–220ms 内快速失败。本机实测:对已附加
   (attached)镜像重复 attach 耗时约 129ms,与重试耗时吻合。

### 1.3 根因

分两层:

**直接根因**:`hdiutil attach` 成功附加了磁盘镜像设备,但 DiskArbitration 将卷挂载到
`/Volumes` 这一步在用户机器上持续失败。hdiutil 不把"附加成功但挂载失败"视为错误
(退出码仍为 0),只是输出的设备表中挂载点列为空,于是文本解析抛错。输出形如:

```
/dev/disk4          	GUID_partition_scheme          	
/dev/disk4s1        	Apple_HFS                      	
```

**放大器(代码缺陷)**:解析失败时 `mountPoint` 仍为 `null`,`catch` 块只在
`mountPoint` 非空时才 detach,因此镜像残留在"已附加"状态。后续每次重试,hdiutil
都对已附加的镜像尝试重新挂载卷、每次都失败、每次都快速返回(~100ms)——重试和
重启应用都无法自愈,形成死循环。

**卷挂载为何失败**:现有日志无法给出最终答案,因为代码没有记录 hdiutil 的原始输出
(这本身是本次要修的问题之一)。按可能性排序的嫌疑:

1. 终端管控/安全软件(EDR、天擎类)或 MDM 策略拦截磁盘镜像/外部卷挂载,国内企业
   Mac 高发;
2. `/Volumes` 目录权限异常或 diskarbitrationd 状态异常(重启系统可恢复);
3. DMG 卷文件系统(HFS+)在用户系统上挂载失败。

用户侧鉴别方法:在 Finder 中双击
`~/Library/Application Support/LobsterAI/updates/` 下的 DMG,系统弹出的真实错误
即根因;重启 Mac 可清除附加残留。

### 1.4 目标

P0 修复目标:

1. 挂载点解析不再依赖"最后一行 + tab + `/Volumes`"的脆弱文本匹配,改用
   `hdiutil attach -plist` 结构化输出。
2. attach 成功但没有挂载点时,自动清理同一镜像的附加残留,并用显式挂载点
   (`-mountpoint`)重试一次,绕开 `/Volumes` 层面的权限/策略问题。
3. 安装的任何失败路径都不再留下附加残留(按 image-path 兜底 detach)。
4. 挂载失败时把 hdiutil 的完整 stdout/stderr 记入日志,让下一次用户日志能直接
   给出根因,不再靠猜。
5. 自动安装彻底失败时提供兜底:打开 DMG 交给 Finder/系统挂载(系统会把真实错误
   直接呈现给用户),引导手动拖装,不让"重试"死循环成为唯一出路。

### 1.5 非目标

- 不迁移 `electron-updater`,不重写更新系统。
- 不改变更新检查 API、下载缓存、ready file 持久化、自动/手动更新状态机
  (`appUpdateCoordinator.ts` 的失败后回 Ready 可重试逻辑保持不变)。
- 不改 Windows NSIS 安装流程。
- 不在本次处理 `rm -rf 目标app && cp -R` 的非原子性风险(rm 成功而 cp 失败会把
  用户当前应用删掉)。该问题独立存在、风险性质不同,应另立 spec(见第 9 节)。

## 2. 用户场景

### 场景 1:正常 macOS 用户升级(回归)

**Given** 用户系统卷挂载功能正常
**When** 更新下载完成,用户点击立即更新
**Then** DMG 通过 `-plist` 解析拿到挂载点,拷贝、detach、重启流程与现状一致
**And** 无论 DMG 卷是 HFS+ 还是 APFS(多 entity),都能取到正确挂载点。

### 场景 2:卷自动挂载被拦截的用户

**Given** 用户机器上 DiskArbitration 自动挂载到 `/Volumes` 失败(安全软件/策略/权限)
**When** 用户点击立即更新
**Then** 首次 attach 拿不到挂载点后,自动 detach 残留并用
`<userData>/updates/mnt-<ts>` 显式挂载点重试
**And** 若重试成功,安装流程正常完成,用户无感知。

### 场景 3:显式挂载点也失败

**Given** 显式挂载点重试仍拿不到挂载点
**When** 安装流程失败
**Then** 日志记录两次 attach 的完整 stdout/stderr 与 `hdiutil info` 摘要
**And** 应用调用 `shell.openPath(dmgPath)` 让 Finder 挂载 DMG(系统真实错误
直接弹给用户),失败则 `shell.showItemInFolder(dmgPath)` 兜底
**And** 更新状态按现有逻辑回到 Ready,UI 显示"安装失败/重试"。

### 场景 4:老版本失败留下的附加残留

**Given** 用户曾在旧版本上安装失败,镜像残留在已附加状态(跨应用重启仍存在)
**When** 用户升级到含本修复的版本后再次点击立即更新
**Then** 新逻辑按 image-path 检测到该 DMG 已附加,先 detach 再全新 attach
**And** 若用户机器挂载功能本身正常(如残留由一次性故障造成),本次安装直接成功。

### 场景 5:安装失败后重试

**Given** 某次安装因任何原因失败
**When** 用户点击重试
**Then** 不存在上一次尝试留下的附加残留,每次重试都是干净的全新 attach。

## 3. 功能需求

### FR-1:挂载改用 `-plist` 结构化解析

attach 命令改为:

```bash
hdiutil attach <dmg> -nobrowse -noautoopen -noverify -plist
```

输出为 XML plist,通过管道 `plutil -convert json -o - -` 转成 JSON 后
`JSON.parse`,从 `system-entities[]` 中取第一个含 `mount-point` 的 entity:

```bash
hdiutil attach <dmg> -nobrowse -noautoopen -noverify -plist | plutil -convert json -o - -
```

要点:

- `plutil` 是 macOS 系统自带工具(`/usr/bin/plutil`),不引入新的 npm 依赖;
- 不再假设挂载点行的位置、分隔符和 `/Volumes` 前缀,天然兼容 HFS+(2 行)与
  APFS(4 entity)两种 DMG 结构、卷名含空格/中文/重名(`LobsterAI 1`)等情况;
- 解析逻辑抽成不依赖 Electron 的纯函数(如
  `parseHdiutilAttachOutput(json: string): { mountPoint?: string; devEntries: string[] }`),
  便于 Vitest 单测。

### FR-2:attach 无挂载点时按 image-path 清理残留

当 FR-1 解析结果没有任何 `mount-point` 时,不立即报错:

1. 执行 `hdiutil info -plist`(同样经 `plutil` 转 JSON),在 `images[]` 中按
   `image-path === dmgPath` 找到对应镜像的 `system-entities`;
2. 对其根设备(第一个 `dev-entry`,形如 `/dev/diskN`)执行
   `hdiutil detach <dev> -force`;
3. 本次 attach 输出中的 `dev-entry`(FR-1 返回的 `devEntries`)同样参与清理,
   避免 `hdiutil info` 匹配不到时残留。

### FR-3:清理后用显式挂载点重试一次

残留清理后,重试 attach 并显式指定挂载点:

```bash
hdiutil attach <dmg> -nobrowse -noautoopen -noverify -plist -mountpoint <userData>/updates/mnt-<ts>
```

要点:

- 挂载点目录位于应用自己的 `userData/updates/` 下,绕开 `/Volumes` 目录权限、
  卷名冲突等问题;
- attach 前 `mkdir -p` 该目录;安装完成或失败 detach 后删除该目录;
- 只重试一次,重试仍无挂载点则进入 FR-4/FR-6 失败路径,不做多轮循环。

### FR-4:失败时记录完整诊断信息

任一 attach 拿不到挂载点时,以 `console.error` 记录(一次性错误路径,非热路径,
不违反日志规范):

1. 该次 attach 的完整 stdout(plist 原文或转换后 JSON)与 stderr;
2. `hdiutil info -plist` 中与该 dmgPath 相关的条目摘要(设备、是否已附加);
3. 最终抛出的错误信息中附带简短原因分类,例如
   `attached but volume mount failed (no mount-point in plist)`,便于用户反馈
   截图直接定位。

日志遵守仓库规范:英文、`[AppUpdate]` tag、error object 放最后。

### FR-5:所有失败路径兜底 detach

`installMacDmg()` 的 `catch` 中,除现有"`mountPoint` 非空则 detach"外,新增:
凡本函数内 attach 过的 `devEntries`,失败时一律 `hdiutil detach -force`
(best effort,失败仅 warn)。保证任何失败都不留下附加残留,使"重试"永远从
干净状态开始(场景 5)。

### FR-6:自动安装彻底失败后的手动安装兜底

FR-3 重试仍失败(或后续拷贝阶段因挂载导致的不可恢复失败)时:

1. 调用 `shell.openPath(dmgPath)`:交给 Finder/DiskImageMounter 挂载,若系统
   层面挂载被拦截,**系统会把真实错误弹给用户**——既是兜底也是诊断;
2. `openPath` 返回非空 error 时降级 `shell.showItemInFolder(dmgPath)`
   (与 Windows 分支 launch 失败的既有做法一致);
3. 仍然 `throw`,让 `appUpdateCoordinator.installReadyUpdate()` 走既有失败
   处理(ready file 完好则回 Ready,UI 显示 `updateInstallFailed` + `updateRetry`),
   状态机不改。

### FR-7:文案

复用现有 `updateInstallFailed` / `updateRetry`,错误详情继续进入
`state.errorMessage`。本次预期不新增 i18n key;若实现中发现需要向用户明确
"已为您打开安装包,请手动拖入应用程序文件夹",再新增
`updateManualInstallHint`(中英文各一条),不做其他文案改动。

### FR-8:显式挂载点目录生命周期

- 命名:`<userData>/updates/mnt-<timestamp>`,与下载文件的命名风格一致;
- detach 成功后删除目录;
- `downloadUpdate()` 已有的 updates 目录治理不变;应用启动时若发现遗留的
  `mnt-*` 空目录则清理(挂载中的目录 rmdir 会失败,天然安全)。

## 4. 实现方案

### 4.1 新的挂载流程

```text
installMacDmg(dmgPath)
  ├─ attach -plist                          ── 常规路径
  │    ├─ 有 mount-point → 继续安装(与现状一致:找 .app、拷贝、detach、relaunch)
  │    └─ 无 mount-point
  │         ├─ console.error 完整 stdout/stderr + hdiutil info 摘要   (FR-4)
  │         ├─ 按 image-path + devEntries detach 残留                 (FR-2)
  │         ├─ attach -plist -mountpoint <userData>/updates/mnt-<ts>  (FR-3)
  │         │    ├─ 有 mount-point → 继续安装
  │         │    └─ 仍无 → console.error 诊断 → openPath(dmg) 兜底 → throw (FR-4/6)
  └─ catch: 现有 detach(mountPoint) + 新增 detach(devEntries) 兜底     (FR-5)
```

安装拷贝、管理员提权(osascript)、relaunch 逻辑不动。

### 4.2 plist 解析

`hdiutil attach -plist` 成功输出示例(APFS DMG,节选):

```json
{
  "system-entities": [
    { "dev-entry": "/dev/disk4", "content-hint": "GUID_partition_scheme" },
    { "dev-entry": "/dev/disk4s1", "content-hint": "Apple_APFS" },
    { "dev-entry": "/dev/disk5", "content-hint": "EF57347C-0000-11AA-AA11-00306543ECAC" },
    { "dev-entry": "/dev/disk5s1", "mount-point": "/Volumes/LobsterAI" }
  ]
}
```

解析函数取所有 entity 中第一个存在 `mount-point` 的值;同时返回全部
`dev-entry` 列表供清理使用。挂载失败时该字段整体缺失,函数返回
`mountPoint: undefined` 而非抛错,由调用方决定走 FR-2/FR-3。

选择 `plutil` 管道而非引入 npm plist 解析库的原因:零新依赖、macOS 必带、
JSON.parse 即可消费;XML 转义(卷名含 `&` 等)由 plutil 正确处理,自写正则
提取会重新引入本次要消灭的脆弱文本解析。

### 4.3 备选方案评估

| 方案 | 结论 | 原因 |
|---|---|---|
| `-plist` + 残留清理 + `-mountpoint` 重试 | 推荐 | 改动集中在 `installMacDmg`,同时解决解析脆弱、残留死循环、挂载被拦截三个问题 |
| 仅放宽正则(如不要求 tab / 不取最后一行) | 不采用 | 用户案例中输出里根本没有挂载点,解析写得再好也拿不到;治标不治本 |
| 直接 `shell.openPath(dmg)` 全量改为手动安装 | 不采用 | 放弃一键升级体验;保留为最终兜底(FR-6) |
| `hdiutil attach -nomount` + 自行 `diskutil mount` | 不采用 | 引入两阶段状态管理,复杂度高;`-mountpoint` 一步到位 |
| 迁移 `electron-updater` | 不适合 P0 | 现有自定义更新 API、缓存、状态机迁移范围过大;且其 macOS 路径要求签名 zip + Squirrel,发布链路要重做 |

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| HFS+ DMG(2 行输出)/ APFS DMG(4 entity) | `-plist` 解析对 entity 数量无假设,取含 `mount-point` 的 entity |
| 卷名含空格/中文/重名(`/Volumes/LobsterAI 1`) | plist 中是完整字符串,不受影响 |
| 镜像已附加且卷已挂载(上次安装中断) | attach 直接返回现有 entities 含挂载点,常规路径继续 |
| 镜像已附加但卷未挂载(本次用户案例) | attach 返回无 mount-point → FR-2 detach → FR-3 显式挂载重试 |
| detach 残留失败(设备忙) | `-force` 后仍失败则 warn 并继续 FR-3;FR-3 也失败则走 FR-6 |
| `plutil` 转换失败 / JSON 解析失败 | 视同"无挂载点",记录原始输出后走 FR-2/FR-3;不引入独立错误分支 |
| 显式挂载点目录已存在(时间戳冲突) | 目录带毫秒时间戳,冲突概率可忽略;`mkdir -p` 幂等 |
| 应用启动时遗留 `mnt-*` 目录 | 空目录直接清理;仍处于挂载状态的目录 rmdir 失败即跳过 |
| DMG 内无 `.app` | 保留现有 `No .app bundle found in DMG` 错误;detach 兜底由 FR-5 覆盖 |
| 拷贝阶段用户取消管理员授权 | 现有 `insufficient permissions` 路径不变;catch 中 detach 正常执行 |
| `openPath` 兜底也失败 | 降级 `showItemInFolder`;两者都失败仅记日志,错误照常抛出 |
| Windows 更新 | 不走 `installMacDmg()`,不受影响 |
| stdout 超过 execAsync 10MB maxBuffer | attach/info 的 plist 输出远小于此,不处理 |

## 6. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/main/libs/appUpdateInstaller.ts` | `installMacDmg()` 挂载流程重构(FR-1~6、FR-8);解析逻辑抽纯函数导出 |
| `src/main/libs/appUpdateInstaller.test.ts` | 新增 macOS 挂载解析与流程测试(现仅覆盖 Windows) |
| `src/renderer/services/i18n.ts` | 仅当 FR-7 需要 `updateManualInstallHint` 时新增中英文案 |
| `specs/bugfixes/mac-update-dmg-mount-point/2026-07-12-mac-update-dmg-mount-point-fix-design.md` | 本设计文档 |

预期不改动:

- `src/main/libs/appUpdateCoordinator.ts`(失败回 Ready 的状态机不变)
- `src/renderer/components/update/` 下 UI
- `electron-builder.json` / DMG 打包配置

## 7. 测试计划

### 7.1 单元测试

针对抽出的解析纯函数:

1. 正常 APFS plist(4 entity)→ 取到 `/Volumes/...` 挂载点与全部 dev-entry;
2. 正常 HFS+ plist(2 entity)→ 取到挂载点;
3. 无 `mount-point` 的 plist(本次故障形态)→ `mountPoint: undefined`,
   devEntries 完整返回;
4. 卷名含空格/中文/`&` 的 plist → 挂载点字符串精确还原;
5. 非法 JSON / 空输出 → 返回 undefined 不抛错。

流程级(mock `exec`):首次 attach 无挂载点时,按序触发 detach → 带
`-mountpoint` 的二次 attach;二次仍失败时调用 `shell.openPath` 且最终 reject。

### 7.2 静态检查与编译

```bash
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/appUpdateInstaller.ts src/main/libs/appUpdateInstaller.test.ts
npm test -- appUpdate
npm run compile:electron
```

### 7.3 macOS 手动验证

1. 正常升级回归:构造可检测到新版本的 build,完整走"下载 → 立即更新 →
   重启进入新版本"。
2. 残留自愈:`hdiutil attach -nomount <该dmg>` 人为制造"已附加未挂载"状态,
   再点立即更新,确认日志出现残留清理并安装成功。
3. 失败诊断:临时把 attach 命令改错(或 mock)使两次均无挂载点,确认:
   日志含完整 hdiutil 输出;Finder 打开了 DMG;UI 回到"安装失败/重试";
   `hdiutil info` 中无该镜像残留。
4. 重试幂等:失败后连续点击重试若干次,每次日志都是全新 attach,无
   ~100ms 快速失败模式。

## 8. 验收标准

- [ ] 挂载点解析改为 `-plist` + `plutil` 结构化解析,删除对"最后一行 +
      tab + `/Volumes`"的文本匹配。
- [ ] attach 成功但无挂载点时,自动按 image-path 清理附加残留,并用显式
      挂载点重试一次。
- [ ] 任何安装失败路径都不留下已附加镜像(`hdiutil info` 验证)。
- [ ] 挂载失败时日志包含 hdiutil 完整原始输出与附加状态摘要。
- [ ] 两次挂载均失败时,自动打开 DMG(失败则在 Finder 中定位),错误状态与
      重试行为与现状一致。
- [ ] 正常升级路径(HFS+ 与 APFS DMG、卷名含空格)回归通过。
- [ ] 现有 Windows 安装测试全部通过,Windows 流程无改动。
- [ ] 触及文件通过 CI 同款 eslint 检查,`npm run compile:electron` 通过。

## 9. 后续迭代

1. **安装拷贝原子性(建议尽快另立 spec)**:现有
   `rm -rf <目标app> && cp -R <源app> <目标app>` 在 rm 成功、cp 失败时会把用户
   当前应用删掉且无法回滚。应改为"cp 到同目录临时名 → 原子 rename 换入 →
   失败回滚旧目录",或使用 `ditto` 保留扩展属性。
2. **根因数据回收**:FR-4 的诊断日志上线后,收集真实用户的 hdiutil 输出,
   确认挂载失败的主因分布(安全软件/权限/文件系统),再评估是否需要针对性
   引导文案(如检测到管控软件时提示联系 IT)。
