# OpenClaw 历史回放字段校验修复设计文档

## 1. 概述

### 1.1 问题

旧任务连续出现 `Cannot read properties of undefined (reading 'trim')`，切换模型后仍然失败，
新建任务可暂时恢复。反馈日志中的失败发生在模型请求发出之前，说明异常位于本地请求准备阶段。

排查基于 LobsterAI 固定的 OpenClaw `v2026.8.1`。现有界面会话导出包含消息正文、工具名称、
工具输入和时间戳，但缺少原始内容块、工具调用 ID 和停止原因，无法据此确定用户旧任务中
具体哪条记录异常。需要原始 OpenClaw 会话 JSONL 或对应 agent 的 SQLite 数据库继续定位。

### 1.2 根因

已通过原版本源码和失败回归确认以下回放缺陷：

1. 核心转换器直接调用 `toolCall.id.trim()` 和 `toolResult.toolCallId.trim()`；缺失或非字符串
   ID 会在请求发送前抛出异常。
2. 部分转换路径直接读取 `text`、`thinking` 的字符串方法，历史内容块缺少字段或字段类型错误
   时会中断回放。空内容块也可能在访问 `type` 时抛出异常。
3. 核心转换器将非文本、非思考的内容块统一作为工具调用处理，使合法的提供商扩展块进入
   工具 ID 转换分支。

这些缺陷能够解释本地回放失败，但现有资料不足以证明该次反馈具体命中了哪个字段。
本次处理历史回放校验和记录定位；实时响应中的工具调用解析异常另行处理。

## 2. 用户场景

| 场景 | 预期行为 |
| --- | --- |
| 旧任务包含缺失 ID、错误类型字段或空内容块 | 本次请求排除不安全内容，保留可用历史并记录位置。 |
| 异常块与合法文本、工具调用共存 | 普通消息保留合法相邻内容，后续请求可以继续发送。 |
| 提供商返回签名思考内容或扩展块 | 合法内容及签名按原有提供商契约回放。 |
| 工具 ID 在后续轮次复用，或结果延迟到达 | 结果仍归属正确轮次，避免误配到更早的调用。 |
| 排查旧任务中的异常记录 | 只读扫描原始会话，输出可核对的文件行号或数据库序号。 |

## 3. 功能需求

- FR-1：在执行字符串转换前校验 assistant 的工具 ID、文本和思考字段，以及工具结果 ID。
- FR-2：保留提供商扩展块、合法空思考字符串及签名、现有工具参数格式兼容和旧版结果配对能力。
- FR-3：校验只作用于本次请求的内存历史，保持持久化记录不变，且重复校验结果稳定。
- FR-4：诊断日志限制输出数量，仅包含结构位置和字段名；定位工具提供原始记录行号或序号。
- FR-5：通过版本补丁交付，同时登记补丁清单、应用结果强校验和回归测试。

## 4. 实现方案

### 4.1 共享回放校验

新增 `packages/ai/src/transcript-replay-validation.ts`，由核心
`transcript-transform.ts` 和配置了自定义传输的 `transport-message-transform.ts` 共同调用。
校验发生在原有字段转换之前；随后继续使用原有 ID 归一化顺序和失败消息过滤策略。

| 字段或形状 | 校验及处理 |
| --- | --- |
| assistant 内容块为空或不是对象 | 排除该块并记录块索引。 |
| `text`、`thinking` | 接受字符串，包括空字符串；错误类型的已知块被排除。 |
| `toolCall.id` | 要求非空字符串，空白 ID 视为无效；保留原有合法 ID 归一化。 |
| `toolResult.toolCallId` | 核心入口排除无效 ID；具备旧版身份恢复能力的传输保留结果给原配对器处理。 |
| 未知提供商内容块 | 原样保留，由具体传输解释；不进入工具 ID 转换分支。 |
| 工具名称和参数表示 | 继续由原有传输处理，包括其支持的字符串参数。 |

### 4.2 签名内容与工具结果归属

如果需要排除签名 assistant 消息中的某个块，将该消息标记为不可回放的失败轮次，
保留其中有效的调用身份，供原配对逻辑识别。合法签名内容保持原值。

针对失败轮次，只排除相邻结果中能够通过已知 ID 确认归属的记录。遇到新的消息边界后
清空局部排除集合，避免后续复用同一 ID 的调用受影响。此前成功轮次的延迟结果、压缩窗口
保留的结果，以及原配对器能够恢复的旧版 ID，继续沿既有规则处理。

### 4.3 诊断日志和只读定位工具

运行时警告以 `[transcript-replay]` 为前缀，记录异常总数以及最多 8 个位置。
位置包含从 0 开始的消息索引和块索引、时间戳、字段名及处理动作，不包含正文、工具参数或签名。
运行时索引对应当前请求历史，可能与压缩或过滤前的原始记录位置不同。

`scripts/diagnose-openclaw-replay.cjs` 复用同一校验器，支持两种输入：

