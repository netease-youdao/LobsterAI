# LobsterAI 产品使用日志上报设计文档

## 1. 概述

### 1.1 问题/背景

LobsterAI 需要增加产品使用日志上报能力，帮助项目维护者了解应用安装、核心功能入口和关键交互的使用情况，为功能优化、兼容性改进和开发优先级提供数据依据。

当前关注的数据包括用户选择和使用的技能、MCP、专家套件、模型来源与模型类型、设置项、Agent、定时任务、会话输入框、消息交互、artifact/浏览器预览以及其他核心功能的使用情况。具体事件名称、触发时机和业务参数已在本文 2.4 中维护，后续新增事件继续按同一规范补充。

当前实现已建立独立、统一的日志请求入口，集中处理日志服务地址、通用参数、用户标识、时间戳、基础环境信息、使用统计开关和网络请求，避免各业务模块自行拼接和发送日志。

### 1.2 目标

1. 提供统一的有道 Analyzer 日志上报方法。
2. 集中维护日志请求地址和 `_npid`、`_ncat` 等通用参数。
3. 自动补充当前登录用户的 `yid`、事件发生时间戳和基础环境参数。
4. 允许业务模块传入 `action` 和事件特有参数。
5. 日志上报失败不能影响应用原有功能。
6. 在设置中提供用户可主动关闭的使用统计开关。
7. 按统一命名和参数规范覆盖主要功能入口，并为后续新增事件保留扩展入口。

### 1.3 非目标

当前阶段仍不包含以下内容：

- 不实现请求队列、批量发送、失败重试、离线缓存或频率限制。
- 不新增数据库表、迁移脚本或独立安装 ID；安装维度统计复用现有 `installation_uuid`。
- 不上传 prompt 正文、对话内容、文件内容、完整文件路径、完整 URL、密钥、API Key、MCP env/header、IM 凭据或其他用户业务数据。
- 不上传 prompt hash，避免通过短文本或常见任务反查用户输入。
- 不做远端内容理解或远端 prompt 分类；输入语言、意图和形态特征仅在本地用规则计算后上传结构化结果。
- 不采集后台轮询、流式 token 或鼠标移动等高频行为，避免性能和日志噪声问题。

## 2. 当前实现

### 2.1 文件位置

日志请求实现在：

```text
src/renderer/services/logReporter.ts
```

对应单元测试位于：

```text
src/renderer/services/logReporter.test.ts
```

业务调用方统一通过 `reportYdAnalyzer()` 发送事件。当前已接入计划模式、应用启动、技能、MCP、专家套件、模型选择、设置页和 IM 机器人等入口；具体事件列表见下文 2.4。

### 2.2 日志服务配置

当前请求地址和通用参数为：

```typescript
export const LogReporterEndpoint = {
  YoudaoAnalyzer: 'https://rlogs.youdao.com/rlog.php',
} as const;

export const LogReporterProduct = {
  LobsterAI: 'wisdom',
} as const;

export const LogReporterCategory = {
  Actions: 'actions',
} as const;

export const LogReporterActionPrefix = {
  LobsterAI: 'lobsterai_',
} as const;
```

所有 `action` 必须以 `lobsterai_` 开头。日志模块会拒绝发送不符合该命名规则的事件，避免不同业务模块产生无法统一检索的事件名称。

### 2.3 参数构建

`buildLogUrl()` 使用 `URL` 和 `URLSearchParams` 生成 GET 请求地址。最终参数由以下部分组成：

| 参数 | 来源 | 说明 |
|------|------|------|
| `_npid` | 通用配置 | 产品 ID，当前为 `wisdom` |
| `_ncat` | 通用配置 | 日志分类，当前为 `actions` |
| `action` | 业务调用方 | 事件名称，不能为空且必须以 `lobsterai_` 开头 |
| `app_version` | Electron 应用信息 | 当前应用版本；首次上报前异步读取并缓存，读取失败时为空字符串 |
| `os_platform` | Preload 暴露的运行环境 | 当前系统平台，例如 `darwin`、`win32`、`linux` |
| `os_arch` | Preload 暴露的运行环境 | 当前系统架构，例如 `arm64`、`x64` |
| `language` | 应用配置 | 当前应用语言 |
| `uuid` | 本地安装 ID | 复用现有 `installation_uuid`，未登录时也可用于安装维度统计；读取失败时不发送 |
| `firstKeyfrom` | 渠道归因 | 复用现有首次渠道归因；读取失败时不发送 |
| `latestKeyfrom` | 渠道归因 | 复用现有最近渠道归因；读取失败时不发送 |
| `is_logged_in` | Redux 登录态 | 当前是否存在登录用户 `yid` |
| `log_Usid` | Redux 登录态 | 当前用户的 `yid`，未登录时为空字符串 |
| `uts` | 日志模块 | `Date.now()` 生成的毫秒时间戳 |
| 其他参数 | 业务调用方 | 当前事件特有的字符串、数字或布尔值参数 |

值为 `null` 或 `undefined` 的可选参数不会加入请求地址。

### 2.4 事件定义

所有事件名称通过 `action` 字段上报，命名统一使用 `lobsterai_` 前缀。已实现和规划中的事件不上传 API Key、MCP env/header、文件路径、对话内容或本地日志内容。涉及自定义技能、MCP、专家套件和模型时，当前仅上报 ID、名称、来源、类型和数量等结构化信息。

#### 2.4.1 `lobsterai_plan_mode_enabled`

- 状态：已实现。
- 触发时机：用户在输入框工具菜单中主动开启计划模式。关闭计划模式不发送。
- 事件含义：统计计划模式开启行为。
- 业务参数：
  - `entry`：string，触发入口。当前固定为 `prompt_tools_menu`，表示用户从输入框工具菜单开启计划模式。

#### 2.4.2 `lobsterai_app_started`

- 状态：已实现。
- 触发时机：Renderer 初始化完成并进入 shell ready 后发送一次。
- 事件含义：统计应用启动和活跃安装。
- 业务参数：
  - `providerModelCount`：number，Renderer 初始化阶段加载到的用户自配模型数量，用于观察本地模型配置覆盖情况。
  - `hasLoggedInUser`：boolean，启动完成时本地 Redux 登录态中是否存在用户 `yid`。该字段只表示启动时登录态快照，不替代通用参数 `is_logged_in`。

#### 2.4.3 `lobsterai_skill_enabled`

- 状态：已实现。
- 触发时机：用户成功启用技能时发送。关闭技能不发送，启用失败不发送。
- 事件含义：统计技能启用情况。
- 业务参数：
  - `skillId`：string，被启用技能的稳定 ID。
  - `skillName`：string，被启用技能的展示名称。
  - `skillSource`：string，技能来源分类。当前取值为 `built_in`、`official` 或 `custom`。
  - `isBuiltIn`：boolean，是否为应用内置技能。
  - `isOfficial`：boolean，是否为官方技能。
  - `version`：string，技能版本；缺失时不发送。

#### 2.4.4 `lobsterai_mcp_enabled`

- 状态：已实现。
- 触发时机：用户成功启用 MCP 服务时发送。关闭 MCP 不发送，启用失败不发送。
- 事件含义：统计 MCP 使用情况。
- 业务参数：
  - `mcpId`：string，被启用 MCP 服务的稳定 ID。
  - `mcpName`：string，被启用 MCP 服务的展示名称。
  - `mcpSource`：string，MCP 来源分类。当前取值为 `built_in`、`marketplace` 或 `custom`。
  - `registryId`：string，MCP 市场/注册表 ID；自定义 MCP 缺失时不发送。
  - `transportType`：string，MCP 传输类型，当前为 `stdio`、`sse` 或 `http`。
  - `isBuiltIn`：boolean，是否为内置 MCP。
- 隐私边界：不上传 MCP `command`、`args`、`env`、`url`、`headers` 等配置内容。

#### 2.4.5 `lobsterai_expert_kit_selected`

- 状态：已实现。
- 触发时机：用户在输入框专家套件菜单中选择套件时发送。取消选择不发送。
- 事件含义：统计专家套件选择情况。
- 业务参数：
  - `kitId`：string，被选择专家套件的稳定 ID。
  - `kitName`：string，专家套件展示名称；无法从市场元数据解析时不发送。
  - `kitSource`：string，专家套件来源分类。当前取值为 `lobsterai-kits` 或 `installed`。
  - `isInstalled`：boolean，当前本地是否已安装该专家套件。
  - `skillCount`：number，该专家套件关联的技能数量；无法解析时不发送。
  - `mcpServerCount`：number，该专家套件关联的 MCP 服务数量；无法解析时不发送。
  - `connectorCount`：number，该专家套件关联的连接器数量；无法解析时不发送。

#### 2.4.5.1 `lobsterai_expert_kit_action`

- 状态：已实现。
- 触发时机：用户在「专家套件」页面搜索、清空搜索、打开详情、返回列表、安装、卸载、打开卸载确认、取消卸载确认、点击「试着问问」、因未安装打开安装提示，以及安装后继续提问时发送。
- 事件含义：统计专家套件市场浏览、详情转化、安装/卸载结果和示例提问转化。
- 业务参数：
  - `source`：string，触发来源。当前取值为 `kits_manager`。
  - `actionType`：string，动作类型。当前取值包括 `search`、`clear_search`、`open_detail`、`back_to_list`、`install_submit`、`install_success`、`install_failed`、`uninstall_confirm_open`、`uninstall_confirm_cancel`、`uninstall_submit`、`uninstall_success`、`uninstall_failed`、`try_asking`、`install_prompt_open`、`install_prompt_cancel`、`install_and_try_submit`。
  - `kitId`：string，专家套件稳定 ID。
  - `kitName`：string，专家套件展示名称。
  - `kitSource`：string，专家套件来源分类。当前取值为 `lobsterai-kits` 或 `installed`。
  - `isInstalled`：boolean，当前本地是否已安装该专家套件。
  - `version`：string，市场版本。
  - `installedVersion`：string，本地已安装版本。
  - `currentVersion`：string，市场当前版本；存在更新时发送。
  - `hasUpdate`：boolean，是否存在可重装/更新提示。
  - `skillCount`：number，套件关联技能数量。
  - `skillIds`：string，套件关联技能 ID 列表，以英文逗号连接。
  - `skillNames`：string，套件关联技能展示名称列表，以英文逗号连接。
  - `mcpServerCount`：number，套件关联 MCP 服务数量。
  - `connectorCount`：number，套件关联连接器数量。
  - `tryAskingIndex`：number，点击的示例提问序号。
  - `hasTryAsking`：boolean，套件是否包含示例提问。
  - `searchKeywordLength`：number，搜索关键词长度。
  - `resultCount`：number，当前搜索结果数量。
  - `result`：string，动作结果。当前取值包括 `success`、`failed`。
  - `errorCode`：string，失败分类；不上传错误详情。
- 隐私边界：
  - 不上传套件 bundle URL、示例提问完整文本、安装错误详情或本地路径。
  - 会上传专家套件 ID/名称、关联技能 ID/名称、版本和能力数量，用于分析用户对不同能力包的兴趣与转化。

#### 2.4.5.2 `lobsterai_skill_action`

