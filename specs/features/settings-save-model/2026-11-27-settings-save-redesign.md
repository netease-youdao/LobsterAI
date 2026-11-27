# 设置页保存机制重构（去全局底栏与两级保存模型）设计文档

## 1. 概述

### 1.1 问题/背景

当前设置弹窗（`src/renderer/components/Settings.tsx`）在整个内容区外层包裹了一个全局 `<form onSubmit={handleSubmit}>`，并在除 `CoworkMemory`、`Email` 外的 **12 个页签** 统一渲染右下角 `[取消] [保存]` 底栏（`Settings.tsx:5177-5202`）。

随着多个模块陆续独立演进以及运行时从 OpenClaw 迁移至 DeepSeek Harness（DSH），当前设置页呈现出 **4 种互相冲突的保存语义**，极易造成用户误解与配置丢失：

1. **同一页签内“一半即时落盘、一半必须点保存”，外观完全一致**：
   - **通用（`General`）**：`默认权限模式`、`开机自启`、`防止休眠`、`退出确认` 为即时落盘（点「取消」也无法撤回）；`语言`、`产物自动预览`、`任务完成通知`、`授权/提问通知`、`使用系统代理` 必须点全局「保存」，不点保存关窗时 `语言` 会在 `unmount` 中被强制回滚。
   - **外观（`Appearance`）**：`浅色/深色/跟随系统`、`主题配色`、`AI 皮肤` 全部即时落盘；`界面字号`、`代码字号` 必须点保存，否则关窗回滚。
   - **自定义模型（`Model`）**：`删除自定义服务商`、`OpenAI / xAI OAuth 登录登出` 即时落盘；但 `API Key / Base URL / 协议 / 启用开关`、测试连接成功后自动打开服务商开关、以及**在子弹窗中点了「保存」的模型编辑**，未点外层右下角「保存」时全部丢失。
   - **浏览器（`BrowserWebAccess`）**：`网站凭据` 新增/删除即时落盘；`显示模式`、`外部浏览器路径 / CDP 地址`、`凭据策略`、`黑名单域名` 必须点全局保存。
   - **数据与隐私（`DataPrivacy`）**：临时文件清理、数据备份、数据恢复全是即时动作；仅底部 `使用统计` 开关依赖全局保存。
2. **“半落盘、半延迟生效”的割裂状态**：
   - **IM 机器人（`Im`）**：输入框 `onBlur` 与部分开关已经通过 `imService.persistConfig(..., { syncGateway: false })` 写入 SQLite，但同步到运行中的 DSH 通道依赖点击全局「保存」触发 `imService.saveAndSyncConfig()`。结果点「取消」撤不回 SQLite 改动，直接关窗则本地已改但机器人未生效。
3. **纯展示/纯即时页面空挂保存按钮**：
   - **桌面宠物（`DesktopCompanion`）**、**插件（`Plugins`）**、**帮助与反馈（`Help`）**、**关于（`About`）**（除极隐藏的 `testMode` 开关外）没有任何待提交表单，却挂着 `[取消] [保存]`，误导用户以为改动尚未生效。
4. **外层 `<form>` 带来的事件污染与布局不统一**：
   - 嵌套在设置弹窗内的子表单（如 `BrowserCredentialSettings`）必须手工 `event.stopPropagation()` 防止提交事件冒泡触发外层全局保存并关闭整个设置窗口；
   - 有无底栏导致各页签的滚动可视高度与底部留白不一致。

**历史约束已解除**：旧版 OpenClaw 时代许多配置改动会触发整进程 Gateway 重启，因而将改动攒至全局「保存」一次提交。当前 DSH 架构下，`app_config` 写入（`src/main/main.ts` `store:set`）、IM 通道同步（`scheduleImConfigSync` 自带防抖且 `restartGatewayIfRunning: false`）、实验性决策模型切换（`decisionModel/handlers.ts` 动态热同步宿主工具，无 DSH 重启）均已支持**无重启热同步**，维持全局大表单的技术包袱已不存在。

### 1.2 参考实践（Antigravity / Codex / DSH）

| 参考对象 | 全局底栏 | 独立偏好控件 | 多字段 / 密钥连接配置 |
| --- | --- | --- | --- |
| **Google Antigravity** | 无全局 `[取消] [保存]` | 开关、下拉、通知、快捷键全部**即改即生效** | 简单字段自动保存；复杂集成走独立弹窗或局部提交 |
| **OpenAI Codex Desktop** | 无全局 `[取消] [保存]` | 常规偏好、权限、开关全部**即改即生效** | 长文本与多字段配置块在**卡片内部**提供局部「Save」 |
| **DeepSeek Harness（DSH）** | `SettingsRoot` 无全局底栏，仅右上角关闭 | `DeveloperToolsRow` 开关、`Shortcuts` 录制均**即改即落盘**，失败原地报错 | 模型提供商（`ProviderEditor` / `CustomProviderCard`）与插件配置（`WebSearchCard` / `ShellCard` / `AgentLoopCard`）统一使用**局部暂存表单 `<SettingsForm>`**（`dirty / invalid / saving / failed` + 局部 `[取消/放弃] [保存]`），避免密钥误覆盖、支持多字段原子校验及草稿探测 |

