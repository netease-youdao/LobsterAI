# DSH 引擎数据备份与迁移设计文档

## 1. 概述

### 1.1 问题/背景

LobsterAI 已从 OpenClaw 一次性切换至 DeepSeek Harness（DSH）作为唯一 Agent 引擎，但设置页“备份与迁移”模块仍存在以下历史遗留与结构性问题，导致该入口此前被暂时禁用：

1. **残留 OpenClaw 耦合**：文案、Manifest 逻辑仍兼容旧版 OpenClaw v1 备份并在恢复后触发 6 步离线迁移；同时升级迁移为保留历史媒体路径而留在磁盘上的 `userData/openclaw/state/` 未被排除，导致 DSH 备份包体积虚高。
2. **黑名单模式失控**：按黑名单排除 `userData` 容易遗漏新功能产生的缓存、日志和本机运行态（如 `external-browser/`、`Partitions/`、`dsh-profile/logs`、`dsh-profile/dsh-launcher`、`image-thumbnails/`、`library/thumbnails/`、`word-fonts/`、`mcp-bridge/bin`、`dsh-generated-mcp/` 等）。
3. **SQLite 校验表名错误且覆盖不全**：`SQLITE_MIGRATION_TABLES` 将定时任务表误写为 `scheduled_tasks` / `scheduled_task_runs`（实际为 `lobster_scheduled_tasks` / `lobster_scheduled_task_runs`），且漏检 `cowork_session_capsules`、`cowork_message_versions`、`cowork_message_edits`、`library_*`、`browser_credentials` 等现役表。
4. **活体写入竞态**：备份前仅检查活跃 Cowork 会话，未检查正在执行的 `LobsterScheduler` 定时任务；备份后拿快照/staging 反比正在运行的活库与活目录，极易因后台写入触发 checksum mismatch。
5. **跨机恢复存在隐性破坏**：
   - `browser_credentials` 与 `mcp_oauth_token:*` 使用系统钥匙串（`safeStorage`）加密，跨机无法解密；且 `BrowserCredentialService` 单条解密失败会误将整台新设备标记为 `EncryptionUnavailable`。
   - 源机 `dsh_cached_shell_path_v1`、`mcp_launch_resolutions`、失效默认工作目录未清理或回退。
   - 路径重写仅覆盖 `cowork_messages.metadata` 的 6 个目录，漏掉了 `library_local_artifacts`、`library_manual_sources`、`cowork_message_versions`、`cowork_message_edits` 及 `browser-annotation-assets` / `qq-media` / Office `*-drafts`。
   - 第三方 DSH 插件因 `node_modules` 不进备份包而在跨机恢复后静默失效，用户无感知且无一键恢复入口。
6. **同步阻塞与交互缺失**：全程同步打包/哈希且反复全量解压，大数据量会卡死主进程并消耗多倍磁盘空间；回滚包只增不删；导入前无摘要预览，恢复后缺少结构化指引。

### 1.2 目标

- **彻底去 OpenClaw 化**：只支持 DSH 引擎数据备份与恢复（Manifest v3，兼容已有 DSH v2 备份），彻底丢弃 `openclaw/`，遇到旧版 OpenClaw v1 备份包给出清晰拦截提示。
- **白名单声明式备份**：由单一白名单定义全部用户资产范围，精准备份、精准清理替换、回滚包自动轮转。
- **跨机确定性与零静默破坏**：同机恢复完整保留本地加密数据；跨机恢复自动重写全量受管路径、清理不可解密密文与源机环境缓存、回退失效默认工作目录，并在重启后展示结构化摘要报告与第三方 DSH 插件“一键重装”。
- **一键备份、异步流式与可预览**：统一采用标准 `.tar.gz` 归档（不增加密码加密/不加密分叉，避免忘记口令导致本地备份不可逆丢失，同时在备份保存提示中明确告知妥善保管）；全异步流式处理与实时阶段进度、磁盘余量预检、导入前摘要预览。
- **模块化拆分**：将逻辑从 `main.ts`、`Settings.tsx` 与 `dataMigrationService.ts` 拆分为职责清晰、可单测的独立模块，并重新开放设置页入口。

