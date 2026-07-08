# IMAP/SMTP 邮箱 Skill 多账号设计文档

## 1. 概述

### 1.1 问题/背景

LobsterAI 设置页中的“邮箱”当前对应内置 Skill
`imap-smtp-email`，不是 IM 设置里的第三方 `@clawemail/email` 通道。

当前实现是单账号模型：

- Renderer 的 `EmailSkillConfig.tsx` 只编辑一组全局 `IMAP_*` 和
  `SMTP_*` 字段。
- Main process 的 `SkillManager.getSkillConfig()` /
  `setSkillConfig()` 直接读写 `SKILLs/imap-smtp-email/.env`。
- `SKILLs/imap-smtp-email/scripts/imap.js` 和 `smtp.js` 启动时只从同一个
  `.env` 加载配置。

这导致用户只能配置一个邮箱账号。Agent 读信、搜信、下载附件、发信都只能使用
这一组默认凭据，无法覆盖常见的工作/个人/团队邮箱并存场景。

此外，该 Skill 的公开上游未能从 npm/GitHub 精确定位到：

- `imap-smtp-email-skill` 不存在公开 npm 包。
- 本地 `package.json` 没有 `repository` 或 `homepage`。
- Git 历史显示它随 `Initial open-source release` 一次性进入仓库，后续修改为
  LobsterAI 侧本地修复。

因此本需求不按“同步上游版本”处理，而是作为 LobsterAI 内置邮箱 Skill 的自主
演进。

### 1.2 目标

1. 将设置页邮箱配置从“单个 `.env` 表单”升级为“邮箱账号管理器”。
2. 支持多个 IMAP/SMTP 邮箱账号，包括添加、删除、启用、默认账号和连通性测试。
3. 保持现有单账号 `.env` 配置的自动迁移和向后兼容。
4. 让 Skill 脚本支持按账号执行：读信、搜信、下载附件、标记已读/未读、发信。
5. 为 Agent 提供清晰的使用规则：默认账号、指定账号、聚合查询，以及发信确认策略。
6. 保持第一阶段聚焦通用 IMAP/SMTP，不引入 Gmail/Outlook OAuth。

### 1.3 非目标

- 不处理 IM 设置里的 `@clawemail/email` 第三方通道。
- 不把 `imap-smtp-email` 改造成 OpenClaw channel。
- 不在第一阶段实现 Gmail/Outlook OAuth、Gmail API 或 Microsoft Graph。
- 不实现后台实时邮件监听、邮件触发任务、统一收件箱 UI 或邮件会话线程 UI。
- 不替换整个 Skill 系统的配置存储模型。

## 2. 用户场景

### 场景 1：配置多个邮箱账号

**Given** 用户同时有工作邮箱和个人邮箱
**When** 用户打开设置页的邮箱配置
**Then** 可以添加两个账号，分别填写服务商、邮箱地址、授权码、IMAP/SMTP 服务器
和默认收件箱。

### 场景 2：选择默认账号

**Given** 用户配置了多个邮箱账号
**When** 用户把工作邮箱设为默认账号
**Then** Agent 在没有明确指定账号时使用工作邮箱执行读信和发信。

### 场景 3：按账号读信

**Given** 用户配置了 `work` 和 `personal` 两个账号
**When** 用户要求“查一下个人邮箱最近 10 封邮件”
**Then** Agent 应使用 `personal` 账号执行 `imap.js check --account personal --limit 10`。

### 场景 4：聚合查询多个账号

**Given** 多个账号已启用
**When** 用户要求“查一下所有邮箱今天有没有面试相关邮件”
**Then** Agent 可使用 `--all-accounts` 聚合查询，结果中必须带账号标识，避免用户
不知道邮件来自哪个邮箱。

### 场景 5：发信前确认

**Given** Agent 根据用户请求准备发送邮件
**When** 目标账号配置要求发信确认
**Then** Agent 应先展示收件人、主题、发件账号和正文摘要，等待用户确认后再发送。

### 场景 6：旧用户升级

**Given** 用户已有旧版 `.env`，其中包含 `IMAP_USER` / `SMTP_USER`
**When** 用户升级到新版本并打开邮箱设置
**Then** 旧配置自动迁移为一个默认账号，原有连接测试和脚本命令继续可用。

## 3. 功能需求

### FR-1：多账号配置模型

新增邮箱账号配置模型，至少包含：

