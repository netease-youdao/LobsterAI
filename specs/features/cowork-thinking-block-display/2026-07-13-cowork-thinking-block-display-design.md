# Cowork Thinking Block 顺序分块展示设计文档

## 1. 概述

### 1.1 背景与历史

LobsterAI 在 2026 年 5 月 20 日合入 PR #2019（`feat/model-custom-params`）。其中提交
`d989c082` 为 thinking 内容建立了独立消息生命周期，`e5dc5396` 与 `9df3f2ae` 补充了
`beforeMessageId` 链路，使单个 thinking block 可以显示在普通 assistant 回复之前。

当时 OpenClaw 提供给 LobsterAI 的实时事件不能稳定表达多轮工具调用之间的 thinking
边界，因此实现把当前轮次的 thinking 内容合并为一个消息。其结果是：

1. thinking 有时只能在最终 history 同步时获取，显示位置落在普通回复或工具消息之后；
2. 多轮“思考 → 工具 → 思考 → 工具”被合并，无法按真实顺序分块；
3. 实时事件与最终 history 同时存在时，需要避免把同一 thinking 显示两次。

当前项目固定使用 OpenClaw `v2026.6.1`。该版本的 `chat.history` 已保留 assistant
消息中的结构化 thinking 与 tool call 边界；会话设置为 `reasoningLevel: 'stream'` 时，
支持的模型还可以产生 `agent stream=thinking` 增量事件。因此 LobsterAI 可以采用
“实时流用于尽早展示、结构化 history 用于确定顺序和最终对账”的双通道方案。

仓库此前没有专门描述 thinking block UI 展示的 spec。以下文档同时记录既有能力和本次
顺序分块方案。模型协议侧的 reasoning/thinking 回放不在本文范围，详见
`specs/bugfixes/deepseek-mimo-reasoning-content-replay/`。

### 1.2 目标

1. 每一轮工具调用前的 thinking 独立展示，并位于对应 `tool_use` 之前。
2. 最终可见回复前的 thinking 独立展示，并位于对应 assistant 回复之前。
3. 有 thinking stream 时立即增量展示；没有 thinking stream 时仍能通过 history 分块展示。
4. history 是内容、边界和最终状态的权威来源，对账过程必须幂等。
5. 长工具链超过本地消息分页窗口后，最终对账不得重复插入已存在的 thinking block。
6. thinking 正文不得写入常规诊断日志，IM outbound 继续过滤 thinking 消息。

### 1.3 非目标

- 不从普通 assistant 文本推测或生成模型未提供的思考内容。
- 不修改 provider 的 reasoning/thinking 请求格式或历史回放策略。
- 不改变 thinking block 的折叠样式、埋点语义和 IM 投递规则。
- 不保证所有模型都提供实时 thinking stream；history-only 是受支持的正常路径。

## 2. 用户场景

### 场景 1：模型提供实时 thinking stream

**Given** 当前模型支持 thinking，OpenClaw 发出 `agent stream=thinking` 事件

**When** thinking 增量到达，随后模型调用工具

**Then** UI 立即更新一个临时 thinking 消息，并在工具开始时将其定稿、放在对应工具之前；
history 到达后复用同一消息并补充稳定 key，不创建第二份。

### 场景 2：模型只在 history 中保留 thinking

**Given** 当前模型没有发送实时 thinking 事件，但 `chat.history` 包含结构化 thinking

**When** 工具开始或当前轮次结束

**Then** LobsterAI 从 history 提取当前用户轮次的 thinking，并按 assistant/tool 边界插入
到相应工具或最终回复之前。

### 场景 3：多轮工具调用

**Given** history 的顺序为“thinking A → tool A → thinking B → tool B → thinking C → final”

**When** LobsterAI 进行增量同步和最终对账

**Then** UI 以三个独立 thinking block 展示 A、B、C，分别位于 tool A、tool B 和 final 前；
重复对账不改变消息数量和顺序。

### 场景 4：长轮次超过 30 条本地消息

**Given** thinking A 已经展示，但之后产生大量工具消息，使 A 离开 `getSession()` 默认返回的
最近 30 条消息窗口

**When** 最终 history 再次包含 thinking A

**Then** 对账通过当前活动轮次的稳定 key 索引找到 A 的本地消息 ID，更新原消息而不是插入副本。