---

## 2. 用户场景

### 场景 1：一键导出 DSH 数据备份
**Given** 用户在设置页点击“备份数据”，当前无运行中的对话或定时任务。
**When** 用户直接选择导出保存路径（`.tar.gz`）并确认。
**Then** 应用预检磁盘空间，以异步流式方式快照 SQLite 并按白名单打包归档、单遍流式校验完整性，实时展示进度；完成后提示保存路径、体积、敏感文件保管提醒及“在文件夹中显示”。

### 场景 2：跨机导入 DSH 备份并查看恢复报告
**Given** 用户在新电脑上拿到原设备导出的 DSH 备份文件（`.tar.gz` / `.tgz`）。
**When** 用户点击“导入备份”并选择文件，在摘要预览弹窗中确认时间、源系统、会话/Agent/定时任务/技能/插件统计后点击确认导入。
**Then** 应用关闭渲染窗、展示独立恢复进度窗、停止 DSH 与定时任务并释放数据库句柄、生成白名单回滚点、单次解压校验、执行全量路径重写与跨机状态修正、原子替换并自动重启；重启后展示恢复结果卡片，列出需重新授权的远程 MCP、已清理的不可解密浏览器凭据、失效工作目录提醒，以及缺失第三方 DSH 插件的“一键重装”按钮。

### 场景 3：误选旧版 OpenClaw 备份包
**Given** 用户选择了一份由旧版 OpenClaw 引擎导出的 Manifest v1 备份包。
**When** 应用在预览阶段流式读取 `.lobsterai-migration.json`。
**Then** 不关闭应用、不修改当前数据，直接返回结构化错误并提示用户“该备份来自旧版 OpenClaw 引擎，请先在原设备升级至新版 LobsterAI 完成数据迁移后再重新导出备份”。

### 场景 4：导入中途异常自动回滚
**Given** 备份文件损坏、校验失败或磁盘写入异常。
**When** 恢复流程在触及目标目录后抛出异常。
**Then** 自动从本次恢复前生成的回滚包还原白名单内全部用户数据，记录失败原因并重启提示用户。

---

## 3. 功能需求

### FR-1（P0）：去 OpenClaw 化与 Manifest v3 规范
- Manifest 升级至 `version: 3`，增加 `engine: 'dsh'`、`appVersion`、`stats`、`whitelistPaths`；保留 `sourceUserDataPath`、`platform`、`arch`、`sqlite`、`dshState`。
- 兼容导入现有 DSH `version: 2` 归档（要求含 `dshState`）；拒绝 `version: 1` 并返回错误码 `legacy_openclaw_unsupported`。
- 彻底丢弃 `openclaw/` 目录，不再打包、不再校验、不再调用 `runLegacyOpenClawMigration`。
- 更新中/英文文案，移除所有“OpenClaw 状态”表述。

### FR-2（P0）：全表 SQLite 完整性校验与竞态消除
- 动态扫描 `sqlite_master` 全部应用表（排除 `sqlite_%` 与瞬态表 `mcp_launch_resolutions`），计算每张表的行数与内容 SHA-256（覆盖 `lobster_scheduled_tasks`、`lobster_scheduled_task_runs`、`cowork_session_capsules`、`cowork_message_versions`、`cowork_message_edits`、`library_*`、`browser_credentials` 等）。
- 关键 KV 校验替换为 DSH 现役键：`auth_tokens`、`auth_user`、`app_config`、`skills_state`、`dsh_permission_preset`、`installation_uuid`。
- 备份前门禁同时检查 `coworkEngineRouter.getActiveSessionIds()` 与 `LobsterScheduler.hasRunningTasks()`。
- 移除备份期易受后台写入干扰的 live DB / live dir 反比校验，改为校验快照与 staging 自身完整性并在恢复后双向核对。

### FR-3（P0）：跨机凭据安全降级、状态清理与全量路径重写
- 修复 `BrowserCredentialService`：`decryptString` 单条解密失败抛出凭据不可解密错误，不得将全局可用状态覆写为 `EncryptionUnavailable`。
- 恢复后通过当前设备 `safeStorage` 探测：
  - 同机恢复：全部保留。
  - 跨机恢复：清理无法解密的 `browser_credentials` 行与 `kv` 中 `mcp_oauth_token:*` 的 `safe:` 条目，并将受影响项写入恢复报告 `notices`。