- 状态：已实现。
- 触发时机：用户在「技能」页面切换 tab、搜索、清空搜索、切换市场标签、打开添加菜单、上传 zip/folder、打开远程导入、提交远程导入、创建技能入口、启用/关闭技能、市场安装、升级、全部升级、删除确认、删除结果、安全审计弹窗和审计操作时发送。
- 事件含义：统计技能管理页的发现、安装、升级、启用、删除、安全审计和创建入口转化。
- 业务参数：
  - `source`：string，触发来源。当前取值为 `skills_manager`。
  - `actionType`：string，动作类型。当前取值包括 `tab_change`、`search`、`clear_search`、`market_tag_change`、`add_menu_open`、`upload_zip_open`、`upload_folder_open`、`remote_import_open`、`remote_import_close`、`remote_import_submit`、`import_submit`、`import_success`、`import_failed`、`create_by_chat`、`create_by_chat_missing_skill`、`create_by_chat_disabled_skill`、`toggle_enabled`、`toggle_enabled_success`、`toggle_enabled_failed`、`open_installed_detail`、`open_marketplace_detail`、`close_installed_detail`、`close_marketplace_detail`、`marketplace_install_submit`、`marketplace_install_success`、`marketplace_install_failed`、`upgrade_submit`、`upgrade_success`、`upgrade_failed`、`upgrade_all_submit`、`upgrade_all_finished`、`delete_confirm_open`、`delete_confirm_cancel`、`delete_success`、`delete_failed`、`security_report_open`、`security_report_action`、`sync_from_openclaw_submit`、`sync_from_openclaw_success`、`sync_from_openclaw_failed`、`manual_openclaw_sync`。
  - `activeTab`：string，当前 tab。当前取值为 `installed` 或 `marketplace`。
  - `targetTab`：string，目标 tab。
  - `activeMarketTag`：string，当前市场标签。
  - `targetMarketTag`：string，目标市场标签。
  - `searchKeywordLength`：number，搜索关键词长度。
  - `resultCount`：number，当前结果数量。
  - `skillId`：string，技能稳定 ID。
  - `skillName`：string，技能展示名称。
  - `skillSource`：string，技能来源分类。当前取值包括 `built_in`、`official`、`custom`、`marketplace`。
  - `isBuiltIn`：boolean，是否为应用内置技能。
  - `isOfficial`：boolean，是否为官方技能。
  - `version`：string，当前技能版本。
  - `marketplaceVersion`：string，市场版本。
  - `hasUpdate`：boolean，是否存在可升级版本。
  - `tags`：string，市场标签 ID 列表，以英文逗号连接。
  - `sourceType`：string，导入来源类型。当前取值包括 `zip`、`folder`、`remote`、`github`、`clawhub`、`marketplace`。
  - `importTab`：string，远程导入 tab。当前取值为 `github` 或 `clawhub`。
  - `riskLevel`：string，安全审计风险等级。
  - `findingsCount`：number，安全审计发现数量。
  - `securityAction`：string，用户对安全审计弹窗的操作。当前取值为 `install`、`installDisabled` 或 `cancel`。
  - `targetEnabled`：boolean，技能开关后的目标状态。
  - `updatableCount`：number，全部升级时可升级技能数量。
  - `result`：string，动作结果。当前取值包括 `success`、`failed`、`cancel`。
  - `errorCode`：string，失败分类；不上传错误详情。
- 隐私边界：
  - 不上传 `SKILL.md` 正文、prompt、`skillPath`、zip/folder 本地路径、远程导入 URL 原文、安全审计 findings 详情或错误详情。
  - 会上传技能 ID/名称、市场标签、版本、来源、安全风险等级和发现数量，用于分析技能安装转化、升级转化和安全审计影响。

#### 2.4.5.3 `lobsterai_mcp_action`

- 状态：已实现。
- 触发时机：用户在「MCP」页面切换 tab、搜索、清空搜索、切换市场分类、打开市场安装表单、打开自定义新增表单、打开编辑表单、保存表单、启用/关闭、删除确认、删除结果和重试 launch resolution 时发送。
- 事件含义：统计 MCP 市场发现、自定义配置、启用转化、删除和启动修复链路。
- 业务参数：
  - `source`：string，触发来源。当前取值为 `mcp_manager`。
  - `actionType`：string，动作类型。当前取值包括 `tab_change`、`search`、`clear_search`、`category_change`、`marketplace_install_open`、`custom_create_open`、`edit_open`、`form_close`、`create_submit`、`create_success`、`create_failed`、`edit_submit`、`edit_success`、`edit_failed`、`toggle_enabled`、`toggle_enabled_success`、`toggle_enabled_failed`、`delete_confirm_open`、`delete_confirm_cancel`、`delete_success`、`delete_failed`、`launch_retry_submit`、`launch_retry_success`、`launch_retry_failed`。
  - `activeTab`：string，当前 tab。当前取值为 `installed`、`marketplace` 或 `custom`。
  - `targetTab`：string，目标 tab。
  - `activeCategory`：string，当前市场分类。
  - `targetCategory`：string，目标市场分类。
  - `searchKeywordLength`：number，搜索关键词长度。
  - `resultCount`：number，当前结果数量。
  - `mcpId`：string，MCP 服务稳定 ID；自定义保存前缺失时不发送。
  - `mcpName`：string，MCP 服务展示名称。
  - `mcpSource`：string，MCP 来源分类。当前取值为 `built_in`、`marketplace` 或 `custom`。
  - `registryId`：string，市场/注册表 ID。
  - `category`：string，市场分类。
  - `transportType`：string，MCP 传输类型。当前取值为 `stdio`、`sse` 或 `http`。
  - `isBuiltIn`：boolean，是否为内置/市场安装服务。
  - `enabled`：boolean，当前是否启用。
  - `targetEnabled`：boolean，开关后的目标状态。
  - `requiredEnvKeyCount`：number，必填环境变量 key 数量。
  - `optionalEnvKeyCount`：number，选填环境变量 key 数量。
  - `hasRequiredEnv`：boolean，是否存在必填环境变量。
  - `hasOptionalEnv`：boolean，是否存在选填环境变量。
  - `envKeyCount`：number，已配置 env key 数量；不上传 env 值。
  - `headerKeyCount`：number，已配置 header key 数量；不上传 header 值。
  - `argCount`：number，stdio 参数数量；不上传参数内容。
  - `hasUrl`：boolean，HTTP/SSE 配置是否存在 URL；不上传 URL。
  - `launchStatus`：string，启动解析状态。当前取值包括 `pending`、`installing`、`ready`、`failed`、`unsupported`。
  - `resolverKind`：string，启动解析器类型。当前取值包括 `npx`、`uvx`、`python`、`raw`。
  - `packageName`：string，解析到的包名。
  - `requestedVersion`：string，请求版本。
  - `resolvedVersion`：string，解析版本。
  - `hasLaunchError`：boolean，是否存在启动解析错误。
  - `result`：string，动作结果。当前取值包括 `success`、`failed`。
  - `errorCode`：string，失败分类；不上传错误详情。
- 隐私边界：
  - 不上传 MCP `command` 完整内容、`args` 内容、`env` 值、`headers` 值、`url`、`installDir`、`sourceFingerprint`、launch error 详情或本地路径。
  - 会上传 registry/category/transport/package/launch 状态和 key 数量，用于分析 MCP 安装配置阻塞点和启动失败类型。

#### 2.4.6 `lobsterai_model_selected`

- 状态：已实现。
- 触发时机：用户成功切换当前会话模型，或成功保存 Agent 模型选择后发送。切换/保存失败不发送。
- 事件含义：统计模型选择情况。
- 业务参数：
  - `modelId`：string，被选择模型的 ID。
  - `modelName`：string，被选择模型的展示名称。
  - `modelSource`：string，模型来源分类。当前取值为 `package` 或 `custom`；`package` 表示套餐/服务端模型，`custom` 表示用户自配模型。
  - `providerKey`：string，模型所属 provider 的配置 key；缺失时不发送。
  - `provider`：string，模型所属 provider 的展示名称；缺失时不发送。
  - `selectorGroup`：string，模型选择器分组，当前为 `server` 或 `user`。
  - `target`：string，本次选择作用范围。`session` 表示切换当前会话模型，`agent` 表示保存 Agent 模型。
  - `agentId`：string，当前 Agent ID。
  - `sessionId`：string，当前会话 ID；仅 `target=session` 时发送。
  - `isServerModel`：boolean，是否为服务端套餐模型。
- 隐私边界：不上传 provider API Key、base URL、鉴权类型或其他模型凭证配置。

#### 2.4.7 `lobsterai_general_setting_changed`

- 状态：已实现。
- 触发时机：用户在「设置 -> 通用」修改设置并成功生效后发送。未保存、保存失败或系统 API 调用失败不发送。
- 事件含义：统计通用设置项的实际变更情况。
- 生效语义：
  - `autoLaunch` 和 `preventSleep` 是立即生效项，应在对应系统 API 返回成功后发送。
  - `language`、`useSystemProxy`、`sqliteAutoBackupEnabled`、`taskCompletionNotificationsEnabled`、`skipMissedJobs` 等配置项应在设置页保存成功后，根据保存前后的 diff 逐项发送。
  - `usageAnalyticsEnabled=false` 不通过该事件发送，避免用户选择关闭使用统计后仍继续上报关闭动作。
- 业务参数：
  - `settingKey`：string，变更的通用设置项 key。当前规划取值包括 `language`、`autoLaunch`、`preventSleep`、`useSystemProxy`、`sqliteAutoBackupEnabled`、`taskCompletionNotificationsEnabled`、`skipMissedJobs`。
  - `settingValue`：string 或 boolean，变更后的基础值。布尔设置使用 `true` / `false`；语言使用 `zh` / `en`。
  - `previousValue`：string 或 boolean，变更前的基础值；无法可靠获取时不发送。
  - `source`：string，触发来源。当前固定为 `settings_general`。
- 暂不记录：快捷键具体组合、代理地址、API Key、base URL、文件路径等可能包含用户偏好或敏感信息的内容。

#### 2.4.8 `lobsterai_usage_analytics_enabled`