三者共识高度一致：**取消全局保存底栏，用“即改即生效”消除偏好操作的心智负担，用“对象内局部保存”兜底含密钥/多字段联动的连接配置。** 这也与 LobsterAI 现有 `EmailSkillConfig` 的成熟交互完全同构。

### 1.3 目标与非目标

**目标**：
- 彻底移除设置弹窗右下角全局 `[取消] [保存]` 底栏与外层 `<form onSubmit={handleSubmit}>`。
- 建立全站统一的 **两级保存心智模型**：
  1. **Level 1（即改即生效）**：所有开关、下拉选择、主题/皮肤、字号、快捷键、列表类增删弹窗，修改即持久化，无需点击保存；失败时原地回滚并提示错误。
  2. **Level 2（局部表单保存）**：多字段联动、含敏感密钥或需连通性校验的连接配置对象（自定义模型连接区、IM 机器人实例表单、邮箱账号表单、实验性决策模型卡片、外部浏览器连接地址），统一在**对象内部**提供局部保存/放弃条，一次性完成校验、落盘与 DSH 热同步。
- 统一未保存草稿的离开保护（Dirty Guard），在切换 Tab、切换 Provider/IM 实例、按 `Esc` 或关闭设置弹窗时防止误丢草稿。
- 遵守仓库大文件拆分规范，将通用设置持久化、模型设置持久化、脏状态协调逻辑从 `Settings.tsx` 提取到独立模块，降低 `Settings.tsx` 复杂度。

**非目标**：
- 不重做设置弹窗整体视觉布局（保持左导航 + 右内容结构、自定义模型左右分栏结构、IM 平台与多实例概览结构）。
- 不改变 DSH 底层配置格式、`app_config` SQLite 存储结构或对外 IPC 兼容契约。
- 不调整企业配置（`enterpriseConfig.ui`）的页签显隐规则。

---

## 2. 用户场景

### 场景 1: 修改常规偏好开关或下拉选项
**Given** 用户打开设置弹窗，处于「通用」、「外观」、「快捷键」、「数据与隐私」或「关于」页签  
**When** 用户切换语言、开关「使用系统代理」、调整字号、修改「产物自动预览」或录制一个新的快捷键  
**Then** 页面右下角不再出现「取消/保存」按钮；改动立即持久化并生效，直接按 `Esc` 或点击右上角 `×` 关闭弹窗后重新打开，改动完整保留；若系统调用失败（如全局快捷键冲突），控件原地回滚并展示明确错误提示。

### 场景 2: 在「自定义模型」中添加模型与修改 API Key
**Given** 用户在「自定义模型」页签选中某个服务商  
**When** 用户点击「添加模型」并在弹窗中填写模型信息后点击弹窗「保存」  
**Then** 模型立即持久化并同步到主界面的模型选择器中，即使不进行其他操作直接关闭设置弹窗也不会丢失。  
**When** 用户修改该服务商的 `API Key`、`Base URL` 或 `API 格式`  
**Then** 连接配置卡片底部浮现局部 `[放弃更改] [保存]` 操作条，标题旁显示「未保存」徽章；此时点击「测试连接」会直接使用草稿中的密钥与地址探测，测试成功后自动保存并开启该服务商（或由用户显式点击「保存」落盘），保存成功后局部条收起并短暂展示「已保存」微反馈。

### 场景 3: 在「IM 机器人」中开关实例与编辑机器人凭据
**Given** 用户在「IM 机器人」页签查看飞书/钉钉等多实例列表  
**When** 用户在实例列表页点击某实例的启用开关、删除实例，或在微信页完成扫码绑定  
**Then** 操作立即写入 SQLite 并在后台防抖热同步到 DSH，无需额外点「保存」。  
**When** 用户点进某个机器人实例详情页，依次填写 `App ID` 和 `App Secret`  
**Then** 填写 `App ID` 后切窗复制 `App Secret` 不会因为失焦触发半残写入或无效同步；填完后可先点「连通性测试」（使用当前草稿探测），再点击详情页底部的 `[保存并生效]`，一次性完成校验、写 SQLite 与 DSH 同步，并在头部更新同步状态。

### 场景 4: 在「实验室」启用并配置决策模型
**Given** 用户在「实验室」页签展开决策模型连接配置并填入 API Key  
**When** 用户点击卡片底部的 `[保存]`（与「测试连接」并排）  
**Then** 配置立即保存并触发 DSH 动态宿主工具热同步，徽章从「未保存」变为「已生效」；若用户已经保存过有效 API Key，直接切换外部总开关可立即生效。

### 场景 5: 存在未保存局部草稿时切换页签或关闭设置
**Given** 用户在自定义模型连接区、IM 实例详情页、邮箱编辑页、实验室决策模型卡片或外部浏览器地址区修改了字段但尚未点局部「保存」  
**When** 用户点击左侧其他设置页签、切换其他服务商/平台、点击返回列表、按 `Esc` 或点击右上角 `×` 关闭设置  
**Then** 弹出轻量二次确认弹窗：「当前有未保存的更改」，提供 `[继续编辑]`、`[放弃更改]`、`[保存并继续]`（当表单校验通过且可保存时）三个清晰动作；无未保存草稿时所有切换与关闭均零弹窗瞬时完成。

