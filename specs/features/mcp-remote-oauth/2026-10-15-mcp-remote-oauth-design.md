# 远程 MCP 服务 OAuth 登录设计文档

## 1. 概述

### 1.1 背景

越来越多的远程 MCP 服务（Streamable HTTP / SSE）按 MCP 授权规范要求 OAuth 2.1 登录：客户端先发现授权服务器，动态注册客户端，再走 PKCE 授权码流程拿到访问令牌。目前 LobsterAI 的自定义 MCP 只能填写固定请求头，用户需要自己去服务商后台生成 API Key 再粘贴进来；市场里只有企查查一个条目通过 `oauthProvider: 'qichacha'` 做了专门对接，无法复用到其他服务。

OpenClaw（v2026.8.1）已经内置了完整的 MCP OAuth 支持：

- `openclaw.json` 中 `mcp.servers.<key>.auth = "oauth"` 即声明该服务使用 OAuth；
- `openclaw mcp login <key>` 负责发现、动态注册、PKCE、本机回调（`127.0.0.1:8989`，等待 5 分钟）与令牌落盘，授权链接打印到 stdout，不会自己打开浏览器；
- `openclaw mcp status --json` 返回每个服务的 `authStatus.state`；
- `openclaw mcp logout <key>` 清除令牌；
- 令牌存在 OpenClaw 状态库里，网关每次请求都会重新读取，并自动刷新。

所以 LobsterAI 只需要把开关写进配置，并在界面上驱动这三个命令，就能支持任意符合规范的 OAuth MCP 服务。

### 1.2 目标

- 自定义远程 MCP 服务可以选择「OAuth 登录」认证方式，无需填写密钥。
- 服务卡片显示登录状态，提供「登录」按钮与「退出登录」菜单。
- 点击登录后由系统浏览器打开服务商的授权页，授权完成后自动生效，不重启网关。
- 不改动 OpenClaw，不新增依赖。

### 1.3 非目标

- 不改造企查查现有的专门对接（`oauthProvider: 'qichacha'`）。
- 不在本次为市场条目增加 OAuth 字段；市场条目一键接入可以在此基础上另行实现。
- 不支持 stdio 服务的 OAuth（规范只定义了 HTTP 传输的授权）。

## 2. 用户场景

### 场景 1: 添加 OAuth 服务

**Given** 用户在「自定义」里添加一个 Streamable HTTP 服务
**When** 认证方式选择「OAuth 登录」并保存
**Then** 卡片出现「需要登录」标签和「登录」按钮；表单里的工具预览提示需要先登录。

### 场景 2: 登录

**Given** 一个启用中的 OAuth 服务处于「需要登录」
**When** 用户点击「登录」
**Then** 按钮变为「等待浏览器授权…」，系统浏览器打开服务商授权页；用户授权后卡片变为「已登录」，网关在下一次请求时带上令牌。

### 场景 3: 本机回调端口被占用

**Given** 127.0.0.1:8989 已被其他程序占用
**When** 用户点击「登录」
**Then** 不打开浏览器（否则授权完成后会跳到一个无人监听的地址），直接提示端口被占用。

### 场景 4: 用户没有完成授权

**Given** 浏览器授权页已打开
**When** 用户关闭页面，超过 OpenClaw 的 5 分钟等待时间
**Then** 提示授权超时，卡片仍为「需要登录」，可以再次点击登录。

### 场景 5: 退出登录

**Given** 服务处于「已登录」
**When** 用户在卡片菜单中选择「退出登录」
**Then** OpenClaw 清除令牌，卡片回到「需要登录」。

## 3. 功能需求

### FR-1: 配置字段

`McpServerRecord` / `McpServerFormData` 新增可选字段 `auth?: 'none' | 'oauth'`（`src/shared/mcp/auth.ts` 中的 `McpAuthMode`）：

- 只持久化 `'oauth'`，其余值读写时都归一为未设置，旧数据不受影响；
- stdio 服务的 `auth` 一律清空；
- 更新时未传 `auth` 保留原值。

### FR-2: 写入 openclaw.json

`buildOpenClawMcpServers` 对 `auth === 'oauth'` 的远程服务写入 `auth: "oauth"`，并去掉 `authorization` 请求头（OpenClaw 对 OAuth 服务会忽略并告警该请求头），其余请求头保留。`mcpRuntime` 推给网关的远程服务定义同样带上 `auth`。