- 状态：已实现。
- 触发时机：用户在「设置 -> 通用」中将「帮助改进 LobsterAI」从关闭重新开启，并成功保存后发送。
- 事件含义：统计用户主动重新开启基础使用统计的情况。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_general`。
- 隐私边界：
  - 用户将 `usageAnalyticsEnabled` 从开启改为关闭时不发送任何日志请求。
  - 重新开启事件只在保存成功后发送，不在用户点击但未保存时发送。

#### 2.4.9 `lobsterai_appearance_setting_changed`

- 状态：已实现。
- 触发时机：用户在「设置 -> 外观」修改设置并保存成功后，根据保存前后的 diff 逐项发送。未保存或保存失败不发送。
- 事件含义：统计外观设置项的实际变更情况。
- 业务参数：
  - `settingKey`：string，变更的外观设置项 key。当前取值包括 `theme`、`themeId`。
  - `settingValue`：string，变更后的基础值。`theme` 当前为 `light`、`dark` 或 `system`；`themeId` 为主题色 ID，例如 `classic-light`、`midnight`、`cyber`。
  - `previousValue`：string，变更前的基础值；无法可靠获取时不发送。
  - `source`：string，触发来源。当前固定为 `settings_appearance`。
- 隐私边界：不上传主题 token、颜色值、CSS 变量或其它样式细节。

#### 2.4.10 `lobsterai_agent_engine_setting_changed`

- 状态：已实现。
- 触发时机：用户在「设置 -> Agent 引擎」相关配置保存成功后，根据保存前后的 diff 逐项发送。未保存或保存失败不发送。
- 事件含义：统计 Agent 引擎相关设置的实际变更情况。
- 业务参数：
  - `settingKey`：string，变更的 Agent 引擎设置项 key。当前取值包括 `agentEngine`、`openClawSessionKeepAlive`。
  - `settingValue`：string，变更后的基础值。
  - `previousValue`：string，变更前的基础值；无法可靠获取时不发送。
  - `source`：string，触发来源。当前固定为 `settings_agent_engine`。
- 暂不记录：OpenClaw gateway URL、本地 runtime 路径、配置文件路径、工作区路径、token、key 或 env。
- 说明：`skipMissedJobs` 当前归入「设置 -> 通用」的 `lobsterai_general_setting_changed`，避免同一次保存重复上报。

#### 2.4.11 `lobsterai_agent_engine_maintenance_action`

- 状态：已实现。
- 触发时机：用户在「设置 -> Agent 引擎」主动执行维护动作，并且动作完成后发送。用户取消文件选择等未完成动作不发送。
- 事件含义：统计 Agent 引擎维护动作的结果。
- 业务参数：
  - `actionType`：string，维护动作类型。当前取值包括 `repair_gateway_state`、`backup_data`、`restore_data`。
  - `result`：string，动作结果。当前取值包括 `success`、`failed`。数据恢复成功后即使需要自动重启，也上报 `success`。
  - `errorCode`：string，失败分类；无法识别时为 `unknown`。仅失败时发送。
  - `sizeBytes`：number，备份文件大小；仅 `backup_data` 成功且可获取时发送。
  - `source`：string，触发来源。当前固定为 `settings_agent_engine`。
- 隐私边界：不上传备份文件路径、导入文件路径、OpenClaw gateway URL、错误详情文本或本地配置内容。

#### 2.4.12 `lobsterai_custom_model_settings_saved`

- 状态：已实现。
- 触发时机：用户在「设置 -> 自定义模型」修改 provider 或模型配置，并成功保存后发送；删除自定义 provider 这类即时持久化动作在确认删除且持久化成功后发送。未保存、保存失败或仅切换 provider tab 不发送。
- 事件含义：用较粗粒度统计用户自定义模型配置情况，避免对每个输入框或每个模型编辑动作做过细埋点。
- 发送口径：
  - 根据保存前后的 `providers` 配置做 diff，仅当 provider 开关、API 协议、Coding Plan 开关、鉴权类型、provider 数量、模型数量或模型配置摘要发生变化时发送。
  - 同一次保存只发送一条摘要事件，不按 provider 或 model 逐条发送。
  - 自定义 provider 的新增、删除、启用状态变化，都归入该摘要事件。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_model`。
  - `changedProviderCount`：number，本次保存中发生配置变化的 provider 数量。
  - `enabledProviderCount`：number，保存后的已启用 provider 数量。
  - `customProviderCount`：number，保存后的自定义 provider 数量，例如 `custom_0`、`custom_1` 等。
  - `enabledCustomProviderCount`：number，保存后的已启用自定义 provider 数量。
  - `modelCount`：number，保存后的模型总数，仅统计当前 providers 配置中的模型条目数量。
  - `customProviderModelCount`：number，保存后的自定义 provider 模型数量。
  - `hasLocalProviderEnabled`：boolean，保存后是否启用了本地模型 provider，例如 `ollama` 或 `lm-studio`。
  - `hasCodingPlanEnabled`：boolean，保存后是否存在已开启 Coding Plan 的 provider。
  - `changedKeys`：string，本次变化类型的去重列表，使用逗号分隔。当前规划取值包括 `provider_enabled`、`provider_count`、`api_format`、`coding_plan`、`auth_type`、`model_count`、`model_config`。
- 隐私边界：
  - 不上传 API Key、OAuth token、base URL、provider displayName、模型名称、模型 ID、customParams、导入/导出文件名或本地路径。
  - `model_config` 只表示模型配置摘要发生变化；用于本地 diff 的模型名称、模型 ID、上下文长度、能力开关和 customParams 不会作为日志参数上传。
  - 不上传具体自定义 provider 编号列表，只上传数量和是否启用等摘要字段。
  - `modelCount` 仅用于统计配置规模，不表达用户是否实际使用某个模型；实际选择模型仍以 `lobsterai_model_selected` 为准。

#### 2.4.13 `lobsterai_custom_model_connection_tested`

- 状态：已实现。
- 触发时机：用户在「设置 -> 自定义模型」点击测试连接，并得到测试结果后发送。缺少 API Key、缺少模型导致测试无法发起时也发送失败分类；用户未点击测试不发送。
- 事件含义：统计自定义模型 provider 的连接可用性和配置成功率。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_model`。
  - `providerKey`：string，被测试 provider 的配置 key，例如 `openai`、`anthropic`、`custom_0`、`ollama`。
  - `providerKind`：string，provider 类型。当前规划取值为 `builtin`、`custom`、`local`。
  - `apiFormat`：string，测试时使用的 API 协议。当前规划取值为 `openai`、`anthropic`、`gemini`。
  - `result`：string，测试结果。当前规划取值为 `success`、`failed`。
  - `failureReason`：string，失败分类。当前规划取值包括 `missing_api_key`、`missing_model`、`http_error`、`network_error`、`unknown`；仅失败时发送。
  - `statusCode`：number，HTTP 失败时的状态码；无法获取时不发送。
- 隐私边界：
  - 不上传测试请求 URL、API Key、请求头、请求体、模型名称、模型 ID 或服务端错误详情。
  - 不上传完整错误 message，因为供应商错误内容可能包含地址、账号、token 片段或其他敏感信息。

#### 2.4.14 `lobsterai_im_settings_saved`

- 状态：已实现。
- 触发时机：用户在「设置 -> IM 机器人」保存平台配置成功后发送；微信扫码登录成功并持久化配置后、企业微信快速配置成功并持久化配置后，也按该事件发送。保存失败不发送。
- 事件含义：统计 IM 机器人平台配置的使用情况和配置规模，不记录具体凭证或会话信息。
- 发送口径：
  - 单平台保存成功发送一条事件。
  - 多实例平台保存成功发送平台摘要，不按每个实例逐条发送。
  - 微信扫码登录和企业微信快速配置属于自动填充并保存配置，成功后发送一条事件。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_im`。
  - `platform`：string，IM 平台，例如 `weixin`、`dingtalk`、`feishu`、`telegram`、`discord`、`email`。
  - `platformKind`：string，平台形态。当前取值为 `single_instance` 或 `multi_instance`。
  - `enabled`：boolean，保存后的平台是否启用。多实例平台表示是否存在已启用实例。
  - `instanceCount`：number，多实例平台保存后的实例数量；单实例平台不发送。
  - `enabledInstanceCount`：number，多实例平台保存后的启用实例数量；单实例平台不发送。
  - `changedKeys`：string，本次变化类型的去重列表，使用逗号分隔。当前规划取值包括 `enabled`、`instance_count`、`dm_policy`、`agent_binding`、`reply_mode`、`connection_mode`、`credential_state`、`config`。
  - `hasAgentBinding`：boolean，保存后该平台是否配置了非默认 Agent 绑定。
- 隐私边界：
  - 不上传 bot token、app secret、secret、webhook URL、邮箱地址、allowFrom、群 ID、会话 ID、用户 ID、账号 ID、bot username、实例名称或错误详情。
  - `credential_state` 只表示凭证配置状态发生变化，不上传任何凭证内容。

#### 2.4.15 `lobsterai_im_gateway_toggled`

- 状态：已实现。
- 触发时机：用户在「设置 -> IM 机器人」启动或停止单实例平台网关并得到结果后发送。多实例平台的实例启停不发送本事件，统一走 `lobsterai_im_instance_changed`。
- 事件含义：统计单实例 IM 网关启停使用情况和失败率。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_im`。
  - `platform`：string，被操作的 IM 平台。
  - `operation`：string，当前取值为 `start` 或 `stop`。
  - `result`：string，当前取值为 `success` 或 `failed`。
  - `platformKind`：string，平台形态。当前取值为 `single_instance`。
  - `failureReason`：string，失败分类；无法识别时为 `unknown`。仅失败时发送。
- 隐私边界：不上传网关错误详情、账号信息、token、secret、会话 ID 或本地日志内容。

#### 2.4.16 `lobsterai_im_connection_tested`

- 状态：已实现。
- 触发时机：用户在「设置 -> IM 机器人」点击连接测试，并得到测试结果或发生测试异常后发送。
- 事件含义：统计 IM 机器人连接可用性和配置成功率。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_im`。
  - `platform`：string，被测试的 IM 平台。
  - `platformKind`：string，平台形态。当前取值为 `single_instance` 或 `multi_instance`。
  - `result`：string，测试结果。当前取值为 `pass`、`warn`、`fail` 或 `failed`。
  - `checkCount`：number，测试项总数；无法获取时不发送。
  - `failedCheckCount`：number，失败测试项数量；无法获取时不发送。
  - `warningCheckCount`：number，警告测试项数量；无法获取时不发送。
- 隐私边界：不上传测试项 message、网关 URL、账号、会话、群信息、token、secret、请求内容或错误详情。

#### 2.4.17 `lobsterai_im_instance_changed`

- 状态：已实现。
- 触发时机：用户在「设置 -> IM 机器人」对多实例平台新增、删除、启用或停用实例，并且操作成功后发送。
- 事件含义：统计多实例 IM 机器人配置规模变化。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_im`。
  - `platform`：string，被操作的 IM 平台。
  - `operation`：string，当前取值为 `added`、`deleted`、`enabled` 或 `disabled`。
  - `instanceCount`：number，操作后的实例数量。
  - `enabledInstanceCount`：number，操作后的启用实例数量。
- 隐私边界：不上传 instanceId、instanceName、账号、邮箱、token、secret、URL 或其它实例配置内容。

#### 2.4.18 `lobsterai_browser_setting_changed`

- 状态：已实现。
- 触发时机：用户在「设置 -> 浏览器」修改配置并保存成功后，根据保存前后的 diff 发送。未保存、保存失败或配置无变化不发送。
- 事件含义：统计浏览器访问配置的使用情况，当前只记录网络模式和阻止访问域名列表规模。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_browser`。
  - `changedKeys`：string，本次变化类型的去重列表，使用逗号分隔。当前取值包括 `network_mode`、`blocked_hostnames`。
  - `networkMode`：string，保存后的浏览器网络模式。当前为 `proxy-compatible` 或 `strict`。
  - `blockedHostnameCount`：number，保存后的阻止访问域名数量。
  - `previousBlockedHostnameCount`：number，保存前的阻止访问域名数量；无法获取时不发送。
- 隐私边界：
  - 不上传具体 hostname、URL、CDP URL、浏览器可执行路径、extraArgs、代理地址、测试页面、浏览历史或网页内容。
  - `blockedHostnameCount` 只用于观察配置规模，不表达用户访问或屏蔽了哪些具体站点。

#### 2.4.19 `lobsterai_email_skill_settings_saved`

