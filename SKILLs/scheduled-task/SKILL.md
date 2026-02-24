---
name: scheduled-task
description: 创建定时任务，支持一次性、每日、每周、每月、Cron 等调度方式。当用户想设置定期自动执行的任务时使用。Create scheduled tasks for recurring or one-time automated execution.
official: true
---

# 定时任务 Skill

## 使用场景

当用户想要：
- 设置定时执行的任务（每天、每周、每月、自定义 Cron）
- 创建一次性定时执行的任务
- 安排定时自动化检查、报告生成、代码备份等
- 设置定期监控或提醒

## 创建定时任务

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
| `notifyPlatforms` | ❌ | 通知平台数组：`["dingtalk","feishu","telegram","discord"]`（默认 `[]`） |
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

- **编码安全（Windows 必看）**：含中文 payload 必须优先使用 `@file` 方式，避免命令行参数编码导致标题/提示词乱码
- **相对时间（Windows 必看）**：当用户说“X 分钟后 / 明早 9 点 / 今天下午”等相对时间时，先用本机命令获取当前本地时间，再换算目标时间。不要直接猜测当前时间，也不要使用 UTC 时间。
- **创建顺序（防过期）**：当用户要求“1 分钟后/5 分钟后”等短延时一次性任务时，先立即创建定时任务，再进行任何耗时操作；不要先联网检索、总结内容再创建任务。
- **Prompt 边界**：`prompt` 应描述“任务触发时要执行的动作”，不要提前执行任务并把静态结果写进 prompt。示例：写“到点后检索昨天 AI 新闻并发送摘要”，不要先把新闻列表整理好再塞进 prompt。
- 推荐命令（跨平台）：
  ```bash
  node -e 'const d=new Date();const p=n=>String(n).padStart(2,"0");console.log(`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`)'
  ```
- **自动执行**：定时任务运行时所有工具调用自动批准（auto-approve），无需人工审批
- **独立运行**：`prompt` 是任务独立运行时 Claude 收到的唯一指令，应写得清晰完整
- **自动禁用**：连续失败 5 次的任务会自动禁用
- **一次性任务**：`type: "at"` 的任务执行后自动禁用
- **Cowork 会话**：每次执行会创建一个新的 Cowork 会话（标题前缀为「[定时]」），可在 Cowork 列表中查看执行详情
