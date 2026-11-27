# 内置技能精简、只读不可关闭与市场化迁移设计文档

## 1. 概述

### 1.1 背景与问题

当前 LobsterAI 在 `SKILLs/` 中默认内置了 20 个技能（见 `SKILLs/skills.config.json`），并在每次应用启动时通过 `SkillManager.syncBundledSkillsToUserData()` 将其全部复制到 `<userData>/SKILLs/` 与用户自行安装/市场安装的技能混居。这一模式存在以下问题：

1. **默认上下文开销过大、模型路由易受干扰**：大量垂直或外部生态技能（股票分析、公众号策划、每日热搜、Remotion、有道云笔记、天气、系统日历等）默认随应用启用，每轮均将其描述注入 DSH `<available_skills>`，挤占上下文窗口并降低通用对话路由准确率。
2. **核心内置能力可被误关**：`web-search`、`docx`、`xlsx`、`pptx`、`pdf` 等与桌面实时编辑器/宿主工具深度绑定的底座能力可被用户手动或在「上下文清理」中误关，导致产品核心体验静默失效。
3. **内置与用户目录混居，生命周期耦合重**：内置技能复制到 `userData/SKILLs/` 既额外占用磁盘空间（如 `pptx` 39MB、`imap-smtp-email` 7.1MB），又增加了升级拷贝、损坏修复与归属判定的复杂度；且 `imap-smtp-email` 将用户凭据（`accounts.json` / `.env`）直接存放在技能代码目录内。
4. **DSH 原生调用策略未启用**：DSH 底层（`@deepseek-ai/dsh-tool-skill`）已支持 `invocation: { modelInvocable, userInvocable }`，但 `@lobsterai/dsh-bundle` 目前硬编码为 `{ modelInvocable: true, userInvocable: true }`，导致如 `skill-creator`、`lobsterai-image-processing`、未配置邮箱时的 `imap-smtp-email` 等无法做到按需曝光与零冗余 Token。
5. **Kit 托管技能与常驻内置混淆**：`skin-creator` 实际归属内置 Kit `ai-skin-designer`（默认 `enabled: false`），与常驻内置技能语义冲突。

### 1.2 核心决策总览

结合 Codex、Claude Code、Antigravity 与 DSH 的工程实践，本期确定以下设计基线：

| 决策项 | 确定方案 |
|---|---|
| **保留的核心内置技能（9 个，不可关闭、不可删除）** | `web-search`、`docx`、`xlsx`、`pptx`、`pdf`、`lobsterai-image-processing`、`frontend-design`、`skill-creator`、`imap-smtp-email` |
| **迁出到市场的垂直技能（10 个）** | `article-writer`、`content-planner`、`daily-trending`、`stock-analyzer`、`stock-announcements`、`stock-explorer`、`remotion`、`local-tools`、`weather`、`youdaonote` |
| **`skin-creator` 归属** | 对齐 `computer-use` 改造为 **Kit 托管模式**：移出 `SKILLs/` 放入 `resources/skin-pack/skin-creator/`，仅在安装「外观定制」Kit 时释放，卸载 Kit 时清理 |
| **内置技能存储架构** | **一期一步到位改为只读挂载**：不再向 `userData/SKILLs/` 复制这 9 个核心内置技能，直接通过 DSH `skillsPolicy` 只读加载 `Resources/SKILLs/`；将 `imap-smtp-email` 用户凭据迁至 `<userData>/email-skill/`，并清理老用户在 `userData/SKILLs/` 中的 9 个旧内置副本 |
| **核心内置 ID 保护** | 9 个核心内置 ID 为保留名：加载优先级 `核心内置 > 用户目录`；用户导入同名技能时自动加后缀（如 `docx-1`），确保核心底座不可被覆盖或绕过 |
| **调用与可见性策略** | 打通 DSH 原生 `disable-model-invocation` / `user-invocable`：`skill-creator` 默认不进模型目录（仅显式触发）；`lobsterai-image-processing` 不进输入框技能选择器；`imap-smtp-email` 未配置已启用邮箱账号时不注入模型目录 |
| **「不可关闭」的 UI 形态** | 保留「内置技能」Tab，对不可关闭技能隐藏开关与删除按钮，替换为只读「始终启用」标签；在「上下文清理」中彻底排除 |
| **老用户迁移策略（10 个迁出技能）** | **软保留 + 维持原启停状态**（绝不加入 `RETIRED_BUNDLED_SKILL_IDS`），本地副本自动转入「我的技能」可自由开关/卸载；离线中文名移入 `LEGACY_BUNDLED_SKILL_DISPLAY_NAMES`；后续交由现有 30 天「上下文清理」自然瘦身 |
| **老用户无版本号旧副本升级** | 保持现有版本比较（无 `version` 按 `0.0.0`），允许老用户通过「更新全部」平滑升级为带版本号的市场正式版；同时补齐 `isBuiltIn` 不参与市场版本对比的保护 |
| **安全扫描分流策略** | **官方市场免客户端扫描，仅扫描用户自行导入来源**：由主进程缓存并校验 Overmind 官方市场目录，仅对**精确命中官方市场目录且托管在官方可信域名（或带 `sha256` 校验）的下载包**跳过客户端静态安全扫描；用户自导入（本地 ZIP/目录、GitHub/ClawHub/npm、聊天内 `lobster_skill_install`）及非官方可变链接继续强制走安全扫描 |
| **新用户生态衔接（本期范围）** | 本期落地 **专家广场缺失技能补齐（非阻塞自动补齐 + 专家设置可见缺失态与重试）** 及 `docCatalog.ts` / `cheerio` 兼容处理；「对话内市场搜索 + 一键安装技能卡片」留作独立二期 |

### 1.3 非目标（二期规划）

- 对话内市场技能搜索工具（`lobster_search_marketplace`）与聊天消息内一键安装卡片渲染（留待二期）。
- `imap-smtp-email` 迁出市场及「设置 > 邮箱」未安装引导页（本期仍保留内置）。
- 全局技能目录 2% 上下文预算强制截断器（留待二期配合市场生态规模一并设计）。

---

## 2. 用户场景