- 恢复后清理 `kv` 中 `dsh_cached_shell_path_v1` 并清空 `mcp_launch_resolutions` 全表。
- 路径重写覆盖全部托管子目录（`cowork-image-originals`、`generated-images`、`generated-videos`、`workspaces`、`SKILLs`、`image-editing`、`browser-annotation-assets`、`qq-media`、以及 `OFFICE_EDITORS` 派生的 `*-drafts`），并覆盖 `cowork_messages.metadata`、`cowork_message_versions.snapshot_json`、`cowork_message_edits.{operation_json,snapshot_json}`、`library_local_artifacts.{file_path,path_key}`、`library_manual_sources.{file_path,path_key}`。
- 若 `cowork_config.workingDirectory` 在目标机不存在，自动回退为目标机默认目录并在报告中告知；`agents.working_directory` 与 `lobster_scheduled_tasks` 中不存在的路径在报告中列出提醒。
- 检测 `dsh-profile/profiles/lobsterai/package.json` 中非托管第三方 DSH 插件缺失 `node_modules` 的条目，写入恢复报告并提供“一键重装”。

### FR-4（P1）：白名单声明式备份与回滚点轮转
- 以 `archiveWhitelist.ts` 作为唯一数据源声明纳入备份与恢复替换的路径：
  - `lobsterai.sqlite`（在线快照）
  - `dsh-profile/sessions`
  - `dsh-profile/credentials`
  - `dsh-profile/agents-home`
  - `dsh-profile/cordis.patch.yml`
  - `dsh-profile/profiles/lobsterai/{package.json,pnpm-workspace.yaml,pnpm-lock.yaml,cordis.patch.yml}`
  - `workspaces`（排除 `memory-fts.sqlite*`）
  - `SKILLs`、`skins`
  - `cowork-image-originals`、`generated-images`、`generated-videos`、`image-editing`、`browser-annotation-assets`、`qq-media`、Office `*-drafts`
  - `auth`、`codex`
- 恢复时仅清空并替换白名单条目，不动目标机其余目录（Electron 缓存、`external-browser/`、`Partitions/`、`runtimes/`、`updates/`、`logs/` 等）。
- 回滚目录 `appData/LobsterAI-migration-rollbacks` 自动按时间保留最近 2 份，超额自动删除。

### FR-5（P2）：异步流式、磁盘预检与预览/报告 UI
- **异步流式与进度**：备份打包、归档完整性流式校验、恢复解压改为异步流式执行并推送阶段进度（`DataMigrationIpc.Progress`），消除主进程阻塞与冗余二次全量解压。
- **磁盘预检**：备份与恢复前调用 `fs.promises.statfs` 检查目标卷和临时目录余量，不足时提前中断并报告所需/可用空间。
- **单一简洁格式决策**：统一导出标准 `.tar.gz` 备份包，不提供口令加密开关，避免用户设置一次性口令遗忘后造成不可逆的数据丢失；系统钥匙串级凭据（`browser_credentials`、`mcp_oauth_token:*`）天然受 `safeStorage` 设备绑定保护，同时在保存完成卡片提示用户妥善保管备份文件、避免公开分享。
- **预览与报告 UI**：
  - 导入选包后先流式读取 Manifest 展示摘要预览弹窗，确认后再关窗执行恢复。
  - 恢复重启后展示结构化恢复结果卡片（回滚包路径、重置的工作目录、失效工作目录提醒、需重授权 MCP、已清理浏览器凭据数、缺失第三方 DSH 插件及“一键重装”按钮）。

---

## 4. 实现方案

### 4.1 模块拆分架构

为避免继续膨胀 `main.ts`、`Settings.tsx` 与 `dataMigrationService.ts`，拆分为如下独立模块：