---

## 3. 功能需求

### FR-1: 移除全局底栏与外层 `<form>`
- 移除 `Settings.tsx` 中的全局右下角 `[取消] [保存]` Footer（含 `footerFadeVisible` 遮罩逻辑，若无其他用途一并清理）。
- 移除包裹整个内容区的 `<form onSubmit={handleSubmit}>` 及巨型 `handleSubmit` 批提交函数；各局部表单自行管理提交或按钮点击事件。
- 统一所有 14 个页签的内容滚动容器内边距与高度，消除此前 `CoworkMemory` / `Email` 与其他 Tab 的高度差。
- 移除 `Settings.tsx` `unmount` 时对 `language`、`uiFontSize`、`codeFontSize` 的回滚 `useEffect`（原 `Settings.tsx:2071-2085`）。

### FR-2: 建立统一的局部暂存表单规范（`SettingsFormFooter`）
参考 DSH `<SettingsForm>` 与项目内现有 `SettingsLayout.tsx`，在 `src/renderer/components/settings/` 下抽象统一的局部保存反馈原语：
- **状态枚举**（`as const` 常量）：`Idle`（无改动）、`Dirty`（有未保存修改）、`Saving`（保存/同步中）、`Saved`（已保存，展示 1.8s 后淡回 `Idle`）、`Error`（保存失败，保留草稿）。
- **状态徽章**：复用 `SettingsLayout.tsx` 中已有的 `SettingsStatusBadge`：
  - `Dirty` → `Warning` 语气，文案「未保存」；
  - `Saving` → `Progress` 语气，文案「保存中…」；
  - `Saved` → `Success` 语气，文案「已保存」；
  - `Error` → `Danger` 语气，文案「保存失败」。
- **局部操作条（`SettingsFormFooter`）**：
  - 支持两种展示模式：
    - **Dirty Bar 模式**（用于常驻表单卡片，如自定义模型连接区、外部浏览器连接地址、实验室决策模型、IM 单实例页）：平时无改动时不占位或折叠，变为 `Dirty` / `Saving` / `Error` 时在卡片底部展示 `[放弃更改]`（次按钮）与 `[保存]`（主按钮，存在校验错误时禁用并展示行内错误原因）。
    - **显式编辑页底栏模式**（用于从列表进入的二级编辑页，如 `EmailSkillConfig` 账号表单、IM 多实例详情页）：底部固定显示 `[取消/放弃]` 与 `[保存]`（无改动时主按钮置灰，有改动且合法时高亮）。

### FR-3: 全量 14 个设置页签持久化矩阵

| 页签 (`SettingsTabId`) | 保存模式 | 细项行为规范 |
| --- | --- | --- |
| **通用 (`general`)** | **全即时** | `language`、`artifactAutoPreviewEnabled`、`taskCompletionNotificationMode`、`attentionNotificationsEnabled`、`useSystemProxy` 均改为即改即写 `configService.updateConfig` 并立刻上报对应埋点；`defaultPermissionMode`、`autoLaunch`、`preventSleep`、`quitConfirmation` 保持即时；`useSystemProxy` 切换期间 `disabled` 防重入。 |
| **外观 (`appearance`)** | **全即时** | 主题模式、配色主题、AI 皮肤保持即时；`uiFontSize`、`codeFontSize` 保持实时预览，同时改为 `300ms` 防抖 + `onBlur` 立即落盘，并上报埋点。 |
| **桌面宠物 (`desktopCompanion`)** | **全即时** | 保持现状（全部即时调用 `desktopCompanion.setPreferences`）。 |
| **快捷键 (`shortcuts`)** | **全即时** | 录制有效且无冲突快捷键、清除快捷键、切换发送快捷键、`重置全部快捷键`（建议带轻量二次确认）均立即落盘。`QuickPanel` 全局快捷键立即调用 `desktopCompanion.setPreferences({ shortcut })`，若系统注册冲突当场提示错误并回滚该行。 |
| **自定义模型 (`model`)** | **结构操作即时 + 连接配置局部保存** | 详见 **FR-4**。 |
| **记忆 (`coworkMemory`)** | **总开关即时 + 局部编辑** | 保持现状（已闭环）。 |
| **浏览器 (`browserWebAccess`)** | **常规项即时 + External 地址局部保存** | `displayMode`、`credentialUseMode`、`credentialSaveMode`、`blockedHostnames`（弹窗添加/行内删除）全部改为即改即写 `configService.updateConfig`；`BrowserCredentialSettings` 保持即时；仅 `External` 模式下的 `executablePath` + `cdpUrl` 归入局部 `SettingsFormFooter`（校验 `cdpUrl` 合法后点「保存」落盘并刷新 `agentBrowserHost`；若用户把 `displayMode` 切回 `InApp`，放弃未保存的 External 地址草稿并立即保存模式切换）。 |
| **IM 机器人 (`im`)** | **列表动作即时 + 实例表单局部保存并生效** | 详见 **FR-5**。 |
| **邮箱 (`email`)** | **列表即时 + 账号编辑页局部保存** | 保持现状，接入统一 Dirty Guard（编辑中切 Tab/关窗时受保护）。 |
| **插件 (`plugins`)** | **全即时** | 保持现状（`DshPluginEcosystemView` 已全即时）。 |
| **数据与隐私 (`dataPrivacy`)** | **全即时** | `usageAnalyticsEnabled` 开关改为即改即写 `configService.updateConfig`（关闭时同步清理归因状态，开启时上报 `UsageAnalyticsEnabled`）；临时文件清理、备份、恢复保持现状。 |
| **实验室 (`experimental`)** | **总开关按需即时 + 连接区局部保存** | `DecisionModelExperimentalSettings` 移除对父组件 `draftRef` 的依赖，改由组件内部自闭环调用 `window.electron.decisionModel.saveConfig`：<br>1. 当已有有效 API Key 且连接区无未保存修改时，切换总开关直接落盘并热同步；<br>2. 连接区（Provider / Endpoint / API Key）修改时进入 `Dirty`，底部与「测试连接」并排提供 `[放弃]` `[保存]` 按钮；保存后更新 `saved` 快照。接入 Dirty Guard。 |
| **帮助 (`help`)** | **全即时/纯动作** | 保持现状。 |
| **关于 (`about`)** | **全即时/纯动作** | 隐藏的 `testMode` 开关改为即改即写 `configService.updateConfig({ app: { ...prev.app, testMode: next } })`。 |