- 状态：已实现。
- 触发时机：用户在「设置 -> 邮箱」修改 `imap-smtp-email` 技能配置，并且自动保存成功后发送。保存失败或配置无变化不发送。
- 事件含义：统计邮箱技能配置的使用情况和配置完成度，不记录账号、密码或服务器详情。
- 发送口径：
  - 邮箱配置页当前采用 blur 后自动保存；日志只在持久化成功后发送。
  - 同一次自动保存只发送一条摘要事件，不按每个字段逐条发送。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_email`。
  - `skillId`：string，当前固定为 `imap-smtp-email`。
  - `provider`：string，邮箱服务商摘要。当前取值包括 `gmail`、`outlook`、`163`、`126`、`qq`、`custom` 或空字符串。
  - `hasEmail`：boolean，保存后是否填写了邮箱账号。
  - `hasPassword`：boolean，保存后是否填写了密码或授权码。
  - `hasImapHost`：boolean，保存后是否存在 IMAP Host。
  - `hasSmtpHost`：boolean，保存后是否存在 SMTP Host。
  - `imapTlsEnabled`：boolean，保存后是否启用 IMAP TLS。
  - `smtpSslEnabled`：boolean，保存后是否启用 SMTP SSL。
  - `allowInsecureCert`：boolean，保存后是否允许不安全证书。
  - `mailboxCustomized`：boolean，保存后的默认 mailbox 是否不是 `INBOX`。
  - `changedKeys`：string，本次变化类型的去重列表，使用逗号分隔。当前取值包括 `provider`、`email`、`password`、`imap_host`、`imap_port`、`imap_tls`、`smtp_host`、`smtp_port`、`smtp_secure`、`allow_insecure_cert`、`mailbox`。
- 隐私边界：
  - 不上传邮箱地址、密码/授权码、IMAP/SMTP host、端口、mailbox 名称或任何邮件内容。
  - `provider` 只表达预置服务商分类；无法识别时统一为 `custom` 或空字符串。

#### 2.4.20 `lobsterai_email_skill_connection_tested`

- 状态：已实现。
- 触发时机：用户在「设置 -> 邮箱」点击连接测试，并得到测试结果或测试失败后发送。用户未点击测试不发送。
- 事件含义：统计邮箱技能连通性测试的使用情况和通过率。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_email`。
  - `skillId`：string，当前固定为 `imap-smtp-email`。
  - `provider`：string，测试时的邮箱服务商摘要。当前取值包括 `gmail`、`outlook`、`163`、`126`、`qq`、`custom` 或空字符串。
  - `result`：string，测试结果。当前取值为 `pass` 或 `fail`。
  - `imapResult`：string，IMAP 测试项结果。当前取值为 `pass`、`fail` 或空字符串。
  - `smtpResult`：string，SMTP 测试项结果。当前取值为 `pass`、`fail` 或空字符串。
  - `checkCount`：number，测试项数量。
  - `hasEmail`：boolean，测试时是否填写了邮箱账号。
  - `hasPassword`：boolean，测试时是否填写了密码或授权码。
  - `hasImapHost`：boolean，测试时是否存在 IMAP Host。
  - `hasSmtpHost`：boolean，测试时是否存在 SMTP Host。
- 隐私边界：
  - 不上传邮箱地址、密码/授权码、IMAP/SMTP host、端口、测试错误详情、测试项 message 或 AI 诊断 prompt。
  - 失败只通过 `result=fail` 和测试项级别表达，不上传原始异常文本。

#### 2.4.21 `lobsterai_memory_setting_changed`

- 状态：已实现。
- 触发时机：用户在「设置 -> 记忆」修改记忆或 Embedding 相关配置，并且设置页保存成功后发送。未保存、保存失败或配置无变化不发送。
- 事件含义：统计记忆功能和 Embedding 语义搜索配置的使用情况。
- 发送口径：
  - 根据保存前后的 `coworkConfig` 做 diff，同一次保存只发送一条摘要事件。
  - 仅记录配置项状态和变化类型，不记录记忆条目内容或远程服务配置详情。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_memory`。
  - `changedKeys`：string，本次变化类型的去重列表，使用逗号分隔。当前取值包括 `memory_enabled`、`llm_judge_enabled`、`embedding_enabled`、`embedding_provider`、`embedding_model`、`embedding_base_url`、`embedding_api_key`、`embedding_vector_weight`。
  - `memoryEnabled`：boolean，保存后是否启用用户记忆。
  - `memoryLlmJudgeEnabled`：boolean，保存后是否启用 LLM 二次判断。
  - `embeddingEnabled`：boolean，保存后是否启用 Embedding 语义搜索。
  - `embeddingProvider`：string，保存后的 Embedding provider。当前取值包括 `openai`、`gemini`、`voyage`、`mistral`、`ollama`。
  - `hasEmbeddingModel`：boolean，保存后是否填写了 Embedding 模型。
  - `hasEmbeddingBaseUrl`：boolean，保存后是否填写了远程 Base URL。
  - `hasEmbeddingApiKey`：boolean，保存后是否填写了远程 API Key。
  - `embeddingVectorWeight`：number，保存后的语义重排权重，范围为 0-1。
- 隐私边界：
  - 不上传记忆条目内容、搜索词、Embedding 模型名称、远程 Base URL、API Key、本地模型路径或文件路径。
  - `embedding_model`、`embedding_base_url` 和 `embedding_api_key` 只表示对应字段发生变化，不上传实际值。

#### 2.4.22 `lobsterai_memory_entry_changed`

- 状态：已实现。
- 触发时机：用户在「设置 -> 记忆」手动新增、编辑或删除记忆条目，并且操作成功后发送。操作失败不发送。
- 事件含义：统计用户手动管理记忆条目的使用情况。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_memory`。
  - `operation`：string，条目操作类型。当前取值包括 `created`、`updated`、`deleted`。
  - `entryCount`：number，操作后本地可见记忆条目数量的摘要估算；无法可靠获取时不发送。
- 隐私边界：
  - 不上传记忆条目正文、条目 ID、搜索词、来源信息、创建/更新时间或删除原因。
  - 不记录用户打开编辑弹窗、输入草稿或搜索列表的行为，只记录持久化成功后的 CRUD 操作。

#### 2.4.23 `lobsterai_dreaming_setting_changed`

- 状态：已实现。
- 触发时机：用户在「设置 -> 梦境」修改 Dreaming 配置，并且设置页保存成功后发送。未保存、保存失败或配置无变化不发送。
- 事件含义：统计 Dreaming 记忆整理功能的开启和调度配置使用情况。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_dreaming`。
  - `changedKeys`：string，本次变化类型的去重列表，使用逗号分隔。当前取值包括 `dreaming_enabled`、`dreaming_frequency`。
  - `dreamingEnabled`：boolean，保存后是否启用 Dreaming。
  - `frequencyType`：string，保存后的频率类型。当前取值为 `preset` 或 `custom`。
- 隐私边界：不上传自定义 cron 表达式、时区、Dream Diary 内容、记忆内容或模型名称。

#### 2.4.24 `lobsterai_plugin_settings_saved`

- 状态：已实现。
- 触发时机：用户在「设置 -> 插件」修改插件启用状态或插件配置，并且设置页保存成功后发送。未保存、保存失败或无插件变更不发送。
- 事件含义：统计插件设置变更规模，不记录具体插件配置。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_plugins`。
  - `toggleCount`：number，本次保存中发生启用状态变化的插件数量。
  - `enabledToggleCount`：number，本次保存中被启用的插件数量。
  - `disabledToggleCount`：number，本次保存中被停用的插件数量。
  - `configCount`：number，本次保存中发生配置变化的插件数量。
  - `changedKeys`：string，本次变化类型的去重列表，使用逗号分隔。当前取值包括 `toggle`、`config`。
- 隐私边界：不上传插件 ID、插件配置、token、API Key、URL、本地路径、env 或 header。

#### 2.4.25 `lobsterai_plugin_action`

- 状态：已实现。
- 触发时机：用户在「设置 -> 插件」执行安装、卸载、更新、检测本地插件或检查更新等动作，并得到结果后发送。
- 事件含义：统计插件生命周期动作和成功率。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_plugins`。
  - `actionType`：string，动作类型。当前取值包括 `install`、`uninstall`、`update`、`check_updates`、`detect`、`sync`。
  - `result`：string，动作结果。当前取值为 `success` 或 `failed`。
  - `installSource`：string，安装来源；仅安装动作发送。当前取值为 `npm`、`clawhub`、`git`、`local`、`openclaw`。
  - `hasVersion`：boolean，安装时是否填写版本；仅安装动作发送。
  - `hasRegistry`：boolean，安装时是否填写 registry；仅 npm 安装动作发送。
  - `updateCount`：number，检查更新时发现的可更新插件数量；仅检查更新成功时发送。
  - `detectedCount`：number，检测或同步本地插件时发现/同步的插件数量；仅对应动作成功时发送。
- 隐私边界：不上传插件 ID、安装 spec、registry URL、版本号、Git URL、本地路径、安装日志、更新日志或错误详情。

#### 2.4.26 `lobsterai_shortcut_setting_changed`

- 状态：已实现。
- 触发时机：用户在「设置 -> 快捷键」修改快捷键并保存成功后发送。未保存、保存失败或快捷键无变化不发送。
- 事件含义：统计快捷键自定义使用情况。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_shortcuts`。
  - `changedCount`：number，本次保存中发生变化的快捷键数量。
  - `configuredCount`：number，保存后已配置快捷键数量。
  - `disabledCount`：number，保存后被清空的快捷键数量。
  - `resetToDefault`：boolean，保存后的快捷键配置是否与默认配置一致。
- 隐私边界：不上传快捷键具体组合、动作 key、搜索词或冲突提示内容。

#### 2.4.27 `lobsterai_about_action`

- 状态：已实现。
- 触发时机：用户在「设置 -> 关于」执行主动动作后发送。包括检查更新、复制联系邮箱、打开用户社区、打开用户手册、打开服务条款、导出日志。
- 事件含义：统计关于页支持/更新相关入口使用情况。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `settings_about`。
  - `actionType`：string，动作类型。当前取值包括 `check_update`、`copy_contact_email`、`open_user_community`、`open_user_manual`、`open_service_terms`、`export_logs`。
  - `result`：string，动作结果。当前取值为 `success`、`failed`、`canceled`、`update_found`、`up_to_date`、`downloading`、`ready`。
  - `missingEntryCount`：number，导出日志时缺失的日志项数量；仅导出成功且存在缺失项信息时发送。
- 隐私边界：不上传联系邮箱、外链 URL、导出日志路径、日志内容、更新包 URL、错误详情或本地文件信息。

#### 2.4.28 `lobsterai_account_menu_action`

- 状态：已实现。
- 触发时机：用户在首页左下角「我的」入口执行主动动作后发送。包括未登录点击登录、已登录打开/关闭账号菜单、展开/收起剩余额度、打开用量概览、打开充值页、打开邀请页、退出登录。
- 事件含义：统计账号菜单入口的使用情况和常用路径。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `home_account_menu`。
  - `actionType`：string，动作类型。当前取值包括 `login`、`open_menu`、`close_menu`、`expand_credits`、`collapse_credits`、`open_usage_overview`、`open_recharge`、`open_invitation`、`logout`。
  - `result`：string，动作结果。当前取值为 `success` 或 `failed`；仅登录、打开外链和退出登录等异步动作发送。
  - `isLoggedIn`：boolean，触发动作时是否处于登录态。
  - `hasCredits`：boolean，当前账号摘要中是否存在额度明细。
  - `creditItemCount`：number，当前账号摘要中的额度明细数量。
