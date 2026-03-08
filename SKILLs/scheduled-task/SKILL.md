---
name: scheduled-task
description: 创建和管理定时任务，支持查看、修改、启用/禁用、删除及创建定时任务。当用户想设置、修改或管理定期自动执行的任务时使用。Create and manage scheduled tasks for recurring or one-time automated execution.
official: true
---

# 定时任务 Skill

## ⚠️ 核心原则

### 原则一：优先修改已有任务

> 当用户说"修改/更改/调整某个定时任务"时，**绝对不要创建新任务**。
> 正确流程：① 列出任务 → ② 找到目标任务 ID → ③ 调用 update 脚本修改

### 原则二：IM 发送 = 通知平台，不是 prompt

> 当用户说"发到钉钉/飞书/企业微信/Telegram/Discord"时，这是**通知投递需求**，应设置 `notifyPlatforms` 字段，**不要**写进 `prompt`。
>
> 任务完成后，系统会**自动**将 Claude 的执行结果发送到指定 IM 平台，无需在 prompt 中额外指示"发送到 XX"。
>
> **正确做法：**
> - `prompt`: `"查询今天的天气并整理成报告"` — 只描述要执行的动作
> - `notifyPlatforms`: `["dingtalk"]` — 系统自动把结果发到钉钉
>
> **错误做法：**
> - `prompt`: `"查询今天的天气并发送到钉钉群"` — ❌ 不要把 IM 发送写进 prompt
>
> 常见触发词映射：
> | 用户说的 | 对应 notifyPlatforms 值 |
> |---------|----------------------|
> | 发到钉钉/钉钉群/DingTalk | `"dingtalk"` |
> | 发到飞书/Lark | `"feishu"` |
> | 发到QQ/QQ群/QQ机器人 | `"qq"` |
> | 发到 Telegram/TG/电报 | `"telegram"` |
> | 发到 Discord | `"discord"` |
> | 发到企业微信/WeCom | `"wecom"` |
> | 发到云信/网易云信/NIM | `"nim"` |
> | 发到小蜜蜂/Xiaomifeng | `"xiaomifeng"` |

### 原则三：从用户自然语言中正确提取各字段

> 用户通常一句话包含所有意图。你需要将其拆解为定时任务的各个字段，**不要**把所有内容都塞进 `prompt`。

**字段提取映射：**

| 用户描述中的成分 | 对应字段 | 提取方式 |
|---|---|---|
| 时间/频率（每天9点、周一、每30分钟…） | `schedule` | 转换为 cron/at/interval |
| 要做的事情（核心动作） | `prompt` | 展开为完整独立指令（见下方 prompt 编写规范） |
| 发到某个 IM（钉钉、飞书、TG…） | `notifyPlatforms` | 映射为平台数组（见原则二），**不要**写进 prompt |
| 任务简称（可从动作推断） | `name` | 提炼简短名称 |
| 涉及特定目录/项目 | `workingDirectory` | 提取目录路径 |
| 到期/截止（只跑到月底、到3月为止…） | `expiresAt` | 转换为 `"YYYY-MM-DD"` |
| 执行环境（在沙箱里跑…） | `executionMode` | `"sandbox"` / `"local"` |

**完整拆解示例：**

**示例 1**：用户说 `"每天早上9点帮我查一下AI新闻发到钉钉"`

```json
{
  "name": "每日AI新闻播报",
  "schedule": { "type": "cron", "expression": "0 9 * * *" },
  "prompt": "请搜索并整理今天最重要的 AI 领域新闻（不少于 5 条），每条包含标题、来源和一句话摘要。按重要性排序，输出为清晰的列表格式。",
  "notifyPlatforms": ["dingtalk"]
}
```
> 注意：`prompt` 中**没有**"发到钉钉"——IM 发送由 `notifyPlatforms` 处理。

**示例 2**：用户说 `"工作日下午6点跑一下项目测试，结果发飞书"`

```json
{
  "name": "工作日项目测试",
  "schedule": { "type": "cron", "expression": "0 18 * * 1-5" },
  "prompt": "在当前项目目录下执行完整的测试套件（npm test 或对应的测试命令），收集测试结果。输出测试通过/失败的统计摘要，列出所有失败的测试用例及其错误信息。",
  "notifyPlatforms": ["feishu"]
}
```

**示例 3**：用户说 `"每周一早上8点总结上周的Git提交"`

```json
{
  "name": "周报-Git提交总结",
  "schedule": { "type": "cron", "expression": "0 8 * * 1" },
  "prompt": "执行 git log 查看过去 7 天的所有提交记录。按作者分组统计提交数量，列出每位作者的主要变更摘要。最后给出整体项目进展的简要总结。"
}
```
> 注意：用户没提 IM，所以没有 `notifyPlatforms`。

**示例 4**：用户说 `"5分钟后提醒我开会"`

```json
{
  "name": "开会提醒",
  "schedule": { "type": "at", "datetime": "2026-02-27T14:35:00" },
  "prompt": "提醒用户：您有一个会议即将开始，请做好准备。"
}
```
> 注意：先获取本机当前时间，加5分钟计算 `datetime`。

