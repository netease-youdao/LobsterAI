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
**Then** 卡片右下角出现「登录授权」；表单里提示 OAuth 服务不支持预览工具。

### 场景 2: 登录

**Given** 一个启用中的 OAuth 服务处于未授权状态
**When** 用户点击「登录授权」
**Then** 按钮变为「取消」，标签显示「授权中…」，系统浏览器打开服务商授权页；用户授权后标签变为「已授权」，网关在下一次请求时带上令牌。

### 场景 3: 本机回调端口被占用

**Given** 127.0.0.1:8989 已被其他程序占用
**When** 用户点击「登录授权」
**Then** 不打开浏览器（否则授权完成后会跳到一个无人监听的地址），直接提示端口被占用。

### 场景 4: 用户没有完成授权

**Given** 浏览器授权页已打开
**When** 用户关闭页面，超过 OpenClaw 的 5 分钟等待时间
**Then** 提示授权超时，卡片仍显示「登录授权」，可以再次点击。用户也可以随时点卡片上的「取消」立即结束等待，并释放 8989 端口。

### 场景 5: 退出登录

**Given** 服务处于「已授权」
**When** 用户在卡片菜单中选择「退出登录」
**Then** OpenClaw 清除令牌，卡片回到显示「登录授权」。

## 3. 功能需求

### FR-1: 配置字段

`McpServerRecord` / `McpServerFormData` 新增可选字段 `auth?: 'none' | 'oauth'`（`src/shared/mcp/auth.ts` 中的 `McpAuthMode`）：

- 只持久化 `'oauth'`，其余值读写时都归一为未设置，旧数据不受影响；
- stdio 服务的 `auth` 一律清空；
- 更新时未传 `auth` 保留原值。

### FR-2: 写入 openclaw.json

`buildOpenClawMcpServers` 对 `auth === 'oauth'` 的远程服务写入 `auth: "oauth"`，并去掉 `authorization` 请求头（OpenClaw 对 OAuth 服务会忽略并告警该请求头），其余请求头保留。`mcpRuntime` 推给网关的远程服务定义同样带上 `auth`。

### FR-3: CLI 驱动（`src/main/mcp/mcpOAuthCli.ts`）