### 场景 1: 新用户首次安装与日常使用
- **Given** 新用户首次安装新版 LobsterAI
- **When** 打开「技能管理 > 内置技能」与对话输入框「使用技能」选择器
- **Then**
  - `<userData>/SKILLs/` 初始为空（不再复制 47MB 内置文件）
  - 「内置技能」Tab 展示 9 个核心内置技能，卡片与详情弹窗不显示启停开关和删除按钮，仅展示「始终启用」只读标签与「使用」操作
  - 对话系统提示词的 `<available_skills>` 中仅注入必要且当前可见的技能（`web-search` 走原生工具、`skill-creator` 未显式选中不注入、`imap-smtp-email` 未配账号不注入），大幅降低默认上下文 Token 占用
  - 输入框技能选择器中不展示 `lobsterai-image-processing`（`user-invocable: false`），但用户发送图片并要求去水印/抠图时模型仍自动调用

### 场景 2: 老用户升级后，迁出市场的 10 个技能平滑保留
- **Given** 老用户此前版本已在 `<userData>/SKILLs/` 同步了全部 20 个旧内置技能，其中部分技能已被用户关闭，部分被绑定在自定义 Agent / 定时任务中
- **When** 升级到新版本并启动应用
- **Then**
  - 10 个迁出市场的技能文件完整保留在 `<userData>/SKILLs/`，原有启停状态（`skills_state`）不变
  - 它们的 `isBuiltIn` 自动变为 `false`，归入「我的技能」Tab，老用户现在可自由开关或删除，且离线状态下仍正确显示中文名
  - 市场页面与本地副本按相同 ID 自动识别为「已安装」或「可更新」，点击「更新 / 更新全部」可原地升级并保留 `.env` / `_meta.json`

### 场景 3: 老用户升级前曾关闭过某个核心内置技能
- **Given** 老用户在旧版本中曾手动或在「上下文清理」中关闭了 `web-search` 或 `docx`（SQLite `kv['skills_state']` 存有 `{ "web-search": { "enabled": false } }`）
- **When** 升级到新版本启动，或从旧版数据迁移包恢复备份
- **Then**
  - 启动阶段自动清理 `skills_state` 中针对 9 个核心内置技能的历史 `enabled: false` 记录
  - `SkillManager.listSkills()`、`SkillManager.isSkillEnabled('web-search')`、DSH `skillsPolicy` 与 `WebSearchHost` 全部一致返回启用态，不存在界面开启但底层报错的分裂状态

### 场景 4: 老用户升级后的邮箱凭据安全迁移与 9 个旧内置副本清理
- **Given** 老用户在 `<userData>/SKILLs/imap-smtp-email/` 中配置了 `accounts.json`（或旧版 `.env`），同时 `<userData>/SKILLs/` 中留有旧版拷贝的 `pptx`、`docx` 等 9 个核心内置目录
- **When** 升级到新版本首次启动
- **Then**
  - 启动迁移逻辑优先将 `accounts.json` 和 `.env` 原子拷贝至 `<userData>/email-skill/` 并校验落盘完整
  - 校验成功后，清理 `<userData>/SKILLs/` 中这 9 个核心内置技能的旧副本（`pptx` 等立即释放 ~47MB 重复磁盘空间）
  - 若邮箱凭据拷贝失败，则中止删除 `<userData>/SKILLs/imap-smtp-email/`，绝不丢失用户邮箱配置
  - 设置页「邮箱设置」、连通性测试、DSH 对话收发邮件以及跨设备备份恢复均无缝切换至 `<userData>/email-skill/`

### 场景 5: `skin-creator` 随「外观定制」Kit 按需托管
- **Given** 用户未安装「LobsterAI 外观定制」Kit（或老用户旧版存在默认禁用的 `<userData>/SKILLs/skin-creator/`）
- **When** 升级启动、安装 Kit、卸载 Kit
- **Then**
  - 未安装 Kit 时：不显示 `skin-creator`，老用户无用的旧副本会被安全清理
  - 安装 Kit 时：从打包资源 `resources/skin-pack/skin-creator/` 释放到 `<userData>/SKILLs/skin-creator/` 并启用；已安装 Kit 的老用户升级后自动原地刷新最新模板
  - 卸载 Kit 时：删除 `<userData>/SKILLs/skin-creator/` 及对应 `skills_state`

### 场景 6: 显式触发「通过对话创建」与选技能
- **Given** `skill-creator` 配置了 `disable-model-invocation: true`
- **When** 用户在普通对话中聊天 vs 在技能页点击「通过对话创建」或在输入框选中 `skill-creator` / 输入 `/skill-creator`
- **Then**
  - 普通对话中 `<available_skills>` 不包含 `skill-creator`（0 Token 占用）
  - 点击「通过对话创建」时，前端同时填入引导 Prompt 并预选 `skill-creator`；该轮次中 DSH 放行加载 `skill-creator`，正常进入技能创建引导流程

### 场景 7: 新用户安装引用已迁出技能的预设专家
- **Given** 新用户本地未安装 `stock-analyzer`、`stock-announcements`、`stock-explorer`
- **When** 在专家广场点击安装/召唤「股票分析专家」
- **Then**
  - 专家记录立即创建完成并同步 DSH，不阻塞用户进入界面
  - 系统自动查询官方技能市场并静默补齐安装该专家缺失的官方托管技能（不弹误报安全拦截；若市场指向非官方可变仓库则仍走安全审计弹窗）
  - 若处于离线状态或某依赖技能暂未上架市场，在专家设置页的技能区域清晰标出缺失技能，支持用户一键重试安装或前往市场

### 场景 8: 用户导入与核心内置同名的自定义技能
- **Given** 用户从本地 ZIP/文件夹/GitHub/ClawHub 导入一个名为 `docx` 的第三方技能
- **When** 执行安装
- **Then** 系统识别 `docx` 为核心内置保留 ID，自动安装为 `docx-1`（属于「我的技能」），不会覆盖或顶替只读内置的 `docx`

---

## 3. 功能需求

### FR-1: 核心内置技能单一事实源与配置扩展
- 在 `SKILLs/skills.config.json` 中仅保留 9 个核心内置技能，新增可选字段 `alwaysEnabled?: boolean`（核心 9 项均为 `true`）。
- 在 `src/shared/skills/constants.ts` 中集中定义：
  - `SkillInvocationMode` / `SkillRecord` 共享字段约束
  - `CORE_ALWAYS_ENABLED_SKILL_IDS`（或由 `SkillManager` 从 bundled `skills.config.json` 读取并作为后端权威集合；同时 `src/shared/contextCleanup/constants.ts` 复用统一语义，消除两套硬编码漂移）
  - `EMAIL_SKILL_CONFIG_DIR_NAME = 'email-skill'`、`SKIN_PACK_RESOURCE_DIR = 'skin-pack'` 等跨模块常量。