### 原则四：prompt 编写规范

> `prompt` 是定时任务触发时 Claude 收到的**唯一指令**，必须独立、完整、可执行。

**编写要求：**

1. **展开用户简述**：用户说的很简短（如"查天气"），你需要展开为完整、具体的执行指令
2. **独立可执行**：prompt 中不能依赖当前对话上下文，必须包含所有执行所需信息
3. **不含 IM 分发**：不要写"发送到钉钉/飞书"，IM 投递由 `notifyPlatforms` 自动完成
4. **注意输出格式**：如果任务结果会通过 IM 发送（`notifyPlatforms` 非空），prompt 中应指示输出格式清晰、结构化、适合 IM 阅读（用列表、分段等，避免过长的大段文字）
5. **动作导向**：prompt 描述"要执行什么动作"，而不是"把已知结果发出去"

**用户说 → prompt 展开对照：**

| 用户简述 | ❌ 错误 prompt | ✅ 正确 prompt |
|---------|---------------|---------------|
| "查天气" | `"查天气"` | `"搜索并整理今天的天气预报，包含温度、天气状况、空气质量和穿衣建议。"` |
| "看看项目有没有bug" | `"检查bug"` | `"在项目目录下执行 lint 检查和测试套件，分析是否存在错误或警告。输出问题清单及修复建议。"` |
| "总结新闻发钉钉" | `"总结新闻并发到钉钉群"` | `"搜索今天的科技新闻热点，挑选最重要的5条，整理为简明摘要列表。"` |
| "备份数据库" | `"备份"` | `"执行数据库备份命令，将备份文件保存到 /backups/ 目录，文件名包含日期。完成后输出备份文件路径和大小。"` |

## 使用场景

当用户想要：
- **修改已有定时任务**（改时间、改内容、改频率等）→ 先列出 → 再修改
- **查看定时任务列表** → 列出任务
- **启用/禁用定时任务** → toggle 操作
- **删除定时任务** → delete 操作
- 设置定时执行的任务（每天、每周、每月、自定义 Cron）
- 创建一次性定时执行的任务
- 安排定时自动化检查、报告生成、代码备份等
- 设置定期监控或提醒

---

## 管理已有任务

### 列出所有任务

```bash
bash "$SKILLS_ROOT/scheduled-task/scripts/list-tasks.sh"
```

返回 `{ "success": true, "tasks": [...] }`，每个任务包含 `id`、`name`、`enabled`、`schedule`、`prompt`、`state` 等字段。
根据任务名称或描述找到目标任务的 `id`，用于后续修改/删除操作。

### 修改任务（只提供需要变更的字段）

先通过 list 获取任务 ID，然后只传入需要修改的字段（未提供的字段保持原值）：

```bash
cat > /tmp/update-task.json <<'JSON'
{
  "schedule": { "type": "cron", "expression": "0 10 * * *" }
}
JSON

bash "$SKILLS_ROOT/scheduled-task/scripts/update-task.sh" "<task_id>" @/tmp/update-task.json
```

#### 可修改字段

| 字段 | 说明 |
|------|------|
| `name` | 任务名称 |
| `description` | 详细描述 |
| `schedule` | 调度配置（见下方「Schedule 类型」） |
| `prompt` | 任务运行时 Claude 收到的指令 |
| `workingDirectory` | 执行目录 |
| `systemPrompt` | 自定义系统提示词 |
| `executionMode` | `"auto"` / `"local"` / `"sandbox"` |
| `expiresAt` | 过期日期 `"YYYY-MM-DD"` 或 `null`（不过期） |
| `notifyPlatforms` | 任务完成后自动发送结果的 IM 平台（见「原则二」）|
| `enabled` | 是否启用 |

### 启用 / 禁用任务

```bash
bash "$SKILLS_ROOT/scheduled-task/scripts/toggle-task.sh" "<task_id>" true   # 启用
bash "$SKILLS_ROOT/scheduled-task/scripts/toggle-task.sh" "<task_id>" false  # 禁用
```

响应包含 `warning` 字段（可能为 `TASK_AT_PAST`、`TASK_EXPIRED`），告知用户任务可能不会触发。

### 删除任务

⚠️ **不可撤销**，执行前请向用户明确确认。

```bash
bash "$SKILLS_ROOT/scheduled-task/scripts/delete-task.sh" "<task_id>"
```

---

## 创建新任务

> ⚠️ 如果用户想要修改已有任务，**不要使用创建脚本**，请使用上方的「修改任务」流程。

### Step 1: 收集信息

先与用户确认以下信息（如果用户未提供）：
1. **任务名称**（必填）— 简短描述
2. **执行内容**（必填）— 任务运行时 Claude 收到的 prompt 指令
3. **执行频率**（必填）— 一次性、每天、每周、每月或自定义 Cron
4. **工作目录**（可选）— 默认为当前会话的工作目录
5. **通知平台**（可选）— 任务完成后发送通知