- **共享契约** `src/shared/dataMigration/constants.ts`
  - IPC 通道常量 `DataMigrationIpc`（`Backup`、`PickRestoreArchive`、`Preview`、`Restore`、`GetLastRestoreResult`、`Progress`、`ReinstallPlugins`）
  - 错误码 `DataMigrationErrorCode`、阶段常量 `DataMigrationProgressPhase`、恢复报告与预览类型定义。
- **主进程核心库** `src/main/libs/dataMigration/`
  - `dataMigrationError.ts`：结构化错误类型 `DataMigrationError` 与类型守卫。
  - `archiveWhitelist.ts`：白名单声明、目录收集、定点清理与回滚轮转。
  - `sqliteMigrationSnapshot.ts`：SQLite 在线快照、WAL checkpoint、动态全表摘要与校验。
  - `archiveManifest.ts`：Manifest v3 生成、v2/v3 校验、v1 拦截、流式提取 Manifest（不落盘全量解压）。
  - `rewriteRestoredUserDataPaths.ts`：扩展为覆盖全托管子目录及 5 张 SQLite 表的路径重写器。
  - `postRestoreSanitizer.ts`：跨机 `safeStorage` 探测清理、`dsh_cached_shell_path_v1` / `mcp_launch_resolutions` 清理、工作目录回退与检测、缺失第三方 DSH 插件扫描。
  - `dataMigrationService.ts`：异步/同步编排入口（含磁盘空间预检、进度回调、失败自动回滚）。
- **主进程 IPC 与进度窗** `src/main/ipcHandlers/dataMigration/`
  - `restoreProgressWindow.ts`：独立恢复进度窗管理（支持动态阶段文本更新）与渲染窗释放。
  - `handlers.ts` + `index.ts`：`registerDataMigrationHandlers(deps)`，处理一键备份、选文件、流式预览、恢复调度、消费恢复报告、第三方插件一键重装。
- **渲染进程服务与 UI**
  - `src/renderer/services/dataMigration.ts`：封装 `window.electron.openclaw.dataMigration.*` 调用与错误码/阶段文案映射。
  - `src/renderer/components/settings/useDataMigration.ts`：独立 Hook 管理备份、预览、导入、进度、恢复结果与插件重装状态。
  - `src/renderer/components/settings/DataMigrationDialogs.tsx`：导入前摘要预览弹窗与阻塞阶段进度遮罩。
  - `src/renderer/components/settings/DataMigrationRestoreReportCard.tsx`：恢复后结构化报告卡片（含一键重装第三方插件）。

### 4.2 第三方 DSH 插件一键重装流程

1. 恢复阶段 `postRestoreSanitizer.ts` 调用 `readInstalledProfilePlugins(profileDir)` 筛选 `managed === false` 的插件，检查 `<profileDir>/node_modules/<name>` 是否存在；不存在则记入 `notices.missingDshPlugins`（含 `name`、`specifier`、`enabled`）。
2. 重启后用户可在恢复结果卡片点击“一键重装”。
3. IPC `DataMigrationIpc.ReinstallPlugins` 逐个校验 `specifier`（跳过指向源机绝对本地路径且不存在的 `file:`/`link:` 项并提示），调用现有 `runDshPluginCommand(..., args: ['add', spec])`，完成后执行 `ensureProfileIntegrity()` 并按原启用状态恢复 `dsh.profile.bundles`，最后重启 DSH host。

---

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 导入旧版 OpenClaw v1 备份 | 预览/检验阶段识别 `version === 1`，返回 `legacy_openclaw_unsupported`，提示先升级原机再重新备份 |
| 导入早期 DSH v2 备份（含多余旧目录） | 兼容导入：仅按当前白名单提取并恢复受管目录，自动忽略包内多余旧缓存与 `openclaw/` |
| 同机恢复（未换机/回滚重导） | `safeStorage` 探针解密全部成功，保留全部浏览器密码与 MCP OAuth Token，不误删 |
| 跨机/跨 OS 恢复（macOS ↔ Windows） | 路径重写按目标平台风格规范化路径与 `file://` URL；清理不可解密 `safeStorage` 条目；清理 `dsh_cached_shell_path_v1` 与 `mcp_launch_resolutions`；失效默认工作目录自动回退 |
| 备份期间存在活跃会话或运行中定时任务 | 门禁拦截并提示停止任务后再备份 |
| 目标盘或临时目录空间不足 | `statfs` 预检失败，提前中止并展示所需空间与可用空间 |
| 恢复中途 I/O 或校验失败 | 自动从本次恢复前生成的回滚包还原全部白名单目标并报告错误 |
| 第三方插件指向源机本地路径（`file:/Users/a/plugin`） | 一键重装前检测本地路径不存在，跳过该项并在结果中说明需手动安装 |
| `library_local_artifacts` 路径重写后与已有 `path_key` 冲突 | 在事务内安全跳过/合并，不违反 `UNIQUE` 约束 |

