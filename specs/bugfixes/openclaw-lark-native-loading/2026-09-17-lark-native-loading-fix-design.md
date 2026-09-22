# 飞书插件原生加载失败修复设计文档

## 1. 概述

### 1.1 问题

9 月 16 日反馈表第 5 行的 macOS arm64 用户在升级后无法正常使用飞书渠道。网关日志显示完整插件加载失败：

```text
ReferenceError: exports is not defined in ES module scope
.../openclaw-lark/src/core/version.js
```

配置或 HTTP 鉴权成功不能证明完整插件已注册。此错误发生在建立飞书连接之前，已有启用账户也能触发，不需要重新创建机器人或发送特定消息。

本次修复在独立 worktree、分支 `fix/openclaw-lark-native-loading` 实施。基线为 2026-09-17 拉取的 `origin/release/2026.9.16`：`1d4ca081396e9ab7c66407088f2d64b183fd4d7a`。应用固定使用 OpenClaw `v2026.8.1` 和 `@larksuite/openclaw-lark@2026.7.16`。

### 1.2 根因

插件发布包中的两个 `.js` 文件使用 CommonJS 的 `exports`、`require`，却残留 `import.meta.url`：

- `src/core/version.js` 在版本读取函数中通过 `fileURLToPath(import.meta.url)` 获取文件路径。
- `src/core/token-store.js` 为 `createRequire()` 提供的条件表达式保留了 ESM 分支。

包未声明 `type`。原生 Node 加载器检测到 ESM 语法后按 ESM 解释文件，随后在访问 `exports` 时失败；表达式位于函数体或未执行分支中也会被检测。只修第一处后，完整加载会继续在第二处失败。

OpenClaw 的 `toSafeImportPath()` 在 Windows 上将绝对路径转为 `file://` URL；当前加载器原生加载未命中，随后回退 jiti 转译。macOS 保留普通绝对路径，能进入原生加载分支；这条 ReferenceError 不属于转译回退条件。因此此前在 Windows 上测试通过与此次 macOS 故障并不矛盾。

用户此前可用的应用 2026.9.4 使用 OpenClaw `v2026.6.1` / Lark `2026.6.10`；首次可见失败发生于升级后完整插件开始加载时。不能将 9/16 的反馈日期直接视为引入回归的提交日期。

## 2. 用户场景

1. 已配置飞书账户的用户升级、冷启动或重启网关后，完整插件应正常加载并注册渠道和工具。
2. Windows 用户继续通过现有加载方式使用飞书，版本号和凭据存储模块的公开接口保持不变。
3. 构建复用已安装插件缓存，或重复准备运行时时，应稳定获得同样的修复产物。

## 3. 功能需求

- 在插件打包边界修正两个 CommonJS 产物，保持原生加载与 jiti 路径兼容。
- 保持基于当前安装位置的版本读取；不硬编码文件绝对路径或返回版本号。
- 保持现有凭据后端和飞书通信逻辑，仅调整 `createRequire()` 的模块定位参数。
- 补丁限定已审查的包名、版本、模块类型及源码结构，异常时明确构建失败。
- 支持重复应用和部分已修补缓存；校验两处文件后再写入，避免第二处异常时只改第一处。

## 4. 实现方案

### 4.1 打包补丁

在 `scripts/openclaw-plugin-patches/lark.cjs` 增加 `patchNativeModuleCompatibility()`，由 `patchLark()` 在其他飞书补丁之前调用：

| 文件 | 原表达式 | 修正后 |
|---|---|---|
| `src/core/version.js` | `const __filename = fileURLToPath(import.meta.url)`，发布包使用 tsc 的 `node_url_1` 调用形式 | `const __filename = module.filename` |
| `src/core/token-store.js` | `createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)` | `createRequire(__filename)` |

`version.js` 中不能直接写成 `const __filename = __filename`，否则会引用尚未初始化的局部绑定。`module.filename` 保持路径随模块实际安装位置变化。

每处只接受唯一的原表达式或唯一的已修复表达式，并验证 CommonJS 导出标记。补丁不扫描或改写其他 ESM 文件，也不修改平台标识、OpenClaw 加载器或插件版本。

### 4.2 交付与后续维护

沿用 `ensure-openclaw-plugins.cjs` 的「缓存复制到 runtime → `applyOpenClawPluginPatches()`」流程，因此缓存命中也会应用修复。两个文件已是 `.js` 入口依赖，不依赖 TypeScript 预编译来消除 ESM 语法。

正式安装包必须重新准备对应平台的 OpenClaw runtime，使其包含该补丁。仅更新 LobsterAI 主进程代码或重启已有网关不会改变旧插件文件。后续升级 Lark 时应审查上游模块格式，再更新或移除此补丁。

### 4.3 涉及文件

| 文件 | 职责 |
|---|---|
| `scripts/openclaw-plugin-patches/lark.cjs` | 版本/结构校验、两处产物修正、打包入口接入 |
| `tests/fixtures/openclaw-lark-2026.7.16/version.txt` | 发布包原始版本模块，保留原 MIT 版权头 |
| `tests/fixtures/openclaw-lark-2026.7.16/token-store.txt` | 发布包原始凭据模块，保留原 MIT 版权头 |
| `tests/openclaw-plugin-patches-lark-native.test.ts` | 原生加载、路径迁移、缓存复制、幂等及异常结构回归 |
| `tests/openclaw-im-sdk-compat.test.ts` | 现有 SDK 测试的飞书 fixture 补齐包信息和两个真实模块 |

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| runtime 未安装飞书插件 | 跳过补丁 |
| 包名、版本改变，元数据缺失，或包声明为 ESM | 构建失败，提示复核补丁 |
| 目标文件缺失、表达式变化或重复、CommonJS 标记缺失 | 在写入任一目标前失败 |
| 两处均已修正 | 文件保持不变 |
| 只有一处已修正 | 校验后补齐另一处 |
| LF / CRLF 文件 | 单行替换，保留既有换行 |
| 安装路径迁移、空格或中文路径 | 按当前模块路径读取 package.json |
| Windows 原先通过 jiti 正常加载 | 保留其加载路径，回归验证修改模块仍可加载 |

