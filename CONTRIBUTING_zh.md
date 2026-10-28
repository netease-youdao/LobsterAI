# 参与贡献 LobsterAI

[English](CONTRIBUTING.md) · **简体中文**

感谢你帮助改进 LobsterAI。本文介绍如何搭建开发环境、提交改动前需要通过的检查，以及如何打包安装程序。

- [开发环境](#开发环境)
- [测试与 Lint](#测试与-lint)
- [OpenClaw Runtime](#openclaw-runtime)
- [DeepSeek Harness Runtime](#deepseek-harness-runtime)
- [打包](#打包)
- [项目地图](#项目地图)
- [提交改动](#提交改动)

## 开发环境

环境要求：

- Node.js `>=24.15.0 <25`
- npm `>=11.17.0 <12`（旧版本可运行 `npm install -g npm@11.17.0` 升级）
- git 与 pnpm，首次启动时用于从同级目录 `../openclaw` 构建锁定版本的 OpenClaw runtime

`better-sqlite3@13.0.3` 已包含 Windows、macOS 和 Linux 的 x64/arm64 N-API
预编译文件。`package.json` 中的 `allowScripts` 配置跳过 npm 对此版本触发的多余编译，
因此在 Windows 上安装它不需要 Visual Studio C++ Build Tools。其他依赖的安装脚本仍会执行。
升级 `better-sqlite3` 时需重新检查此配置。

```bash
git clone https://github.com/netease-youdao/LobsterAI.git
cd LobsterAI
npm install
```

首次开发启动：

```bash
npm run electron:dev:openclaw
```

OpenClaw runtime 已构建后，日常开发使用：

```bash
npm run electron:dev
```

Renderer 开发服务器默认运行在 `http://localhost:5175`。

## 测试与 Lint

```bash
# 生产 renderer bundle
npm run build

# Electron main/preload TypeScript 构建
npm run compile:electron

# CI 使用的 Vitest 入口
npm test

# src 全量 ESLint；可能暴露既有历史 lint debt
npm run lint

# 对改动过的 TypeScript 文件执行 CI 风格 lint
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>
```

CI 只对 PR 中改动过的 TypeScript 文件执行 lint。请确保你改动的每个文件在上面这条命令下没有任何 ESLint 错误和警告；新增逻辑尽量补充同目录下的 `*.test.ts` Vitest 测试。

## OpenClaw Runtime

锁定的 OpenClaw 版本和第三方插件列表位于 `package.json` 的 `openclaw` 字段。

```bash
# 手动构建当前平台 runtime
npm run openclaw:runtime:host

# 指定 OpenClaw 源码路径
OPENCLAW_SRC=/path/to/openclaw npm run electron:dev:openclaw

# 强制重建 runtime
OPENCLAW_FORCE_BUILD=1 npm run electron:dev:openclaw

# 保持本地 OpenClaw checkout 在当前分支或 tag
OPENCLAW_SKIP_ENSURE=1 npm run electron:dev:openclaw
```

需要改变 OpenClaw 内部行为时，优先在 LobsterAI 侧寻找集成点。确实需要打补丁时，请在 `scripts/patches/<openclaw.version>/` 下添加按版本划分的小补丁，而不是在同级源码目录里留下手工修改。

## DeepSeek Harness Runtime

锁定的 dsh 版本以及各平台的分发包描述位于 `package.json` 的 `dsh` 字段。开发环境读取 `vendor/dsh-runtime/current`；发布版在首次使用时下载分发包，并用应用自带的摘要校验。

```bash
# 构建并激活当前平台的 runtime
npm run dsh:runtime:host

# 启动一次并验证 Web UI 可访问
npm run dsh:runtime:verify

# 完整门禁：构建、打包、经 HTTP 安装、启动、经 RPC 断言 provider/model
npm run dsh:e2e
```

<details>
<summary>发布 runtime 分发包（分平台）</summary>

每个目标平台必须在对应机器上构建：原生依赖按宿主平台安装，跨架构构建产出的包能正常打包上传，只会在用户机器上失败。构建脚本会在宿主与目标不匹配时直接报错退出。

| 目标 | 构建机器 |
| --- | --- |
| `mac-arm64` | Apple Silicon mac |
| `mac-x64` | Intel mac |
| `win-x64` | Windows 10 1803+（自带 `tar.exe`） |

在对应机器上执行，把目标名替换掉即可：

```bash
# 1. 构建（应用锁定的补丁，裁剪到约 160 MB）
npm run dsh:runtime:mac-arm64

# 2. 打包，输出 sha256 与体积
npm run dsh:runtime:pack mac-arm64

# 3. 把 vendor/dsh-dist/dsh-runtime-<版本>-mac-arm64.tar.gz 上传到 CDN，
#    然后登记地址。摘要与体积取自本地 manifest，不会与实际打包的字节脱节。
npm run dsh:runtime:url mac-arm64 "https://cdn.example.com/<上传后的地址>"

# 4. 确认该地址返回的就是这些字节
npm run dsh:runtime:verify-urls mac-arm64
```

第 3 步会把 `dsh.runtimes[目标]` 写入 `package.json`，记得提交这段改动，确保各平台的描述在同一个构建里齐全。每个目标只保存一个绝对 URL 且不做任何拼接，因此"每个文件一个独立地址"的 CDN 无需共享目录。

</details>

<details>
<summary>升级 dsh 版本</summary>

1. 修改 `package.json` 的 `dsh.version`。
2. 在新版本目录尚不存在时复制补丁目录：`cp -R scripts/dsh-patches/<旧版本> scripts/dsh-patches/<新版本>`（`<新版本>` 目录已存在时，`cp` 会把副本嵌套到下一层，构建时一个补丁都找不到）。补丁按版本号查找，目录缺失时**一个补丁都不会应用且不会报错**——Windows 控制台隐藏修复会就此静默消失。复制后构建时的 sentinel 会重新校验每个补丁是否仍能落地，上游挪动代码时构建失败：此时改写补丁目标，并在 `scripts/build-dsh-runtime.cjs` 的 `PATCH_SENTINELS` 中登记新的 sentinel；上游已带上修复则删掉该补丁（目录选择器修复自 0.1.5 起已在上游，控制台隐藏修复自 0.1.6-alpha.2 起在上游）。
3. 清空 `dsh.runtimes`。残留的旧描述仍能通过摘要校验，于是旧 runtime 会被安装到新版本号命名的目录下。
4. 按上文重新构建、上传并登记三个平台。
5. 重跑 `npm run dsh:runtime:verify-urls` 与 `npm run dsh:e2e`。

已知缺口：老用户会继续使用已安装的那份 runtime。`ensureRuntimeInstalled` 只要检测到任何已安装 runtime 就直接返回，从不与锁定版本比对，因此只有全新安装才会用上新版 dsh。已安装版本之间的选择还是字典序，会把 `rc.6` 排在 `rc.10` 前面。

</details>

## 打包

CI 工作流在各自的操作系统上构建对应的安装包（macOS、Windows、Linux），本地打包也请这样做：原生模块按宿主平台编译，`dist:*` 脚本只会构建所请求目标平台的 OpenClaw runtime。

构建机环境要求：

- Node.js `>=24.15.0 <25`。`.npmrc` 开启了 `engine-strict`，其他版本会被 npm 直接拒绝。
- npm `>=11.17.0 <12`，用于支持依赖安装脚本的按包配置。
- git 与 pnpm，用于从同级目录 `../openclaw` 构建锁定版本的 OpenClaw runtime（可用 `OPENCLAW_SRC` 指定路径）。
- Windows：需要 Git for Windows，runtime 构建脚本在它自带的 Git Bash 中运行。没有安装的话，先执行一次 `npm run setup:mingit`，在 `resources/mingit` 准备便携版 Git。

干净构建：

```bash
# 1. 严格按 package-lock.json 安装依赖。
#    npm ci 会自己清空 node_modules，不要手动删，也不要先跑 npm install：
#    那样所有依赖会装两遍，还可能改写 lock 文件。
#    postinstall 会应用 patches/ 下的补丁；better-sqlite3 在 Node.js 和 Electron 中
#    均使用包内的 N-API 预编译文件。
npm ci

# 2. 清理旧的构建产物。dist-electron 由 tsc 输出，源文件删掉后旧产物不会自动清理。
npx rimraf dist dist-electron

# 3. 构建安装包，产物输出到 release/。
npm run dist:mac            # macOS，宿主架构
npm run dist:mac:x64
npm run dist:mac:arm64
npm run dist:mac:universal
npm run dist:win            # Windows x64
npm run dist:linux
```

两次构建之间不需要删除 `vendor/`。`vendor/openclaw-runtime/<目标>` 下的 OpenClaw runtime 按锁定版本和补丁哈希缓存，任一变化都会自动重建。只改了构建脚本本身时，用 `OPENCLAW_FORCE_BUILD=1` 强制重建；用 `OPENCLAW_FORCE_PLUGIN_INSTALL=1` 重新下载内置插件。可选插件（POPO、NIM）在其 registry 不可达时只会打印警告并跳过，发布前请检查构建日志。

`dist:*` 脚本还会自动执行以下步骤：

- `openclaw:runtime:<目标>`：构建、打补丁、打包并裁剪 OpenClaw runtime，随安装包内置到 `Resources/cfmind`。
- 仅 Windows，`verify:installer-patches`：把 `patches/app-builder-lib+*.patch` 重新应用到 `node_modules`，并运行安装器契约测试。`node_modules` 里还留着旧版本补丁时它会失败，例如 `git pull` 之后没有重新安装依赖，此时执行 `npm ci` 后重试。该步骤失败的代码树打出的安装包一律不要发布。
- 仅 Windows，`setup:python-runtime`：在 `resources/python-win` 准备便携 Python 运行时，终端用户无需手动安装 Python。cfmind、`SKILLs` 和 python-win 会合并成一个 `win-resources.tar` 随安装包分发，安装后再解压。

Windows 渠道包与在线安装器都是对同一条 `dist:win` 链的封装：

```bash
# 指定渠道的完整安装包
npm run dist:win:channel -- --keyfrom <渠道> [--silent]

# 在线安装器：一个小体积 stub，安装时从你的 CDN 下载主包
npm run dist:win:web -- --keyfrom <渠道> [--silent] [--pkg-base-url <CDN 目录> | --pkg-url <主包地址>]
```

离线或私有源打包可使用：

- `LOBSTERAI_PORTABLE_PYTHON_ARCHIVE`
- `LOBSTERAI_PORTABLE_PYTHON_URL`
- `LOBSTERAI_WINDOWS_EMBED_PYTHON_VERSION`
- `LOBSTERAI_WINDOWS_EMBED_PYTHON_URL`
- `LOBSTERAI_WINDOWS_GET_PIP_URL`
- `LOBSTERAI_PORTABLE_GIT_ARCHIVE`
- `LOBSTERAI_PORTABLE_GIT_URL`

## 项目地图

| 路径 | 用途 |
| --- | --- |
| `src/main/main.ts` | Electron 生命周期、IPC 注册、鉴权、日志、runtime 启动和服务装配 |
| `src/main/libs/openclawEngineManager.ts` | OpenClaw 网关进程、运行时状态、端口、日志、重启和修复 |
| `src/main/libs/openclawConfigSync.ts` | 将 LobsterAI 的 provider、model、agent、IM 绑定、skills、MCP 和工作区指令渲染为 OpenClaw 配置 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 将 OpenClaw 网关事件翻译为 Cowork 流式事件 |
| `src/main/coworkStore.ts` | Cowork 会话、消息、配置、Agents、记忆元数据和 SQLite CRUD |
| `src/main/office/` | Word、Excel、PowerPoint 原生编辑器：文件存储、Agent 工具桥和 MCP 服务 |
| `src/renderer/components/cowork/` | 主 Cowork UI、输入框、会话详情、权限、思考/工具展示、媒体和语音输入 |
| `src/renderer/components/artifacts/` | 产物面板、预览卡片和渲染器 |
| `src/renderer/components/agent/` | Agent 创建和设置 UI |
| `src/renderer/components/skills/` | 技能管理 UI |
| `src/renderer/components/mcp/` | MCP 服务管理 UI |
| `src/renderer/components/scheduledTasks/` | 定时任务列表、表单、详情、运行历史和模板 |
| `src/renderer/services/i18n.ts` | Renderer i18n 字典和 `t()` helper |
| `src/shared/` | 主进程和渲染进程共用的常量与类型 |
| `SKILLs/` | LobsterAI 内置技能 |

更完整的架构说明以及本仓库对编码 Agent 的约定，见 [`AGENTS.md`](AGENTS.md)。

## 提交改动

- 从 `main` 拉分支，命名形如 `feat/...` 或 `fix/...`。
- 提交信息使用英文并遵循 [Conventional Commits](https://www.conventionalcommits.org/)，例如 `fix(sqlite): prevent duplicate session insert on retry`。
- 不要硬编码用户可见文案：使用 `t('key')`，并同时补充 `zh` 和 `en` 翻译。
- IPC 通道名、状态值等判别用字符串，请使用共享的 `as const` 常量对象，不要写裸字符串。
- 保持改动聚焦，不要在大型历史文件里顺手重构或做格式化调整。
- 按 PR 模板填写：简要说明、关联 issue、UI 改动截图，以及 IPC、存储、runtime、窗口等 Electron 相关改动的说明。