- `id`：稳定账号 ID，用于脚本参数和配置引用。
- `name`：用户可见名称，例如“工作邮箱”。
- `enabled`：是否启用。
- `isDefault` 或全局 `defaultAccountId`。
- `provider`：预设服务商或 `custom`。
- `email`：邮箱地址。
- `password`：密码或授权码。
- `imapHost` / `imapPort` / `imapTls` / `imapRejectUnauthorized`。
- `smtpHost` / `smtpPort` / `smtpSecure` / `smtpRejectUnauthorized`。
- `smtpFrom`：默认发件人，可默认等于邮箱地址。
- `mailbox`：默认收件箱，默认 `INBOX`。
- `requireSendConfirmation`：发信前是否要求确认，默认开启。

### FR-2：设置页账号管理器

`EmailSkillConfig.tsx` 从单表单改为账号列表 + 账号详情：

- 左侧或顶部显示账号列表。
- 支持添加账号、删除账号、启用/停用账号、设置默认账号。
- 详情区沿用现有服务商预设、基础字段、密码显示/隐藏、高级配置和连接测试。
- 账号卡片展示连接状态：未测试、测试通过、测试失败。
- 删除默认账号时，需要自动选择另一个启用账号为默认，或要求用户确认无默认账号状态。

### FR-3：旧配置迁移

读取配置时支持旧 `.env`：

- 如果存在旧的 `IMAP_USER` / `SMTP_USER`，且没有新多账号配置，则生成一个账号。
- 账号 ID 可由邮箱前缀稳定生成，例如 `default` 或 `account-1`。
- 迁移后保留旧 `.env` 字段用于一次性兼容，但新保存应写入新配置格式。
- 迁移不应丢失密码、服务器、端口、TLS、默认邮箱夹等字段。

### FR-4：脚本按账号执行

`imap.js` 和 `smtp.js` 支持账号选择：

```bash
node scripts/imap.js check --account work --limit 10
node scripts/imap.js search --account personal --from boss@example.com
node scripts/imap.js fetch --account work <uid>
node scripts/smtp.js send --account work --to a@example.com --subject "Hello" --body "..."
```

规则：

- 未传 `--account` 时使用默认账号。
- 传入未知账号时返回清晰错误和可用账号列表。
- 禁用账号不能被默认使用；显式使用禁用账号时返回错误。
- 查询类命令支持 `--all-accounts`。

### FR-5：聚合输出格式

`--all-accounts` 的结果必须是结构化 JSON，并在每条邮件或每个账号结果中包含：

- `accountId`
- `accountName`
- `email`
- 原有邮件字段
- 单账号失败时的错误信息

聚合查询应允许部分账号失败。整体返回中要区分：

- 所有账号成功。
- 部分账号成功、部分失败。
- 所有账号失败。

### FR-6：连接测试

连接测试从单账号扩展为：

- 单个账号测试：IMAP list-mailboxes + SMTP verify。
- 全部账号测试：串行或有限并发测试，显示每个账号结果。
- 测试时不发送真实测试邮件，继续使用 SMTP verify。

### FR-7：Agent 使用说明更新

更新 `SKILL.md`：

- 说明配置由 LobsterAI 设置页管理，不要求用户编辑配置文件。
- 说明多账号命令参数：`--account`、`--all-accounts`。
- 说明默认账号规则。
- 明确发信安全策略：除非用户明确要求并确认，否则不要静默发邮件。
- 示例覆盖读信、搜索、下载附件、发信和跨账号查询。

### FR-8：依赖升级策略

第一阶段不强制重写底层协议库，但允许安全升级：

- 可升级 `dotenv`、`mailparser` 等 patch/minor 依赖。
- `nodemailer` 主版本升级需要单独验证 SMTP 行为。
- `imap` 已长期不更新，第一阶段可以保留；后续单独评估迁移到 `imapflow`。
- 移除未使用依赖前需要确认脚本没有间接引用。

## 4. 方案设计

### 4.1 配置存储

推荐新增独立配置文件：

```text
SKILLs/imap-smtp-email/accounts.json
```

示例：

```json
{
  "version": 1,
  "defaultAccountId": "work",
  "accounts": [
    {
      "id": "work",
      "name": "工作邮箱",
      "enabled": true,
      "provider": "163",
      "email": "user@163.com",
      "password": "...",
      "imapHost": "imap.163.com",
      "imapPort": 993,
      "imapTls": true,
      "imapRejectUnauthorized": true,
      "smtpHost": "smtp.163.com",
      "smtpPort": 465,
      "smtpSecure": true,
      "smtpRejectUnauthorized": true,
      "smtpFrom": "user@163.com",
      "mailbox": "INBOX",
      "requireSendConfirmation": true
    }
  ]
}
```