### Step 2: 构建 JSON 并执行脚本

#### Schedule 类型

**一次性执行（at）：**
```json
{ "type": "at", "datetime": "2026-03-15T09:00:00" }
```

**Cron 表达式（cron）— 5 字段格式：分 时 日 月 周**
```json
{ "type": "cron", "expression": "0 9 * * *" }
```

常用 Cron 示例：
| 表达式 | 含义 |
|--------|------|
| `0 9 * * *` | 每天 9:00 |
| `0 8 * * 1` | 每周一 8:00 |
| `0 9 * * 1-5` | 工作日 9:00 |
| `0 0 1 * *` | 每月1号 0:00 |
| `*/30 * * * *` | 每30分钟 |
| `0 * * * *` | 每小时整点 |
| `0 9,18 * * *` | 每天 9:00 和 18:00 |

#### 执行脚本创建任务（推荐：`@file` 方式，避免 Windows 中文编码问题）

当 payload 含中文时，**不要**把整段 JSON 直接作为命令行参数传入。
请先写入 UTF-8 文件，再用 `@文件路径` 传给脚本。

```bash
cat > /tmp/scheduled-task.json <<'JSON'
{
  "name": "任务名称",
  "schedule": { "type": "cron", "expression": "0 9 * * *" },
  "prompt": "任务运行时 Claude 将执行的详细指令...",
  "workingDirectory": "/path/to/project"
}
JSON

bash "$SKILLS_ROOT/scheduled-task/scripts/create-task.sh" @/tmp/scheduled-task.json
```

#### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 简短的任务名称 |
| `prompt` | ✅ | 任务运行时 Claude 收到的指令（应清晰完整） |
| `schedule` | ✅ | 调度配置（见上方类型说明） |
| `workingDirectory` | ❌ | 执行目录（默认空） |
| `description` | ❌ | 详细描述（默认空） |
| `systemPrompt` | ❌ | 自定义系统提示词（默认空） |
| `executionMode` | ❌ | `"auto"` / `"local"` / `"sandbox"`（默认 `"local"`） |
| `expiresAt` | ❌ | 过期日期 `"YYYY-MM-DD"`（默认 null，不过期） |
| `notifyPlatforms` | ❌ | 任务完成后自动发送结果的 IM 平台：`["dingtalk","feishu","wecom","qq","telegram","discord","nim","xiaomifeng"]`（默认 `[]`）。用户说"发到钉钉/飞书/企业微信/QQ/TG"时设置此字段，**不要**写进 prompt |
| `enabled` | ❌ | 是否立即启用（默认 `true`） |

### Step 3: 确认结果

脚本返回 JSON 响应：
- 成功：`{ "success": true, "task": { "id": "...", "name": "...", ... } }`
- 失败：`{ "success": false, "error": "错误信息" }`

向用户确认以下信息：
- ✅ 任务名称和 ID
- ⏰ 执行频率（人类可读格式，如"每天早上 9:00"）
- 📋 执行内容摘要
- 💡 提示用户可在「设置 → 定时任务」中管理

## 重要注意事项

- **IM 通知分离**：用户提到"发到钉钉/飞书/企业微信/TG/Discord"等 IM 平台时，设置 `notifyPlatforms` 字段即可，系统会自动将任务执行结果推送到对应平台。**不要**把"发送到 XX"写进 `prompt`，`prompt` 只描述任务本身要做的事
- **优先修改**：用户说"改一下 XX 任务的时间/内容"时，先 list 找到任务 id，再 update 修改，**不要 create 新任务**
- **编码安全（Windows 必看）**：含中文 payload 必须优先使用 `@file` 方式，避免命令行参数编码导致标题/提示词乱码
- **相对时间（Windows 必看）**：当用户说"X 分钟后 / 明早 9 点 / 今天下午"等相对时间时，先用本机命令获取当前本地时间，再换算目标时间。不要直接猜测当前时间，也不要使用 UTC 时间。
- **创建顺序（防过期）**：当用户要求"1 分钟后/5 分钟后"等短延时一次性任务时，先立即创建定时任务，再进行任何耗时操作；不要先联网检索、总结内容再创建任务。
- **Prompt 边界**：`prompt` 只描述"任务触发时要执行的动作"（见「原则四」），不要提前执行任务并把静态结果写进 prompt，也不要把 IM 发送写进 prompt。
- 推荐命令（跨平台）：
  ```bash
  node -e 'const d=new Date();const p=n=>String(n).padStart(2,"0");console.log(`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`)'
  ```
- **自动执行**：定时任务运行时所有工具调用自动批准（auto-approve），无需人工审批
- **独立运行**：`prompt` 是任务独立运行时 Claude 收到的唯一指令，应写得清晰完整
- **自动禁用**：连续失败 5 次的任务会自动禁用
- **一次性任务**：`type: "at"` 的任务执行后自动禁用
- **Cowork 会话**：每次执行会创建一个新的 Cowork 会话（标题前缀为「[定时]」），可在 Cowork 列表中查看执行详情
