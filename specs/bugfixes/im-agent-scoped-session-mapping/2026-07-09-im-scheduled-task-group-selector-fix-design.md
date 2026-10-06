# 定时任务 IM 群聊 Bot 归属修复设计

## 1. 概述

### 1.1 问题

在同一个飞书群聊中接入多个 Bot，并且这些 Bot 绑定到不同 Agent 后，定时任务表单选择某个 Bot 时，群聊目标下拉会出现多条相同 `群聊 · oc_...` 选项。用户无法判断每条选项对应哪个 Agent，创建任务时也可能因为同一群聊存在多条 agent-scoped mapping 而绑定到错误 Agent。

后续验证还发现，已经保存在 OpenClaw cron state 中的旧任务不会重新经过创建/编辑归一化。用户点击“立即运行”，或旧任务自然到点执行，仍会使用旧 job 配置。结果可能是 IM 侧收到消息，但 LobsterAI 侧没有展示在期望的群聊会话中。

进一步排查 OpenClaw 当前行为后确认：飞书 cron delivery 的发送目标如果是裸 `oc_...` 群聊 id，IM 发送可以成功，但 OpenClaw 侧 delivery mirror 会把这次出站消息记录到一个 `direct:<oc_...>` 形态的会话，而不是既有的 canonical `group:<oc_...>` 会话。OpenClaw Web UI 也会展示这个独立会话。因此 LobsterAI 不应在普通会话列表层强行隐藏或合并该会话；更自然的短期策略是在定时任务候选通知渠道中隐藏这类 fake direct，避免用户配置任务时选错。

### 1.2 根因

PR #2298 后，`im_session_mappings` 支持同一个 `(platform, im_conversation_id)` 下存在多个不同 `agent_id` 的 mapping，用来保留同群不同 Agent 的会话归属。这是正确的。

私聊会话的 `im_conversation_id` 带账号前缀，例如：

```text
61823a93:direct:ou_xxx
```

可以按账号前缀过滤。但群聊会话的 `im_conversation_id` 通常是：

```text
group:oc_xxx
```

不带账号前缀。定时任务选择 Bot 实例时，不能通过给群聊 session key 增加 accountId 解决归属问题，只能结合 LobsterAI 本地 mapping 和当前 Bot 绑定关系判断。

OpenClaw cron job 是持久化配置。创建/编辑任务会经过 LobsterAI IPC handler，但手动运行只调用 `cron.run(id)`，自然到点执行则完全由 OpenClaw cron 调度。两条路径都不会重新执行创建/编辑时的 IM announce 归一化。

## 2. OpenClaw Session Key 规范与现状

这次修复不能通过给群聊 session key 增加 accountId 来解决。

OpenClaw 文档和插件测试都把群聊写成：

```text
agent:<agentId>:feishu:group:<chatId>
```

不带 `accountId`。OpenClaw 当前实现中，`accountId` 只在 direct message 且 `session.dmScope = "per-account-channel-peer"` 时参与 session key：

```text
agent:<agentId>:<channel>:<accountId>:direct:<peerId>
```

对于 group/channel，规范形态是：

```text
agent:<agentId>:<channel>:group:<peerId>
agent:<agentId>:<channel>:channel:<peerId>
```

因此 LobsterAI 不应在 `im_conversation_id` 或 OpenClaw canonical session key 层面发明群聊 account 前缀。群聊的 Bot 归属只能在 LobsterAI 侧通过 mapping 元数据或当前实例绑定关系辅助判断。

### 2.1 飞书 delivery mirror 现状

当前 LobsterAI pinned runtime 使用 OpenClaw v2026.6.1 与 `@larksuite/openclaw-lark@2026.6.10`。实测和源码排查结果：

1. 飞书 canonical 群聊会话是 `agent:<agentId>:feishu:group:<chatId>`，不带 `accountId`。
2. cron 运行本身会创建独立 `agent:<agentId>:cron:<jobId>...` 会话。
3. cron delivery 向飞书群聊发送时，`delivery.to` 必须使用平台原生 `chatId`，例如 `oc_...`。如果传 `group:oc_...`，飞书发送 API 会把它当成 open_id 校验并返回 400。
4. 发送成功后，OpenClaw 当前 outbound mirror 会把裸 `oc_...` 解析成 `agent:<agentId>:feishu:<accountId>:direct:<chatId>`。这个会话在 OpenClaw Web UI 中也独立存在。
5. 该现象来自 OpenClaw cron delivery mirror 路径没有把前面已解析出的 group target kind 继续传给 outbound session route；飞书插件本身也没有提供足够的 `resolveOutboundSessionRoute`/target kind 推断能力来把裸 `oc_...` 识别回 group。

因此当前 LobsterAI 侧采用“配置候选隐藏 fake direct，普通会话列表保留 OpenClaw 实际会话”的策略。这样既避免定时任务配置误选，又不篡改 OpenClaw 真实会话结构。