### FR-4: 自定义模型（`Model`）详细交互规范
保留现有“左服务商列表 + 右服务商详情”布局，明确拆分两类操作：

1. **即时持久化操作**（操作完成立刻调用 `persistProviders` 写入 `configService.updateConfig`、同步 `apiService.setConfig` 并刷新 Redux `availableModels`）：
   - 切换服务商启用/禁用开关（当目标服务商已具备有效凭据，或正在禁用时）；
   - 新增自定义服务商（创建槽位后先切入该服务商，若尚未填写 Base URL/模型不强写垃圾配置，或创建空卡片进入局部编辑态，填完点「保存」正式落盘——详见边界情况）；
   - 删除自定义服务商（确认弹窗确认即删）；
   - 模型子弹窗（`ModelEditorDialog`）点击「保存」、删除模型、拉取模型弹窗（`ModelDiscoveryDialog`）点击确认；
   - 导入服务商配置（`ProviderTransferDialog` 确认导入即落盘）；
   - 所有 OAuth 登录/登出（统一 `OpenAI`、`xAI`、`MiniMax`、`GitHub Copilot` 四个服务商，登录成功或登出后统一即时落盘并刷新 `availableModels`）。
2. **连接配置区块（局部暂存表单）**：
   - 纳入草稿的字段：`authType`、`apiKey`、`baseUrl`、`apiFormat`、`openaiApiMode`、`codingPlanEnabled`、`displayName`（自定义服务商名称）。
   - 与已持久化快照对比得出 `isConnectionDirty`；有改动时在连接配置区块底部出现 `SettingsFormFooter`（`[放弃更改] [保存]`）并在区块右上角显示「未保存」徽章。
   - **「测试连接」联动**：
     - 点击「测试连接」始终使用当前草稿值发起测试（与 DSH `probe` 一致）；
     - 若测试成功且当前连接区处于 `Dirty`（或服务商尚未启用），自动将当前草稿保存并启用该服务商（`enabled: true`），测试结果弹窗提示「连接成功，配置已自动保存」，彻底解决“测通了却忘点保存”的高频痛点；
     - 若测试失败，保留草稿不落盘，方便用户修改后重试。
   - **切换服务商保护**：左侧点击切换另一个服务商时，若当前服务商连接区处于 `Dirty`，触发 Dirty Guard 确认框。

### FR-5: IM 机器人（`Im`）详细交互规范
彻底废除当前“输入框 `onBlur` 静默写库、等全局保存再 sync DSH”的割裂机制：

1. **外层列表与快捷动作（即时落盘 + 自动防抖同步 DSH）**：
   - 多实例概览页的**启用/停用开关**、**删除实例**、**添加实例**、**重命名实例**；
   - 单实例平台（微信 `weixin`）的**启用/停用开关**、**扫码绑定成功**、**清除绑定**；
   - 以上操作均直接传 `{ syncGateway: true }`（走主进程已有的 `scheduleImConfigSync`，带 `IM_CONFIG_SYNC_DEBOUNCE_MS` 防抖且不重启 DSH），并刷新运行状态。