- 隐私边界：
  - 不上传手机号、手机号后四位、昵称、头像 URL、具体剩余额度数值、额度明细 label、额度类型、到期时间、Portal URL、登录 URL 或退出登录错误详情。
  - 额度相关字段只记录是否有额度明细和明细数量，不记录资产金额。

#### 2.4.29 `lobsterai_sidebar_action`

- 状态：已实现。
- 触发时机：用户在首页左侧边栏执行主动动作后发送。包括顶部导航入口、折叠/展开侧边栏、Agent 行操作、历史任务列表点击、任务菜单、展开更多/收起、批量操作和子任务操作。
- 事件含义：统计首页侧边栏主要入口、Agent/任务列表和批量操作的使用情况。
- 业务参数：
  - `source`：string，触发来源。当前取值包括 `home_sidebar`、`home_agent_sidebar`。
  - `actionType`：string，动作类型。当前取值包括：
    - 顶部入口：`new_task`、`open_search`、`open_scheduled_tasks`、`open_kits`、`open_skills`、`open_mcp`、`collapse_sidebar`、`expand_sidebar`。
    - Agent 行：`agent_header_click`、`agent_create_task`、`agent_menu_open`、`agent_edit`、`agent_pin_toggle`、`agent_delete_confirm_open`、`agent_delete_cancel`、`agent_delete_submit`、`agent_delete_success`、`agent_delete_failed`。
    - 历史任务：`select_task`、`task_menu_open`、`task_pin_toggle`、`task_rename_start`、`task_rename_cancel`、`task_rename_submit`、`task_share_open`、`task_delete_confirm_open`、`task_delete_cancel`、`task_delete_submit`、`task_delete_success`、`task_delete_failed`。
    - 列表加载：`task_list_expand_more`、`task_list_collapse`、`task_list_retry_load`。
    - 批量操作：`batch_mode_enter`、`batch_mode_exit`、`batch_item_toggle`、`batch_select_all_toggle`、`batch_delete_confirm_open`、`batch_delete_cancel`、`batch_delete_submit`、`batch_delete_success`、`batch_delete_failed`。
    - 子任务：`select_subagent_task`、`subagent_delete_confirm_open`、`subagent_delete_cancel`、`subagent_delete_submit`、`subagent_delete_success`、`subagent_delete_failed`。
  - `activeView`：string，触发时当前主视图。当前取值包括 `cowork`、`skills`、`scheduledTasks`、`kits`、`mcp`。
  - `isCollapsed`：boolean，触发时侧边栏是否折叠；仅顶部侧边栏入口发送。
  - `agentType`：string，相关 Agent 类型。当前取值为 `main` 或 `custom`。
  - `isPinned`：boolean，相关 Agent 或任务触发前是否已置顶；仅置顶、菜单和相关行操作按需发送。
  - `targetPinned`：boolean，置顶切换后的目标状态；仅置顶切换时发送。
  - `isExpanded`：boolean，Agent 行触发前是否处于展开状态；仅 Agent 行点击/菜单按需发送。
  - `visibleTaskCount`：number，当前 Agent 可见任务数量；仅展开更多、收起和加载重试时发送。
  - `isCurrentSession`：boolean，被选择或操作的任务是否为当前会话；仅任务相关操作按需发送。
  - `taskStatus`：string，被选择或操作任务的状态摘要；仅任务相关操作按需发送。
  - `hasActiveSubagent`：boolean，当前任务是否有正在查看的子任务；仅任务行操作按需发送。
  - `subagentStatus`：string，被选择或操作子任务的状态摘要；仅子任务相关操作发送。
  - `isCurrentSubagent`：boolean，被选择或操作子任务是否为当前子任务；仅子任务相关操作发送。
  - `selectedCount`：number，批量模式当前选中项目数；仅批量操作发送。
  - `selectableCount`：number，批量模式当前可选项目数；仅批量操作发送。
  - `selectedSessionCount`：number，批量模式当前选中的主任务数量；仅批量删除提交/结果发送。
  - `selectedSubagentCount`：number，批量模式当前选中的子任务数量；仅批量删除提交/结果发送。
  - `targetSelected`：boolean，批量单项切换后的目标选中状态；仅 `batch_item_toggle` 发送。
  - `isSelectAllChecked`：boolean，全选切换后的目标状态；仅 `batch_select_all_toggle` 发送。
  - `result`：string，异步操作结果。当前取值为 `success` 或 `failed`；仅删除、置顶、重命名等完成后按需发送。
- 隐私边界：
  - 不上传任务标题、sessionId、subagentId、runId、agentId、agentName、消息内容、创建/更新时间、用户输入或本地路径。
  - 重命名只记录开始、取消和提交结果，不上传新旧标题。
  - 批量操作只记录数量和类型，不上传具体条目 ID。

#### 2.4.30 `lobsterai_task_search_action`

- 状态：已实现。
- 触发时机：用户打开/关闭首页任务搜索弹窗、搜索结果为空、或点击搜索结果任务后发送。
- 事件含义：统计任务搜索入口使用情况和搜索结果点击情况。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `home_task_search`。
  - `actionType`：string，动作类型。当前取值包括 `open`、`close`、`empty_result`、`select_result`。
  - `hasQuery`：boolean，触发时搜索框是否有输入。
  - `resultCount`：number，触发时展示的结果数量。
  - `isCurrentSession`：boolean，被点击结果是否为当前会话；仅 `select_result` 时发送。
  - `sessionStatus`：string，被点击结果的状态摘要；仅 `select_result` 时发送。
  - `agentType`：string，被点击结果所属 Agent 类型。当前取值为 `main` 或 `custom`；仅 `select_result` 时发送。
- 隐私边界：
  - 不上传搜索词、任务标题、sessionId、agentId、agentName、消息内容、创建/更新时间或本地路径。
  - 不记录每次输入变化，避免产生高频噪音和隐私风险。

#### 2.4.31 `lobsterai_agent_settings_action`

- 状态：已实现。
- 触发时机：用户打开 Agent 编辑弹窗、切换弹窗 tab、保存配置、关闭弹窗或处理未保存变更确认时发送。
- 事件含义：统计 Agent 编辑弹窗内的主要配置行为，补齐侧边栏 `agent_edit` 之后的弹窗内操作路径。
- 业务参数：
  - `source`：string，触发来源。当前固定为 `agent_settings_panel`。
  - `actionType`：string，动作类型。当前取值包括 `open`、`close`、`tab_change`、`save_submit`、`save_success`、`save_failed`、`discard_confirm_open`、`discard_confirm_submit`、`discard_confirm_cancel`。
  - `agentType`：string，相关 Agent 类型。当前取值为 `main` 或 `custom`。
  - `activeTab`：string，触发时当前 tab。当前取值包括 `identity`、`prompt`、`user`、`skills`、`im`。
  - `targetTab`：string，目标 tab；仅 `tab_change` 时发送。
  - `isDirty`：boolean，触发时弹窗内容是否存在未保存变更。
  - `changedFieldCount`：number，触发时发生变更的字段数量；仅保存和未保存确认相关动作发送。
  - `changedFields`：string，触发时发生变更的字段 key 列表，以英文逗号连接；当前可能包含 `name`、`description`、`systemPrompt`、`identity`、`userInfo`、`icon`、`model`、`workingDirectory`、`skillIds`、`imBindings`。
  - `skillCount`：number，当前 Agent 已选择技能数量。
  - `imBindingCount`：number，当前 Agent 显式绑定 IM 渠道数量。
  - `hasModel`：boolean，当前是否选择模型。
  - `hasWorkingDirectory`：boolean，当前是否设置工作目录。
  - `result`：string，保存结果。当前取值为 `success` 或 `failed`；仅保存完成后发送。
  - `modelId`：string，当前选择模型 ID；仅保存相关动作发送。
  - `modelName`：string，当前选择模型展示名称；仅保存相关动作发送。
  - `modelSource`：string，模型来源分类。当前取值为 `package` 或 `custom`；仅保存相关动作发送。
  - `providerKey`：string，当前模型所属 provider key；仅保存相关动作发送。
  - `provider`：string，当前模型所属 provider 展示名称；仅保存相关动作发送。
  - `selectorGroup`：string，当前模型选择器分组，取值为 `server` 或 `user`；仅保存相关动作发送。
  - `skillIds`：string，当前选择技能 ID 列表，以英文逗号连接；仅保存相关动作发送。
  - `skillNames`：string，当前选择技能展示名称列表，以英文逗号连接；仅保存相关动作发送。
  - `builtInSkillCount`：number，当前选择技能中的内置技能数量；仅保存相关动作发送。
  - `customSkillCount`：number，当前选择技能中的非内置技能数量；仅保存相关动作发送。
  - `imPlatforms`：string，当前显式绑定 IM 平台列表，以英文逗号连接；仅保存相关动作发送。
- 隐私边界：
  - 不上传 Agent 名称、简介、头像值、system prompt、identity、userInfo、工作目录路径、IM 渠道 key 或错误详情。
  - 保存相关动作会上传模型 ID/名称、技能 ID/名称和 IM 平台名，用于分析 Agent 配置行为。
  - 文本编辑只记录字段是否发生变更，不记录内容长度或文本内容。
  - 关闭和切换 tab 只记录行为摘要，避免对每次输入做高频上报。

#### 2.4.32 `lobsterai_agent_create_action`

- 状态：已实现。
- 触发时机：用户打开创建 Agent 弹窗、打开/关闭模板选择、选择模板、切换弹窗 tab、创建 Agent、关闭弹窗或处理未保存变更确认时发送。
- 事件含义：统计 Agent 创建入口、模板使用、创建配置选择和创建结果。
- 业务参数：
  - `source`：string，触发来源。当前取值包括 `home_agent_sidebar`、`home_agent_sidebar_empty`、`agents_view`、`agent_create_modal`。
  - `actionType`：string，动作类型。当前取值包括 `open`、`close`、`open_template_picker`、`close_template_picker`、`template_selected`、`tab_change`、`create_submit`、`create_success`、`create_failed`、`discard_confirm_open`、`discard_confirm_submit`、`discard_confirm_cancel`。
  - `activeTab`：string，触发时当前 tab。当前取值包括 `identity`、`prompt`、`user`、`skills`、`im`。
  - `targetTab`：string，目标 tab；仅 `tab_change` 时发送。
  - `creationMode`：string，创建方式。当前取值为 `blank` 或 `template`。
  - `isDirty`：boolean，触发时弹窗内容是否存在未保存变更。
  - `changedFieldCount`：number，触发时发生变更的字段数量；仅创建和未保存确认相关动作发送。
  - `changedFields`：string，触发时发生变更的字段 key 列表，以英文逗号连接；当前可能包含 `name`、`description`、`systemPrompt`、`identity`、`userInfo`、`icon`、`model`、`workingDirectory`、`skillIds`、`imBindings`。
  - `templateId`：string，被选择模板 ID；仅模板选择和模板创建相关动作发送。
  - `templateName`：string，被选择模板展示名称；仅模板选择和模板创建相关动作发送。
  - `templateSkillCount`：number，被选择模板包含的技能数量；仅模板选择和模板创建相关动作发送。
  - `skillCount`：number，当前选择技能数量。
  - `imBindingCount`：number，当前显式绑定 IM 渠道数量。
  - `hasModel`：boolean，当前是否选择模型。
  - `hasWorkingDirectory`：boolean，当前是否设置工作目录。
  - `result`：string，创建结果。当前取值为 `success` 或 `failed`；仅创建完成后发送。
  - `errorCode`：string，失败分类。当前取值包括 `user_info_write_failed`、`create_agent_failed`、`unknown`；仅创建失败时发送。
  - `modelId`：string，当前选择模型 ID；仅创建相关动作发送。
  - `modelName`：string，当前选择模型展示名称；仅创建相关动作发送。
  - `modelSource`：string，模型来源分类。当前取值为 `package` 或 `custom`；仅创建相关动作发送。
  - `providerKey`：string，当前模型所属 provider key；仅创建相关动作发送。
  - `provider`：string，当前模型所属 provider 展示名称；仅创建相关动作发送。
  - `selectorGroup`：string，当前模型选择器分组，取值为 `server` 或 `user`；仅创建相关动作发送。
  - `skillIds`：string，当前选择技能 ID 列表，以英文逗号连接；仅创建相关动作发送。
  - `skillNames`：string，当前选择技能展示名称列表，以英文逗号连接；仅创建相关动作发送。
  - `builtInSkillCount`：number，当前选择技能中的内置技能数量；仅创建相关动作发送。
  - `customSkillCount`：number，当前选择技能中的非内置技能数量；仅创建相关动作发送。
  - `imPlatforms`：string，当前显式绑定 IM 平台列表，以英文逗号连接；仅创建相关动作发送。