### 2.2 主要 IM 渠道对比

| 渠道 | bundled 插件现状 | 对本问题的影响 |
|------|------------------|----------------|
| 飞书 | 支持群聊，但群聊 canonical key 不带 `accountId`；cron mirror 对裸 `oc_...` 会生成 `accountId:direct:<chatId>` | 当前问题的直接来源，候选列表需要隐藏同 peer fake direct |
| 钉钉 | `dingtalk-connector` 声明 `chatTypes: ["direct", "group"]`，提示使用 `user:userId`/`group:conversationId`，并提供 `normalizeTarget`/`targetResolver` | 目标格式更明确，风险低于飞书；仍适用候选侧同 peer fake direct 隐藏兜底 |
| 企业微信 | 官方 WeCom 插件声明 `chatTypes: ["direct", "group"]`；README 明确 `delivery.to` 支持 `group:<id>`/`chat:<id>`，也会按 `wr...`/`wc...` 启发式识别群聊 | 群聊 target 有明确前缀或可识别前缀，预计不容易落成 fake direct |
| POPO | `moltbot-popo` 声明 `chatTypes: ["direct", "channel"]`；提示 `user:email`/`group:sessionId`，发送端会剥离 `group:`/`channel:` 并把邮箱视为私聊、纯数字视为群/频道 | 群聊 id 和邮箱形态区分明显，风险低；候选兜底仍适用 |
| 微信 | `openclaw-weixin` 只声明 `chatTypes: ["direct"]`，agent prompt 要求 cron 使用用户 `xxx@im.wechat` 和 `accountId` | 当前插件不支持群聊形态，不涉及群聊 fake direct |

## 3. 方案

### 3.1 表单候选过滤

定时任务会话列表层做短期修复：

1. 仍然先按选中的 Bot 实例调用 `listSessionMappings(platform, accountId)`。
2. 私聊 mapping 保持原逻辑。
3. 对 `group:%` 这类不带账号前缀的群聊 mapping，读取当前 `settings.platformAgentBindings`，解析“选中 Bot 实例当前绑定的 Agent”。
4. 只保留 `mapping.agentId` 等于该绑定 Agent 的群聊 mapping。
5. 如果历史 delivery mirror 已经留下 `accountId:direct:<chatId>` 这类与群聊同 peer 的伪私聊 mapping，且同 peer 已存在当前 Agent 的 accountless `group:<chatId>`/`channel:<peerId>` mapping，则候选列表隐藏该 direct 形态，避免同一个 IM 群聊同时显示为“群聊”和“私聊”。
6. 再执行现有 `dedupeConversationMappings()`，继续保留 PR #2298 对不同 Agent mapping 的保护语义。

当无法解析选中账号或绑定关系时，保留旧行为，避免误删历史会话选项。

### 3.2 任务创建/编辑归一化

创建或编辑 IM announce 任务时：

1. 设置 `sessionTarget = isolated`。
2. 将 `systemEvent` payload 转换为 `agentTurn` payload。
3. 根据本地 `im_session_mappings` 和 `platformAgentBindings` 推导目标 `agentId`。
4. `delivery.to` 归一化为平台原生 peer id，去掉 `direct:`、`group:`、`channel:` 以及账号前缀。
5. 创建/编辑路径继续允许调用 gateway `sessions.list`，用于恢复大小写敏感 IM target 的原始 casing/account。

OpenClaw canonical session key 中的 `group:<chatId>` 是会话键语义，不是飞书出站发送参数。飞书群聊发送的 `delivery.to` 必须保持原生 `chatId`（例如 `oc_...`），不能传 `group:oc_...`，否则飞书 API 会按 open_id 校验并返回 400。

如果 OpenClaw delivery mirror 把裸群聊 id 记录成 `direct:<chatId>` 形态，LobsterAI 的 channel session sync 层不再全局合并到既有 accountless `group:<chatId>`/`channel:<peerId>` mapping。普通会话列表保留 OpenClaw 实际产生的会话；只有定时任务表单候选会隐藏同 peer fake direct。

任务归属推导也要优先同 peer 的 accountless group/channel mapping。否则历史污染 direct mapping 若更新时间更新，可能先命中选中 Bot 的 `accountId:direct:<chatId>`，把任务重新绑定到错误 Agent。

### 3.3 旧任务迁移

旧任务迁移只使用本地轻量归一化，不调用 gateway `sessions.list`：

1. 只处理 `delivery.mode = announce` 且能解析到 LobsterAI IM 平台的任务。
2. 只比较并 patch 稳定字段：`sessionTarget`、`payload`、`delivery`、`agentId`、`sessionKey`。
3. 仅当归一化后字段发生变化时调用 `cron.update`，保证幂等。
4. 手动立即执行前先迁移该 job，再调用 `cron.run`。
5. OpenClaw gateway 启动成功后后台扫描现有 cron jobs 并执行同一套迁移，不阻塞任务列表加载。