理由：

- 不把多账号结构塞进平铺 `.env`。
- 脚本可以直接读取结构化配置，减少环境变量命名复杂度。
- 旧 `.env` 仍可作为兼容输入和迁移来源。

注意：该文件包含敏感信息。保存、升级、打包、分享时必须继续按照 `.env` 级别保护，
不得被 artifact 分享或日志输出。

### 4.2 Main Process 配置 API

新增或扩展 Skill 配置 API：

- `getEmailSkillAccountsConfig(skillId)`：返回多账号配置，必要时从旧 `.env` 迁移。
- `setEmailSkillAccountsConfig(skillId, config)`：写入 `accounts.json`。
- `testEmailAccountConnectivity(skillId, accountId, configOverride?)`：测试单账号。
- `testAllEmailAccountsConnectivity(skillId, configOverride?)`：测试全部账号。

保留现有 `getSkillConfig/setSkillConfig/testEmailConnectivity`，用于旧 UI 或迁移期兼容。

### 4.3 脚本配置解析

新增公共 helper，例如：

```text
SKILLs/imap-smtp-email/scripts/config.js
```

职责：

1. 读取 `accounts.json`。
2. 如果不存在，则读取旧 `.env` 并返回一个 legacy default account。
3. 根据 `--account` 解析目标账号。
4. 为 `--all-accounts` 返回启用账号列表。
5. 输出安全的配置摘要用于 debug，不能包含密码。

`imap.js` 和 `smtp.js` 不再各自直接拼装 `process.env`，而是调用该 helper。

### 4.4 UI 设计

设置页保持工作型界面，不做营销式页面：

- 账号列表使用紧凑行或列表项。
- 账号详情使用表单分区：基础信息、登录凭据、服务器设置、高级选项。
- 服务商预设沿用现有 Gmail、Outlook、163、126、QQ、自定义。
- 操作用图标按钮：添加、删除、测试、设为默认、显示密码。
- 连接测试结果内联展示，并提供“AI 诊断”入口。

第一阶段不做统一收件箱预览，不显示邮件内容。

### 4.5 发信确认策略

由于邮件发送是外部副作用，默认安全策略应偏保守：

- `requireSendConfirmation` 默认 `true`。
- `smtp.js send` 可接受 `--confirmed`，由 Agent 在用户确认后使用。
- 如果账号要求确认但未传 `--confirmed`，脚本返回结构化错误，提示需要确认。
- 如果未来存在自动化/定时任务需要免确认，应由用户在账号或任务级显式开启。

示例：

```bash
node scripts/smtp.js send --account work --to a@example.com --subject "..." --body "..."
# 返回: confirmation_required

node scripts/smtp.js send --account work --confirmed --to a@example.com --subject "..." --body "..."
# 实际发送
```

### 4.6 与 OpenClaw/Skill 路由关系

OpenClaw 仍通过现有 Skill 机制读取 `SKILL.md` 和执行脚本。LobsterAI 不需要新增
OpenClaw channel 或 runtime gateway 配置。

本需求只改变：

- LobsterAI 设置页如何管理该 Skill 的配置。
- Skill 脚本如何解析多账号配置。
- `SKILL.md` 如何指导 Agent 使用账号参数。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 没有任何账号 | 设置页显示空状态；脚本返回“未配置邮箱账号” |
| 没有默认账号 | 使用第一个启用账号，或返回需要设置默认账号的错误；实现时二选一并保持一致 |
| 默认账号被禁用 | 保存时阻止，或自动切换到另一个启用账号 |
| 账号 ID 重复 | 保存时阻止，并提示重复账号 ID |
| 邮箱地址重复 | 允许但给出警告；同一邮箱可能用不同 SMTP 身份配置 |
| 旧 `.env` 字段不完整 | 迁移为草稿账号但保持 disabled，提示补全配置 |
| 账号密码包含空格、`#`、引号 | `accounts.json` 正常保存；日志必须脱敏 |
| `--all-accounts` 部分失败 | 返回 partial 结果，不吞掉成功账号数据 |
| SMTP verify 通过但发送失败 | 发送命令返回真实错误；连接测试不保证投递成功 |
| 邮件 UID 在不同账号重复 | 输出和附件下载路径必须包含 `accountId` |
| 附件文件名冲突 | 下载目录下按 `accountId/uid/filename` 或去重后保存 |

