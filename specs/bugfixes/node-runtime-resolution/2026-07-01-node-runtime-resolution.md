# Node 环境统一处理设计文档

## 1. 概述

### 1.1 问题

Windows 安装包会在运行环境 PATH 前面注入 `userData/cowork/bin`，其中包含用于 Git Bash 的 `node`、`npm`、`npx` bash shim，也包含 Windows `.cmd` shim。部分模块使用 `where node` 或 `hasCommand('node')` 判断 Node 是否可用，然后把命中的 `node` 直接传给 Node.js `spawn`。

在 Windows 上，`where node` 可能优先返回无扩展名的 `...\cowork\bin\node` bash shim。该文件不能被原生 `spawn` 直接执行，导致 MCP 安装解析、MCP 启动或技能脚本运行出现 `spawn ...\cowork\bin\node ENOENT`。

### 1.2 根因

项目中存在两类 Node 使用场景，但此前没有统一建模：

- shell/Git Bash 场景：需要 PATH 中的 `node`/`npm`/`npx` shim，让用户命令和 OpenClaw shell 能找到工具。
- 原生进程启动场景：`child_process.spawn` 需要可直接执行的 `node.exe`，或 Electron 可执行文件配合 `ELECTRON_RUN_AS_NODE=1`。

MCP 和部分技能模块把 shell shim 当作原生可执行 Node 使用，触发 Windows 启动失败。

## 2. 用户场景

### 场景 1：Windows 安装包无系统 Node

**Given** 用户只安装 LobsterAI，没有安装系统 Node.js  
**When** 用户启用 `npx` 类型 MCP 或启动需要 Node 的技能脚本  
**Then** 应使用 LobsterAI 自带 Electron runtime 以 Node 模式运行，而不是依赖系统 Node

### 场景 2：Windows 安装包已有系统 Node

**Given** 用户系统 PATH 中有真实 `node.exe`，但 LobsterAI shim 目录在 PATH 前面  
**When** LobsterAI 需要原生 spawn Node 进程  
**Then** 应跳过无扩展名 shim，使用真实 `node.exe`

### 场景 3：macOS/Linux

**Given** 用户在 macOS/Linux 上运行 LobsterAI  
**When** 相关模块解析 Node runtime  
**Then** 保持原有行为：能找到系统 Node 则使用系统 Node，否则回退 Electron-as-node

## 3. 功能需求

- FR-1：提供统一 Node runtime 解析工具，区分 shell shim 和原生 spawn runtime。
- FR-2：Windows 原生 spawn 场景只接受真实 `node.exe`，不接受 `node` bash shim 或 `node.cmd` 作为 Node runtime。
- FR-3：无系统 Node 时，使用 `getElectronNodeRuntimePath()` 并注入 `ELECTRON_RUN_AS_NODE=1`。
- FR-4：npm/npx CLI 场景优先使用打包内 `npm-cli.js` / `npx-cli.js`，通过 Electron-as-node 运行。
- FR-5：升级后对旧的 `cowork\bin\node ENOENT` MCP 解析失败自动重试一次，其他失败状态不自动重试。

## 4. 实现方案

- 新增 `src/main/libs/nodeRuntime.ts`，提供：
  - `findSpawnableSystemNodePath()`
  - `resolveNodeRuntimeForSpawn()`
  - `resolveNodePackageCliCommand()`
  - Windows shim 过滤辅助逻辑
- `resolveStdioCommand.ts` 保留 `findSystemNodePath()` 导出名，但内部改为调用统一解析。
- `mcpLaunchResolverManager.ts` 使用统一 npm/node runtime，并识别可恢复的旧 shim ENOENT 失败。
- `mcpRuntime.ts` 在配置同步时遇到可恢复失败会重新进入 managed resolution，而不是直接 raw fallback。
- `skillManager.ts` 和 `skillServices.ts` 的 Node 脚本运行候选改为统一 runtime。
- `pluginManager.ts` 复用统一 npm CLI 解析，避免维护重复逻辑。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| Windows 只有 LobsterAI shim，没有系统 Node | 使用 Electron-as-node |
| Windows shim 在 PATH 前、系统 Node 在后 | 跳过 shim，选择真实 `node.exe` |
| Windows 只有 `node.cmd` | 不作为原生 Node runtime；需要时回退 Electron-as-node |
| bundled npm-cli.js 不存在 | fallback 到系统 `npm.cmd` 并使用 shell |
| MCP 失败原因是 npm 网络/包错误 | 保持 failed，不自动重试 |
| macOS/Linux | 不增加 Windows shim 过滤，维持原系统 Node 解析语义 |

## 6. 验收标准

- Windows 安装包无系统 Node 时，Context7/Fetch/Playwright 等 `npx` MCP 可完成安装解析。
- Windows 安装包已有系统 Node 且 shim 目录在 PATH 前时，MCP 不再出现 `spawn ...\cowork\bin\node ENOENT`。
- 旧版本产生的 shim ENOENT 型 MCP 失败状态在升级后可自动恢复。
- 技能脚本服务和技能脚本运行不再把无扩展 bash shim 当作原生 Node。
- macOS 的插件、技能、OpenClaw gateway 和 MCP 行为不回退、不改变 PATH shim 策略。