## 6. 验收标准与验证记录

### 6.1 自动化回归

```powershell
npm --ignore-scripts test -- openclaw-plugin-patches openclaw-im-sdk-compat ensure-openclaw-plugins openclaw-plugin-sdk-bridge
npx --no-install eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 tests/openclaw-plugin-patches-lark-native.test.ts tests/openclaw-im-sdk-compat.test.ts
node --check scripts/openclaw-plugin-patches/lark.cjs
npm --ignore-scripts run compile:electron
```

加载回归在独立进程中使用真正的 `.cjs` 驱动文件，避免 `node -e` 将 `exports` / `require` 暴露为全局而掩盖故障。原始两个模块必须先失败，补丁后必须原生加载成功。凭据模块只检查导出和纯函数，不调用系统凭据读写。

2026-09-17 本地结果：

- Node `24.15.0` 下 9 个相关测试文件、77 项测试全部通过，其中本次新增 14 项。
- 两个修改的 TypeScript 测试文件通过 CI 同等 ESLint 规则，0 error / 0 warning。
- 补丁脚本通过 `node --check`，`compile:electron` 通过，`git diff --check` 通过。
- 未运行全量测试。原工作区依赖通过 junction 复用，命令加 `--ignore-scripts` 避免 npm 生命周期脚本重建共享原生依赖。

两个 fixture 与原始安装缓存的文件字节一致，SHA-256 为：

- `version.txt`：`643f7c2e54abeca541afcdf3e487c3b2cc9309e5b2850e076aece7dd5fd4261d`
- `token-store.txt`：`ec08e378a6ddf132aa68017316f7426a82d5ce7ff203771541d825ba5006f92c`

### 6.2 真实插件本机验证

使用已有真实插件缓存和 OpenClaw runtime 的隔离副本，通过本分支的正式补丁入口处理产物，再用 Electron 内置 Node 加载完整插件并执行注册回调。原生路径必须不发生 jiti 回退；Windows 路径需保持可加载。

独立 home/state/config 使用虚构账户，不连接真实飞书。Windows 上选择普通绝对路径复现 macOS 会走的 Node 原生加载分支，不修改 `process.platform`。该验证覆盖本次模块故障，不等同于 macOS arm64 系统验收。

正式补丁验证使用 `copyPreinstalledPluginToRuntime()` 从真实缓存复制插件，再调用本分支的 `applyOpenClawPluginPatches()`，没有使用上一轮实验的候选字符串替换器。宿主为 OpenClaw `v2026.8.1`，runtime 构建记录的上游提交为 `ea806575e6450e4d1efdfc72c19f04be982a1b9b`。

Electron 内置 Node `24.19.0` 实测：

| 检查 | 结果 |
|---|---|
| 完整插件原生加载、执行注册、再检查两个目标模块 | 通过；3 次 native hit，0 次 jiti 回退；测试注册接口记录 Feishu channel、39 个工具、4 个聊天指令 |
| 两个目标模块按 Windows 实际路径加载 | 通过；版本号仍为 2026.7.16，凭据模块公开函数可用 |
| 完整插件按 Windows 实际路径加载并执行注册 | 通过；同样注册 39 个工具、4 个指令 |
| 两个源缓存文件及测试输入文件校验 | 未被修复和验证过程修改 |

以上三项加载检查共 17.2 秒，分别使用独立进程及状态目录。测试接口只记录注册，不执行工具处理函数或连接飞书。

另启动实际 Electron Gateway，使用修复后的插件、隔离状态目录和禁用连接的虚构账户，验证真实宿主注册与生命周期：

- 日志明确从修复副本的 `index.js` 加载 `openclaw-lark`，完成工具注册，网关进入 `ready`。
- 冷启动约 31.6 秒后 `/healthz` 返回 HTTP 200。
- 修改 `channels.feishu.name` 后观察到 `config hot reload applied (channels.feishu.name)`，随后健康检查仍为 HTTP 200。
- 日志未出现本次 ReferenceError、插件加载失败或非法配置；账户禁用造成部分工具跳过注册，属于预期。
- 测试完成后通过 IPC 请求 SIGINT 关闭，网关 exit 0，已确认进程停止。

本机详细证据保存在该 worktree 的 `.work/lark-native-loading/`，不纳入 Git：

- `prepared-runtime.json`：缓存来源、正式补丁产物路径、前后哈希。
- `verification/run-jaqR3Q/report.json`：完整加载统计、注册列表、节点版本及耗时。
- `gateway-smoke-g6Xy2y/result.json`、`gateway.log`：健康检查、配置热重载和正常退出记录。

修复产物位于 `.work/lark-native-loading/runtime/`；原工作区 runtime 和已有 `.gitignore` 修改均未改动。上述检查不包含完整 Electron UI、真实机器人通信或 Mac Keychain，仍需下面的发布前验收。

### 6.3 发布前 QA

- [ ] 包含新 runtime 的 macOS arm64 应用冷启动后，飞书完整插件和账户监听成功启动，日志无上述 ReferenceError。
- [ ] 真实私聊消息可以收到并回复；网关重启后可以恢复。
- [ ] 飞书工具、OAuth 和 Mac Keychain 凭据读写通过回归。
- [ ] Windows 正式包的飞书连接和消息往返正常。