2. **机器人实例配置详情表单（局部暂存 + 原子「保存并生效」）**：
   - 覆盖全部多实例详情组件（`DingTalkInstanceSettings`、`FeishuInstanceSettings`、`WecomInstanceSettings`、`QQInstanceSettings`、`TelegramInstanceSettings`、`DiscordInstanceSettings`、`PopoInstanceSettings`、`NimInstanceSettings`）以及单实例凭据页（`netease-bee`）。
   - **去掉所有输入框与控件上的 `onBlur={() => void onSave()}` 与自动写库调用**；编辑期间所有字段（凭据、Webhook、白名单、DM/群聊策略、Agent 绑定等）仅更新该实例表单的本地草稿状态（不直接 dispatch 覆盖 Redux 已存配置）。
   - **「一键创建机器人」/ 扫码授权回填凭据**（如飞书/钉钉/企微向导回填 `appId`/`appSecret`）：若向导是一步完成的完整凭据下发，回填后可直接执行一次保存并同步（或高亮提示已填入并保存），避免用户二次点击遗漏。
   - **「连通性测试」**：调用 `imService.testGateway(platform, draftConfigOverride)`，直接使用当前未保存草稿探测（主进程 `im:gateway:test` 现已原生支持 `configOverride`）。
   - **局部底栏**：详情页底部使用 `SettingsFormFooter`，主按钮为 **`[保存并生效]`**（无改动时禁用），点击后一次性执行：前端校验 → 写 SQLite → 调用 `im:config:sync` 热同步 DSH → 更新 Redux 配置与运行状态 → 展示「已保存并生效」微反馈。
   - 同步清理历史残留状态：`platformsPendingSave`、`renderPlatformRuntimeNotice` 中“请点击保存”的提示、`IM_AUTH_RESTART_ON_SAVE_OPTIONS` 中对全局保存的耦合。

### FR-6: 统一 Dirty Guard 与 `Esc` 分层
- 在设置弹窗顶层维护轻量的 `dirtyGuardRegistry`（一个回调 ref 或注册接口，由当前激活 Tab 上报 `{ isDirty, label, save?, discard }`）。
- 触发 Dirty Guard 的入口统一为 4 处：
  1. 切换左侧设置 Tab（`handleTabChange`）；
  2. Tab 内部子上下文切换（如切换自定义模型 Provider、IM 返回平台列表/切换平台、邮箱编辑页返回列表）；
  3. 点击右上角关闭按钮 `×` 或点击遮罩关闭（`guardedClose`）；
  4. 按 `Esc` 键（`settingsEscape.ts` 在所有子弹窗均关闭后，若当前有脏表单，返回新动作 `SettingsEscapeAction.PromptUnsaved` 弹出未保存确认框，而不是直接关闭设置弹窗）。
- 确认弹窗提供：
  - **保存并继续**（当草稿校验合法且提供 `save` 时显示；保存失败则停留在原页并展示错误）；
  - **放弃更改**（调用 `discard()` 并继续原本的导航/关闭目标）；
  - **继续编辑**（关闭确认弹窗，留在原表单）。

### FR-7: 埋点与数据备份兼容性
- **埋点迁移**：原 `Settings.tsx` `handleSubmit` 中的差异上报逻辑（`reportGeneralSettingChanged`、`reportAppearanceSettingChanged`、`reportBrowserSettingChanged`、`reportShortcutSettingChanged`、`reportCustomModelSettingsSaved`、`UsageAnalyticsEnabled`）随各项即时写入与局部保存迁至对应写入点，保证埋点口径不丢失、且不会再漏报未点总保存的修改。
- **数据备份联动**：移除或简化 `Settings.tsx:2848-2861` 的 `persistModelSettingsBeforeDataBackup` 变通逻辑——因为用户在离开 `Model` Tab 前已由 Dirty Guard 决定保存或放弃，进入 `DataPrivacy` 触发备份时已存配置即为最新状态。

---

## 4. 实现方案

### 4.1 架构与模块拆分（遵循大文件瘦身原则）

`Settings.tsx` 当前超过 5,400 行，属于明确列管的大文件。本次改造**不向 `Settings.tsx` 堆叠新状态**，而是借机把职责抽离为边界清晰的独立模块：

```text
src/renderer/components/settings/
├── settingsDirtyGuard.ts           # [新增] 脏状态常量、DirtyGuard 决策纯函数（可单测）
├── settingsDirtyGuard.test.ts      # [新增] DirtyGuard 与退出/切换决策单元测试
├── SettingsFormFooter.tsx          # [新增] 统一局部保存条（Dirty Bar / 编辑页底栏 + 状态徽章）
├── UnsavedChangesConfirmDialog.tsx # [新增] 统一的“未保存更改”确认弹窗（保存并继续 / 放弃 / 继续编辑）
├── useImmediateConfigWriter.ts     # [新增] 串行化写入队列 Hook：防竞态、支持乐观更新与失败回滚
├── useModelSettingsPersistence.ts  # [新增] 抽离自定义模型草稿、dirty 比对、连接保存、即时模型增删与 Redux 同步
├── useModelSettingsPersistence.test.ts # [新增] 模型 dirty 判断、保存与回滚纯函数测试
├── settingsEscape.ts               # [修改] 增加 PromptUnsaved 动作与 hasUnsavedChanges 输入
├── settingsEscape.test.ts          # [修改] 补充有脏草稿时 Esc 拦截测试
└── ...
```

### 4.2 关键技术设计细节

#### 1. 串行写入队列与防竞态（`useImmediateConfigWriter`）
多个即时开关快速连续点击（或字号防抖触发同时切换开关）时，`configService.updateConfig` 是异步 read-modify-write（`localStore.getItemStrict` → merge → `setItem`）。
- 在 `configService.updateConfig` 内部（`src/renderer/services/config.ts`）增加 Promise 串行队列（`writeQueue`），保证并发 partial update 严格按序读-改-写，杜绝后写覆盖先写（lost update）。
- 为 `configService.updateConfig` 补充并发写单测，验证连续两次不同字段的 `updateConfig({ language })` + `updateConfig({ useSystemProxy })` 不会互相覆盖。

