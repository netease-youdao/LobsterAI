# 邮箱 Skill 附件下载路径穿越修复设计文档

## 1. 概述

### 1.1 问题

NVDB 人工智能产品安全漏洞专业库针对 LobsterAI 邮箱 Skill 报告了一个路径遍历漏洞，
临时编号为 `NVDB-TEMP-CAIVD-2026921579`，通知中定级为低危。报告复现版本为
`2026.3.25.0`。

攻击者可以发送附件名包含路径穿越片段的邮件，例如：

```text
../../../../../../hack
```

用户配置邮箱后，如果让 LobsterAI 下载该邮件附件，邮箱 Skill 会把邮件提供的附件名直接
拼接到目标目录并写盘。攻击者可以利用 `../` 或 `..\` 逃离预期附件目录，在 LobsterAI
当前系统用户权限允许的范围内写入或覆盖其它文件。

该问题的直接影响是“任意路径文件写入/覆盖”，不是收到邮件后立即执行代码。若攻击者能够
猜中用户可写的启动项、脚本、配置文件或其它后续会被执行的路径，才可能进一步转化为代码
执行。

### 1.2 当前实现

当前附件下载实现位于：

```text
SKILLs/imap-smtp-email/scripts/imap.js
```

核心逻辑为：

```javascript
const accountOutputDir = path.join(outputDir, account.id, String(uid));
const filePath = path.join(accountOutputDir, attachment.filename);
fs.writeFileSync(filePath, attachment.content);
```

数据流如下：

```text
邮件 MIME Content-Disposition filename
  -> mailparser 解码
  -> attachment.filename
  -> path.join(accountOutputDir, attachment.filename)
  -> fs.writeFileSync()
