# 企微定时任务群聊 ID 大小写兼容修复设计文档

## 1. 概述

### 1.1 背景

PR #2306 修复了定时任务选择 IM 群聊作为通知目标时的账号过滤、Agent 绑定和历史数据规范化问题。该方案主要以飞书回测，企微回测后发现：普通群聊可以正常收发，但相同群聊被选为定时任务通知目标时，企微返回 `93006 invalid chatid`。

本次修复是 #2306 的企微兼容补充，因此继续放在 `im-agent-scoped-session-mapping` 主题目录中，以新的日期文档记录迭代。按照 `specs/README.md` 的约定，保留此前文档，不移动或覆盖历史设计。

### 1.2 问题现象

企微入站消息携带的真实群聊 ID 包含大小写，例如：

```text
wrrQeUDgAAeLCVE2WB3A39jXRlrSVEyA
```

OpenClaw 为统一 session key，会把其中的会话标识规范成小写：

```text
agent:<agentId>:wecom:group:wrrqeudgaaelcve2wb3a39jxrlrsveya
```

LobsterAI 的 `im_session_mappings` 来自该 session key。定时任务选择器在 #2306 后会正确选中企微账号和群聊，但保存到 `delivery.to` 的仍是小写群 ID。企微 Bot WebSocket 主动发送时把 `delivery.to` 直接作为 `chatid`，最终返回：

```text
93006 invalid chatid
```

### 1.3 根因

这是“会话索引”和“通道原生投递目标”语义混用造成的：

- session key 是内部索引，允许统一小写，以便稳定匹配会话；
- 企微群 `chatid` 是通道原生投递目标，必须保留入站消息中的原始大小写；
- 企微插件对私聊会写入 `lastTo` / `deliveryContext`，但对群聊明确设置 `updateLastRoute: undefined`；
- 因此通用的 session delivery hint 恢复逻辑无法从企微群 session 的 `lastTo` 找回原始大小写；
- 企微 session 的 `origin.to` 仍保留原始群 ID，可作为定时任务的恢复来源。

## 2. 私聊与普通群聊排查结论

### 2.1 私聊也存在大小写混合，但本次故障只在群聊复现

QA 日志中的企微私聊用户 ID 为 `YangShan`，对应 session key 同样被规范成 `direct:yangshan`，所以“私聊没有大小写混合”并不成立。

但同一批日志中，定时任务使用小写 `delivery.to=yangshan` 可以成功投递；所有 `93006` 均发生在任务切换为小写群 ID 后。结合企微插件行为，私聊与群聊存在两个差异：

- 私聊入站会额外记录 `lastRoute`，主动投递可复用最近路由信息；
- QA 使用的私聊用户 ID 即使以小写发送，也被企微接受；群 `chatid` 则不能改变大小写。

因此本次不修改私聊目标，不把企微所有 ID 一概改写，只恢复已确认有问题的群 `chatid`。

### 2.2 常规企微群聊回复不受影响

常规群聊的标准链路是“收到企微消息后回复该消息”。企微插件在这条链路中保留原始入站 frame：

- 普通消息使用 `replyStream(frame, ...)` 被动回复；
- 事件回调需要主动发送时，也从 `frame.body.chatid` 读取原始群 ID；
- session key 虽然为小写，但不参与本次回复的目标解析。

QA 日志也验证了这一点：混合大小写群 ID 的入站消息对应小写 session key，但普通回复收到 ack 并完成；相同群聊只有在 cron 主动投递使用小写 `delivery.to` 时失败。

### 2.3 其他主动发送仍需区分

企微插件的通用 outbound 最终会把调用方传入的 `to` 直接交给 `sendMessage(chatId, ...)`。因此，任何脱离入站 frame 的主动发送，只要其群目标来自小写 session key，都存在同类风险。

当前 LobsterAI 的常规企微群聊回复不走该路径，`IMGatewayManager.sendNotification` 也尚未为企微实现主动通知。本次只处理已经确认的定时任务创建、更新、手动执行和历史任务迁移，不修改企微插件、普通 IM 回复或通用 message tool 行为。若后续为常规 IM 增加主动群发能力，应单独复用“保留通道原生目标”的原则并补充测试。