## 3. 功能需求

### FR-1：启用 OpenClaw thinking stream

对 LobsterAI 管理的 OpenClaw 会话应用模型覆盖时，同时写入
`reasoningLevel: 'stream'`。不支持 thinking 的模型可以忽略该设置，LobsterAI 必须继续支持
history-only 路径。

### FR-2：结构化分块与稳定 key

只处理当前最后一个 user message 之后的 assistant thinking。每个 thinking block 生成稳定 key：

- 工具前 thinking：`tool:<toolCallId>:thinking:<ordinal>`；
- 最终无工具锚点 thinking：`final:thinking:<contentFingerprint>`；
- 同一基础 key 冲突时追加出现序号。

key 和工具锚点写入 thinking 消息 metadata，分别为 `openclawThinkingKey` 和
`openclawThinkingAnchorToolCallId`。

### FR-3：顺序锚定

- 有工具锚点的 thinking 使用对应本地 `tool_use` 消息 ID 作为 `beforeMessageId`；
- 最终 thinking 使用当前最终 assistant 消息 ID 作为 `beforeMessageId`；
- 如果锚点尚不存在，先等待工具事件或最终对账，不凭内容猜测工具位置。

### FR-4：实时临时消息复用

实时 thinking 消息先以 `isStreaming: true, isFinal: false` 展示。工具边界或轮次结束时将其定稿。
history 对账优先按稳定 key 复用；尚未分配 key 时，可复用锚点之前、正文完全相同且未被其他
block 占用的临时 thinking 消息。

### FR-5：分页无关的幂等性

当前活动轮次维护 `Map<openclawThinkingKey, localMessageId>`。对账查找顺序为：

1. 当前活动轮次 key 索引；
2. 当前已加载本地消息中的相同 metadata key；
3. 锚点前正文完全相同的无 key 临时 thinking；
4. 创建新消息。

`getSession()` 的默认分页尾页只能作为复用候选来源，不能作为“消息是否存在”的唯一依据。
工具开始时若已有实时 thinking 消息，应立即把工具稳定 key 与该消息 ID 建立索引，以便它在
history 同步前滑出分页窗口时仍可复用。

### FR-6：安全诊断

诊断日志由 `LOBSTERAI_THINKING_DIAGNOSTICS=1` 显式开启，只记录事件类型、session/run 标识、
稳定 key、字符数和锚点，不记录 thinking 正文。

## 4. 实现方案

### 4.1 数据流

1. `agent stream=thinking` 更新当前临时 thinking 消息。
2. `agent stream=tool phase=start` 定稿临时消息、建立工具 key 索引、创建 `tool_use`，并防抖请求
   `chat.history`。
3. 增量 history 只物化已经有本地工具锚点的 thinking block。
4. `chat.final` 或 lifecycle fallback 获取最终 history，并允许物化最后一个无工具锚点的 thinking。
5. 对账模块根据稳定 key 更新或插入消息；renderer 继续通过既有 `beforeMessageId` 链路维持顺序。

### 4.2 模块边界

- `thinking/blocks.ts`：纯解析；从 OpenClaw history 提取当前轮次结构化 block 和稳定 key。
- `thinking/controller.ts`：thinking 活动轮次状态、实时消息创建/更新/定稿、工具锚点注册，
  并统一调用 history 对账。
- `thinking/reconciliation.ts`：纯对账编排；选择可物化 block、维护 key 索引、复用/更新/
  插入本地消息，不承担 gateway 生命周期。
- `openclawTurnHistorySync.ts`：统一管理工具边界 thinking 同步与空 tool result 回填的防抖、
  history 请求、turn token 过期校验、失败重试和 timer 清理。
- `thinking/diagnostics.ts`：安全诊断摘要，不接收或输出正文。
- `openclawRuntimeAdapter.ts`：只负责 OpenClaw 事件、history 请求时机、当前活动轮次状态和 IPC 事件。

该拆分避免继续扩大运行时适配器，也使分页、幂等和顺序规则可以脱离 Electron gateway 单独测试。

### 4.3 重复问题根因与修复

2026 年 7 月 13 日的实际日志显示，工具边界增量同步已经为前六个 thinking block 创建了带稳定
key 的消息；最终对账却再次为相同 key 创建消息。SQLite 中对应正文、key 和工具锚点完全相同。