```

`mailparser` 负责 MIME 解码，但不承诺把附件名转换为安全的本地文件名。当前项目实际安装的
`mailparser 3.9.9` 会原样保留 `../../../../../../hack`。在 Windows 上，上述路径可以被
归一化到 `C:\hack` 一类目录外位置。

### 1.3 高版本状态

报告版本 `2026.3.25.0` 中存在该问题。当前仓库 `package.json` 版本为 `2026.7.23`，
`main`、`release/2026.7.24` 和当前可见的修复分支仍保留相同的直接拼接与写盘逻辑。

2026 年 7 月的多邮箱改造增加了：

```text
<outputDir>/<accountId>/<uid>/
```

目录层级，但没有验证附件名。攻击者只需增加路径穿越层数，仍能逃离该目录，因此高版本仍
受影响。

### 1.4 触发条件和风险边界

漏洞成立需要满足：

1. 攻击者能向用户已配置的邮箱发送邮件；
2. 邮件包含恶意附件名；
3. 用户、定时任务或 Agent 触发 `imap.js download`；
4. LobsterAI 当前系统用户对目标位置有写权限。

以下因素降低了直接利用概率：

- 邮件接收本身不会自动写附件；
- 写入权限不高于 LobsterAI 当前系统用户；
- 进一步实现代码执行通常需要知道可利用的目标路径和后续执行机制。

以下现状增加了潜在影响：

- 邮箱 Skill 默认启用；
- 附件名完全由邮件发送方控制；
- 下载命令支持下载全部附件；
- `writeFileSync()` 默认允许覆盖已有文件；
- Agent 运行时可以直接执行该 Skill。

### 1.5 修复目标

本次修复需要：

1. 邮件提供的附件名只能生成一个普通文件名，不能生成目录；
2. 最终写入路径必须位于当前账号和 UID 对应的附件目录内；
3. Windows、macOS 和 Linux 使用一致的安全规则；
4. 保持普通附件的原始名称和现有下载行为；
5. 保持 `--dir`、`--account`、`--mailbox`、`--file` 的现有使用方式；
6. 保持 `<outputDir>/<accountId>/<uid>/` 目录结构；
7. 重复下载同一邮件时仍可更新同一个普通附件文件；
8. 修复版本能够覆盖用户目录中已经同步的旧 Skill，同时保留邮箱配置；
9. 用自动化测试锁定路径穿越、跨平台分隔符、符号链接和兼容行为。

### 1.6 非目标

- 不修改 IMAP 连接、邮件搜索、邮件正文解析和已读状态逻辑。
- 不修改 SMTP 发信和附件上传逻辑。
- 不取消 `--dir` 参数，也不改变用户明确指定下载目录的能力。
- 不改变邮箱账号配置文件格式。
- 不修改 OpenClaw、Electron IPC 或 Renderer 邮箱设置 UI。
- 不在本次修复中引入附件病毒扫描、文件类型封禁或附件大小策略。
- 不把邮件正文提示注入治理混入本次路径穿越修复。
- 不禁止在当前账号/UID 附件目录内重复下载并覆盖同一个普通文件。

## 2. 用户场景

### 场景 A：下载普通附件

**Given** 邮件附件名为 `季度报告.xlsx`

**When** 用户执行附件下载

**Then** 文件仍保存为：

```text
<outputDir>/<accountId>/<uid>/季度报告.xlsx
```

**And** 返回结果中的 `filename` 和 `path` 与现有正常行为兼容。

### 场景 B：下载包含 POSIX 路径穿越的附件

**Given** 邮件附件名为 `../../../../../../hack`

**When** 用户执行附件下载

**Then** 文件只保存为：

```text
<outputDir>/<accountId>/<uid>/hack
```

**And** 不会在 `<outputDir>`、磁盘根目录或其它上级目录生成文件

**And** 返回结果能够区分原始附件名和实际保存名。

### 场景 C：下载包含 Windows 路径穿越的附件

**Given** 邮件附件名为 `..\..\Startup\evil.cmd`

**When** 用户在任意支持平台执行附件下载

**Then** 文件只保存为：

```text
<outputDir>/<accountId>/<uid>/evil.cmd
```

**And** macOS/Linux 不会把反斜杠保留为平台相关的危险或不可移植文件名。

### 场景 D：下载多个同名附件

**Given** 同一封邮件包含两个最终安全名称都为 `report.pdf` 的附件

**When** 用户下载全部附件

**Then** 两个附件都应保留，例如：

```text
report.pdf
report-2.pdf
```

**And** 再次下载同一封邮件时得到相同的确定性名称。

### 场景 E：通过 `--file` 下载指定附件

**Given** 原始附件名为 `../../hack`

**When** 用户执行：

```text
node scripts/imap.js download <uid> --file ../../hack
```

**Then** `--file` 仍与邮件中的原始附件名精确匹配

**And** 实际保存名为安全名称 `hack`

**And** 不要求用户提前知道清洗后的文件名。

### 场景 F：重复下载普通附件

**Given** `<outputDir>/<accountId>/<uid>/report.pdf` 已经是一个普通文件

**When** 用户再次下载同一邮件附件

**Then** 仍按现有行为更新该文件

**And** 不因为安全修复把重复下载变成失败。

### 场景 G：目标文件是符号链接

**Given** 附件目录中的目标文件名已经是一个指向目录外的符号链接

**When** 用户下载同名附件

**Then** 下载失败并返回错误

**And** 不跟随符号链接覆盖目录外文件。

### 场景 H：旧版本用户升级

**Given** 用户目录中已有 `imap-smtp-email 1.0.6`

**When** 用户安装包含修复的新版 LobsterAI 并启动

**Then** `SkillManager.syncBundledSkillsToUserData()` 使用更高的 Skill 版本替换旧代码

**And** 用户原来的 `accounts.json` 和 `.env` 被保留

**And** 后续附件下载使用安全实现。

## 3. 功能需求

### FR-1：安全处理发生在 MIME 解码之后

安全处理的输入必须是 `mailparser` 生成的最终 `attachment.filename`，不能只检查原始 MIME
头文本。

这样可以覆盖：

- RFC 2047 encoded-word；
- RFC 2231 `filename*`；
- 引号和字符集解码；
- 邮件服务器转码后的最终文件名。

### FR-2：附件名必须收敛为单个文件名

新增纯函数：

```javascript
sanitizeAttachmentFilename(filename, fallbackIndex)
```

规则：

1. `filename` 缺失或不是字符串时使用 `attachment-<index>`；
2. 同时把 `/` 和 `\` 视为路径分隔符；
3. 只保留最后一个非路径部分；
4. 替换 NUL、ASCII 控制字符和 Windows 非法文件名字符；
5. 去除 Windows 不接受的结尾空格和点；
6. `.`、`..` 或清洗后为空时使用回退名称；
7. Windows 设备保留名必须改写，例如 `CON` -> `_CON`；
8. 限制 UTF-8 文件名字节长度，避免超过常见文件系统单文件名上限；
9. 普通文件名应保持不变。

不能只使用当前平台的 `path.basename()`。在 POSIX 上，反斜杠不是路径分隔符；只用
`path.basename()` 会让同一恶意附件在不同平台产生不同结果。

### FR-3：最终路径必须通过目录边界校验

新增通用的目录包含关系检查：

```javascript
isPathInside(parentPath, candidatePath)
```

校验应基于：

```javascript
path.resolve()
path.relative()
```

当以下任一条件成立时必须拒绝：

- 相对路径为 `..`；
- 相对路径以 `..${path.sep}` 开头；
- 相对路径是绝对路径；
- 最终附件路径等于目录本身。

边界校验至少执行两次：

1. `<outputDir>/<accountId>/<uid>` 必须位于 `outputDir` 内；
2. 最终文件必须位于真实的账号/UID 附件目录内。

### FR-4：防止通过符号链接逃逸

仅做字符串路径检查无法阻止目录内的符号链接指向目录外。

写入前必须：

1. 创建预期的账号/UID 目录；
2. 获取 `outputDir` 和账号/UID 目录的真实路径；
3. 再次确认真实账号/UID 目录位于真实 `outputDir` 内；
4. 如果最终目标已经存在且是符号链接，拒绝写入；
5. 如果最终目标存在但不是普通文件，拒绝写入。

正常已存在的普通文件仍允许更新，以保持重复下载兼容。

### FR-5：保持现有下载目录语义

保持现有结构：

```text
<outputDir>/<accountId>/<uid>/<safeFilename>
```

要求：

- `outputDir` 为相对路径时，返回结果继续使用相对路径；
- `outputDir` 为绝对路径时，返回结果继续使用绝对路径；
- 不把默认输出位置迁移到新的全局目录；
- 不把不同邮箱账号或不同邮件 UID 的附件混在一起。

### FR-6：保持 `--file` 原始名称匹配

`specificFilename` 必须继续和邮件中原始 `attachment.filename` 比较：

```javascript
specificFilename === attachment.filename
```

匹配成功后，实际写盘才使用清洗后的名称。

如果改成与安全名称匹配，会破坏现有调用者根据 `fetch/check` 输出的原始名称下载附件的
能力。

### FR-7：安全名称冲突必须确定性处理

同一封邮件的两个附件可能：

- 原本就同名；
- 路径清洗后同名；
- 在 Windows 大小写不敏感规则下同名。

应按附件顺序生成确定性后缀：

```text
report.pdf
report-2.pdf
report-3.pdf
```

扩展名应尽量保留。重复执行同一封未变化的邮件时，名称映射保持稳定。

### FR-8：返回结果兼容

已有返回项：

```javascript
{
  filename,
  path,
  size
}
```

继续保留。

对普通附件：

```javascript
filename === attachment.filename
```

对发生清洗或冲突改名的附件：

- `filename` 返回实际保存名；
- 新增可选 `originalFilename` 返回邮件中的原始名称；
- `path` 指向实际安全保存路径。

只增加可选字段，不删除已有字段。

### FR-9：错误必须阻止危险写入

以下情况应抛出清晰错误并停止当前下载：

- 账号/UID 目录逃离 `outputDir`；
- 真实目录通过符号链接逃离；
- 最终文件路径逃离附件目录；
- 最终目标是符号链接或非普通文件；
- 无法生成有效安全名称；
- 创建目录或写文件失败。

不能在检测到危险后退回旧的直接拼接逻辑。

### FR-10：旧用户必须收到修复

当前 Skill frontmatter 版本为 `1.0.6`。修复版本至少提升为：

```text
1.0.7
```

同时更新 `_meta.json` 发布版本。

`SkillManager` 会在 bundled Skill 版本高于用户目录版本时执行 clean copy，并在复制前后保留：

```text
.env
accounts.json
```

本次不修改该升级机制，但必须通过版本提升触发它。

## 4. 实现方案

### 4.1 新增附件存储模块

新增：

```text
SKILLs/imap-smtp-email/scripts/attachment-storage.js
```

把路径安全和文件落盘从 IMAP 网络逻辑中提取出来，避免通过真实邮箱才能测试。

建议导出：

```javascript
sanitizeAttachmentFilename(filename, fallbackIndex)
isPathInside(parentPath, candidatePath)
storeEmailAttachments(options)
```

其中：

```javascript
storeEmailAttachments({
  attachments,
  outputDir,
  accountId,
  uid,
  specificFilename,
})
```

返回与当前 `downloadAttachments()` 使用的 `downloaded` 数组相同的结构。

### 4.2 安全文件名生成

建议流程：

```text
原始附件名
  -> 将反斜杠按路径分隔符处理
  -> 取最后一个路径段
  -> 替换控制字符和跨平台非法字符
  -> 去除结尾点/空格
  -> 处理空名称、.、..
  -> 处理 Windows 设备名
  -> 限制 UTF-8 字节长度
  -> 处理同邮件内重名