### FR-3: CLI 驱动（`src/main/mcp/mcpOAuthCli.ts`）

- 与网关相同的方式启动 CLI：Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1`，指向同一个 `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH`，并注入 `openclaw.json` 中 `${VAR}` 引用的密钥环境变量；
- `login`：逐行读取 stdout，只接受整行为 http(s) 链接的输出作为授权链接，交给 `shell.openExternal` 打开一次；看到 “Could not start the local OAuth callback” 时不打开浏览器并返回 `callback_unavailable`（CLI 此时会以 0 退出但没有令牌）；成功以 stdout 中的 “credentials saved” 为准；同一服务同时只允许一个登录；
- `status`：解析 `mcp status --json`（容忍前后日志），只保留 `auth: "oauth"` 的服务，未知状态归为 `unknown`；
- `logout`：调用 `mcp logout`。

服务键与 `openclaw.json` 一致，由 `safeServerKey(server.name)` 生成。

### FR-4: IPC

新增 `mcp:oauthLogin`、`mcp:oauthLogout`、`mcp:oauthStatus`。登录前先同步一次 `openclaw.json`，保证 CLI 读到的是刚保存的配置。状态接口按服务 id 返回。

### FR-5: 界面

- 表单：远程服务新增「认证方式」两段选择（无 / 请求头、OAuth 登录）；选择 OAuth 时不发起工具预览；
- 卡片：OAuth 服务显示「已登录 / 需要登录」标签，未登录且已启用时显示「登录」按钮；已登录时菜单里有「退出登录」；
- 只有存在 OAuth 服务时才调用 `mcp status`，避免无谓地启动 CLI。

## 4. 实现方案

| 文件 | 改动 |
| --- | --- |
| `src/shared/mcp/auth.ts` | 新增认证方式、OAuth 状态、错误码常量与结果类型 |
| `src/main/mcp/mcpStore.ts` | `auth` 字段的读写与归一 |
| `src/main/libs/openclawConfigSync.ts` | 写入 `auth: "oauth"`，去掉 `authorization` 请求头；导出 `safeServerKey` |
| `src/main/mcp/mcpRuntime.ts` | 网关服务定义带上 `auth` |
| `src/main/mcp/mcpOAuthCli.ts` | CLI 驱动（新增） |
| `src/main/libs/openclawPluginInstallMigration.ts` | 导出 `resolveOpenClawCliPath` 供复用 |
| `src/main/ipcHandlers/mcp/handlers.ts`、`src/main/main.ts`、`src/main/preload.ts` | IPC 与上下文注入 |
| `src/renderer/components/mcp/McpServerFormModal.tsx`、`McpManager.tsx` | 表单与卡片交互 |
| `src/renderer/services/mcp.ts`、`src/renderer/types/*`、`src/renderer/services/i18n.ts` | 渲染层服务、类型与中英文文案 |

## 5. 边界情况

- 登录完成前网关已经尝试过连接并失败：OpenClaw 约 5 秒后会重试拉取工具目录，所以登录后马上发起的第一轮对话可能还没有该服务的工具，稍等即可。
- 服务名包含非 ASCII 字符：`safeServerKey` 会转成 `mcp-<hash>`，CLI 与 `openclaw.json` 使用同一个键，令牌按服务名 + URL 识别，改名或改 URL 后需要重新登录。
- 授权链接只接受 http/https，防止恶意服务让应用打开 `file:` 或自定义协议链接。
- 还没有配置模型时，LobsterAI 只写入不含 MCP 服务的最简 `openclaw.json`，CLI 会报 “No MCP server named …”。登录前先检查服务是否已在 `mcp.servers` 中，不在则返回 `server_not_loaded`，提示用户先配置模型；CLI 返回同样的报错时也归到这个错误码。

## 6. 验收标准

- 单元测试：`mcpStore` 读写 `auth`、`openclawConfigSync` 写入 `auth` 并去掉 `authorization`、`mcpOAuthCli` 的链接提取 / 状态解析 / 登录成功 / 已有令牌 / 端口占用 / 非 0 退出 / 并发登录。
- 用 OpenClaw v2026.8.1 运行时实测：`mcp status --json` 解析正确（未登录为 `unauthenticated`，打开授权页后为 `pending-authorization`）；登录能完成发现与动态注册并提取到授权链接；8989 端口被占用时返回 `callback_unavailable` 且不打开浏览器。