根因是 `CoworkStore.getSession(sessionId)` 默认只读取最近 30 条消息。长工具链结束时，早期
thinking 已经离开这个窗口，旧对账逻辑因而误判它们不存在；较晚、仍位于窗口内的 thinking
没有重复，这与日志和数据库现象一致。

修复后，活动轮次的 key 索引是首要身份来源。即使本地分页尾页已经看不到消息，对账仍直接按
原消息 ID 更新 SQLite 和 renderer，不再创建副本。

## 5. 边界情况

| 场景                                         | 处理方式                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 没有 `agent stream=thinking`                 | 在工具边界和 final 通过 history 分块物化                                                 |
| thinking-only 后直接调用工具                 | 即使没有普通 assistant 文本，也先定稿 thinking 再创建工具消息                            |
| 同一 thinking 正文重复出现                   | 工具 block 以 tool call ID 区分；最终 block 使用指纹加冲突序号                           |
| 一个 assistant message 含多个 thinking block | 按 content index 和 ordinal 生成不同 key 并保持原顺序                                    |
| history 暂时没有对应工具锚点                 | 增量阶段跳过，后续工具事件或 final 再对账                                                |
| 增量 history 请求失败                        | 不删除已流式展示内容；最终对账继续补齐                                                   |
| 本地消息超过默认 30 条分页                   | 通过活动轮次 key 索引复用，不依赖分页可见性                                              |
| 应用重启后恢复旧的未完成轮次                 | 不依赖内存索引恢复；已持久化 metadata key 可在加载到的消息中复用，完整跨重启恢复另行设计 |
| 模型最终没有可见回复                         | 保持现有 thinking-only / retry / compaction 兜底，不把 thinking 当普通回复               |
| IM 渠道                                      | 继续排除 `metadata.isThinking === true` 的消息                                           |

## 6. 涉及文件

| 文件                                                        | 职责                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `src/common/openclawSession.ts`                             | OpenClaw session reasoning level 常量与类型                      |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`       | OpenClaw 事件路由，并把 thinking 与 history 同步委托给独立控制器 |
| `src/main/libs/agentEngine/thinking/blocks.ts`              | history thinking 分块和稳定 key                                  |
| `src/main/libs/agentEngine/thinking/controller.ts`          | thinking 状态与实时消息生命周期                                  |
| `src/main/libs/agentEngine/thinking/reconciliation.ts`      | 分页无关的本地消息对账                                           |
| `src/main/libs/agentEngine/thinking/diagnostics.ts`         | 可选安全诊断                                                     |
| `src/main/libs/agentEngine/openclawTurnHistorySync.ts`      | thinking/tool-result history 防抖调度与过期保护                  |
| `src/main/libs/agentEngine/thinking/blocks.test.ts`         | history 解析与 key 测试                                          |
| `src/main/libs/agentEngine/thinking/controller.test.ts`     | thinking stream、定稿、工具锚定和临时消息复用测试                |
| `src/main/libs/agentEngine/thinking/reconciliation.test.ts` | 多轮顺序、实时复用、分页回归测试                                 |
| `src/main/libs/agentEngine/openclawTurnHistorySync.test.ts` | 防抖合并、过期丢弃、失败重试和清理测试                           |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`  | session patch 和运行时集成路径测试                               |

## 7. 验收标准

1. 有实时 thinking 事件时，thinking 在生成过程中可见，并在工具开始后保持在对应工具之前。
2. 没有实时 thinking 事件时，多轮 history 能生成多个独立 thinking block，顺序与 OpenClaw
   assistant/tool 边界一致。
3. 同一 history 重复执行增量和最终对账，thinking 消息数量不增加。
4. thinking 消息滑出本地最近 30 条分页后再次最终对账，仍只保留一份。
5. 最终无工具锚点 thinking 位于最终 assistant 回复之前。
6. thinking 内容不进入普通 assistant 回复或 IM outbound。
7. 诊断未开启时不增加高频日志；开启时日志不包含 thinking 正文。
8. thinking 解析、对账、运行时相关 Vitest 通过，触及文件 ESLint 零警告，Electron main TypeScript
   编译通过。