- 隐私边界：
  - 不上传 Agent 名称、简介、头像值、system prompt、identity、userInfo、工作目录路径、IM 渠道 key、创建后的 agentId 或错误详情。
  - 创建相关动作会上传模型 ID/名称、技能 ID/名称、模板 ID/名称和 IM 平台名，用于分析 Agent 创建行为。
  - 文本编辑只记录字段是否发生变更，不记录内容长度或文本内容。
  - 关闭和切换 tab 只记录行为摘要，避免对每次输入做高频上报。

#### 2.4.33 `lobsterai_scheduled_task_action`

- 状态：已实现。
- 触发时机：用户在「定时任务」界面切换任务/历史 tab、新建任务、选择任务、打开任务菜单、开关任务、手动运行、编辑、删除确认、填写任务表单、选择模板、查看运行历史和进入运行会话时发送。
- 事件含义：统计定时任务入口使用、任务配置偏好、模板使用、任务运行操作、历史筛选和关键操作结果。
- 业务参数：
  - `source`：string，触发来源。当前取值包括 `scheduled_tasks_view`、`scheduled_tasks_list`、`scheduled_task_detail`、`scheduled_task_form`、`scheduled_tasks_history`、`scheduled_task_history`。
  - `actionType`：string，动作类型。当前取值包括：
    - 页面与列表：`tab_change`、`new_task`、`select_task`、`task_menu_open`、`toggle_enabled`、`toggle_enabled_success`、`toggle_enabled_failed`、`run_manually`、`run_manually_success`、`run_manually_failed`、`edit_task`、`delete_confirm_open`、`delete_confirm_cancel`、`delete_success`、`delete_failed`、`retry_load_tasks`。
    - 表单：`form_open`、`form_cancel`、`form_unsaved_confirm_open`、`form_unsaved_confirm_submit`、`form_unsaved_confirm_cancel`、`template_picker_open`、`template_picker_close`、`template_selected`、`validation_failed`、`create_submit`、`create_success`、`create_failed`、`edit_submit`、`edit_success`、`edit_failed`。
    - 详情：`detail_edit`、`detail_run_manually`、`detail_run_manually_success`、`detail_run_manually_failed`。
    - 历史：`history_filter_status`、`history_filter_date`、`history_filter_clear`、`history_load_more`、`history_view_session`、`retry_load_history`、`task_history_filter_status`、`task_history_filter_date`、`task_history_filter_clear`、`task_history_load_more`、`task_history_view_session`。
  - `activeTab`：string，当前页签；当前取值为 `tasks` 或 `history`。
  - `targetTab`：string，目标页签；仅 tab 切换时发送。
  - `viewMode`：string，当前视图模式；当前取值为 `list`、`create`、`edit`、`detail`。
  - `mode`：string，表单模式；当前取值为 `create` 或 `edit`。
  - `result`：string，动作结果。当前取值包括 `success`、`failed`、`retry`。
  - `errorCode`：string，失败分类；仅失败或校验失败时发送，不上传错误详情。
  - `errorFields`：string，校验失败字段 key 列表，以英文逗号连接。
  - `errorFieldCount`：number，校验失败字段数量。
  - `scheduleKind`：string，定时计划底层类型；当前取值包括 `at`、`cron`、`every`。
  - `planType`：string，表单或解析后的计划类型；当前取值包括 `once`、`hourly`、`daily`、`weekly`、`monthly`、`cron`、`advanced`。
  - `cronMode`：string，cron 表单模式；当前取值为 `builder` 或 `raw`。
  - `cronExpr`：string，cron 表达式。该字段不包含用户正文或目标账号，用于分析定时频率偏好。
  - `cronTz`：string，cron 时区。
  - `hour` / `minute`：number，计划触发时间的小时和分钟。
  - `weekdayCount`：number，选择的星期数量；仅周计划发送。
  - `weekdays`：string，选择的星期列表，以英文逗号连接；仅周计划发送，支持多个星期值，例如 `1,2,3,4,5`。
  - `monthDay`：number，月度计划的日期；仅月计划发送。
  - `everyMs`：number，`every` 类型计划的间隔毫秒数。
  - `payloadKind`：string，任务 payload 类型；当前取值为 `agentTurn` 或 `systemEvent`。
  - `payloadTextLength`：number，prompt/payload 文本长度。
  - `hasPrompt`：boolean，是否填写 prompt/payload 文本。
  - `deliveryMode`：string，通知投递模式；当前取值包括 `none`、`announce`、`webhook`。
  - `notifyChannel`：string，通知渠道 key。
  - `notifyPlatform`：string，通知渠道所属 IM 平台。
  - `hasNotifyTarget`：boolean，是否选择通知目标。
  - `hasNotifyAccount`：boolean，是否选择多实例通知账号。
  - `enabled`：boolean，任务是否启用。
  - `targetEnabled`：boolean，用户开关任务后的目标状态。
  - `taskStatus`：string，任务当前运行态摘要；当前取值为 `running` 或 `idle`。
  - `lastStatus`：string，最近一次运行状态；当前取值包括 `success`、`error`、`skipped`、`running`。
  - `hasNextRun`：boolean，是否有下一次运行时间。
  - `consecutiveErrors`：number，连续错误次数。
  - `hasLastError`：boolean，是否存在最近错误。
  - `sessionTarget`：string，任务会话目标；当前取值包括 `main`、`isolated`。
  - `wakeMode`：string，任务唤醒模式；当前取值包括 `now`、`next-heartbeat`。
  - `hasSessionKey`：boolean，任务是否绑定 session key。
  - `hasTemplate`：boolean，创建/编辑时是否应用模板。
  - `hasInitialTemplate`：boolean，打开表单时是否带初始模板。
  - `templateId`：string，模板 ID。
  - `templateName`：string，模板展示名称。
  - `modelId`：string，任务选择模型 ID。
  - `modelName`：string，任务选择模型展示名称。
  - `modelSource`：string，模型来源分类。当前取值为 `package` 或 `custom`。
  - `providerKey`：string，当前模型所属 provider key。
  - `provider`：string，当前模型所属 provider 展示名称。
  - `selectorGroup`：string，当前模型选择器分组，取值为 `server` 或 `user`。
  - `modelResolved`：boolean，任务模型是否能在当前模型列表中解析。
  - `hasModel`：boolean，任务是否选择模型。
  - `filterStatus`：string，历史筛选状态。
  - `hasActiveFilter`：boolean，历史列表是否存在筛选条件。
  - `hasStartDate` / `hasEndDate`：boolean，历史筛选是否设置开始/结束日期。
  - `targetStatus`：string，用户点击的目标筛选状态。
  - `selected`：boolean，本次筛选点击后目标状态是否被选中。
  - `resultCount`：number，触发筛选时当前展示结果数量。
  - `loadedCount`：number，加载更多前已加载数量。
  - `runStatus`：string，运行记录状态。
  - `hasSession`：boolean，运行记录是否有关联会话。
  - `hasDuration`：boolean，运行记录是否有耗时。
  - `durationMs`：number，运行耗时毫秒数。
  - `hasError`：boolean，运行记录是否有错误。
- 隐私边界：
  - 不上传任务标题、任务描述、prompt/payload 正文、通知目标 ID/邮箱/群号/用户号、`taskId`、`runId`、`sessionId`、`sessionKey`、本地路径、凭据或错误详情。
  - 会上传模型 ID/名称、provider、cron 表达式、通知渠道/platform、模板 ID/名称、payload 长度、计划时间和任务状态摘要，用于分析定时任务功能使用偏好。
  - 历史页只记录筛选和是否查看关联会话，不上传运行记录 ID、任务名或会话标识。

#### 2.4.34 `lobsterai_prompt_submit`

- 状态：已实现。
- 触发时机：用户从首页初始输入框或历史对话输入框成功发起一次任务/继续对话后发送。发送前被拦截、模型权限弹窗、附件校验失败、父层提交返回 `false` 时不发送本事件，而发送 `lobsterai_prompt_control_action` 的 `submit_blocked`。
- 事件含义：统计核心 prompt 提交漏斗，区分新建任务和历史对话续聊。
- 业务参数：
  - `surface`：string，输入框所在场景。当前取值为 `home` 或 `conversation`。
  - `conversationState`：string，对话状态。当前取值为 `new_task` 或 `continue_session`。
  - `submitMethod`：string，提交方式。当前取值包括 `button`、`keyboard`、`voice`。
  - `promptLength`：number，用户输入正文长度。不包含自动拼接的本地附件路径。
  - `promptLineCount`：number，用户输入正文行数。
  - `promptLengthBucket`：string，用户输入正文长度分桶。当前取值包括 `0`、`1_20`、`21_100`、`101_500`、`501_2000`、`2000_plus`。
  - `promptLineCountBucket`：string，用户输入正文行数分桶。当前取值包括 `0`、`1`、`2_5`、`6_20`、`20_plus`。
  - `hasPrompt`：boolean，是否存在文本输入。
  - `inputLanguageType`：string，本地按字符粗略判断的输入语言类型。当前取值包括 `zh`、`en`、`mixed`、`unknown`。
  - `inputSource`：string，本次提交的输入来源。当前取值包括 `typed`、`template`、`voice`、`selected_text`、`media_reference`、`history_continue`。
  - `hasQuestionMark`：boolean，输入正文中是否包含中英文问号。
  - `hasCodeFence`：boolean，输入正文中是否包含 Markdown 代码块标记。
  - `hasInlineCode`：boolean，输入正文中是否包含 Markdown 行内代码标记。
  - `hasUrl`：boolean，输入正文中是否包含 URL 形态文本。
  - `hasPathLikeText`：boolean，输入正文中是否包含疑似本地路径形态文本。
  - `hasCommandLikeText`：boolean，输入正文中是否包含常见命令行开头形态文本。
  - `hasAtMediaMention`：boolean，输入正文中是否包含媒体生成结果引用标记。
  - `attachmentCount`：number，提交时附件数量。
  - `imageAttachmentCount`：number，提交时图片附件数量。
  - `fileTypeGroups`：string，附件类型分组，以英文逗号连接。当前取值包括 `image`、`pdf`、`office`、`archive`、`code`、`other`。
  - `totalAttachmentSizeBucket`：string，附件总大小分桶。无法获得大小时不发送。
  - `activeSkillCount`：number，提交时主动选择的技能数量。
  - `activeSkillIds` / `activeSkillNames`：string，提交时主动选择的技能 ID/名称列表，以英文逗号连接。
  - `activeKitCount`：number，提交时主动选择的专家套件数量。
  - `activeKitIds` / `activeKitNames`：string，提交时主动选择的专家套件 ID/名称列表，以英文逗号连接。
  - `modelId` / `modelName`：string，提交时使用的模型 ID/名称。
  - `modelSource`：string，模型来源分类。当前取值为 `package` 或 `custom`。
  - `providerKey` / `provider`：string，模型所属 provider。
  - `isServerModel`：boolean，是否为套餐/服务端模型。
  - `agentId`：string，当前 Agent ID。
  - `isMainAgent`：boolean，是否为主 Agent。
  - `agentSource`：string，Agent 来源。当前取值为 `custom` 或 `preset`。
  - `agentSkillCount`：number，当前 Agent 配置的技能数量。
  - `isPlanMode`：boolean，提交时是否处于计划模式。
  - `hasWorkingDirectory`：boolean，提交时是否存在工作目录。
  - `hasSession`：boolean，是否为历史对话续聊。
  - `sessionMessageCountBucket`：string，历史对话消息数量分桶。当前取值包括 `0`、`1_3`、`4_10`、`11_30`、`30_plus`。
  - `sessionAgeBucket`：string，历史对话创建时间距当前时间分桶。当前取值包括 `same_day`、`1_3_days`、`3_7_days`、`7_days_plus`。
  - `mediaReferenceCount`：number，prompt 中引用媒体生成结果的数量。
  - `selectedTextSnippetCount`：number，提交时携带的选中文本片段数量。
  - `effectiveCollaborationMode`：string，实际提交给 Cowork 的协作模式。