- `SkillRecord`（main）与 `Skill`（renderer）新增字段：
  - `canDisable: boolean`（`alwaysEnabled` 为 `true` 时为 `false`）
  - `modelInvocable: boolean`（默认 `true`，受 frontmatter `disable-model-invocation` 及动态可见性控制）
  - `userInvocable: boolean`（默认 `true`，受 frontmatter `user-invocable` 控制）

### FR-2: 核心内置技能只读加载与保留 ID 保护
- `SkillManager` 不再将 `Resources/SKILLs/` 中的内置技能复制到 `<userData>/SKILLs/`。
- 启动时执行一次性/幂等迁移与清理：
  1. 先迁移 `<userData>/SKILLs/imap-smtp-email/{accounts.json,.env}` 到 `<userData>/email-skill/`（若目标不存在且源文件存在）；
  2. 仅在邮箱凭据安全落盘（或源凭据不存在）后，移除 `<userData>/SKILLs/` 下与当前 9 个核心内置 ID 同名的旧同步副本目录；
  3. 清理 `kv['skills_state']` 中针对 `alwaysEnabled` 技能的历史 `enabled: false` 脏记录；
  4. 继续执行现有 `removeRetiredBundledSkills()`（仅针对永久退役的 `films-search`、`music-search`）与 `recoverInterruptedUpgrades()`。
- `SkillManager.listSkills()` 合并两个根目录：
  - 只读内置根 `bundledRoot`（仅按 `skills.config.json` 白名单读取 9 个核心内置技能，优先级高于 `userRoot` 中的同名核心 ID）
  - 用户/市场根 `userRoot`（`<userData>/SKILLs/`），自动忽略已被核心内置保留的同名目录（防护手工拷贝覆盖）
- `resolveInstallTarget()`（及 Kit 安装拷贝目录逻辑）将当前核心内置保留 ID 集合视为已占用，导入同名技能时自动递增后缀（`-1`、`-2`）。
- DSH 同步配置时，将 `bundledSkillsDir`（及保留内置 ID 列表）透传给 `@lobsterai/dsh-bundle`，由 DSH 按「核心内置只读根 > 用户目录 > 项目目录」或显式保留规则解析，确保运行期与 UI 视图完全一致。

### FR-3: 邮箱凭据目录独立化（`<userData>/email-skill/`）
- `SkillManager` 读写 `imap-smtp-email` 的 `accounts.json` 与 `.env` 改为读写 `<userData>/email-skill/`（若读取时新目录尚无文件但旧目录残留，则自动触发一次兜底迁移）。
- DSH 子进程环境（`buildIsolatedDshChildEnv`）与 `SkillManager.runSkillScriptWithEnv()` 统一注入：
  - `EMAIL_ACCOUNTS_PATH=<userData>/email-skill/accounts.json`
  - `EMAIL_ENV_PATH=<userData>/email-skill/.env`
- 更新 `SKILLs/imap-smtp-email/SKILL.md` 中关于凭据路径的说明，并在 `src/main/libs/dataMigration/archiveWhitelist.ts` 中将 `'email-skill'` 加入 `WHITELISTED_DIRECTORIES` 与 `REWRITABLE_USER_DATA_SUBDIRS`，确保备份/恢复与老版本迁移包双向兼容（恢复旧版备份时，下次启动自动把旧包里的 `SKILLs/imap-smtp-email/accounts.json` 迁到 `email-skill/`）。

### FR-4: 后端强制「不可关闭」闭环
- `SkillManager.parseSkillDir()`：对 `alwaysEnabled` 技能强制 `enabled = true`、`canDisable = false`。
- `SkillManager.isSkillEnabled(id)`：若 `isAlwaysEnabledSkillId(id)`，直接返回 `true`（修复 `WebSearchHost` 直接查原始 `skills_state` 可能误拒的隐患）。
- `SkillManager.setSkillEnabled(id, enabled)`：当 `!enabled && isAlwaysEnabledSkillId(id)` 时抛出明确错误（如 `'Built-in skills cannot be disabled'`），拒绝写入 `skills_state`。
- `SkillManager.setSkillsEnabledBatch(ids, enabled)`：当 `!enabled` 时自动过滤掉 `alwaysEnabled` 技能，仅对其余技能生效（防止批量清理接口报错或写入 `false`）。
- 保留 DSH 会话层的单 Agent `allowedSkillIds` 和 Plan Mode 空技能集约束不受影响（不可关闭仅指全局启用态锁定，不破坏专家隔离与规划模式）。

### FR-5: `skin-creator` 改造为 Kit 托管模式
- 将 `SKILLs/skin-creator/` 移至 `resources/skin-pack/skin-creator/`，并在 `electron-builder.json`（mac & win `extraResources`）与打包脚本中作为资源打包。
- 从 `SKILLs/skills.config.json` 中移除 `skin-creator`。
- 改造 `src/main/skins/skinPackKitLifecycle.ts` 对齐 `computerUseKit.ts`：
  - 安装 `ai-skin-designer` Kit 时：从 `resources/skin-pack/skin-creator/` 拷贝至 `<userData>/SKILLs/skin-creator/` 并写入 `skills_state['skin-creator'] = { enabled: true }`；
  - 卸载 `ai-skin-designer` Kit 时：删除 `<userData>/SKILLs/skin-creator/` 及 `skills_state['skin-creator']`；
  - 应用启动时：若 `ai-skin-designer` 已安装，自动从打包资源同步最新 `skin-creator` 文件（类似 `syncComputerUseSkillFromRuntime`）；若未安装但 `<userData>/SKILLs/skin-creator/` 存在（老用户旧副本），安全清理该目录与 `skills_state['skin-creator']`。
- `SkillManager.listSkills()` 增加与 `computer-use` 一致的可见性守卫：若未安装 `ai-skin-designer` Kit，则过滤 `skin-creator`。

### FR-6: DSH 调用策略与动态可见性
- 扩展 `dsh-bundles/lobsterai-host/plugins/persona-helpers.mjs` 的 frontmatter 解析与技能发现逻辑：
  - 解析 `disable-model-invocation`（boolean，默认 `false`）与 `user-invocable`（boolean，默认 `true`），映射为 DSH 标准的 `invocation: { modelInvocable, userInvocable }`；
  - 同样在 `SkillManager.parseSkillDir()` 中解析这两个字段输出给前端（输入框 `SkillsPopover` 过滤 `skill.userInvocable !== false`，但不影响「技能管理 > 内置技能」Tab 的展示）。
