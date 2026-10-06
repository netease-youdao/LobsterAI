# IM 同群多 Agent 机器人会话映射修复设计文档

## 1. 概述

### 1.1 问题

同一个 IM 群聊中拉入多个机器人，并且这些机器人分别绑定到不同 Agent 时，OpenClaw 可以正确按 `sessionKey` 路由到目标 Agent，但 LobsterAI 本地会话映射只按 `(platform, im_conversation_id)` 查找，导致不同 Agent 的同群会话被压成一条本地 mapping。

典型脱敏 key 形态如下：

```text
agent:main:feishu:group:oc_622a147f6d4****
agent:2ebabf09-1718-4137-xxxx-a8789d8a8325:feishu:group:oc_622a147f6d4****
```

上面两个 key 指向同一个飞书群 `group:oc_622a147f6d4****`，但属于不同 Agent。旧映射会只保留一条：

```text
platform = feishu
im_conversation_id = group:oc_622a147f6d4****
agent_id = main
```

因此非 main Agent 的群聊消息虽然能在移动端收到回复，但不会同步到正确的 LobsterAI 本地会话。

### 1.2 根因

`OpenClawChannelSessionSync.parseChannelSessionKey()` 能从 `sessionKey` 提取平台和 conversationId，`extractAgentIdFromKey()` 也能提取 Agent ID，但后续持久化查询使用的是旧主键：

```text
(im_conversation_id, platform)
```

当两个 key 的 `platform` 和 `im_conversation_id` 相同、`agentId` 不同时，本地映射无法区分它们。

## 2. 用户场景

**Given** 飞书同一个群中有两个机器人，分别绑定 main Agent 和自定义 Agent。

**When** 用户在群里 `@` 自定义 Agent 对应机器人。

**Then** OpenClaw 的 `agent:<agentId>:feishu:group:<chatId>` 会话应同步到该 Agent 名下的 LobsterAI 会话，而不是复用 main Agent 的同群会话。

## 3. 功能需求

### FR-1: 同群不同 Agent 独立映射

`im_session_mappings` 需要支持同一个 `(platform, im_conversation_id)` 下存在多个不同 `agent_id` 的 mapping。

### FR-2: OpenClaw sessionKey 精确优先

同步 channel session 时，优先通过真实 `openclaw_session_key` 命中 mapping；找不到时再按 `(platform, im_conversation_id, agent_id)` 查找。

### FR-3: 历史数据保持可读

迁移旧表时保留现有行，默认使用原有 `agent_id`，没有 agent 字段的历史行使用 `main`。

### FR-4: 列表去重保留不同 Agent

定时任务等 IM 会话列表可以继续按 peer 去重，但不能把同 peer 不同 Agent 的 mapping 合并掉。

## 4. 实现方案

### 4.1 数据模型

`im_session_mappings` 主键从：

```text
PRIMARY KEY (im_conversation_id, platform)
```

迁移为：

```text
PRIMARY KEY (im_conversation_id, platform, agent_id)
```

同时增加 `openclaw_session_key` 索引，用于快速精确查找真实 OpenClaw channel session。

### 4.2 同步流程

`resolveOrCreateSession(sessionKey)` 使用以下顺序：

1. 跳过 LobsterAI 本地 session key。
2. 解析 `platform`、`im_conversation_id` 和 `agentId`。
3. 按 `openclaw_session_key` 精确查找 mapping。
4. 按 `(platform, im_conversation_id, agentId)` 查找 mapping。
5. 仅当 legacy mapping 的 `agentId` 与当前 key 的 `agentId` 一致时才复用。
6. 找不到时，为当前 `agentId` 新建 Cowork session，并创建 agent-scoped mapping。

## 5. 边界情况

| 场景 | 处理方式 |
|------|----------|
| 旧库只有 main Agent 的同群 mapping | 继续保留，非 main Agent key 新建独立 mapping |
| 历史 mapping 没有 `openclaw_session_key` | channel sync 重新发现时按 agent-scoped mapping 回填 |
| sessionKey 没有 accountId 但有 agentId | 信任 key 中的 agentId，不用平台级绑定把它过滤掉 |
| 定时任务列表看到同群多 Agent | 按 `agentId + peerKind + peerId` 去重，保留不同 Agent |

## 6. 验收标准

1. 同一个飞书群下 `agent:main:feishu:group:oc_****` 和 `agent:<custom-agent>:feishu:group:oc_****` 会生成两条 mapping。
2. main Agent 的历史群聊会话不被覆盖或迁移到自定义 Agent。
3. 自定义 Agent 的群聊消息出现在该 Agent 名下的 LobsterAI 会话。
4. `openclaw_session_key` 精确查找可以命中正确 mapping。
5. 定时任务 IM 会话列表不会折叠同群不同 Agent 的 mapping。