- 隐私边界：
  - 不上传 prompt 正文、prompt hash、自动拼接的附件路径、文件名、图片/音频内容、选中文本片段内容或历史消息内容。
  - `inputLanguageType` 和 `has*` 字段均在本地用规则计算，仅上传输入形态信息，不上传用于判断的原始文本或任意截取片段。
  - 会上传技能/专家套件/模型 ID 和名称、Agent ID、数量和分桶信息，用于分析用户在不同场景下的能力选择和提交转化。

#### 2.4.35 `lobsterai_prompt_control_action`

- 状态：已实现。
- 触发时机：用户操作输入框附近控件或提交前被阻断时发送。
- 事件含义：统计输入框周边能力入口使用情况，覆盖首页初始状态和历史对话续聊状态。
- 业务参数：
  - `surface`：string，输入框所在场景。当前取值为 `home` 或 `conversation`。
  - `conversationState`：string，对话状态。当前取值为 `new_task` 或 `continue_session`。
  - `controlType`：string，控件动作类型。当前取值包括 `input_focus`、`draft_started`、`submit_blocked`、`add_menu_open`、`add_menu_close`、`attach_file_click`、`attachment_add_success`、`attachment_add_failed`、`attachment_add_cancelled`、`attachment_add_blocked`、`attachment_remove`、`skill_menu_open`、`skill_toggle`、`manage_skills_click`、`kit_menu_open`、`kit_menu_close`、`kit_toggle`、`manage_kits_click`、`plan_mode_enabled`、`plan_mode_disabled`、`agent_selector_open`、`agent_selector_close`、`agent_selected`、`working_directory_selector_open`、`working_directory_selector_close`、`working_directory_selected`、`working_directory_open`、`voice_record_start`、`voice_record_stop`、`voice_record_blocked`、`stop_streaming`。
  - `blockedReason`：string，阻断原因。当前取值包括 `working_directory_required`、`voice_recognition_failed`、`streaming`、`empty`、`disabled`、`model_patching`、`model_access_required`、`image_attachment_too_large`、`image_preview_failed`、`submit_rejected`、`quota_exhausted`、`login_required`、`voice_input_active`、`adding_file`。
  - `source` / `entry`：string，控件来源，例如 `picker`、`paste`、`drop`、`prompt_tools_menu`、`active_context_badge`、`home_context`、`conversation_context`。
  - `agentId`、`isMainAgent`、`hasWorkingDirectory`、`isPlanMode`：当前输入框上下文。
  - `skillId` / `skillName` / `skillSource` / `targetEnabled`：技能选择或取消选择时发送。
  - `kitId` / `kitName` / `kitSource` / `isInstalled` / `skillCount` / `mcpServerCount` / `connectorCount`：专家套件选择或取消选择时发送。
  - `targetAgentId` / `targetIsMainAgent` / `targetAgentSource` / `targetAgentSkillCount` / `hasAgentModel` / `agentModelId`：切换 Agent 时发送。
  - `attachmentCount` / `imageAttachmentCount` / `fileTypeGroups` / `totalAttachmentSizeBucket` / `selectedFileCount` / `modelSupportsImage` / `hasImageWithoutVision`：附件相关动作发送。
  - `submitMethod` / `accessPrompt`：提交阻断时发送。
  - `promptLength` / `promptLengthBucket` / `promptLineCountBucket` / `inputLanguageType` / `hasQuestionMark` / `hasCodeFence` / `hasInlineCode` / `hasUrl` / `hasPathLikeText` / `hasCommandLikeText` / `hasAtMediaMention`：输入开始或提交阻断时发送，用于分析输入漏斗和阻断场景，不上传正文。
  - `asrQuotaStatus` / `isAsrSubscribed` / `recordingElapsedSeconds`：语音输入相关动作发送。
- 隐私边界：
  - 不上传 prompt 正文、prompt hash、文件路径、文件名、文件内容、工作目录真实路径、Agent 名称、Agent system prompt/identity/userInfo、语音识别文本或错误详情。
  - 会上传技能/专家套件 ID 和名称、模型/Agent 结构化上下文、附件类型分组和数量，用于分析输入框周边控件使用率和阻断原因。

#### 2.4.36 `lobsterai_prompt_template_action`

- 状态：已实现。
- 触发时机：用户在首页初始状态下点击输入框下方的 prompt 模板入口（例如「制作幻灯片」「数据分析」「教育学习」「创建网站」）或点击具体模板 prompt 时发送。
- 事件含义：统计首页 prompt 模板入口点击、模板 prompt 点击和对应技能自动启用情况。
- 业务参数：
  - `surface`：string，当前固定为 `home`。
  - `conversationState`：string，当前固定为 `new_task`。
  - `templateActionType`：string，模板动作类型。当前取值为 `template_card_click` 或 `template_prompt_click`。
  - `templateId` / `templateName`：string，模板入口 ID/展示名称。
  - `templateIndex`：number，模板入口在首页推荐列表中的序号。
  - `mappedSkillId` / `mappedSkillName`：string，模板入口映射的技能 ID/名称。
  - `promptId` / `promptName`：string，用户点击的具体模板 prompt ID/展示名称。
  - `promptIndex`：number，具体模板 prompt 在该模板入口中的序号。
  - `promptLength`：number，模板 prompt 正文长度。
  - `hasAutoEnabledSkill`：boolean，点击模板入口后是否找到并自动启用对应技能。
  - `promptCount`：number，模板入口包含的 prompt 数量。
  - `modelId` / `modelName`：string，点击模板时当前模型 ID/名称。
  - `agentId` / `isMainAgent`：当前 Agent 上下文。
  - `isPlanMode`：boolean，点击模板时首页输入框是否处于计划模式。
- 隐私边界：
  - 不上传模板 prompt 完整正文，仅上传模板 ID、展示名称、prompt ID/名称、长度和映射技能信息。
  - 这些字段用于分析首页模板入口点击率、具体模板偏好、模板到技能选择的转化情况。

#### 2.4.37 `lobsterai_conversation_message_action`

- 状态：已实现。
- 触发时机：用户在历史对话消息上执行复制、重新编辑、从助手消息分叉、打开消息图片预览等动作时发送。
- 事件含义：统计对话内消息级复用行为，区分用户消息和助手消息，并保留必要的能力上下文。
- 业务参数：
  - `surface`：string，当前固定为 `conversation`。
  - `actionType`：string，动作类型。当前取值包括 `copy_message`、`reedit_user_message`、`fork_from_assistant_message`、`open_message_image`。
  - `messageRole`：string，消息角色。当前取值包括 `user`、`assistant`、`system`、`tool_result`。
  - `messageContentLength` / `messageContentLengthBucket`：number/string，消息正文长度和长度分桶。
  - `copySource`：string，复制来源。当前取值为 `user_message` 或 `assistant_message`。
  - `copiedLength`：number，复制内容长度。
  - `result`：string，动作结果。当前取值包括 `success`、`failed`。
  - `activeSkillCount` / `activeSkillIds`：number/string，消息提交时关联的技能数量和 ID 列表。
  - `activeKitCount` / `activeKitIds`：number/string，消息提交时关联的专家套件数量和 ID 列表。
  - `hasAttachments` / `imageAttachmentCount`：boolean/number，消息是否包含图片附件和附件数量。
  - `hasModelLabel` / `modelId` / `modelName` / `providerKey`：boolean/string，消息关联模型摘要。
- 隐私边界：
  - 不上传消息正文、图片内容、文件名、本地路径、sessionId、messageId 或错误详情。
  - 会上传技能/套件 ID、模型 ID/名称、角色、长度分桶和动作结果，用于分析用户对消息复用、分叉和图片查看的行为偏好。

#### 2.4.38 `lobsterai_conversation_navigation_action`

- 状态：已实现。
- 触发时机：用户点击右侧消息轨道、轨道上一条/下一条按钮、回到底部按钮，以及执行会话导出、手动上下文压缩、选中文本引用等会话级操作时发送。
- 事件含义：统计长对话浏览、定位和会话级复用行为，用于判断消息轨道、回到底部、导出、上下文压缩和选中文本引用等能力的使用价值。
- 业务参数：
  - `surface`：string，当前固定为 `conversation`。
  - `actionType`：string，动作类型。当前取值包括 `rail_item_click`、`rail_prev_click`、`rail_next_click`、`scroll_to_bottom_click`、`export_options_open`、`export_text_submit`、`export_text_result`、`export_image_submit`、`export_image_result`、`context_compact_confirm_open`、`context_compact_confirm_close`、`context_compact_blocked`、`context_compact_cancel`、`context_compact_confirm`、`selected_text_add_to_prompt`、`selected_text_add_blocked`、`selected_text_locate_source`。
  - `currentRailIndex` / `targetRailIndex`：number，当前轨道位置和目标轨道位置。
  - `railItemCount`：number，当前轨道消息项数量。
  - `distanceToBottomBucket`：string，回到底部前距离底部分桶。
  - `sessionMessageCountBucket` / `totalMessageCountBucket`：string，当前已加载消息数和总消息数分桶。
  - `isStreaming`：boolean，操作时会话是否仍在生成中。
  - `exportFormat`：string，导出格式。当前取值包括 `markdown`、`json`。
  - `result`：string，动作结果。当前取值包括 `success`、`failed`、`cancelled`。
  - `reason` / `errorCode`：string，会话级动作被阻止或失败时的分类原因，不上传错误详情。
  - `selectedTextLengthBucket` / `selectedTextTotalLengthBucket`：string，选中文本长度和当前已引用文本总长度分桶。
  - `selectedSnippetCount`：number，当前输入框引用的选中文本片段数量。