- **显式选技能透传**：
  - `dshRuntimeAdapter.ts` 在绑定会话/轮次上下文时，将本轮用户显式选中的 `messageSkillIds` 传给 DSH 宿主（`selectedSkillIds`）；
  - `persona-scope.mjs` / `persona-helpers.mjs` 对当前轮次 `selectedSkillIds` 命中的技能临时提升为 `modelInvocable: true`（保证设置了 `disable-model-invocation: true` 的 `skill-creator` 在用户从 UI 点击「通过对话创建」或主动勾选后，模型可正常调用 `skill` 工具加载）；
  - 修复 `src/renderer/App.tsx` 的 `handleCreateSkillByChat()`：同步设置 `setActiveSkillIds(['skill-creator'])` 和 `setDraftSkillIds({ draftKey: '__home__', skillIds: ['skill-creator'] })`。
- **3 个核心技能的具体策略**：
  - `SKILLs/skill-creator/SKILL.md`：添加 `disable-model-invocation: true`（平时 0 Token，仅显式选择/通过对话创建/`/skill-creator` 时加载）；
  - `SKILLs/lobsterai-image-processing/SKILL.md`：添加 `user-invocable: false`（模型处理图片自动路由，不出现在输入框技能选择器）；
  - `imap-smtp-email` 动态可见性：`main.ts` 构建 `skillsPolicy` 时检查 `hasEnabledEmailAccount()`；当无任何已启用邮箱账号时，通过 `skillsPolicy.modelHiddenIds`（如 `['imap-smtp-email']`）通知 DSH 将其 `modelInvocable` 置为 `false`；用户在「设置 > 邮箱」保存/启用/停用账号后触发一次轻量 `syncSkillsPolicy()` 实时生效。

### FR-7: 技能管理 UI 与「上下文清理」改造
- **`SkillsManager.tsx`**：
  - 当 `!skill.canDisable` 时：卡片右上角与已安装详情弹窗底部隐藏 `CardToggle` 和删除入口，展示轻量的只读「始终启用」标签（新增中英文 i18n key）；仍保留卡片点击详情和「使用」按钮（若 `skill.userInvocable === false`，详情页可隐藏「使用」按钮，仅作为系统能力展示说明）。
  - `getSkillInstallStatus()` 和 `updatableSkills` 补齐 `if (installed.isBuiltIn) return 'installed'` 保护，防止内置技能参与市场版本升级比对。
- **`ContextCleanupService`**：
  - `CleanupSkillDescriptor` 新增 `canDisable?: boolean`；
  - `scan()` 直接跳过 `skill.canDisable === false` 的技能，不生成清理候选，也不计入可节省 Token；
  - `apply()` 兜底过滤不可关闭技能。
- **离线中文名兼容**：
  - 将 10 个迁出技能（`article-writer`、`content-planner`、`daily-trending`、`stock-analyzer`、`stock-announcements`、`stock-explorer`、`remotion`、`local-tools`、`weather`、`youdaonote`）的显示名从 `BUNDLED_SKILL_DISPLAY_NAMES` 迁至 `LEGACY_BUNDLED_SKILL_DISPLAY_NAMES`；`skin-creator` 可留于 `LEGACY_BUNDLED_SKILL_DISPLAY_NAMES` 或由 Kit 元数据提供。
- **首页 Showcase 最小清理**：
  - `src/shared/homeShowcase/catalogs/docCatalog.ts` 中 `doc-article-writer` 卡片的 `skillId: 'article-writer'` 调整为 `undefined`（或 `docx`），避免新用户点击卡片时依赖已迁出的技能。

### FR-8: 官方市场免客户端安全扫描（主进程权威来源校验）
- **审核职责分层**：
  - 官方市场技能审核前置到上架/CI 发布阶段（与现有 Kit 市场一致），终端安装与批量升级时不再因客户端静态正则误报反复打断用户。
  - 用户自导入来源（本地 ZIP、本地目录、远程 GitHub/ClawHub/npm URL、聊天内 `lobster_skill_install`）继续强制执行完整的 `scanMultipleSkillDirs()` 与风险确认弹窗。
- **主进程权威判定（禁止渲染层传 `skipSecurityScan` 布尔值）**：
  - 主进程在 `skills:fetchMarketplace` 拉取 Overmind 官方市场清单（`getSkillStoreUrl()`）时，在内存中缓存可信目录条目（`id -> { url, version, sha256? }`），并支持在缓存为空时按需刷新。
  - `SkillManager.downloadSkill()` 与 `SkillManager.upgradeSkill()` 仅在同时满足以下条件时跳过客户端安全扫描：
    1. 下载 `source` / `downloadUrl` 精确命中主进程缓存的官方市场条目 `url`；
    2. 且该 URL 满足供应链防篡改条件之一：
       - 托管在官方可控不可变 CDN 域名（`*.nosdn.127.net`、`*.youdao.com`、`*.126.net`、`*.127.net`，HTTPS 协议）；或
       - 市场条目携带 `sha256` 并在下载后校验通过。
  - 若市场中存在直接指向第三方可变仓库（如外部 GitHub 分支）且无 `sha256` 锁定的条目，仍自动回退到客户端安全扫描兜底。

### FR-9: 专家广场缺失技能补齐（非阻塞自动补齐 + 专家设置缺失态）
- **新增 IPC / 服务能力**：
  - 在渲染层服务（`expertSkillInstaller.ts`）中编排「按技能 ID 列表从官方市场补齐安装缺失技能」（复用 `fetchMarketplaceSkills()`、`skills:download` 与现有 Redux 刷新）：
    1. 对比 `agent.skillIds` 与当前已安装技能列表，筛出本地缺失的 `missingSkillIds`；
    2. 查询市场列表，匹配 `id` 相同的市场技能；
    3. 串行下载安装：官方托管包免客户端扫描直接静默安装并刷新；若命中非官方可变链接触发风险审计则返回 `pendingInstalls` 供前端弹窗确认；若离线或市场未匹配则记录到 `unresolvedSkillIds` 并优雅降级，**不阻断专家创建**。