## 6. 涉及文件

预计修改：

- `src/renderer/components/skills/EmailSkillConfig.tsx`
- `src/renderer/services/skill.ts`
- `src/renderer/services/i18n.ts`
- `src/main/skills/skillManager.ts`
- `src/main/ipcHandlers/skills/handlers.ts`
- `src/main/preload.ts`
- `SKILLs/imap-smtp-email/SKILL.md`
- `SKILLs/imap-smtp-email/README.md`
- `SKILLs/imap-smtp-email/package.json`
- `SKILLs/imap-smtp-email/scripts/imap.js`
- `SKILLs/imap-smtp-email/scripts/smtp.js`

建议新增：

- `SKILLs/imap-smtp-email/scripts/config.js`
- `SKILLs/imap-smtp-email/scripts/config.test.js` 或对应 Vitest/Node 测试
- `src/main/skills/emailSkillConfig.ts`（如主进程逻辑过长）
- `src/main/skills/emailSkillConfig.test.ts`

## 7. 实施步骤

### Step 1：配置模型与迁移

- 定义 `EmailSkillAccountsConfig` 类型。
- 实现旧 `.env` 到新 `accounts.json` 的读取迁移。
- 保留旧 `getSkillConfig/setSkillConfig` 兼容路径。
- 增加主进程单元测试覆盖完整迁移、不完整迁移、重复账号和默认账号规则。

### Step 2：脚本配置 helper

- 新增 `scripts/config.js`。
- 改造 `imap.js` 和 `smtp.js` 使用账号解析。
- 保持无 `--account` 的旧命令仍可使用默认账号。
- 增加 `--account` 和 `--all-accounts`。

### Step 3：设置页多账号 UI

- 改造 `EmailSkillConfig.tsx` 为账号列表 + 详情。
- 迁移现有 provider preset、连接测试、密码显示、AI 诊断逻辑。
- 添加新增/删除/启用/默认账号操作。
- 补齐中英文 i18n。

### Step 4：发信确认与文档

- `smtp.js send` 增加 `--confirmed` 逻辑。
- `SKILL.md` 明确默认确认策略和多账号用法。
- `README.md` 更新本地命令示例。

### Step 5：验证与清理

- 运行相关脚本测试和 changed-file ESLint。
- 手动验证一个旧 `.env` 被识别为默认账号。
- 手动验证至少两个账号的保存、切换和连接测试。
- 检查日志中不输出密码或完整敏感配置。

## 8. 验收标准

1. 用户可以在设置页添加至少 2 个 IMAP/SMTP 邮箱账号并保存。
2. 旧单账号 `.env` 配置在升级后能自动显示为一个账号。
3. 默认账号命令保持兼容：`node scripts/imap.js check` 和
   `node scripts/smtp.js verify` 使用默认账号。
4. 指定账号命令可用：`--account <id>` 对读信、搜索、下载、标记、发信生效。
5. 聚合查询可用：`--all-accounts` 返回带账号标识的结构化结果。
6. 单账号连接测试和全部账号连接测试都能在 UI 中展示结果。
7. 发信默认需要确认；未确认时不会发送真实邮件。
8. `SKILL.md` 能指导 Agent 正确选择账号并避免静默发送邮件。
9. 敏感信息不出现在普通日志、连接测试摘要和 UI 非密码区域。
10. touched TypeScript/TSX 文件通过 changed-file ESLint。

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| `accounts.json` 保存明文密码 | 与现有 `.env` 风险等价；后续可独立设计系统 keychain/credential store |
| 脚本行为变化破坏旧命令 | 默认账号保持旧命令参数不变，新增能力通过可选参数暴露 |
| 多账号 UI 使设置页变复杂 | 使用账号列表 + 分区表单；高级字段默认折叠 |
| 发信确认影响自动化体验 | 默认安全优先；未来按任务或账号显式关闭确认 |
| `imap` 库老旧 | 第一阶段不强制迁移；后续单独评估 `imapflow` |
| 聚合查询耗时 | 初期串行或小并发，并在 UI/脚本输出中保留每账号错误 |

## 10. 后续方向

- Gmail/Outlook OAuth 账号类型。
- 邮件触发计划任务：新邮件、特定发件人、主题关键词、附件。
- 本地邮件索引和跨账号搜索缓存。
- Agent 草稿箱：先生成草稿，用户确认后发送。
- 使用系统 credential store 保存邮箱密码/授权码。
- 迁移底层 IMAP 客户端到 `imapflow`。
