# 企查查 MCP 集成设计文档

## 1. 概述

企查查提供多个按业务领域拆分的 MCP server。LobsterAI 需要让用户通过一次账号授权完成配置，同时在管理界面将这些 server 作为一个产品管理，而不是展示为多个互不相关的 MCP。

本方案采用登录辅助获取 API Key 的方式，不维护 OAuth access token、refresh token 或登录会话。底层仍保留独立 MCP server 记录，以兼容现有存储和 OpenClaw 配置格式。

## 2. 用户场景

### 场景 1：授权企查查

**Given** 用户尚未配置企查查 MCP  
**When** 用户在 MCP 市场点击“登录授权”并完成企查查登录  
**Then** 应用自动获取 API Key，并创建企查查的全部 MCP server 配置。

### 场景 2：查看授权状态

**Given** 企查查 MCP 已配置  
**When** 用户查看 MCP 市场  
**Then** 企查查卡片显示“已授权”，不在市场提供卸载操作。

### 场景 3：管理企查查服务

**Given** 企查查包含多个已安装 server  
**When** 用户进入已安装页  
**Then** 页面只显示一张企查查卡片，并支持统一启停和卸载。

### 场景 4：兼容多 server 产品

**Given** 其他 registry 条目声明为 bundle，或历史数据中多条 server 共享同一 `registryId`  
**When** 用户进入已安装页  
**Then** 这些 server 复用相同的聚合和批量管理逻辑。

## 3. 功能需求

### FR-1：市场展示

- 企查查作为本地托管条目与在线市场数据合并。
- 使用 1 基坐标 `marketplacePosition=4` 控制首屏位置。
- 在线条目不足时追加到末尾；远端同 ID 条目由本地定义覆盖并去重。
- 未配置时显示“登录授权”，配置完成后显示“已授权”。

### FR-2：授权与配置

- 打开隔离的 Electron 授权窗口完成企查查登录。
- 登录后从企查查页面接口读取 API Key。
- 使用 `Authorization: Bearer <apiKey>` 配置以下 HTTP MCP server：
  - `qcc-company`
  - `qcc-risk`
  - `qcc-ipr`
  - `qcc-operation`
  - `qcc-executive`
  - `qcc-history`
- 重复执行授权时更新相同名称的既有 server，不创建重复记录。

### FR-3：套件展示

- `McpRegistryEntry.kind=bundle` 表示该 registry 应作为套件展示。
- 缺少 `kind` 的既有在线条目继续按单 server 处理。
- 同一 `registryId` 存在多条历史记录时，即使 registry 元数据暂时不可用，也推断为套件。
- 套件卡片的名称和描述优先使用 registry 元数据，协议、数量和摘要根据实际成员计算。

### FR-4：批量管理

- `mcp:setEnabledByRegistryId` 统一启停套件下的全部 server。
- `mcp:deleteByRegistryId` 统一删除套件下的全部 server 和 launch resolution。
- 每次批量操作只触发一次 OpenClaw 配置同步。
- 卸载入口位于已安装页，并经过统一确认流程。

## 4. 实现方案

### 4.1 数据与运行层

企查查的每个 MCP server 继续作为独立记录存储，共享 `registryId=qichacha`。OpenClaw 仍接收独立的 `mcp.servers` 配置，不新增套件表或数据库迁移。

### 4.2 授权流程

主进程负责注册企查查 client、构造 PKCE 授权参数、打开授权窗口并探测 API Key。获取成功后，MCP IPC handler 创建或更新六个 server，并同步 OpenClaw 配置。

授权窗口使用临时隔离 session。关闭窗口、超时或无法获得 API Key 时终止流程，不写入部分配置。

### 4.3 通用套件模型

Renderer 的纯逻辑模块负责：

- 合并在线市场条目和本地托管条目；
- 根据 `kind=bundle` 或相同 `registryId` 的多条记录构造已安装套件；
- 保留首个成员在原 server 列表中的位置，避免改变已安装页整体顺序。

企查查专属判断仅保留在授权入口，已安装页的聚合、启停和卸载均使用通用套件逻辑。

## 5. 边界与取舍

| 场景 | 处理方式 |
|------|---------|
| 在线市场不可用 | 使用本地 registry 定义，企查查仍可展示 |
| 在线条目少于目标位置 | 将企查查追加到末尾 |
| 用户中途关闭授权窗口 | 返回失败，不写入 MCP 配置 |
| 企查查只剩部分 server | 仍按 bundle 展示，并显示实际数量 |
| 套件包含多种协议 | 不显示误导性的单一协议标签 |
| registry 元数据不可用 | 相同 `registryId` 多记录仍聚合展示 |

当前方案保存的是 API Key，不保存 OAuth token，因此不实现 token refresh。卸载会删除本地 MCP 配置并同步 OpenClaw，但不调用 OAuth revoke；如果后续改为持久化 OAuth token，应在主进程卸载生命周期中补充 revoke。

## 6. 涉及文件

- `src/main/mcp/qichachaMcpAuth.ts`
- `src/main/ipcHandlers/mcp/handlers.ts`
- `src/main/preload.ts`
- `src/shared/mcp/constants.ts`
- `src/renderer/data/mcpRegistry.ts`
- `src/renderer/services/mcp.ts`
- `src/renderer/services/mcpRegistryPresentation.ts`
- `src/renderer/components/mcp/McpManager.tsx`
- `src/renderer/services/i18n.ts`
- `src/renderer/types/mcp.ts`
- `src/renderer/types/electron.d.ts`

## 7. 验收标准

- 用户可从 MCP 市场完成企查查授权和自动配置。
- OpenClaw 配置包含六个带 Authorization header 的企查查 server。
- 市场中的已授权企查查仅显示“已授权”。
- 已安装页将企查查显示为一张套件卡片。
- 套件可统一启停和卸载，且只同步一次 OpenClaw 配置。
- 单 server 市场条目的安装和管理行为保持不变。
- 历史同 `registryId` 多 server 数据可复用套件展示逻辑。