- **专家安装/召唤链路**：
  - 在专家广场安装/召唤预设专家（`agents:addPreset` 成功后），若返回 `agent.skillIds` 存在缺失技能，前端立即完成专家切换与可用态，同时异步触发缺失技能补齐（轻量提示补齐结果，若触发风险审计复用 `SkillSecurityReport` 弹窗）。
- **专家设置页可见缺失态（`AgentSettingsPanel.tsx` / `AgentSkillSelector.tsx`）**：
  - 当某个专家已绑定的 `skillIds` 中有本地未安装的 ID 时，不再静默丢失在列表外，而是在技能列表顶部展示「缺失技能（未安装）」区块，显示名称（复用 `getLocalizedSkillName`）与状态，提供「一键安装 / 重试」和「前往技能市场」入口。

### FR-10: 依赖保留与打包脚本清理
- **`package.json` 保留 `cheerio`**：因老用户本地保留的 `content-planner` 及市场版 `content-planner` 可能仍通过 `NODE_PATH` 引用 `cheerio`，本期保留 `package.json` 中的 `cheerio`（更新 `tests/electronBuilderAppFiles.test.ts` 注释说明用途）。
- **保留 `build:skill:email`**：因 `imap-smtp-email` 本期保留内置，`package.json` 构建脚本继续安装其生产依赖；`scripts/skill-mac-dependencies.cjs` 和 `scripts/skill-payload.cjs` 无需特殊改写（动态扫描 `SKILLs/*` 中含 `package.json` 的目录，即 `pptx` 和 `imap-smtp-email`）。
- **`electron-builder.json`**：mac 与 win 的 `extraResources` 新增 `resources/skin-pack` → `skin-pack` 映射（仅 ~16KB）。
- **Windows 安装包预校验（`scripts/nsis-installer.nsh`）**：仍校验 `$INSTDIR\resources\SKILLs\*.*`，9 个内置技能仍在 `SKILLs/` 中，保持通过。

---

## 4. 实现方案

### 4.1 配置与共享类型层

1. **`SKILLs/skills.config.json`**（精简为 9 项，增加 `alwaysEnabled: true`）：
```json
{
  "version": 2,
  "description": "Default skill configuration for LobsterAI",
  "defaults": {
    "docx": { "order": 10, "enabled": true, "alwaysEnabled": true },
    "web-search": { "order": 15, "enabled": true, "alwaysEnabled": true },
    "xlsx": { "order": 20, "enabled": true, "alwaysEnabled": true },
    "pptx": { "order": 30, "enabled": true, "alwaysEnabled": true },
    "pdf": { "order": 40, "enabled": true, "alwaysEnabled": true },
    "lobsterai-image-processing": { "order": 45, "enabled": true, "alwaysEnabled": true },
    "frontend-design": { "order": 100, "enabled": true, "alwaysEnabled": true },
    "imap-smtp-email": { "order": 211, "enabled": true, "alwaysEnabled": true },
    "skill-creator": { "order": 300, "enabled": true, "alwaysEnabled": true }
  }
}
```
2. **`src/shared/skills/constants.ts`**：
   - 保持 `SkillLoadIssue`；
   - 新增 `EMAIL_SKILL_ID = 'imap-smtp-email'`、`EMAIL_SKILL_CONFIG_DIR_NAME = 'email-skill'`、`SKIN_PACK_RESOURCE_DIR_NAME = 'skin-pack'`、`SkillIpcChannel`（新增通道按规范使用 `as const`）。
3. **`SkillRecord` / `Skill` 类型扩展**（`src/main/skills/skillManager.ts`、`src/renderer/types/skill.ts`、`src/renderer/types/electron.d.ts`）：
   - 增加 `canDisable: boolean`、`modelInvocable: boolean`、`userInvocable: boolean`。

### 4.2 内置只读加载、邮箱凭据迁出与老用户启动清理

1. **邮箱凭据独立路径**（`SkillManager`）：
   - 新增 `getEmailConfigDir(): string` → `path.resolve(app.getPath('userData'), EMAIL_SKILL_CONFIG_DIR_NAME)`。
   - 新增 `migrateLegacyEmailCredentials(): { migrated: boolean; safeToRemoveLegacyDir: boolean }`：
     - 检查 `<userData>/SKILLs/imap-smtp-email/` 是否存在 `accounts.json` 或 `.env`；
     - 若存在且目标 `<userData>/email-skill/` 尚无对应文件，采用「写临时文件 `.tmp` → 校验字节一致 → 原子 `renameSync`」迁移；
     - 若全部拷贝成功（或源目录本就没有凭据文件），返回 `safeToRemoveLegacyDir: true`；若任一 I/O 失败，记录错误日志并返回 `safeToRemoveLegacyDir: false`。
   - `getEmailAccountsConfig` / `setEmailAccountsConfig` / `getSkillConfig('imap-smtp-email')` / `setSkillConfig('imap-smtp-email', ...)` 统一读写 `getEmailConfigDir()`；
   - 新增 `hasEnabledEmailAccount(): boolean`（供 `main.ts` 计算 `imap-smtp-email` 动态可见性，并由 `setEmailAccountsConfig` 保存后触发 `onSkillsPolicyChanged()` 同步 DSH）。
2. **核心内置只读挂载 & 旧副本清理**（`SkillManager.syncBundledSkillsToUserData()` 重构为 `initializeBundledSkills()`，保留旧方法名作为兼容包装以免破坏调用方）：
   - Step 1：`removeRetiredBundledSkills(...)` + 清理 `skills_state` 中退役项；
   - Step 2：`migrateLegacyEmailCredentials()`；
   - Step 3：对当前 `listBuiltInSkillIds()` 中的每个核心内置 ID，若 `<userData>/SKILLs/<id>` 存在：
     - 如果是 `imap-smtp-email` 且 `!safeToRemoveLegacyDir`，跳过删除并打警告日志；
     - 否则安全删除该旧副本目录（复用 Windows 重试/降级策略）及对应的 `.upgrading` 残留；
   - Step 4：清理 `skills_state` 中所有 `isAlwaysEnabledSkillId(id)` 的 `enabled: false` 记录（删除条目或置 `true`）；
   - Step 5：调用 `syncSkinCreatorSkillOnStartup()`（见 4.3）。