旧任务若已经保存为裸 `oc_...`，迁移会保留该平台原生发送目标，并根据本地 mapping 修正 `agentId` 和 `sessionTarget`。旧任务若保存了 `group:oc_...` 这类会话键片段，则迁移会剥离为 `oc_...`，避免出站发送 400。

### 3.4 投递后的会话同步

OpenClaw delivery mirror 只追加 transcript，不一定更新 session store 中的 `updatedAt`。因此 LobsterAI 不能只依赖最近活跃会话轮询，还要在收到 delivered cron finished event 后定向同步实际 mirror transcript：

1. 从 cron event 的 resolved delivery 中读取 `channel`、平台原生 `to` 和 `accountId`，并从 job 或 run session key 中取得实际执行 `agentId`。
2. 对当前 pinned runtime 的飞书裸 `oc_...` 目标，按 OpenClaw 实际行为定位 `agent:<agentId>:feishu:<accountId>:direct:<chatId>`，必要时创建对应本地 mapping；不错误同步 canonical `group:<chatId>`。
3. 其它 IM 渠道继续按已有 delivery target mapping 解析，不改变私聊、明确 group/channel target 或无通知任务路径。
4. 同步仍使用延迟异步执行，不阻塞主进程或任务列表加载，并保持重复调用幂等。

OpenClaw 当前还会按最近 assistant 文本对 delivery mirror 去重：若不同执行输出完全相同，IM 仍可能重复收到，但 transcript 不追加新消息。本次不在 LobsterAI 侧合成消息，也不修改该 OpenClaw 行为。

## 4. 日志策略

保留必要诊断信息，但避免高频 info 日志：

1. 会话候选列表的 raw/filtered/deduped 计数、群聊摘要、绑定摘要用于排查过滤问题，记录为 `debug`。
2. 创建/编辑/迁移时发生实际 agent 绑定或 job patch，记录为 `log`，便于用户导出日志后确认旧任务是否已被修正。
3. 失败但可恢复的绑定解析、gateway hints 恢复失败，记录为 `warn`。
4. 本次新增的 IM 归一化诊断不记录完整 payload message，避免扩大定时任务正文的日志暴露面。
5. cron 投递后同步成功时记录最终 local session id 与 OpenClaw session key，便于区分实际同步的是 canonical group 还是 fake direct；解析或创建失败记录为 `warn`。

## 5. 边界情况

| 场景 | 处理方式 |
|------|----------|
| Bot 实例绑定自定义 Agent | 群聊列表只展示该 Agent 对应的 group mapping |
| Bot 实例未显式绑定 Agent | 按 OpenClaw/LobsterAI 默认逻辑视为 `main` Agent |
| 私聊 mapping 带账号前缀 | 继续使用 `listSessionMappings(platform, accountId)` 过滤 |
| 群聊 OpenClaw session key 不带 accountId | 不修改 key 规范，只用当前实例绑定关系过滤 UI 候选和修正 cron job |
| 旧任务已经保存裸群聊 id | 保持平台原生 `chatId`，只修正 agent 归属和 sessionTarget |
| 旧任务已经保存 `group:<chatId>` | 迁移为平台原生 `chatId`，避免出站发送 400 |
| 历史 delivery mirror 留下 `accountId:direct:<chatId>` | 普通会话列表保留；若同 peer 存在当前 Agent 的 accountless group/channel mapping，定时任务候选列表隐藏 direct 形态并按 group/channel 归属推导 |
| 无通知定时任务 | `delivery.mode = none`，不进入 IM announce 归一化或旧任务迁移 |
| 非 IM announce 任务 | 不进入 IM announce 归一化或旧任务迁移 |

## 6. 验收标准

1. 同一飞书群存在 main Agent 和自定义 Agent 两条 mapping 时，选择 Bot 1 只看到 Bot 1 当前绑定 Agent 的群聊选项。
2. 私聊选项仍按 Bot 实例账号前缀正常过滤。
3. `dedupeConversationMappings()` 不会把不同 Agent 的同群 mapping 全局折叠。
4. OpenClaw 群聊 session key 不带 accountId 的规范被明确记录。
5. 旧飞书群聊定时任务不重新编辑，点击“立即运行”后能成功发送到 IM；若 OpenClaw 仍写出 fake direct mirror，LobsterAI 普通会话列表保持与 OpenClaw 一致。
6. OpenClaw 启动后的后台迁移完成后，旧任务自然到点执行也使用修正后的 agent 归属和平台原生 `chatId` target。
7. 手动运行迁移路径不调用 gateway `sessions.list`。
8. 定时任务通知目标候选不展示同 peer fake direct；会话列表不做同类过滤。
9. 飞书群聊 cron 输出发生变化时，LobsterAI 同步 OpenClaw 实际 fake direct transcript，不再错误刷新 canonical group 历史。
10. 飞书以外渠道和 `delivery.mode = none` 任务的会话同步行为保持不变。
