# 桌面端系统提示词重复注入设计文档

## 1. 概述

### 1.1 问题

Issue #2440：桌面端（`lobsterai` 通道）会话的首条用户消息里会注入一个 `[LobsterAI system instructions]` 块，其中大部分内容与该 agent 工作区 `AGENTS.md` 托管区逐字相同。OpenClaw 已经把整个 `AGENTS.md` 放进系统提示词，同一份指令会被模型读两遍。

注入并不只发生在首轮。以下情况都会把整块内容再注入一次：

- 选中的技能或套件发生变化；
- 开启或退出计划模式；
- 应用重启后继续旧会话（`lastSystemPromptBySession` 只保存在内存中）。

### 1.2 根因

同一份静态指令有两条注入路径，彼此不知道对方存在：

1. `OpenClawConfigSync.syncAgentsMd()` 把默认系统提示词（`resources/SYSTEM_PROMPT.md`，仅 main agent）和定时任务提示词（`buildScheduledTaskEnginePrompt()`，所有 agent）写进 `AGENTS.md` 托管区。OpenClaw 会把 `AGENTS.md` 作为工作区上下文注入每个会话的系统提示词。
2. 渲染层把 `config.systemPrompt` 拼进会话 systemPrompt，主进程的 `mergeCoworkSystemPrompt()` 再拼上定时任务提示词，然后由 `OpenClawRuntimeAdapter.buildOutboundPrompt()` 注入首条消息。

排查中还发现：OpenClaw v2026.8.1 会截断超过 20,000 字符（`DEFAULT_BOOTSTRAP_MAX_CHARS`）的 bootstrap 文件。部分工作区的 `AGENTS.md` 已经超过这个上限，原因是旧模板遗留的段落加上托管区内容。被截断时，托管区的大部分内容只剩“策略摘要”，这时首轮注入反而是这些指令唯一完整的来源，不能简单删掉注入。

## 2. 用户场景

- 用户在桌面端新建会话。目前首条消息额外携带约 4.5K 字符（定时任务提示词约 2.3K + 默认系统提示词约 2.2K），其中已在 `AGENTS.md` 中的部分是重复的。
- 用户切换技能、计划模式，或重启应用后继续会话，都会再次重复注入同样的内容。
- 自定义（非 main）agent 的 `AGENTS.md` 只包含定时任务提示词，不包含默认系统提示词。它的首轮注入中只有定时任务部分是重复的。

## 3. 功能需求

1. 首轮注入块不再重复 `AGENTS.md` 已经完整送达给模型的段落。
2. 不能丢失任何指令。`AGENTS.md` 缺失、内容不同或会被 OpenClaw 截断时，保持原样注入。
3. 保持现有注入语义不变：
   - 是否注入仍按完整 systemPrompt 的变化判断；
   - 计划模式退出、技能变化、重启后继续都与现在一致；
   - 动态指令（计划模式、选中技能/套件、媒体生成指令）照常注入。

## 4. 实现方案

- 新增纯函数模块 `src/main/libs/agentEngine/workspaceDeliveredInstructions.ts`：
  - `removeWorkspaceDeliveredSections(systemPrompt, agentsMdContent, sections, maxChars)`：
    - 只在 `AGENTS.md` 存在且 `trimEnd()` 后的长度不超过 `OPENCLAW_BOOTSTRAP_MAX_CHARS`（20,000，与 OpenClaw 默认值一致；LobsterAI 未配置 `agents.defaults.bootstrapMaxChars`）时处理；
    - 移除在 `AGENTS.md` 中逐字存在的段落，再收拢多余空行。
  - `removeWorkspaceDeliveredInstructions({ systemPrompt, stateDir, agentId, defaultSystemPrompt })`：
    - 读取 agent 工作区的 `AGENTS.md`：main 对应 `workspace-main`，其他 agent 对应 `workspace-<agentId>`；
    - 候选段落为默认系统提示词和定时任务提示词，与 `syncAgentsMd()` 写入的内容同源。
- `OpenClawRuntimeAdapter.buildOutboundPrompt()`：
  - 仅在需要注入时调用上述函数生成注入正文。
  - 比较失败时记录 warn 日志，并回退为完整注入。
  - 去重后正文为空时，注入块保留标题和“替换旧指令”的说明，并附一行“No session-specific instructions apply; follow the workspace instructions in AGENTS.md.”，确保旧的会话级指令（如计划模式）被替换。
- 渲染层、主进程会话 IPC 和持久化的会话 systemPrompt 都不改。老会话中持久化的完整 prompt 在注入时同样会被去重。

## 5. 边界情况

- `AGENTS.md` 超过 20,000 字符：OpenClaw 会截断，保持完整注入。模板区瘦身（清理旧模板中的主动巡检段和 TOOLS.md 迁移示例）另行处理。
- 非 main agent：其 `AGENTS.md` 中的 System Prompt 是 agent 自己的提示词，默认系统提示词不会被移除，只移除定时任务提示词。
- 工作区还没有 `AGENTS.md`（例如刚创建的 agent 尚未同步）：保持完整注入。
- 用户手动修改了托管区内容：只有逐字一致的段落才会被移除，其余保持注入。
- 读取文件或获取配置失败：记录 warn 日志，保持完整注入。

## 6. 验收标准

- `npm test -- workspaceDeliveredInstructions` 通过，覆盖：
  - 移除已送达的段落；
  - 全部已送达时返回空正文；
  - 非 main agent 保留默认提示词；
  - 文件缺失或超出上限时保持原样。
- `npm test -- openclawRuntimeAdapter` 通过，新增用例验证：
  - `chat.send` 的消息中不再包含 `AGENTS.md` 已送达的段落，动态指令仍在；
  - 全部去重后仍发出“替换旧指令”的注入块；
  - `AGENTS.md` 超出上限时保留完整内容。
- 手动验证：在 `AGENTS.md` 不超过 20,000 字符的 agent 下新建桌面会话，首条消息的注入块中不再出现 `## Scheduled Tasks`。main agent 的 `AGENTS.md` 在上限内时，`# Style` 等默认系统提示词段落也不再出现。