3. **只读解析与优先级**（`SkillManager.listSkills()`）：
   - 先扫描 `userRoot`（跳过与 `builtInIds` 冲突的目录，防止手工投放覆盖）；
   - 再按 `bundledConfig.defaults` 白名单扫描 `bundledRoot`（写入 `skillMap`，确保 `核心内置 > 用户目录`）；
   - `isBuiltIn = true` 仅来自 `bundledRoot` 白名单（及历史 `pluginSkillIds` 兼容）；
   - `canDisable = !alwaysEnabledIds.has(id)`；
   - `enabled = alwaysEnabledIds.has(id) ? true : (state[id]?.enabled ?? defaultEnabled)`。
4. **保留 ID 安装防护**（`resolveInstallTarget()`）：
   - 传入 `reservedIds: ReadonlySet<string>`（核心内置 ID 集合），`while (reservedIds.has(candidateId) || fs.existsSync(targetDir))` 自动递增 `-1` 后缀。
   - `src/main/ipcHandlers/kits/handlers.ts` 安装远端 Kit 技能时同步遵守 `reservedIds` 检查。
5. **DSH 环境变量与根目录透传**：
   - `src/main/libs/dsh/dshHostManager.ts`：`buildIsolatedDshChildEnv()` 新增注入 `EMAIL_ACCOUNTS_PATH` 与 `EMAIL_ENV_PATH`（指向 `<userData>/email-skill/`）。
   - `src/main/main.ts` 构建 `skillsPolicy` 时新增：
     - `bundledDir: getSkillManager().getBundledSkillsRoot()`（或 `extraDirs` + `reservedBuiltInIds`）
     - `modelHiddenIds`（当 `!getSkillManager().hasEnabledEmailAccount()` 时包含 `'imap-smtp-email'`）。

### 4.3 `skin-creator` 改造为 Kit 托管

- 目录迁移：`SKILLs/skin-creator/` → `resources/skin-pack/skin-creator/`。
- 封装 `src/main/skins/skinPackSkillResources.ts`（或并入 `skinPackKitLifecycle.ts`）：
  - `resolveBundledSkinCreatorDir()`：打包态读 `path.join(process.resourcesPath, 'skin-pack', 'skin-creator')`，开发态读 `<projectRoot>/resources/skin-pack/skin-creator`。
  - `isSkinPackKitInstalled(store)`：检查 `kits_installed['ai-skin-designer']`。
  - `syncSkinCreatorSkillOnStartup(store, skillsRoot)`：
    - 若 Kit 已安装：从资源目录刷新 `<userData>/SKILLs/skin-creator/`（仅当内容哈希或版本变化时更新）；
    - 若 Kit 未安装：若 `<userData>/SKILLs/skin-creator/` 存在则删除，并删除 `skills_state['skin-creator']`。
  - `installIfHandled()`：拷贝 `resources/skin-pack/skin-creator/` 到 `<userData>/SKILLs/skin-creator/`，写入 `skills_state['skin-creator'] = { enabled: true }`，记录 `kits_installed`。
  - `uninstallIfHandled()`：删除 `<userData>/SKILLs/skin-creator/`，清理 `skills_state['skin-creator']` 与 `kits_installed`。
- `SkillManager.listSkills()` 隐藏守卫：当 `skillId === SkinPackSkillId.BuiltIn && !isSkinPackKitInstalled(store)` 时直接跳过。

### 4.4 DSH 宿主插件改动（`@lobsterai/dsh-bundle`）

修改 `dsh-bundles/lobsterai-host/plugins/` 下的 4 个文件（纯增量、保持向后兼容）：

1. **`shared-state.mjs` & `ops-rpc.mjs`**：
   - `state.skillsPolicy` 扩展字段：
     - `bundledDir: ''`（只读内置技能目录）
     - `bundledIds: new Set()`（白名单，确保只读内置目录中只加载配置的 9 项，且优先于 `userDir`）
     - `modelHiddenIds: new Set()`（运行时动态隐藏出模型目录的技能，如未配账号时的 `imap-smtp-email`）
   - `sessionContext` 扩展 `selectedSkillIds?: string[]`（来自 `dshRuntimeAdapter.ts` 每轮 `messageSkillIds`）。
2. **`persona-helpers.mjs`**：
   - 补齐 frontmatter 布尔字段解析：`disable-model-invocation`、`user-invocable`；
   - 调整发现顺序：先按 `bundledIds` 白名单扫描 `bundledDir`（只读、不受 `disabledIds` 影响、受 `allowedSkillIds` 专家边界约束），记录 `seen`；再扫描 `skillsDir`（`<userData>/SKILLs`）与 `extraDirs`（自动跳过已被 `bundledIds` 占用的同名目录）；最后扫描项目级 `.dsh/skills` / `.agents/skills`；
   - 计算每条 candidate 的 `invocation`：
     - `userInvocable = meta['user-invocable'] !== false`
     - `baseModelInvocable = meta['disable-model-invocation'] !== true && !modelHiddenIds.has(skillName)`
     - `modelInvocable = baseModelInvocable || selectedSkillIds.has(skillName)`（用户本轮显式选择的技能放行加载，确保点击「通过对话创建」和输入框点选均正常触发 `skill` 工具）。
3. **`persona-scope.mjs`**：
   - `ctx.skills` provider 将 `bound?.selectedSkillIds` 与 `state.skillsPolicy` 一并传入 `discoverLobsterSkills()`；
   - `buildWebSearchRoutingGuidance()` 的根目录集合同样包含 `state.skillsPolicy.bundledDir`。
4. **`dshRuntimeAdapter.ts`**：
   - 在 `bindSessionContext` / 每轮执行前同步当前轮次的 `selectedSkillIds`（`params.messageSkillIds`），并在执行结束后清理或随下轮覆盖。

### 4.5 专家广场缺失技能补齐方案

1. **后端/服务层编排**：
   - 新增纯工具函数 `resolveMissingAgentSkillIds(agentSkillIds, installedSkills)` 与 `resolveInstallableMarketplaceSkills(missingIds, marketplaceSkills)`。
   - 新增 IPC `skills:installMissingByIds`（或在渲染层 `skillService.installMissingSkills(skillIds)` 编排现有 `fetchMarketplaceSkills` + `skills:download`）：
     - 推荐放在渲染层服务 `src/renderer/services/expertSkillInstaller.ts` 复用已有 `skillService.fetchMarketplaceSkills()` 与 `skillService.downloadSkill()`，天然接入现有的安全审计弹窗（`SkillSecurityReport`）与 Redux `setSkills` 刷新，无需重复造轮子！
