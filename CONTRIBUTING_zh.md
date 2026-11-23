# 参与贡献 LobsterAI

[English](CONTRIBUTING.md) · **简体中文**

感谢你帮助改进 LobsterAI。本文介绍如何搭建开发环境、提交改动前需要通过的检查，以及如何打包安装程序。

- [开发环境](#开发环境)
- [测试与 Lint](#测试与-lint)
- [DeepSeek Harness Runtime](#deepseek-harness-runtime)
- [打包](#打包)
- [项目地图](#项目地图)
- [提交改动](#提交改动)

## 开发环境

环境要求：

- Node.js `>=24.15.0 <25`
- npm `>=11.17.0 <12`（旧版本可运行 `npm install -g npm@11.17.0` 升级）
- Git 和 `tar`

`better-sqlite3@13.0.3` 已包含 Windows、macOS 和 Linux 的 x64/arm64 N-API
预编译文件。`package.json` 中的 `allowScripts` 配置跳过 npm 对此版本触发的多余编译，
因此在 Windows 上安装它不需要 Visual Studio C++ Build Tools。其他依赖的安装脚本仍会执行。
升级 `better-sqlite3` 时需重新检查此配置。

```bash
git clone https://github.com/netease-youdao/LobsterAI.git
cd LobsterAI
npm install
```

为当前平台构建锁定版本的 DSH 运行时并启动 Electron。

```bash
npm run electron:dev:dsh
```

运行时准备好后，日常开发可直接启动。

```bash
npm run electron:dev
```

Renderer 开发服务器默认运行在 `http://localhost:5175`。

## 测试与 Lint

```bash
# 对 renderer、common、shared 代码做类型检查，再构建 renderer、main、preload 的 Vite bundle
npm run build

# 用 tsc 对 src/main 做类型检查并编译
npm run compile:electron

# 只对 renderer、common、shared 代码做类型检查，不输出文件
npx tsc

# CI 使用的 Vitest 入口
npm test

# 只运行文件名匹配的测试文件
npm test -- logger

# src 全量 ESLint；可能暴露既有历史 lint debt
npm run lint

# CI 实际执行的 lint，作用于你改动过的 TypeScript 文件
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 --no-warn-ignored <files>
```

CI 只对 PR 中改动过的 TypeScript 文件执行 lint。请确保你改动的每个文件在上面这条命令下没有任何 ESLint 错误和警告；新增逻辑尽量补充同目录下的 `*.test.ts` Vitest 测试。

- `npm run build` 不会对 `src/main` 做类型检查。改动主进程、IPC 或 preload 代码后，还要运行 `npm run compile:electron`。CI 两条都会执行。
- import 顺序是 error 级别的 lint 规则，可以用 `eslint --fix` 修复。
- Vitest 运行在 Node 环境中，只收集 `*.test.ts` 文件。没有 DOM，renderer 逻辑请作为纯函数来测，不要渲染组件。
- 不要对已有文件运行 `npm run format` 或 Prettier。仓库里大部分文件从未用它格式化过，运行后会整文件改写。

## DeepSeek Harness Runtime

`package.json` 的 `dsh` 字段锁定了 `@deepseek-ai/dsh` 和 pnpm 的版本。
构建脚本拉取 npm 包、安装对应平台的依赖、应用 `scripts/dsh-patches/<dsh.version>/`
下的补丁，并准备开发使用的 `vendor/dsh-runtime/current`。
可用 `DSH_NPM_REGISTRY` 指定 npm registry，用 `DSH_FORCE_BUILD=1` 强制重建。

运行时在 `package-manager/pnpm` 中内置锁定版本的 pnpm。应用启动 DSH 时，
通过 `runCli({ packageManager })` 指定这份 pnpm，用于安装 DSH 插件。
Windows 上如果有内置 Git，应用会将 `resources/mingit/cmd` 加入插件安装进程的 `PATH`。
在 Windows 上运行 `dsh:e2e` 前，执行 `npm run setup:mingit -- --required`，
以验证不依赖系统 Git 的插件安装流程。

运行时或补丁有改动时，运行以下检查。

```bash
# 构建并激活当前平台的运行时
npm run dsh:runtime:host

# 启动运行时并验证 Web 与 RPC 接口
npm run dsh:runtime:verify

# 检查运行时内容、LobsterAI 的 DSH 配置和内置包配置
npm run dsh:upgrade-check

# 检查 Electron 内嵌宿主、鉴权 RPC 和数据隔离
npm run dsh:e2e
```

<details>
<summary>升级内置 DSH 版本</summary>

1. 更新 `package.json` 的 `dsh.version`，并确认 `dsh.pnpm` 与上游
   `packageManager` 字段指定的 pnpm 大版本一致。
2. 将仍然需要的补丁移植到 `scripts/dsh-patches/<新版本>/`。构建按版本查找补丁，
   目录缺失时会按空补丁集处理。按需更新补丁目标和
   `scripts/build-dsh-runtime.cjs` 中的 `PATCH_SENTINELS`。
3. 在各安装包目标对应的机器上构建运行时，执行上面的运行时检查，再构建包含新版运行时的安装包。

</details>

<details>
<summary>发布独立运行时分发包</summary>

分发工具维护 `package.json` 中的 `dsh.runtimes`。请在操作系统和架构匹配的机器上打包。

```bash
# 构建并打包，以下以 Apple 芯片为例
npm run dsh:runtime:mac-arm64
npm run dsh:runtime:pack mac-arm64

# 上传 vendor/dsh-dist 中的压缩包后，登记并验证 URL
npm run dsh:runtime:url mac-arm64 "https://cdn.example.com/<上传后的地址>"
npm run dsh:runtime:verify-urls mac-arm64
```

`dsh:runtime:url` 从生成的 manifest 读取摘要和文件大小，与 URL 一并写入对应目标的分发包描述。

</details>

## 打包

请在操作系统和架构与目标匹配的机器上打包，以使用正确的原生依赖。
下面的安装包命令覆盖 macOS arm64/x64 和 Windows x64，构建机环境要求同开发环境。

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

# 3. 按目标选择一条安装包构建命令，产物输出到 release/
npm run dist:mac:arm64      # Apple 芯片
npm run dist:mac:x64        # Intel Mac
npm run dist:win            # Windows x64
```

各命令会构建目标平台的 DSH 运行时，并随包放入 LobsterAI 宿主包和 IM 渠道包。
macOS 的运行时位于 `Contents/Resources/dsh-runtime/`，同级有 `dsh-bundles/`。
Windows 安装程序从 `win-resources.tar` 将 `dsh-runtime/`、`dsh-bundles/`、
`SKILLs/` 和 `python-win/` 解压到安装后的资源目录。
`setup:python-runtime` 用于准备便携 Python 运行时。

目标、锁定版本和补丁哈希匹配时，构建会复用 `vendor/dsh-runtime/<目标>`。
修改构建脚本后可用 `DSH_FORCE_BUILD=1` 强制重建。

Windows 的 `verify:installer-patches` 会重新应用 `patches/app-builder-lib+*.patch`，
并运行安装器契约测试。`dist:win` 和 `dist:win:web` 的 stub 构建都执行这项检查。
检查失败时，执行 `npm ci` 后重试，通过后再打发布包。

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
| `src/main/ipcHandlers/` | 按领域划分的 IPC handler；新增 handler 放在这里，不要写进 `main.ts` |
| `src/main/libs/dsh/dshBootstrap.ts` | DSH 启动、配置同步和应用服务装配 |
| `src/main/libs/dsh/dshHostManager.ts` | 内置 DSH 进程、应用专用配置目录和宿主状态 |
| `src/main/libs/agentEngine/dshRuntimeAdapter.ts` | 将 DSH 的会话、轮次和事件适配到 Cowork |
| `src/main/migration/legacyOpenClawMigrator.ts` | 将旧 OpenClaw 数据导入 LobsterAI 的 DSH 数据布局 |
| `src/main/coworkStore.ts` | Cowork 会话、消息、配置、Agents、记忆元数据和 SQLite CRUD |
| `src/main/skills/skillManager.ts` | 技能同步、安装/升级、安全扫描和启用状态 |
| `src/main/office/` | Word、Excel、PowerPoint 原生编辑器：文件存储、Agent 工具桥和 MCP 服务 |
| `src/main/ipcHandlers/dshHost/` | 通过 IPC 提供 DSH 状态和插件操作 |
| `src/renderer/components/cowork/` | 主 Cowork UI、输入框、会话详情、权限、思考/工具展示、媒体和语音输入 |
| `src/renderer/components/artifacts/` | 产物面板、预览卡片和渲染器 |
| `src/renderer/components/agent/` | Agent 创建和设置 UI |
| `src/renderer/components/skills/` | 技能管理 UI |
| `src/renderer/components/mcp/` | MCP 服务管理 UI |
| `src/renderer/components/scheduledTasks/` | 定时任务列表、表单、详情、运行历史和模板 |
| `src/renderer/services/i18n.ts` | Renderer i18n 字典和 `t()` helper |
| `src/shared/` | 主进程和渲染进程共用的常量与类型 |
| `src/common/` | 两个进程都会编译进去的小型纯函数工具 |
| `src/scheduledTask/` | 定时任务模型、策略和迁移工具 |
| `src/main/scheduledTask/` | 基于 SQLite 的调度、DSH 会话执行及结果投递 |
| `SKILLs/` | LobsterAI 内置技能 |
| `dsh-bundles/` | 面向 DSH 的 LobsterAI 内置宿主工具和 IM 渠道驱动 |
| `scripts/` | runtime 构建、补丁和打包脚本 |
| `specs/` | 按功能、重构和缺陷修复划分的设计文档，用中文撰写 |
| `tests/` | 打包、runtime 和集成测试 |

本仓库对编码 Agent 的约定见 [`AGENTS.md`](AGENTS.md)。更细的说明放在对应代码旁边：[`src/main/AGENTS.md`](src/main/AGENTS.md) 涵盖主进程、IPC、SQLite 表以及数据和日志位置；[`src/renderer/AGENTS.md`](src/renderer/AGENTS.md) 涵盖 renderer、产物和 i18n 字典；[`scripts/AGENTS.md`](scripts/AGENTS.md) 涵盖 runtime 构建、补丁机制和打包。

## 提交改动

- 从当前的 `release/<日期>` 分支（远端最新的那个）拉分支，命名形如 `feat/...` 或 `fix/...`，PR 也提到这个分支，不要提到 `main`。release 分支在发版时合入 `main`。没有进行中的 release 分支时（最新的那个已发版并合入 `main`），从 `main` 拉分支，PR 也提到 `main`。
- 提交信息使用英文并遵循 [Conventional Commits](https://www.conventionalcommits.org/)，例如 `fix(sqlite): prevent duplicate session insert on retry`。`commit-msg` hook 会运行 commitlint：标题和正文的每一行都不超过 100 个字符，subject 以小写字母开头。
- 新增的库放进 `devDependencies`（`npm install -D`）。主进程和 renderer 代码都由 Vite 打包，`dependencies` 只留给在 bundle 之外加载的模块；`tests/electronBuilderAppFiles.test.ts` 逐个列出了它们及原因。
- 不要硬编码用户可见文案：使用 `t('key')`，并同时补充 `zh` 和 `en` 翻译。
- IPC 通道名、状态值等判别用字符串，请使用共享的 `as const` 常量对象，不要写裸字符串。
- 新增的 IPC handler 放在 `src/main/ipcHandlers/<领域>/`，不要写进 `main.ts`，具体步骤见 [`src/main/AGENTS.md`](src/main/AGENTS.md)。
- 保持改动聚焦，不要在大型历史文件里顺手重构或做格式化调整。
- 按 PR 模板填写：简要说明、关联 issue、UI 改动截图，以及 IPC、存储、runtime、窗口等 Electron 相关改动的说明。
