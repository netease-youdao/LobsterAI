# 钉钉定时任务群聊 ID 大小写与投递结果修复设计文档

## 1. 概述

### 1.1 背景

PR #2306 修复了定时任务选择 IM 群聊作为通知目标时的账号过滤、Agent 绑定和历史数据规范化问题。企微回测随后发现，OpenClaw session key 会把通道原生群 ID 转为小写，而部分平台要求主动投递时保留原始大小写。企微兼容方案已在同一主题目录下单独记录。

QA 继续回测钉钉时发现：普通群聊回复正常，但选择同一群聊作为定时任务通知目标后收不到消息，任务运行记录却显示投递成功。本次修复仍属于 #2306 的平台兼容补充，因此继续放在 `im-agent-scoped-session-mapping` 主题目录中，以新的独立文档记录；已有文档保留，不移动或覆盖。

### 1.2 问题现象

日志中创建任务时使用了钉钉返回的原始 `openConversationId`：

```text
cid+wQbmjFBusv8Bld+Du9t1w==
```

任务在手动执行或启动迁移时，`delivery.to` 被基于 session 映射规范成全小写：

```text
cid+wqbmjfbusv8bld+du9t1w==
```

同一日志中，普通群聊回复使用原始大小写 ID 可以成功；定时任务使用全小写 ID 时没有到达群聊，但 cron 结果仍记录为 `delivered=true`。

### 1.3 根因

故障由两个独立问题叠加而成：

1. OpenClaw 为统一 session key，会将钉钉群 peer ID 规范成小写；LobsterAI 的定时任务历史规范化又把该内部索引值写回 `delivery.to`。钉钉 `openConversationId` 是不应改写的通道原生不透明标识，主动投递必须使用入站元数据中的原始值。
2. 钉钉连接器的 outbound text 适配层虽然能从 `sendTextToDingTalk` 收到 `{ ok: false, error }`，却没有检查 `ok`，而是继续返回占位 `messageId`。上层因此把 API 失败误记为投递成功，日志中也丢失了真实错误。

普通群聊回复不受第一个问题影响，因为它沿用当前入站消息中的原始会话标识，不需要从小写 session key 反向构造投递目标。

## 2. 修复目标与约束

### 2.1 目标

- 新建或编辑钉钉群通知任务时，保存原始大小写的 `openConversationId`。
- 已保存全小写群 ID 的历史任务，在启动迁移或手动执行前，能从唯一匹配的 gateway session origin 恢复原始大小写。
- 已保存为正确原始大小写的任务保持不变。
- 钉钉文本主动投递失败时向上层抛出真实错误，不再产生假成功结果。
- 复用企微已验证的安全恢复规则，同时保持其他平台、私聊、账号选择、Agent 绑定和任务 payload 的既有行为。

### 2.2 非目标

- 不修改 OpenClaw session key 的小写规范。
- 不猜测或合成钉钉群 ID。
- 不从历史 session 推断、补充或改变任务的 `accountId`。
- 不修改钉钉私聊目标、普通入站回复或媒体发送行为。
- 不直接修改 `vendor/openclaw-runtime/current` 下的生成产物。

## 3. 实现方案

### 3.1 通用化群聊原生目标恢复

将企微专用的 session origin 恢复 helper 收敛为可指定平台的群聊 helper，并保留企微包装函数以兼容已有调用和测试。恢复规则保持严格：

1. 只读取 `sessions.list` 返回的 `origin`。
2. 只接受指定平台且 `origin.chatType=group` 的记录。
3. 任务已有 `accountId` 时，要求 `origin.accountId` 精确匹配。
4. 去掉可识别的平台通道前缀后，以不区分大小写的方式匹配当前 peer。
5. 只有全部匹配记录对应唯一原生目标时才恢复；存在冲突时保持原值。

该 helper 只将已经存在于通道入站元数据中的原始 ID 写回任务，不根据 session key 猜测大小写。

### 3.2 钉钉任务规范化与历史兼容

把钉钉和企微列为需要保护群聊原生目标大小写的平台：

- 对已经是裸原生 ID 的目标，规范化阶段不再用小写 session mapping 覆盖。
- 新建或编辑任务时，可以从唯一匹配的 session origin 恢复原始大小写。
- 启动迁移和手动执行前，仅当现有目标是全小写时尝试历史恢复。
- 历史恢复采用 `casingOnly` 模式，只允许改变 `delivery.to` 的大小写，不得补充或改变账号及其他投递字段。
- gateway 不可用、无匹配或存在冲突时保持原值，不阻断任务管理流程。

### 3.3 传播钉钉文本发送失败

通过仓库既有的 `scripts/openclaw-plugin-patches/dingtalk.cjs` 对固定版本钉钉插件应用小范围补丁：

- `sendTextToDingTalk` 返回后检查 `result.ok`。
- `ok=false` 时使用连接器提供的 `result.error` 抛出异常；缺少错误文本时使用稳定的兜底消息。
- 只修改 outbound text 适配层，不改变请求参数、成功返回值和媒体发送路径。
- 同时处理插件源码 `src/channel.ts` 与实际运行使用的哈希 `dist/runtime-*.mjs`，并使用标记保证补丁可重复执行。

这样 cron 只有在连接器确认成功后才会记录投递成功；API 拒绝投递时，上层能够记录失败及真实原因。

## 4. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 钉钉群 origin、账号和 peer 唯一匹配 | 恢复原始大小写群 ID |
| 同一账号存在多个仅大小写不同的原生群 ID | 视为冲突，不修改 |
| 任务已保存正确的混合大小写 ID | 原样保留，不为历史修复连接 gateway |
| 历史任务缺少账号 | 仅可按唯一群 origin 恢复大小写，不补账号 |
| origin 为钉钉私聊 | 忽略，保持私聊既有行为 |
| origin 来自其他 IM 平台 | 忽略 |
| gateway 未就绪或 `sessions.list` 失败 | 保持原值并记录警告 |
| 钉钉 API 返回 `ok=false` | outbound 抛出错误，cron 不得记录为成功 |
| 钉钉文本发送成功 | 保持原有 message ID 和 conversation ID 返回行为 |

## 5. 涉及文件

- `src/main/ipcHandlers/scheduledTask/helpers.ts`
- `src/main/ipcHandlers/scheduledTask/helpers.test.ts`
- `src/main/ipcHandlers/scheduledTask/handlers.ts`
- `src/main/ipcHandlers/scheduledTask/handlers.test.ts`
- `scripts/openclaw-plugin-patches/dingtalk.cjs`
- `tests/openclaw-plugin-patches-dingtalk.test.ts`

## 6. 验收标准

- 混合大小写钉钉群 ID 经 session key 小写化后，新建、编辑的定时任务仍保存原始 ID。
- 已有全小写钉钉群任务可在迁移或手动执行前恢复原始大小写。
- 历史兼容只改变目标大小写，不推断账号，不改变 Agent 绑定或其他任务字段。
- 正确的混合大小写目标、钉钉私聊和其他 IM 平台保持原行为。
- 钉钉连接器文本 API 失败时，任务结果为失败并保留错误信息；成功路径保持不变。
- 定时任务 helper/handler 与钉钉插件补丁定向测试通过。
- 变更文件 ESLint、Electron TypeScript 编译、补丁脚本语法检查和 `git diff --check` 通过。