---

## 6. 涉及文件

- `src/shared/dataMigration/constants.ts`
- `src/main/browserCredentials/browserCredentialService.ts`
- `src/main/scheduledTask/lobsterScheduler.ts`
- `src/main/libs/dataMigration/dataMigrationError.ts`（新增）
- `src/main/libs/dataMigration/archiveWhitelist.ts`（新增）
- `src/main/libs/dataMigration/sqliteMigrationSnapshot.ts`（新增）
- `src/main/libs/dataMigration/archiveManifest.ts`（新增）
- `src/main/libs/dataMigration/postRestoreSanitizer.ts`（新增）
- `src/main/libs/dataMigration/rewriteRestoredUserDataPaths.ts`
- `src/main/libs/dataMigration/dataMigrationService.ts`
- `src/main/ipcHandlers/dataMigration/restoreProgressWindow.ts`（新增）
- `src/main/ipcHandlers/dataMigration/handlers.ts`（新增）
- `src/main/ipcHandlers/dataMigration/index.ts`（新增）
- `src/main/main.ts`、`src/main/preload.ts`、`src/main/i18n.ts`
- `src/renderer/types/electron.d.ts`
- `src/renderer/services/dataMigration.ts`（新增）
- `src/renderer/services/i18n.ts`
- `src/renderer/components/settings/useDataMigration.ts`（新增）
- `src/renderer/components/settings/DataMigrationDialogs.tsx`（新增）
- `src/renderer/components/settings/DataMigrationRestoreReportCard.tsx`（新增）
- `src/renderer/components/settings/DataPrivacySettingsSection.tsx`
- `src/renderer/components/settings/ManualDataMigrationAction.tsx`
- `src/renderer/components/Settings.tsx`
- 配套测试：`src/main/libs/dataMigration/*.test.ts`、`src/main/ipcHandlers/dataMigration/handlers.test.ts`、`src/renderer/services/dataMigration.test.ts`、`src/main/browserCredentials/browserCredentialService.test.ts`

---

## 7. 验收标准

1. **白名单与去 OpenClaw**：导出包不含 `openclaw/`、`external-browser/`、`Partitions/`、`dsh-profile/{logs,bin,cache,dsh-launcher,dsh.log,loopback-state.json,clean-shutdown.json,llm-deepseek,profiles/lobsterai/node_modules}` 及各类缓存；导入 v1 备份给出明确拒绝与升级提示。
2. **数据完整与零竞态**：`lobster_scheduled_tasks`、`lobster_scheduled_task_runs` 与全部现役 SQLite 表均参与完整性校验；活跃对话或运行中定时任务时正确拦阻备份。
3. **跨机恢复闭环**：跨机导入后媒体/知识库/消息版本路径全部可用；`safeStorage` 不可解密项被安全清理且不破坏新设备 `BrowserCredentialService`；`dsh_cached_shell_path_v1` 清除；失效默认工作目录自动回退；缺失第三方 DSH 插件在恢复结果卡片展示并支持一键重装。
4. **性能与体验**：点击备份直接导出 `.tar.gz`，异步流式备份/恢复带进度反馈与磁盘余量检查，回滚包自动保留最近 2 份；导入前展示摘要预览，重启后展示结构化恢复报告。
5. **工程门禁**：相关 Vitest 测试全绿，`npm run compile:electron`、`npx tsc` 以及变更文件 ESLint（`--max-warnings 0`）全部通过。