- 原始 JSONL：输出从 1 开始的文件行号及记录 ID。
- agent SQLite：要求显式指定 OpenClaw 会话 ID，读取 `transcript_events`，输出 `seq` 和记录 ID。

工具通过只读连接访问数据库，输出最多 200 个位置，并保留完整异常计数。
扫描范围是指定会话的已存储记录，包含历史分支，结果用于提供候选位置；需结合当前请求日志
确认实际回放范围。严格扫描报告的旧版结果 ID，仍可能由部分传输的配对器恢复。

在 LobsterAI 源码目录中使用 Node 24 和已应用补丁的 OpenClaw 源码运行：

```powershell
$env:OPENCLAW_SRC = 'D:\path\to\patched-openclaw'
node scripts/diagnose-openclaw-replay.cjs 'D:\diagnostics\session.jsonl'
node scripts/diagnose-openclaw-replay.cjs 'D:\diagnostics\openclaw-agent.sqlite' --session '<OpenClaw 会话 ID>'
```

agent 数据库通常位于 `<OpenClaw state>/agents/<agent ID>/agent/openclaw-agent.sqlite`。
运行中的 WAL 数据库应原地只读访问，或使用包含未归并数据的一致备份。界面导出的会话 JSON
不包含回放所需字段，工具会明确拒绝，避免把导出时省略的字段误判为原始数据损坏。

### 4.4 集成与涉及文件

问题位于 OpenClaw 内部的模型消息转换边界，LobsterAI 配置同步无法直接替代这些转换，
因此使用 `v2026.8.1` 版本补丁。上游在两个入口提供等价校验并通过相关兼容性用例后，移除补丁。

| 文件 | 职责 |
| --- | --- |
| `scripts/patches/v2026.8.1/openclaw-transcript-replay-validation.patch` | 共享校验、两个入口接入及上游回归用例。 |
| `scripts/apply-openclaw-patches.cjs` | 验证校验器、入口调用和导出已实际应用。 |
| `src/main/libs/openclawPatches/v20260801UpgradeDecisions.test.ts` | 登记当前版本补丁集合。 |
| `scripts/diagnose-openclaw-replay.cjs` | 只读定位原始异常记录。 |
| `tests/openclawReplayDiagnostics.test.ts` | 使用补丁中的实际校验器验证 JSONL、SQLite、输出上限和内容保护。 |

## 5. 边界情况

| 情况 | 处理方式 |
| --- | --- |
| 合法空字符串思考内容带有签名 | 保留签名及内容，由原传输规则决定回放。 |
| 签名消息中存在错误类型的文本块 | 隔离该消息，保留配对所需的有效调用身份。 |
| 失败结果跨越用户消息，且需要归一化 ID | 保持原转换顺序，避免绕过失败轮次的 ID 映射。 |
| 多次复用工具 ID | 局部排除结果与既有配对规则协作，保留后续合法调用。 |
| 原始记录 JSON 无法解析 | 只报告行号或序号，不回显错误正文。 |
| 扫描数据超过输出上限 | 标记截断并返回总数，避免诊断输出随数据量无限增长。 |

## 6. 验收标准

1. 缺失、空白和非字符串 ID，以及空块、错误类型的文本或思考内容，不再导致本次修复覆盖的
   回放入口在字符串转换处抛出异常。
2. 合法签名、提供商扩展块、旧版工具参数、重复 ID、延迟结果和压缩窗口用例通过。
3. 对同一异常历史连续执行两次真实 Chat Completions SDK 请求，本地模拟服务均收到请求，
   并能返回成功响应；输入历史保持不变。
4. 定位工具准确报告 JSONL 行号和 SQLite 序号，按会话筛选，保持输入文件字节不变，输出受限
   且不包含正文或工具参数。
5. 补丁可应用到原始固定版本，并通过现有补丁集的重复应用验证。

验证命令：

```powershell
# LobsterAI 目录
npm test -- openclawReplayDiagnostics v20260801UpgradeDecisions
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/openclawPatches/v20260801UpgradeDecisions.test.ts tests/openclawReplayDiagnostics.test.ts
npm run compile:electron

# 已应用补丁的 OpenClaw 目录
node scripts/run-vitest.mjs run packages/ai/src/transcript-replay-validation.test.ts packages/ai/src/openai-completions-messages.test.ts packages/ai/src/providers/transform-messages.test.ts --config test/vitest/vitest.unit.config.ts
node scripts/run-vitest.mjs run src/agents/transport-message-transform.test.ts src/agents/transport-message-replay-validation.test.ts --config test/vitest/vitest.unit-fast.config.ts
```

上述定向测试合计 89 项通过，覆盖两条回放入口和定位工具；改动文件 lint 与 Electron 编译通过。
版本补丁只有在重建捆绑运行时后才进入桌面应用，打包后的实机复测尚未完成。
用户具体异常记录仍需原始会话数据确认。