#### 2. `SettingsFormFooter` 接口契约
```ts
export const SettingsFormStatus = {
  Idle: 'idle',
  Dirty: 'dirty',
  Saving: 'saving',
  Saved: 'saved',
  Error: 'error',
} as const;
export type SettingsFormStatus = typeof SettingsFormStatus[keyof typeof SettingsFormStatus];
```
组件 props：
- `status: SettingsFormStatus`
- `mode?: 'dirty-bar' | 'always'`（`dirty-bar` 仅在非 `Idle` 时渲染操作条；`always` 适用于独立二级编辑页）
- `canSave: boolean`（校验未通过或无改动时为 `false`）
- `errorMessage?: string | null`
- `saveLabel?: string`（默认「保存」，IM 实例页可传「保存并生效」）
- `onSave: () => void | Promise<void>`
- `onDiscard: () => void`

#### 3. 模型设置持久化抽离（`useModelSettingsPersistence`）
- **数据源分离**：
  - `savedProviders`：镜像 `configService.getConfig().providers`，作为已落盘基线；
  - `connectionDraft`：仅保存当前 `activeProvider` 的连接区字段草稿；当 `activeProvider` 切换或保存成功时重置。
- **即刻落盘操作**（开关启用、增删改模型、拉取模型、删除自定义服务商、导入、OAuth 回调）：直接基于 `savedProviders` 计算下一份完整 `providers`，经 `normalizeProvidersForSettingsSave` 写入 `configService.updateConfig`，并同步更新 `apiService.setConfig` 与 Redux `setAvailableModels`。
- **连接区保存**：仅把当前 `activeProvider` 的连接草稿合并进 `savedProviders` 后落盘；不影响其他服务商；保存成功后更新 `savedProviders` 并清空 `connectionDraft`。
- **新建自定义服务商处理**：点击「添加自定义服务商」时先在本地创建未落盘的新草稿槽位（`isNewDraft: true`），此时连接区直接处于 `Dirty` 态并展示 `[取消] [保存]`；用户填完并点「保存」（或测试连接通过自动保存）才写入 `configService`，点「取消」直接移除临时槽位，避免配置里残留大量空白 `custom_N`。

#### 4. IM 设置重构（`IMSettings.tsx` 及 8 个 `*InstanceSettings.tsx`）
- 抽离通用草稿 Hook `useIMInstanceDraft<T>(savedInstance, onCommit)`：
  - 管理 `draft`、`isDirty`（深比较排除瞬态字段）、`status`、`error`、`discard()`、`save()`；
  - 当外部同步或开关切换更新了 `savedInstance` 的非表单字段（如 `enabled` 状态）且当前无未保存改动时自动同步；
  - 各 `*InstanceSettings.tsx` 接收 `draft` + `onDraftChange` + 底部渲染 `SettingsFormFooter`，移除全部输入控件上的 `onBlur={() => void onSave()}`。
- 主进程 `src/main/main.ts` 几乎零改动：复用已有的 `im:config:set`（对列表即时动作传 `syncGateway: true`）与 `im:config:sync`（对实例表单「保存并生效」显式调用并返回同步结果）；清理不再需要的 `imConfigRestartOnNextSettingsSave` 标记（核实无其他调用方后删除）。

#### 5. 国际化（i18n）新增文案键
在 `src/renderer/services/i18n.ts` 的 `zh` 与 `en` 区块同步新增（复用已有 `save` / `saving` / `cancel` / `decisionModelBadgeUnsaved` 等键，仅补缺口）：
- `settingsSavedBadge`（「已保存」 / `Saved`）
- `settingsSaveFailedBadge`（「保存失败」 / `Save failed`）
- `settingsDiscardChanges`（「放弃更改」 / `Discard`）
- `settingsSaveAndApply`（「保存并生效」 / `Save & Apply`）
- `settingsUnsavedTitle`（「有未保存的更改」 / `Unsaved changes`）
- `settingsUnsavedDescription`（「离开前是否保存当前修改？」 / `Do you want to save your changes before leaving?`）
- `settingsSaveAndContinue`（「保存并继续」 / `Save & Continue`）
- `settingsContinueEditing`（「继续编辑」 / `Keep Editing`）
- `connectionSuccessAndSaved`（「连接成功，配置已自动保存」 / `Connection succeeded and settings saved`）
- `shortcutResetConfirmTitle` / `shortcutResetConfirmDesc`（恢复默认快捷键轻确认）

### 4.3 分阶段实施步骤

按风险隔离与 PR 可评审粒度拆分为 **3 个 Phase**（每个 Phase 独立通过类型检查、单测与手工验证）：

- **Phase 1：基础原语 + 简单页签全面即时化**
  1. 为 `configService.updateConfig` 增加串行写队列与单元测试；
  2. 新增 `SettingsFormFooter`、`UnsavedChangesConfirmDialog`、`settingsDirtyGuard.ts`；
  3. 将 `General`、`Appearance`（字号防抖落盘）、`Shortcuts`、`DataPrivacy`、`About`（`testMode`）、`BrowserWebAccess`（常规项即时 + External 地址局部保存）改造完毕；
  4. 将 `DecisionModelExperimentalSettings` 改为卡片内局部保存，移除 `decisionModelDraftRef`。
  *(注：Phase 1 期间全局底栏仅在尚未改造的 `Model` / `Im` 两个 Tab 临时保留，其余 12 个 Tab 立即隐藏全局底栏。)*