2. **触发时机**：
   - `ExpertPlazaView` / `agentService.addPresetAgent()` 成功创建或复用预设专家后，检查 `agent.skillIds` 中缺失的技能；
   - 若存在缺失技能：立即放行专家创建并弹出轻量提示（如「正在补齐专家依赖技能…」），后台串行从市场安装匹配技能；
   - 遇到安全扫描需确认的技能时，弹出 `SkillSecurityReport` 弹窗由用户决策；
   - 完成后刷新 Redux skills，并触发一次 DSH 配置同步。
3. **专家设置页缺失态 UI**：
   - `AgentSettingsPanel.tsx` / `AgentSkillSelector.tsx`：比对 `selectedSkillIds` 与 `skills`，识别未安装 ID，在选择器上方渲染「缺失技能（{count}）」告警卡片，列出本地化名称（`skillService.getLocalizedSkillName`）及操作按钮：
     - 市场中存在 → 「一键安装」（支持单个或全部安装）
     - 市场中暂未找到 / 离线 → 「前往技能市场」与「移除绑定」按钮。

### 4.6 数据迁移（备份 / 恢复）兼容

- `src/main/libs/dataMigration/archiveWhitelist.ts`：
  - `WHITELISTED_DIRECTORIES` 与 `REWRITABLE_USER_DATA_SUBDIRS` 新增 `'email-skill'`。
- **跨版本恢复兼容性**：
  - 新版备份 → 新版恢复：直接还原 `email-skill/` 与纯净的 `SKILLs/`（仅用户/市场技能）。
  - 旧版备份 → 新版恢复：旧版备份中无 `email-skill/`，但 `SKILLs/imap-smtp-email/accounts.json` 在 `SKILLs/` 中被恢复；重启后 `initializeBundledSkills()` 自动检测并迁移到 `email-skill/`，同时清理 9 个旧核心副本与历史 `enabled: false` 状态，实现 100% 自愈。

---

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 老用户升级前禁用了 `web-search` / `docx` 等核心技能 | 启动清理 `skills_state` 中对应 `enabled: false`，且 `parseSkillDir` + `isSkillEnabled` 双重兜底强制返回 `true` |
| 老用户升级时 `imap-smtp-email/accounts.json` 迁移失败（如磁盘只读/权限异常） | 中止删除旧 `<userData>/SKILLs/imap-smtp-email/`，读取逻辑降级读旧路径并打 error 日志，下次启动重试 |
| 老用户自定义修改过某核心内置技能的 `SKILL.md` | 一期核心内置采用只读保护，直接清理旧副本使用官方最新内置；如需自定义，可按新名字（如 `my-docx`）作为用户技能导入 |
| 用户通过 ZIP/GitHub/ClawHub/对话导入名为 `docx` 的技能 | `resolveInstallTarget` 检测到保留 ID，自动落盘为 `docx-1`；DSH 扫描时核心内置目录优先，杜绝冲突 |
| 用户在离线环境下安装依赖已迁出技能的预设专家 | 专家正常创建不阻塞；市场拉取失败后在专家设置页展示缺失技能与重试入口 |
| 市场上架的 10 个旧内置技能在安装/升级时是否触发客户端安全扫描 | 托管在官方不可变 CDN（或带 `sha256` 校验）且精确命中 Overmind 市场目录的包由主进程权威放行、免客户端扫描；指向外部可变仓库且无 `sha256` 的链接仍走客户端安全扫描兜底；用户自导入来源一律强制扫描 |
| 老用户保留的 `content-planner` 依赖 `cheerio` | `package.json` `dependencies` 保留 `cheerio`（通过 `NODE_PATH` 暴露给子进程），同时市场版 `content-planner` zip 建议自打包依赖 |
| 老用户安装过「外观定制」Kit，升级后 `skin-creator` 目录已在 `userData/SKILLs/` | 启动检测到 `kits_installed['ai-skin-designer']` 存在，原地刷新为 `resources/skin-pack/skin-creator/` 最新版并保持启用；未安装过 Kit 的老用户则自动清理旧副本 |
| 企业在 `enterpriseConfigSync` 中使用 `overwrite` 模式清空 `userData/SKILLs` | 因核心 9 个内置技能只读挂载在 `Resources/SKILLs/`，企业覆盖用户目录不会误删核心内置技能 |
| 某核心内置技能同时出现在市场接口中 | `getSkillInstallStatus()` 与 `updatableSkills` 增加 `if (installed.isBuiltIn) return 'installed'` 保护，不触发市场覆盖升级 |
| 用户在受限专家（如仅绑定 `['docx']`）或 Plan Mode 下对话 | DSH 的 `allowedSkillIds` 仍按原规则裁剪，不会因核心技能全局不可关闭而泄漏到受限专家或规划模式 |
| 用户通过 `skills:setEnabled` IPC 或脚本直接传入 `{ id: 'docx', enabled: false }` | 后端 `SkillManager.setSkillEnabled` 明确拒绝抛错，保证无法绕过 UI 关闭 |

---

## 6. 涉及文件与实施阶段

### 阶段 1: 基础设施、只读加载与邮箱凭据迁出
- `SKILLs/skills.config.json` — 精简为 9 项，补充 `alwaysEnabled: true`
- `SKILLs/skill-creator/SKILL.md` — 添加 `disable-model-invocation: true`
- `SKILLs/lobsterai-image-processing/SKILL.md` — 添加 `user-invocable: false`
- `SKILLs/imap-smtp-email/SKILL.md` — 更新凭据托管说明
- 移除 10 个迁出技能目录：`SKILLs/{article-writer,content-planner,daily-trending,stock-analyzer,stock-announcements,stock-explorer,remotion,local-tools,weather,youdaonote}/`
- 迁移 `SKILLs/skin-creator/` → `resources/skin-pack/skin-creator/`
- `src/shared/skills/constants.ts` — 共享常量（目录名、保留技能配置类型等）
- `src/shared/contextCleanup/constants.ts` — 对齐不可关闭核心技能定义
- `src/main/skills/skillManager.ts` — 只读加载、保留 ID 防护、强制启用闭环、邮箱凭据迁出与旧副本清理、frontmatter 调用策略解析、`hasEnabledEmailAccount()`
- `src/main/skins/skinPackKitLifecycle.ts` — 改造为 `resources/skin-pack/skin-creator/` 按需释放/刷新/卸载
- `src/main/ipcHandlers/kits/handlers.ts` — 安装远端 Kit 技能时避开核心内置保留 ID
- `src/main/libs/dataMigration/archiveWhitelist.ts` — 新增 `'email-skill'` 白名单
- `electron-builder.json` — mac & win `extraResources` 新增 `resources/skin-pack`

