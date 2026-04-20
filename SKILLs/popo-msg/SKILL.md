---
name: popo-msg
description: 查询 POPO 群组历史消息。当用户需要查询群聊天记录、查看某个群的历史消息、搜索群消息内容时使用。当用户输入的内容涉及群消息查询、群聊历史、会话消息记录时，应尝试唤起此 skill。
---

# POPO 消息 Skill

通过 `fabric_call` 工具调用 POPO 消息 API 查询群组历史消息。

所有操作通过 `fabric_call` tool 完成，传入 `tool`（操作名）和 `params`（业务参数）。

## 严格禁止 (NEVER DO)
- `sessionId` 是当前所在的群组ID，只能查询当前群的消息，不得越权使用其他群的 `sessionId`
- 不要手动构造 `sessionId`，必须从当前会话上下文中获取
- 不要猜测 `sessionId`，不清楚时主动向用户确认
- 不要自己写 python 等方法直接调用，统一使用 `fabric_call` 工具，工具名称不能随意编造
- **严禁使用任何未在"能力总览"表中列出的 tool 名称**，包括但不限于 `popo_msg_search`、`query_history`、`search_msg` 等相似名称
- **唯一合法的 tool 名称是** `teammsg_query_team_history_msg`，任何变体写法均无效

## 能力总览

| 操作 | fabric_call tool | 说明 | 参考文件 |
|------|-----------------|------|---------|
| 查询群历史消息 | `teammsg_query_team_history_msg` | 按会话ID和时间范围查询群聊历史消息 | [tool-reference.md](./references/tool-reference.md#teammsg_query_team_history_msg) |

## 核心流程

首要任务是**理解用户的真实意图**，而不是简单地调用工具。

1. **意图分类**：判断用户想查询哪个群会话的消息、是否有时间范围要求
2. **歧义处理**：如果 `sessionId` 不明确，主动追问用户
3. **精准映射**：选择正确的 tool 和参数
4. **阅读参考文件**：需要时查阅 [tool-reference.md](./references/tool-reference.md) 了解完整参数与返回值

### 时间戳计算规则

**禁止凭空推算时间戳**，必须使用时间转换脚本 [scripts/date-convert.js](./scripts/date-convert.js) 进行转换。

```bash
# 日期 → 毫秒时间戳（默认 GMT+8）
node scripts/date-convert.js "2026-04-10 18:00:00"
# 输出: 2026-04-10 18:00:00 (GMT+8) => 1775815200000

# 毫秒时间戳 → 日期
node scripts/date-convert.js 1775815200000
# 输出: 1775815200000 => 2026-04-10 18:00:00 GMT+8
```

- **构造查询参数时**：用户指定了时间范围时，先用此脚本将日期转为毫秒时间戳，再传入 `beginTime` / `endTime` 参数。
- **处理返回结果时**：返回的 `timetag` 是毫秒时间戳，**必须用此脚本转换为可读日期后再展示给用户**，禁止直接展示原始时间戳或凭空推算日期。

### 工作流：查询群历史消息

```
# 1. 查询指定群会话的全部历史消息（不限时间范围）
fabric_call({"tool": "teammsg_query_team_history_msg", "params": {"sessionId": "<SESSION_ID>"}})

# 2. 查询指定时间段内的历史消息
fabric_call({"tool": "teammsg_query_team_history_msg", "params": {"sessionId": "<SESSION_ID>", "beginTime": 1775727600000, "endTime": 1775814000000}})

# 3. 查询某时间点之后的消息
fabric_call({"tool": "teammsg_query_team_history_msg", "params": {"sessionId": "<SESSION_ID>", "beginTime": 1775727600000}})
```

## 上下文传递表

| 操作 | 从返回中提取 | 用于 |
|------|-------------|------|
| `teammsg_query_team_history_msg` | `messageContents` 消息列表 | 展示给用户、按条件筛选、统计分析等 |

## 错误处理
1. `fabric_call` 返回错误时，查看返回的错误信息（`status` 非 1 或 `message` 包含错误描述）
2. 如果出现认证失败(401/403)，检查当前会话上下文是否正确
3. **如果返回 `status: 414`，说明当前用户无权限获取该群的消息**，须向用户提示："您没有权限获取该群的消息，请确认您是否为该群成员。"，禁止继续重试
4. 禁止自行尝试替代方案，将错误信息报告给用户

## 详细参考 (按需读取)

- [references/tool-reference.md](./references/tool-reference.md) -- 消息 API 端点详细参数与返回值