- **Phase 2：自定义模型与 IM 机器人局部表单闭环**
  1. 抽离 `useModelSettingsPersistence`，完成 `Model` 页签的“结构动作即时 + 连接区 Dirty Bar + 测试通过自动保存 + 全部 OAuth 统一落盘”，同步隐藏 `Model` 页全局底栏；
  2. 抽离 `useIMInstanceDraft`，将 `IMSettings` 及各平台 `*InstanceSettings` 改造为“列表即时防抖同步 + 实例详情页局部「保存并生效」”，接入草稿连通性测试，清理 `platformsPendingSave` 残留，隐藏 `Im` 页全局底栏。

- **Phase 3：彻底收口与全链路 Dirty Guard**
  1. 从 `Settings.tsx` 彻底删除全局底栏 JSX、外层 `<form>`、`handleSubmit`、`didSaveRef`、`footerFadeVisible` 与 `persistModelSettingsBeforeDataBackup`；
  2. 为 `Model`、`Im`、`Email`、`Experimental`、`BrowserWebAccess (External)` 全部接入顶层 Dirty Guard 与 `settingsEscape.ts` 的 `PromptUnsaved` 分层；
  3. 清理 `Settings.tsx` 中已废弃的遗留 OpenClaw 引擎分支死代码（如已退役的 `coworkAgentEngine` case 中无用保存逻辑，保持改动克制）；
  4. 补齐全部单测并完成 `electron:dev:dsh` 全量回归。

---

## 5. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| 连续快速点击多个即时开关（如同时切「使用系统代理」和「产物自动预览」） | `configService.updateConfig` 内部串行队列排队执行，每个写入基于最新已落盘对象做 partial merge，不丢更新；异步 IPC 期间对应开关 `disabled` 防重入。 |
| 即时开关写入失败（如磁盘只读、`autoLaunch` 无权限、`QuickPanel` 全局快捷键冲突） | 回滚该控件到变更前状态，展示行内或顶部错误提示，不影响同一页其他已保存设置。 |
| `Appearance` 字号输入框正在连续点击 `+`/`-` 或键盘输入时立即关闭弹窗 | 在 `onBlur` 及组件 `unmount` 时 flush 尚未执行的 300ms 防抖写入（仅当值相对已存值合法且变化时），确保用户刚改完就关窗不会丢失最后一次字号。 |
| 浏览器 `External` 模式下输入非法 `cdpUrl` | 字段行内标红报错，`SettingsFormFooter` 禁用「保存」按钮；此时若用户切回 `InApp` 模式，丢弃未保存的非法 External 草稿并立即持久化 `displayMode: InApp`。 |
| 自定义模型测试连接通过，但服务商原本未启用或连接区未保存 | 测试成功后自动调用连接区保存并置 `enabled: true`，清除 `Dirty` 状态并更新 Redux `availableModels`，弹窗明确告知「连接成功，配置已自动保存」。 |
| 自定义模型修改了 `API Key` 但尚未保存，此时用户直接点击「添加模型」或「拉取模型」 | 模型列表增删改基于已存配置持久化；「拉取模型」像 DSH 一样使用当前草稿中的 `apiKey / baseUrl` 探测接口，确认选中的模型立即写入模型列表，同时保留连接区草稿（或顺带提示保存连接配置），不互相覆盖。 |
| OAuth 登录进行中（MiniMax / OpenAI / xAI / Copilot）用户切换 Tab 或关闭弹窗 | 登录成功后无论页面是否仍在当前 Tab，通过 `configService.updateConfig` 持久化授权状态；若进行中用户主动取消，仅清理登录态不改动已有配置。 |
| IM 平台「一键创建机器人」或微信扫码登录成功 | 授权完成拿到完整有效凭据后直接写 SQLite + 触发 `syncGateway: true` 并刷新状态，不要求用户再手动点一次「保存并生效」。 |
| IM 实例详情页保存时 DSH 通道同步失败（例如凭据被远端拒绝或 DSH 正在启动） | 若校验失败则不写库且保留草稿；若写库成功但 DSH 同步失败，`SettingsFormFooter` 进入 `Error` 态并展示失败原因与「重试同步」能力，避免静默失败。 |
| 数据备份/恢复/临时文件清理进行中（`dataMigration.isBusy`） | 保持现有阻塞策略：禁止切换 Tab、禁止 `Esc` 与关闭弹窗，优先级高于 Dirty Guard。 |
| 切换语言导致当前激活的 Provider 或 IM 平台在目标区域被隐藏 | 先经 Dirty Guard 处理（若在 `General` 切换语言本身无脏草稿），语言立即持久化生效；切回 `Model` / `Im` 时自动回落到首个可见项（复用现有回落逻辑）。 |
| 企业配置通过 `enterpriseConfig.ui` 隐藏某些 Tab | Dirty Guard 仅对当前实际挂载激活的 Tab 生效，不受隐藏 Tab 影响。 |

---

## 6. 涉及文件