```

普通名称示例：

| 输入 | 输出 |
|------|------|
| `report.pdf` | `report.pdf` |
| `季度报告.xlsx` | `季度报告.xlsx` |
| `photo 01.jpg` | `photo 01.jpg` |

危险或不可移植名称示例：

| 输入 | 输出 |
|------|------|
| `../../hack` | `hack` |
| `..\..\hack` | `hack` |
| `C:\Windows\win.ini` | `win.ini` |
| `\\server\share\payload.cmd` | `payload.cmd` |
| `.` | `attachment-1` |
| `..` | `attachment-1` |
| `CON` | `_CON` |
| `file.txt:payload` | `file.txt_payload` |

### 4.3 安全目录准备

`storeEmailAttachments()` 先计算：

```javascript
const resolvedOutputDir = path.resolve(outputDir);
const accountOutputDir = path.resolve(
  resolvedOutputDir,
  accountId,
  String(uid),
);
```

然后：

1. 对 `accountOutputDir` 做词法包含关系检查；
2. `mkdirSync(accountOutputDir, { recursive: true })`；
3. 分别调用 `realpathSync()` 获取真实根目录和真实附件目录；
4. 对真实路径再次做包含关系检查。

这同时防御附件名以外的异常账号 ID、UID 和目录符号链接问题，正常账号 ID 和数字 UID
行为不变。

### 4.4 安全文件写入

每个附件：

1. 使用原始名称完成 `specificFilename` 过滤；
2. 分配安全且不冲突的存储名称；
3. 基于真实附件目录计算绝对写入路径；
4. 校验绝对写入路径仍在真实附件目录内；
5. 使用 `lstatSync()` 检查已有目标；
6. 拒绝符号链接和非普通文件；
7. 写入普通文件；
8. 返回保持原相对/绝对风格的逻辑路径。

本次保留普通文件覆盖语义。原因是同一 UID 重复下载属于现有功能，直接改成 `wx` 会让重复
下载失败。安全边界由“只能写入真实附件目录”和“不能跟随符号链接”保证。

### 4.5 集成到 `downloadAttachments()`

`imap.js` 继续负责：

- 连接 IMAP；
- 打开 mailbox；
- 根据 UID 获取邮件；
- 调用 `parseEmail(..., { includeAttachments: true })`；
- 返回无附件或指定附件不存在的提示；
- 关闭 IMAP 连接。

以下逻辑替换为 `storeEmailAttachments()`：

- 创建输出目录；
- 遍历附件；
- 拼接附件路径；
- 写文件；
- 构建 `downloaded` 数组。

这样网络、账号和命令行行为不变，安全逻辑可以独立测试。

### 4.6 Skill 升级

修改：

```text
SKILLs/imap-smtp-email/SKILL.md
SKILLs/imap-smtp-email/_meta.json
```

要求：

- frontmatter 版本从 `1.0.6` 提升到 `1.0.7`；
- `_meta.json` 从 `0.0.7` 提升到 `0.0.8`；
- 不修改账号配置格式；
- 不删除或覆盖仓库中的依赖锁文件；
- 打包时新模块必须随整个 Skill 目录进入 `extraResources`。

### 4.7 日志和用户输出

不在普通文件名的正常附件循环中增加日志。

附件名因安全处理或同邮件冲突而改名时，输出一条 warning：

```text
[imap-security] Stored attachment with a safe filename: account="...", uid="...", original="...", stored="..."
```

文件名日志值必须通过 JSON 转义并限制长度，避免控制字符造成日志注入或超长文件名污染
日志。单封邮件只记录有限数量的改名明细，超过上限后输出一条 omitted 汇总，避免恶意邮件
制造日志洪泛。日志只记录账号 ID 和 UID，不记录邮箱地址、密码或授权码。

附件存储失败时先输出一条带账号 ID、UID 和 error 对象的错误日志：

```text
[imap-download] Failed to store attachments: account="...", uid="..."
```

然后继续由现有 CLI 顶层错误处理输出：

```text
Error: <reason>
```

发生安全改名时不把命令视为失败。`downloaded` 结果中的 `filename`、`originalFilename`
和 `path` 足以让 Agent 向用户说明实际保存位置。

本下载链路由邮箱 Skill CLI 直接执行，不经过 Renderer 专用 API。本次不新增无调用关系的
Renderer 日志；CLI stderr 会随工具调用结果进入现有诊断链路。

## 5. 边界情况

| 场景 | 处理方式 |
|------|----------|
| 普通 ASCII 文件名 | 原样保存 |
| 普通中文/Unicode 文件名 | 原样保存 |
| `/` 路径穿越 | 只保留最后一个文件名 |
| `\` 路径穿越 | 所有平台都只保留最后一个文件名 |
| POSIX 绝对路径 | 只保留最后一个文件名 |
| Windows 盘符路径 | 去除路径并替换非法冒号 |
| UNC 路径 | 只保留最后一个文件名 |
| 文件名为空或缺失 | 使用 `attachment-<index>` |
| 文件名为 `.` / `..` | 使用 `attachment-<index>` |
| 文件名含 NUL/控制字符 | 替换为 `_` |
| Windows 设备保留名 | 前置 `_` |
| 文件名结尾为空格或点 | 去除结尾空格和点 |
| 文件名超过字节上限 | 按完整 Unicode code point 截断 |
| 同一邮件附件重名 | 使用确定性数字后缀 |
| `--file` 指定恶意原始名称 | 原始名称匹配，安全名称写盘 |
| 相对 `outputDir` | 返回相对路径，行为兼容 |
| 绝对 `outputDir` | 返回绝对路径，行为兼容 |
| `outputDir` 本身是符号链接 | 以它指向的真实目录作为安全根 |
| 账号/UID 子目录逃离根目录 | 拒绝 |
| 账号/UID 子目录通过符号链接逃逸 | 拒绝 |
| 目标已存在且为普通文件 | 允许重复下载覆盖 |
| 目标已存在且为符号链接 | 拒绝 |
| 目标已存在且为目录/特殊文件 | 拒绝 |
| 附件没有 `content` | 与现有行为一致，跳过 |
| 指定附件不存在 | 保持现有 “not found” 返回 |

## 6. 涉及文件

### `SKILLs/imap-smtp-email/scripts/attachment-storage.js`

新增纯路径处理、目录边界检查和附件落盘逻辑。

### `SKILLs/imap-smtp-email/scripts/imap.js`

引入 `storeEmailAttachments()`，替换直接使用附件名拼接和写盘的逻辑。

### `SKILLs/imap-smtp-email/SKILL.md`

提升 Skill 版本，确保已安装用户收到修复。可在 Security Notes 中补充附件名会在下载时
安全处理，但不改变命令说明。

### `SKILLs/imap-smtp-email/_meta.json`

提升发布元数据版本。

### `tests/imapSmtpEmailAttachmentStorage.test.ts`

新增 Vitest 回归测试。测试直接加载新的 CommonJS 存储模块，不连接真实邮箱。

## 7. 验收标准

1. `../../../../../../hack` 不会在附件目录外生成文件。
2. `..\..\Startup\evil.cmd` 在所有平台都只保存为 `evil.cmd`。
3. POSIX 绝对路径、Windows 盘符路径和 UNC 路径都不能控制保存目录。
4. 普通 ASCII、中文和带空格附件名保持不变。
5. 附件仍保存到 `<outputDir>/<accountId>/<uid>/`。
6. `--dir`、`--account`、`--mailbox` 和 `--file` 用法保持不变。
7. `--file` 继续匹配邮件中的原始名称。
8. 同一封邮件中的安全名称冲突不会丢失附件。
9. 重复下载同一封邮件仍能更新已有普通文件。
10. 最终目标是符号链接、目录或特殊文件时拒绝写入。
11. 账号/UID 目录通过路径穿越或符号链接逃离 `outputDir` 时拒绝。
12. 普通附件返回结构仍包含 `filename`、`path` 和 `size`。
13. 安全改名附件额外返回 `originalFilename`，且 `path` 指向实际文件。
14. `SKILL.md` 版本高于 `1.0.6`，启动同步会 clean copy 旧 Skill。
15. Skill 升级仍保留用户的 `accounts.json` 和 `.env`。
16. 邮件检查、搜索、正文读取、标记已读/未读和 SMTP 发信行为无变化。
17. `npm run build:skill:email` 成功。
18. 新增 Vitest、相关现有测试和变更文件 lint 全部通过。

## 8. 验证计划

### 8.1 单元测试：文件名安全

覆盖：

1. 普通英文、中文、空格和多扩展名保持不变；
2. POSIX `../` 和绝对路径；
3. Windows `..\`、盘符路径和 UNC 路径；
4. 混合分隔符；
5. 空值、空字符串、`.` 和 `..`；
6. NUL、ASCII 控制字符和 Windows 非法字符；
7. `CON`、`PRN`、`AUX`、`NUL`、`COM1-9`、`LPT1-9`；
8. 结尾空格和点；
9. 超长 ASCII 和多字节 Unicode 文件名；
10. 同名和清洗后同名附件的确定性后缀。

### 8.2 单元测试：目录边界

覆盖：

1. 普通子路径通过；
2. 同级前缀目录不被误判为子目录；
3. `..` 逃逸被拒绝；
4. 绝对候选路径被拒绝；
5. 账号 ID 或 UID 导致的逃逸被拒绝；
6. 相对和绝对 `outputDir` 都保持返回路径风格。

### 8.3 存储集成测试

使用临时目录和模拟 `mailparser` 输出结构：

1. 保存普通附件并校验内容；
2. 保存报告 PoC 文件名并确认只在 UID 目录出现；
3. 保存 Windows 路径穿越文件名；
4. `specificFilename` 使用原始恶意名称时仍能下载；
5. 多附件重名时都被保留；
6. 重复下载覆盖已有普通文件；
7. 目标符号链接时拒绝且目录外文件不变；
8. 账号目录符号链接逃逸时拒绝；
9. 附件 `content` 缺失时跳过。

符号链接测试在当前平台不允许创建链接时可以有条件跳过，但 Windows CI/手动验证必须覆盖
junction 或文件符号链接场景。

### 8.4 Skill 升级验证

1. 准备用户目录 Skill `1.0.6`；
2. 写入测试 `accounts.json` 和 `.env`；
3. 使用修复版 bundled Skill 执行同步；
4. 确认脚本已替换为安全实现；
5. 确认两个配置文件内容逐字节保持；
6. 再次同步确认版本相同时不产生重复 clean copy。

### 8.5 自动化命令

```bash
npx vitest run tests/imapSmtpEmailAttachmentStorage.test.ts
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  tests/imapSmtpEmailAttachmentStorage.test.ts
node --check SKILLs/imap-smtp-email/scripts/attachment-storage.js
node --check SKILLs/imap-smtp-email/scripts/imap.js
npm run build:skill:email
npm test
```

如果只修改 Skill JavaScript 和测试，不需要修改 Electron main/preload，因此
`npm run compile:electron` 不是本修复的强制门禁；最终仍应根据实际 diff 判断是否补跑。

### 8.6 手动验证

1. 在 Windows 测试环境配置一个专用邮箱账号。
2. 发送带 `../../../../../../hack` 附件名的测试邮件。
3. 在 LobsterAI 中请求下载该邮件附件。
4. 确认下载结果显示原始名称和安全保存名。
5. 确认文件只存在于：

   ```text
   <project>/<accountId>/<uid>/hack
   ```

6. 确认 `C:\hack`、应用安装目录、用户启动目录和项目上级目录没有生成文件。
7. 再次下载同一封邮件，确认普通重复下载仍成功。
8. 验证邮件 check、fetch、search、mark-read、mark-unread 和 SMTP send 的基本流程。

## 9. 发布和漏洞反馈

修复发布后，向漏洞平台反馈至少包括：

- 受影响版本范围；
- 修复版本号和发布时间；
- 根因说明；
- 附件名清洗与最终路径边界校验说明；
- Windows 原始 PoC 修复前后结果；
- 自动化回归测试结果；
- 旧版本用户升级后 bundled Skill 覆盖验证；
- 仍需用户触发下载且权限受当前系统用户限制的风险边界。

在修复版本可用前，临时缓解措施是停用 `imap-smtp-email` Skill，或避免执行附件
`download` 命令。仅依赖 Agent prompt 忽略恶意附件名不能作为正式修复。