## 3. 修复目标与约束

### 3.1 目标

- 新建或编辑企微群通知任务时，把小写 session peer 恢复为原始大小写群 `chatid`；
- 已保存小写群 ID 的历史企微任务，在启动迁移或手动执行前得到兼容修复；
- 已经保存为正确原始大小写的任务保持不变；
- 私聊及其他 IM 平台行为保持不变。

### 3.2 非目标

- 不改变 OpenClaw session key 的小写规范；
- 不修改企微插件或 OpenClaw runtime；
- 不改变群聊账号过滤、Agent 绑定、任务 payload、session target 等 #2306 既有行为；
- 不从不确定的历史 session 猜测账号或群 ID；
- 不扩展到普通 IM 回复和通用主动发送能力。

## 4. 实现方案

### 4.1 从 session origin 恢复企微群原生目标

在定时任务 helper 中增加企微群目标解析：

1. 只读取 `sessions.list` 返回的 `origin`；
2. 只接受 platform 为企微、`origin.chatType` 为 `group` 的记录；
3. 若任务已有 `accountId`，要求 `origin.accountId` 精确匹配；
4. 去除 `wecom:` 通道前缀后，以不区分大小写的方式匹配当前 peer；
5. 只有匹配结果对应唯一的原始群 ID 时才恢复；存在冲突则不修改。

这里不从 session key 生成大小写，也不采用“最新一条优先”的猜测策略。

### 4.2 新建与编辑任务

定时任务的本地规范化完成后，通过 gateway `sessions.list` 获取 origin 元数据。如果当前平台是企微且命中唯一群 origin，则将 `delivery.to` 替换为原始大小写群 ID。

对于已经是裸原生 ID 的企微目标，规范化阶段不再用小写 mapping 覆盖它，避免正确历史数据被降级。

### 4.3 历史任务兼容

启动迁移和手动执行前的单任务迁移只对“全小写企微目标”查询 gateway 并尝试恢复：

- 仅允许修改 `delivery.to` 的大小写；
- 不补充或修改 `accountId`；
- 不修改 Agent 绑定及其他任务字段；
- gateway 不可用、无匹配或存在冲突时保持原值，等待用户后续编辑选择，不做猜测。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 企微群 origin 与任务账号、peer 均匹配且目标唯一 | 恢复原始大小写群 ID |
| 同一账号出现多个仅大小写不同的原始群 ID | 视为冲突，不修改 |
| origin 是企微私聊 | 忽略，保持既有私聊行为 |
| origin 来自其他 IM 平台 | 忽略 |
| 任务已保存正确的混合大小写裸 ID | 原样保留，不连接 gateway 做历史修复 |
| 历史任务缺少账号 | 可以按唯一群 origin 恢复大小写，但不得补账号 |
| gateway 未就绪或 `sessions.list` 失败 | 保持原值，记录警告，不阻断任务管理 |

## 6. 涉及文件

- `src/main/ipcHandlers/scheduledTask/helpers.ts`
- `src/main/ipcHandlers/scheduledTask/helpers.test.ts`
- `src/main/ipcHandlers/scheduledTask/handlers.ts`
- `src/main/ipcHandlers/scheduledTask/handlers.test.ts`

不修改 `src/main/im/`、企微插件和 OpenClaw runtime。

## 7. 验收标准

- 企微混合大小写群 ID 经 session key 小写化后，新建/编辑定时任务仍保存原始群 ID；
- 已有全小写企微群任务可在迁移或手动执行前恢复原始大小写；
- 历史兼容只改变目标大小写，不推断账号，不改变其他任务行为；
- 正确的混合大小写目标、企微私聊、其他 IM 平台均保持原行为；
- 普通企微群聊回复继续复用入站 frame，不受本次修改影响；
- helper、handler 的定向测试及 scheduled task 全量测试通过；
- 变更文件 ESLint、Electron TypeScript 编译和 `git diff --check` 通过。