### 新增文件
- `src/renderer/components/settings/SettingsFormFooter.tsx` — 统一局部保存操作条与保存状态徽章组件
- `src/renderer/components/settings/UnsavedChangesConfirmDialog.tsx` — 统一未保存更改确认弹窗
- `src/renderer/components/settings/settingsDirtyGuard.ts` — 脏状态导航/关闭决策纯函数与状态常量
- `src/renderer/components/settings/settingsDirtyGuard.test.ts` — 脏状态保护单元测试
- `src/renderer/components/settings/useModelSettingsPersistence.ts` — 自定义模型持久化与连接草稿管理 Hook
- `src/renderer/components/settings/useModelSettingsPersistence.test.ts` — 自定义模型脏状态与保存逻辑单元测试
- `src/renderer/components/im/useIMInstanceDraft.ts` — IM 实例表单本地草稿与原子保存同步 Hook
- `src/renderer/components/im/useIMInstanceDraft.test.ts` — IM 实例草稿比对与保存状态机单元测试

### 修改文件
- `src/renderer/services/config.ts`（及配套 `config.test.ts`）— `updateConfig` 串行写队列防并发覆盖
- `src/renderer/components/Settings.tsx` — 移除全局底栏、外层 `<form>`、`handleSubmit`、`didSaveRef`、`decisionModelDraftRef`、`persistModelSettingsBeforeDataBackup`；接入即时保存与顶层 Dirty Guard
- `src/renderer/components/settings/settingsEscape.ts` & `settingsEscape.test.ts` — 增加未保存草稿 `PromptUnsaved` 分层
- `src/renderer/components/settings/GeneralSettingsSection.tsx` — 代理开关加载态禁用支持
- `src/renderer/components/settings/BrowserWebAccessSettings.tsx` — 常规项即时保存 + External 连接地址局部保存条
- `src/renderer/components/settings/ModelSettingsSection.tsx` — 接入连接区 `SettingsFormFooter` 与状态徽章
- `src/renderer/components/DecisionModelExperimentalSettings.tsx` — 移除 `draftRef` 耦合，卡片内直接调用 `decisionModel.saveConfig` + `SettingsFormFooter`
- `src/renderer/components/skills/EmailSkillConfig.tsx` — 接入顶层 Dirty Guard 注册接口
- `src/renderer/components/im/IMSettings.tsx` & `src/renderer/components/im/*InstanceSettings.tsx` — 列表动作即时热同步 + 详情表单去 `onBlur` 改局部「保存并生效」+ 接入 Dirty Guard
- `src/renderer/services/im.ts` — 列表即时操作默认启用 `syncGateway: true`，提供显式实例「保存并同步」方法
- `src/renderer/components/settings/useDataMigration.ts` — 简化对 `persistModelSettingsBeforeBackup` 的强制依赖
- `src/renderer/services/i18n.ts` — 补充中英文文案键
- `src/main/main.ts` — （Phase 3 可选清理）确认无调用方后清理已废弃的 `imConfigRestartOnNextSettingsSave` 标志

---

## 7. 验收标准

### 自动化验证
- [ ] `npm test` 全部通过，包含新增的 `settingsDirtyGuard.test.ts`、`useModelSettingsPersistence.test.ts`、`useIMInstanceDraft.test.ts`、`settingsEscape.test.ts` 与 `config.ts` 并发写入测试。
- [ ] `npx tsc` 与 `npm run compile:electron` 零错误。
- [ ] 对全部修改文件执行 `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 --no-warn-ignored <files>` 零错误零警告。

### 功能与交互验收（`npm run electron:dev:dsh`）
- [ ] 打开设置弹窗遍历全部 14 个可见页签，**没有任何页签再显示全局右下角 `[取消] [保存]` 底栏**，且滚动区域高度与底部留白统一。
- [ ] **通用 / 外观 / 快捷键 / 数据与隐私 / 关于**：修改任意开关、语言、字号、通知模式、系统代理、快捷键后直接按 `Esc` 或点击 `×` 关闭并重启应用，所有改动均持久化生效。
- [ ] **自定义模型**：
  - 子弹窗新增/编辑/删除模型、导入配置、删除自定义服务商、OAuth 登录登出、切换服务商启用开关，操作后直接关窗均已生效且模型选择器同步刷新；
  - 修改 API Key / Base URL 时卡片底部出现 `[放弃更改] [保存]`；点击「测试连接」成功后自动保存并启用；未保存时切换 Provider / Tab / 关窗弹出确认框。
- [ ] **IM 机器人**：
  - 实例列表切换启用开关、删除实例、微信扫码绑定后，DSH 通道自动热同步生效，无需额外点击保存；
  - 实例详情页修改 `App ID` 失焦不会触发提前写库或错误同步；点击「连通性测试」使用草稿探测；点击「保存并生效」后一次性写 SQLite 并热同步 DSH；未保存离开时触发确认框。
- [ ] **实验室（决策模型） & 浏览器（External 模式） & 邮箱**：均通过局部「保存」完成提交并受 Dirty Guard 保护，且切换决策模型开关不触发 DSH 重启。
- [ ] 检查埋点日志：各页签修改与保存仍正常上报对应分析事件，无遗漏、无重复上报。