### 阶段 2: DSH 运行时对接与调用策略透传
- `dsh-bundles/lobsterai-host/plugins/shared-state.mjs` — `skillsPolicy` 新增 `bundledDir`、`bundledIds`、`modelHiddenIds`
- `dsh-bundles/lobsterai-host/plugins/ops-rpc.mjs` — `syncSkillsPolicy` 接收并应用新字段
- `dsh-bundles/lobsterai-host/plugins/persona-helpers.mjs` — 只读内置优先发现 + `disable-model-invocation` / `user-invocable` / `modelHiddenIds` / `selectedSkillIds` 放行逻辑
- `dsh-bundles/lobsterai-host/plugins/persona-scope.mjs` — 透传 `selectedSkillIds` 与 `bundledDir`
- `src/main/libs/dsh/dshHostManager.ts` & `dshBootstrap.ts` — 注入 `EMAIL_ACCOUNTS_PATH` / `EMAIL_ENV_PATH`、扩展 `syncSkillsPolicy` 类型
- `src/main/libs/agentEngine/dshRuntimeAdapter.ts` — 每轮透传 `selectedSkillIds`
- `src/main/main.ts` — 组装 `bundledDir` / `bundledIds` / `modelHiddenIds`，邮箱账号变更时触发 `syncSkillsPolicy()`

### 阶段 3: 前端 UI、上下文清理与专家广场补齐
- `src/renderer/types/skill.ts` & `src/renderer/types/electron.d.ts` — 同步 `canDisable`、`modelInvocable`、`userInvocable`
- `src/renderer/components/skills/bundledSkillNames.ts` — 10 个迁出技能移入 `LEGACY_BUNDLED_SKILL_DISPLAY_NAMES`
- `src/renderer/components/skills/SkillsManager.tsx` — 不可关闭技能隐藏开关/删除、展示「始终启用」标签、补齐 `isBuiltIn` 版本对比保护
- `src/renderer/components/skills/SkillsPopover.tsx` — 过滤 `userInvocable === false`
- `src/renderer/App.tsx` — `handleCreateSkillByChat` 预选 `skill-creator`
- `src/main/contextCleanup/contextCleanupService.ts` — 跳过 `canDisable === false` 技能
- `src/shared/homeShowcase/catalogs/docCatalog.ts` — 调整 `doc-article-writer` 的 `skillId`
- `src/renderer/services/expertSkillInstaller.ts`（新增）+ 专家广场安装链路 + `src/renderer/components/agent/AgentSettingsPanel.tsx` / `AgentSkillSelector.tsx` — 缺失技能非阻塞补齐与专家设置缺失态展示
- `src/renderer/services/i18n.ts` & `src/main/i18n.ts` — 补齐「始终启用」、专家缺失技能补齐等中英文文案

### 阶段 4: 市场端协同与测试更新
- **外部市场前置上线**：将 10 个迁出技能以原目录 ID 打包上传至官方不可变 CDN 并上架 Overmind 技能市场（带语义化 `version` 与必要依赖）
- **单测更新与补充**：
  - `src/main/skills/skillManager.bundledSync.test.ts` & `skillManager.listSkills.test.ts` & `skillManager.install.test.ts`
  - `src/main/ipcHandlers/skills/handlers.test.ts`（覆盖官方市场信任目录免扫描 vs 第三方/自导入强制扫描）
  - `src/main/contextCleanup/contextCleanupService.test.ts`
  - `tests/dshPersonaHelpers.test.ts` & `src/main/libs/dsh/dshHostManager.test.ts`
  - `src/main/libs/dataMigration/dataMigrationService.test.ts`
  - `src/renderer/components/skills/bundledSkillNames.test.ts`
  - `tests/electronBuilderAppFiles.test.ts`

---

## 7. 验收标准

1. **新装洁净度**：全新安装后 `<userData>/SKILLs/` 为空；「内置技能」Tab 显示 9 个核心内置技能，均无开关与删除按钮、显示「始终启用」只读标签。
2. **不可关闭强约束**：通过 UI、IPC（`skills:setEnabled`）、批量接口（`setSkillsEnabledBatch`）及「上下文清理」均无法关闭 9 个核心内置技能；历史数据库含 `{ enabled: false }` 时重启自动恢复开启且 `WebSearchHost` 正常工作。
3. **只读保护**：外部导入名为 `docx` 的技能自动安装为 `docx-1`；手工在 `userData/SKILLs/docx` 建目录不影响只读内置加载。
4. **调用策略生效**：
   - 普通对话中 `<available_skills>` 不包含 `web-search`、`skill-creator`，未配邮箱时不包含 `imap-smtp-email`；
   - 输入框选择器不显示 `lobsterai-image-processing`，但图片去水印/抠图自动命中；
   - 点击「通过对话创建」可正常加载并执行 `skill-creator`；
   - 在「设置 > 邮箱」添加并启用邮箱后，`imap-smtp-email` 立即对模型可见并可收发邮件，重启后凭据持久化在 `<userData>/email-skill/`。
5. **`skin-creator` Kit 化**：未安装外观定制 Kit 时不可见；安装后可用、卸载后彻底清理；已安装老用户升级无感保留并刷新到最新模板。
6. **老用户零破坏兼容**：
   - 老用户本地 10 个迁出技能全部留在「我的技能」，保留原启停状态与离线中文名，可自由开关、卸载及一键升级到市场正式版；
   - 老用户 `imap-smtp-email/accounts.json` 无损迁入 `<userData>/email-skill/`，旧的 9 个核心内置副本被清理释放空间；
   - 备份恢复（含旧版备份恢复到新版）邮箱配置与用户技能均完好。
7. **专家广场补齐**：新用户安装引用市场技能的预设专家时不阻塞创建，联网时自动补齐缺失技能（遇风险弹安全确认），离线或未匹配时在专家设置页清晰可见并支持重试。
8. **构建与自动化门禁**：相关 Vitest 用例全部通过，`npx tsc`、`npm run compile:electron`、改动文件 ESLint 零告警、`npm run dsh:upgrade-check` 及 `npm run electron:dev:dsh` 端到端验证通过。