- 隐私边界：
  - 不上传消息正文、轨道 tooltip 文本、选中文本正文、导出文件名、sessionId、messageId 或滚动容器具体 DOM 信息。
  - 会上传轨道序号、数量、距离、消息数分桶、导出格式、选中文本长度分桶和动作结果，用于分析长对话导航、导出和引用链路是否有效。

#### 2.4.39 `lobsterai_conversation_block_action`

- 状态：已实现。
- 触发时机：用户在对话内容区操作代码块、思考过程块、计划模式输出块和工具调用块时发送。覆盖代码块展开/收起、换行、全屏、复制、下载、全屏搜索；思考过程展开/收起；计划模式复制、下载、展开/收起、确认执行、继续调整；工具调用展开/收起。
- 事件含义：统计对话内富内容区块的阅读、复用和导出行为。
- 业务参数：
  - `surface`：string，当前固定为 `conversation`。
  - `blockType`：string，区块类型。当前取值为 `code`、`thinking`、`proposed_plan`、`tool`。
  - `actionType`：string，动作类型。当前取值包括 `code_copy`、`code_download`、`code_collapse`、`code_expand`、`code_wrap_enabled`、`code_wrap_disabled`、`code_fullscreen_open`、`code_fullscreen_close`、`code_search_open`、`code_search_close`、`thinking_expand`、`thinking_collapse`、`plan_copy`、`plan_download`、`plan_expand`、`plan_collapse`、`plan_confirm_execute`、`plan_adjust`、`tool_expand`、`tool_collapse`。
  - `result`：string，动作结果。当前取值包括 `success`、`failed`。
  - `source`：string，动作来源。代码块当前取值包括 `inline`、`fullscreen`。
  - `language`：string，代码块语言；无语言时为 `text`。
  - `isDiffBlock`：boolean，是否为 diff 代码块。
  - `codeLength` / `codeLengthBucket` / `codeLineCount`：number/string/number，代码块长度、长度分桶和行数。
  - `thinkingLength` / `thinkingLengthBucket` / `thinkingLineCount`：number/string/number，思考过程长度、长度分桶和行数。
  - `planLength` / `planLengthBucket` / `planLineCount`：number/string/number，计划内容长度、长度分桶和行数。
  - `toolName` / `displayToolName`：string，工具调用名称和展示名称。
  - `hasResult` / `hasResultText` / `isError`：boolean，工具调用是否已有结果、是否有可展示结果文本、是否失败。
  - `resultLengthBucket` / `resultLineCount`：string/number，工具结果展示内容长度分桶和行数。
  - `isBashTool` / `isTodoWriteTool` / `isEditWithDiff`：boolean，工具调用展示类型摘要。
  - `isStreaming`：boolean，思考过程操作时消息是否仍在生成中。
- 隐私边界：
  - 不上传代码正文、思考过程正文、计划正文、工具输入/输出正文、下载文件名、消息正文、sessionId 或 messageId。
  - 会上传语言、工具名称、长度/行数分桶、区块类型和动作结果，用于分析代码、计划、思考过程和工具调用等富内容的真实使用情况。

#### 2.4.40 `lobsterai_artifact_preview_action`

- 状态：已实现。
- 触发时机：用户在会话中的 artifact 卡片、右侧 artifact 预览面板、内置浏览器 tab 和浏览器工具栏中操作时发送。
- 事件含义：统计 artifact 从生成后的点击、打开、预览、切换、复用、浏览和导出链路。
- 业务参数：
  - `source`：string，触发来源。当前取值包括 `conversation_artifact_card`、`artifact_panel`、`artifact_browser`。
  - `actionType`：string，动作类型。当前取值包括 `card_open`、`badge_open`、`open_menu_toggle`、`open_lobster_browser`、`open_external_app`、`open_with_app`、`open_in_browser`、`open_local_service`、`reveal_in_folder`、`panel_toggle`、`panel_expand_toggle`、`panel_add_menu_toggle`、`panel_tab_open`、`panel_tab_switch`、`panel_tab_close`、`file_list_drawer_toggle`、`file_list_select_artifact`、`actions_menu_toggle`、`content_view_change`、`copy_content`、`refresh_preview`、`share_html_click`、`browser_preview_session_create`、`browser_back`、`browser_forward`、`browser_reload`、`browser_stop`、`browser_address_submit`、`browser_open_external`、`browser_more_menu_toggle`、`browser_open_blank_page`、`browser_open_local_service`、`browser_device_toolbar_toggle`、`browser_device_preset_change`、`browser_device_size_change`、`browser_device_rotate`、`browser_device_scale_change`、`browser_zoom_in`、`browser_zoom_out`、`browser_zoom_reset`、`browser_clear_cookies`、`browser_clear_cache`、`browser_screenshot`、`browser_annotate_start`、`browser_annotate_cancel`、`browser_annotate_end`、`browser_annotate_send`。
  - `artifactType`：string，artifact 类型。当前取值包括 `html`、`svg`、`image`、`video`、`mermaid`、`code`、`markdown`、`text`、`document`、`local-service`。
  - `artifactSource`：string，artifact 来源。当前取值包括 `inline`、`tool`、`file`。
  - `artifactTitleLength` / `artifactTitleLengthBucket`：number/string，artifact 标题或文件名长度及分桶。
  - `fileExtension`：string，文件扩展名，例如 `html`、`png`、`pdf`。
  - `hasFilePath` / `hasUrl` / `hasContent`：boolean，artifact 是否有本地文件路径、URL 或内联内容。
  - `contentLengthBucket`：string，artifact 内容长度分桶。
  - `isWebsite`：boolean，是否为网页/本地服务类 artifact。
  - `openTarget`：string，打开目标。当前取值包括 `preview_panel`、`lobster_browser`、`external_browser`、`external_app`、`folder`。
  - `appName`：string，用户选择的系统 App 名称，例如 `Google Chrome`、`Safari`；不上传 App 路径。
  - `isDefaultApp`：boolean，是否为系统默认 App。
  - `tabType`：string，右侧面板 tab 类型。当前取值包括 `artifact`、`browser`、`file_list`。
  - `tabCount`：number，当前会话 artifact tab 数量。
  - `isPanelExpanded` / `targetExpanded` / `targetOpen`：boolean，面板或菜单当前/目标状态。
  - `wasSelected`：boolean，artifact badge 点击前是否已是当前选中项。
  - `contentView` / `targetContentView`：string，artifact 预览视图，例如 `preview`、`code`。
  - `browserUrlType`：string，浏览器地址类型。当前取值包括 `blank`、`local_file`、`localhost`、`external_url`、`other`。
  - `hasCurrentUrl`：boolean，内置浏览器是否存在当前 URL。
  - `browserZoomPercent` / `targetBrowserZoomPercent`：number，浏览器缩放百分比。
  - `isDeviceToolbarVisible`：boolean，设备工具栏是否显示。
  - `devicePreset` / `targetDevicePreset`：string，设备预设。
  - `targetDeviceWidth` / `targetDeviceHeight` / `targetDeviceSize`：number，设备预览目标尺寸。
  - `deviceScalePercent` / `targetDeviceScalePercent`：number，设备预览缩放百分比。
  - `servicePort` / `serviceOnline`：number/boolean，本地服务端口和在线状态。
  - `shareSourceType` / `hasExistingShare`：string/boolean，HTML 分享来源类型和是否已有分享。
  - `hasComment` / `annotationElementTag`：boolean/string，浏览器标注是否有评论、标注元素标签。
  - `result`：string，动作结果。当前取值包括 `success`、`failed`、`cancelled`。
- 隐私边界：
  - 不上传完整本地路径、完整 URL、URL query、文件名全文、HTML/代码/图片/文档内容、sessionId、artifactId、messageId、App 可执行路径或错误详情。
  - 会上传 artifact 类型、扩展名、标题长度、来源、打开目标、App 展示名称、tab/面板状态、浏览器 URL 类型、设备/缩放参数和动作结果，用于分析 artifact 预览链路是否被用户持续使用。

### 2.5 请求流程

```text
业务模块
  -> reportYdAnalyzer(params)
  -> 校验 action
  -> buildLogUrl(params)
  -> 自动补充通用参数、安装 ID、渠道归因、用户 ID、时间戳和基础环境参数
  -> window.electron.api.fetch(GET)
  -> 返回 true 或 false
```

请求复用现有的 Electron API 网络桥接，由主进程通过 Electron session 发出请求，以避免 Renderer 的 CORS 限制。

`uuid` 复用已有 `installation_uuid`，不新增数据库表或迁移脚本。`firstKeyfrom` 和 `latestKeyfrom` 复用主进程现有渠道归因服务，并通过只读 IPC 暴露给 Renderer 日志模块。上述参数读取失败时不会阻断日志请求，只会省略对应字段。

日志请求失败时只记录警告并返回 `false`，不会向调用方抛出异常，也不会阻断原业务流程。

Renderer 调试日志只记录事件 `action` 和请求结果，不记录完整请求地址或事件参数。主进程的通用 API 请求日志会移除 URL query 和 fragment 后再写入本地日志，避免 `log_Usid` 和事件参数进入本地日志文件。

### 2.6 设置开关

使用统计开关放在：

```text
设置 -> 通用 -> 帮助改进 LobsterAI
```

配置字段为 `usageAnalyticsEnabled`，存储在现有 `app_config` 中，默认值为 `true`。老用户本地配置中没有该字段时，按开启处理，不需要新增数据库表或迁移脚本。

用户关闭后，`reportYdAnalyzer()` 在发送请求前直接跳过并返回 `false`，不会访问日志服务。该跳过行为只写入一条 Renderer debug 日志，不影响业务流程。

用户可见文案应避免使用“日志上报”，避免误解为上传本地日志文件。当前中文文案为：

- 标题：`帮助改进 LobsterAI`
- 描述：`允许发送基础使用统计，帮助我们改进功能体验。不会上传对话内容、文件内容或 API Key。`

### 2.7 调用方式示例

业务模块统一通过 `reportYdAnalyzer()` 进行 fire-and-forget 调用，不等待网络请求，不阻塞原业务流程。以下为计划模式开启事件示例：

```typescript
void reportYdAnalyzer({
  action: LogReporterAction.PlanModeEnabled,
  entry: LogReporterEntry.PromptToolsMenu,
});
```

`action` 为 `lobsterai_plan_mode_enabled`，`entry` 为 `prompt_tools_menu`。其他事件同样从 `LogReporterAction` 取统一事件名，并按 2.4 中定义的业务参数补充结构化字段。

## 3. 后续待完善内容

当前日志链路和主要功能入口已按本文实现。后续如果继续扩展，优先关注以下事项：

1. 评估是否需要单独增加首次启动/首次安装事件，用于区分新增安装和普通启动。
2. 根据真实日志分析结果，收敛低价值或过细的 `actionType`，避免分析口径过散。
3. 继续评估是否需要去重、采样、批量发送和失败重试。
4. 补充隐私说明、数据保留周期和日志调试方式。
5. 补充真实应用内的手动验收记录，包括关闭使用统计开关、请求参数检查、会话导出、artifact 预览和工具调用展开/收起。