- 与网关相同的方式启动 CLI：Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1`，指向网关同一个 `OPENCLAW_STATE_DIR`（令牌存在这里）；但 `OPENCLAW_CONFIG_PATH` 指向一份临时的 `openclaw.json`，里面只有这次涉及的服务，条目由配置同步的 `buildOpenClawMcpServers` 生成，与写进网关配置的完全一致。OpenClaw 按服务名 + URL 存令牌，与配置文件无关，所以无论网关配置里此时有没有这个服务（已停用、尚未配置模型、刚保存但网关忙还没投递），CLI 都能操作它的令牌。临时配置不引用 `${VAR}` 密钥也不加载插件，因此不需要注入任何密钥环境变量；
- 临时配置写在系统临时目录下的私有目录（`lobsterai-mcp-oauth-*`，目录 0700、文件 0600，条目里可能有其他请求头），调用结束即删除；应用崩溃留下的目录，在本进程第一次调用 CLI 时按「早于两倍登录超时」清理；
- `login`：逐行读取 stdout，只接受整行为 http(s) 链接的输出作为授权链接，交给 `shell.openExternal` 打开一次；看到 “Could not start the local OAuth callback” 时不打开浏览器并返回 `callback_unavailable`（CLI 此时会以 0 退出但没有令牌）；成功以 stdout 中的 “credentials saved” 为准；同一服务同时只允许一个登录；
- `status`：解析 `mcp status --json`（容忍前后日志），只保留 `auth: "oauth"` 的服务，未知状态归为 `unknown`；
- `logout`：调用 `mcp logout`；
- 登录可通过 `AbortSignal` 取消：结束 CLI 进程（同时释放 8989 端口），返回 `cancelled`；应用退出时取消所有进行中的登录；
- `clearMcpOAuthCredentialsBestEffort`：对该服务执行 `mcp logout`（包括已停用、不在网关配置里的服务），失败只记录告警，不影响调用方。

服务键与 `openclaw.json` 一致，由 `safeServerKey(server.name)` 生成。

### FR-4: IPC

新增 `mcp:oauthLogin`、`mcp:oauthCancel`、`mcp:oauthLogout`、`mcp:oauthStatus`。CLI 用的是自己的临时配置，所以登录 / 退出登录前不再同步 `openclaw.json`，也不受网关是否已加载该服务影响。状态接口按服务 id 返回，只为已启用的 OAuth 服务调用 `mcp status`。

删除服务，或者修改会让令牌失效的字段（名称、URL、关闭 OAuth、改为 stdio）时，先清除该服务在 OpenClaw 中的令牌（服务已停用也一样），避免残留，也避免以后用同名同 URL 重新添加时悄悄沿用旧令牌。删除、停用服务时，正在等待浏览器的登录会被取消（结束 CLI，释放 8989 端口）。

### FR-5: 界面

- 表单：远程服务新增「认证方式」两段选择（无 / 请求头、OAuth 登录）；选择 OAuth 时不发起工具预览；
- 卡片：复用市场里企查查的「登录授权」胶囊样式和文案。「已安装」卡片的标题栏右侧放的是开关，所以胶囊放在卡片右下角（底部标签行的末尾）；授权中，这个位置换成「取消」。左侧标签只表示状态：「⟳ 授权中…」或「已授权」；显示「登录授权」时不再重复显示「未授权」。退出登录在卡片菜单和详情里。状态为 `unknown`（服务已停用）时不显示标签；首次读取状态完成后（即使读取失败），已启用但未授权的服务都会显示「登录授权」；
- MCP 页面打开期间，窗口重新获得焦点时再读一次状态，这样令牌在后台过期或被撤销后不用重新打开页面就能看到。不轮询：每次获得焦点只读一次，读取进行中的焦点事件直接忽略；多次读取重叠时，只采用最后发起的那次结果；
- 详情弹窗：显示授权状态和认证方式，标题栏提供「登录授权 / 取消」按钮（同企查查详情），底部提供「退出登录」；
- 表单里 OAuth 服务不支持预览工具（LobsterAI 自己的工具探测拿不到 OpenClaw 的令牌），提示用户在「高级设置」里按工具名筛选；
- JSON 导入识别远程服务上的 `auth: "oauth"`；
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
- 已停用的服务不在网关的 `openclaw.json` 中，但 CLI 用临时配置，仍能对它执行 logout，所以删除已停用的 OAuth 服务时同样会清除令牌。
- 是否已停用以 LobsterAI 自己的数据为准：已停用的服务一律按未加载处理，不显示授权状态，也不提供「退出登录」；对已停用的服务调用退出登录返回 `server_not_loaded`。
- 网关忙时，保存后的配置可能要等一段时间才投递（`syncOpenClawConfig` 返回 pending），网关配置文件里还没有新服务。登录不依赖网关配置，照常完成；令牌存在共享的状态库里，网关拿到包含该服务（同名同 URL）的配置后直接使用。
- 还没有配置模型时，LobsterAI 只写入不含 MCP 服务的最简 `openclaw.json`。登录同样不受影响；配置模型后网关加载该服务即可使用已保存的令牌。
- CLI 读取配置时可能在 stderr 打印与 MCP 无关的 `[config] warnings`。调用 CLI 时关闭颜色输出，错误信息里去掉这些行，只保留真正的错误。

## 6. 验收标准

- 单元测试：`mcpStore` 读写 `auth`、`openclawConfigSync` 写入 `auth` 并去掉 `authorization`、`mcpOAuthCli` 的链接提取 / 状态解析 / 登录成功 / 已有令牌 / 端口占用 / 非 0 退出 / 并发登录 / 临时配置的内容、权限与清理 / 过期临时目录清理。
- 用 OpenClaw v2026.8.1 运行时实测：`mcp status --json` 解析正确（未登录为 `unauthenticated`，打开授权页后为 `pending-authorization`）；登录能完成发现与动态注册并提取到授权链接；8989 端口被占用时返回 `callback_unavailable` 且不打开浏览器。
- 用本机模拟的 OAuth + MCP 服务和真实 CLI 端到端实测（IPC 处理函数、McpStore、CLI 驱动都是真实代码）：网关配置里没有该服务时登录成功；把服务写进（真实结构的）网关配置后，`mcp probe`（与网关同一套会话 MCP 运行时）带着登录得到的令牌连上服务；登录等待中停用服务，登录返回 `cancelled` 且 8989 端口释放；删除已停用的服务后 `mcp status` 显示 `unauthenticated`、`hasTokens: false`，同名同 URL 重新添加后仍是未授权。
