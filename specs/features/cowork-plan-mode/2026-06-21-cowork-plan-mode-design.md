# LobsterAI Cowork 计划模式设计文档

## 1. 概述

### 1.1 问题/背景

LobsterAI Cowork 默认以执行任务为目标：模型可以读取项目、调用工具、修改文件并验证结果。但在需求尚未明确、改动范围较大或用户希望先审阅方案时，直接执行会增加返工和误修改风险。

计划模式用于把一次 Cowork 提交切换为“先调研、再形成决策完整计划”的协作模式。它不是普通提示词模板，也不是模型自由发挥的展示样式，而是一组跨 Renderer、IPC、OpenClaw runtime、消息持久化和会话分叉的行为约束。

本功能在早期实现和联调中出现过以下回归，后续修改必须把这些问题视为同一状态机的完整性问题，不能只做局部补丁：

- 计划模式提示被持久化到 session，用户说“按照计划实现”后仍重复输出计划，不执行文件修改。
- 模型返回短前言或仅思考内容时，计划 recovery 重复触发，产生空计划、重复计划或第二次计划。
- recovery 自动续写期间使用普通 800ms 收尾窗口，导致完整模型输出只落库到“颜色和”等半句话。
- 只读 `exec` 组合命令被误判为写命令，计划模式直接终止。
- 计划块流式输出时短暂展示 `<proposed_plan>` 标签。
- 从计划消息处分叉时，陈旧的 `isStreaming: true` 元数据导致计划消息未复制到新会话。
- 拆分计划卡片时删除了原消息复制按钮，改变既有消息操作流程。
- 计划卡片重新实现复制按钮和图标颜色，没有复用消息操作组件与主题 token。

因此，本文把计划模式定义为可验证的产品状态机，明确模式边界、提示词生命周期、工具策略、流式完成协议、消息展示、分叉语义和回归标准。后续实现必须以本文为准；如果代码行为与本文冲突，应先更新设计并评审，再修改实现。

### 1.2 目标

1. 在 Cowork 输入框加号弹层中提供“计划模式”开关，交互与现有附件、技能入口一致。
2. 计划模式状态保留在当前 draft/session 输入框上，直到用户手动关闭或明确确认执行，不改变新会话和普通对话的默认行为。
3. 模型在计划模式下可以进行只读调研，但不能修改文件、数据库、Git 状态或系统状态。
4. 模型最终输出决策完整、可执行、可审阅的计划，而不是一句前言或过度精简摘要。
5. `<proposed_plan>` 作为机器可识别协议，不作为用户可见正文展示。
6. 计划内容以独立计划卡片展示，并支持复制、下载、展开和收起。
7. 计划输出完成后进入“待确认”状态，用户明确批准计划并要求实现时，当前轮立即退出计划模式并恢复正常执行能力。
8. 计划消息可以正常复制、分叉、持久化和恢复，不丢失计划正文。
9. 普通对话、普通工具调用、技能选择、附件、媒体生成和历史消息展示不受计划模式实现影响。
10. 兼容 macOS、Windows 和常见窗口尺寸，不新增数据库迁移和老用户升级风险。

### 1.3 非目标

- 不实现 Codex 完整的服务端 collaboration mode 协议；当前由 LobsterAI 在每轮 system prompt 和 runtime 约束中实现。
- 不要求所有模型原生支持 `<proposed_plan>`；客户端必须能够对缺少标签但内容完整的结果进行规范化。
- 不把计划内容拆成新的数据库 message type；第一阶段继续保存为 assistant 原始文本。
- 不自动执行计划。只有用户明确发送实现指令后，才进入普通执行轮次。
- 不允许计划模式执行测试、构建或命令仅因为其通常“看起来安全”；是否允许取决于命令是否只读且不会写入持久状态。
- 不通过删除、改写历史消息来修复旧会话中的残缺计划。

## 2. 产品逻辑与 Codex 模型

### 2.1 产品逻辑

计划模式解决的是“是否开始执行”的协作阶段问题：

```text
默认模式
  -> 用户打开计划模式
计划调研轮次
  -> 只读检查项目和上下文
计划输出
  -> 用户审阅、补充或批准
用户批准实现
  -> 当前轮恢复默认模式
执行与验证
```

计划模式不是全局永久属性。它是输入草稿/session 上的 collaboration mode：

- 用户打开开关后，当前 draft/session 后续提交持续按计划模式发送。
- 计划输出完成后，最新计划进入待确认状态，UI 提供“确认执行”和“调整方案”快捷操作。
- 用户点击“调整方案”或直接输入补充/修改诉求时，继续按计划模式发送并重新生成计划。
- 用户点击“确认执行”或直接输入明确执行意图时，当前提交切换为默认模式，恢复写工具和验证工具能力。
- 用户手动关闭计划模式、新建会话或切换到新的空白 draft 时，清理对应 draft/session 的计划状态。
- 用户说“按照计划实现吧”时，即使 UI 仍错误保留计划开关，Renderer 和 Main runtime 也必须双重兜底退出计划模式。

### 2.2 与 Codex 的对齐边界

LobsterAI 参考 Codex 的以下产品语义：

- 先调研和追问，再输出完整计划。
- 计划阶段不直接修改文件。
- 最终计划使用结构化边界，客户端渲染为独立内容块。
- 用户批准后进入执行阶段，不再次生成同一计划。

LobsterAI 与 Codex 的实现不同：

- LobsterAI 当前 Agent 引擎是 OpenClaw，不依赖 Codex app-server 的 collaboration mode 类型。
- 计划模式提示由 Renderer 构造并作为当前轮 system prompt 传入 Main。
- Main runtime 负责工具安全、输出规范化、恢复和历史同步。
- Renderer 通过解析 assistant 原始文本中的 `<proposed_plan>` 渲染计划卡片。

### 2.3 模型依赖与客户端责任

模型能力会影响计划质量，但不能决定功能是否可靠：

- 模型应遵守计划提示并优先输出 `<proposed_plan>`。
- 如果模型输出完整计划但缺少标签，客户端在稳定 final 阶段补充标签。
- 如果模型只输出短前言或仅思考内容，客户端最多触发一次隐藏 recovery。
- 如果模型已经输出完整计划，客户端不得再次 recovery。
- 如果 recovery 后 OpenClaw 自动续写，客户端必须保持 turn 打开并从权威历史回收完整结果。
- 客户端不得在流式阶段凭空补全计划正文，也不得把明显残缺内容伪装成完整计划。

## 3. 系统不变量

以下规则是本功能不可破坏的系统不变量。任何相关代码修改都必须逐项验证。

### INV-1: 普通对话隔离

未开启计划模式时：

- 不注入 `# Plan Mode`。
- 不注入 `[Plan Mode reminder]`。
- 不注入 `[Plan Mode recovery instruction]`。
- 不启用计划工具拦截。
- 不执行计划完整性检测或 recovery。
- 不改变技能、附件、媒体和工具权限流程。

### INV-2: 计划提示仅当前 runtime 请求有效

- `# Plan Mode` 只用于当前 runtime 请求。
- `cowork_sessions.system_prompt` 不得持久化计划模式提示。
- 新 session 应持久化用户基础 system prompt，而不是本轮计划提示。
- 继续旧 session 时，如果检测到历史版本错误持久化的计划提示，应清理并恢复基础配置。
- `mergeCoworkSystemPrompt()` 必须幂等，不能重复拼接 Scheduled Tasks 等固定段落。
- 计划模式 UI 状态可以保留在当前 draft/session，但不得把 Plan prompt 持久化为 session system prompt。

### INV-3: 批准实现必须退出计划模式

当用户明确表达“按照计划实现”“开始执行这个计划”“Go ahead and implement the plan”等意图时：

- Renderer 当前提交必须使用 `CoworkCollaborationMode.Default`。
- 当前提交必须恢复 selected kit/skill routing。
- Main runtime 即使收到旧 Renderer 发送的 Plan prompt，也必须追加 execution override 并关闭计划工具限制。
- 仅当历史中存在完整 `<proposed_plan>` 时，Main 才使用“批准既有计划”兜底，避免普通语句误触发。
- 不得再次输出 `<proposed_plan>` 或触发计划 recovery。

### INV-4: 计划消息完整性

一个可完成的计划必须满足以下至少一类条件：

- 存在足够的结构化条目；或
- 同时包含 Summary、Implementation Approach、Key Changes、Validation、Assumptions or Questions 等主要章节和足够正文。

短前言、“Here is the plan”、仅环境说明、仅思考内容或明显半句话都不是完整计划。

### INV-5: Recovery 最多一次

- 每个 turn 最多发送一次 `[Plan Mode recovery instruction]`。
- 工具调用边界期间不能触发 recovery。
- recovery 请求失败时必须回滚 turn 内存状态，保留原响应。
- recovery 后收到不完整 final 时必须等待 OpenClaw 自动续写，不能使用普通 800ms 窗口提前完成。
- 完成 recovery 前必须从 `chat.history` 同步权威全文。

### INV-6: 分叉保留选中的计划消息

- 从计划消息处分叉时，新 session 必须包含该计划消息。
- 如果所选消息残留 `isStreaming: true`，但源 session 已停止，仍应复制所选消息。
- 复制时清除 streaming/tool request/run 等运行态 metadata，并将该 assistant 消息规范化为 final。
- 其他未被明确选择的未完成 streaming assistant 消息继续过滤。

### INV-7: 原消息能力不回归

- 计划卡片与普通正文可以视觉分离，但数据库中仍是同一 assistant 消息。
- 原消息时间、模型、分叉和复制操作必须保留。
- 原消息复制按钮复制该 assistant 消息的完整可见内容。
- 计划卡片顶部复制按钮只复制计划正文。
- 新增计划卡片不能删除或替换既有消息操作入口。

## 4. 用户场景

### 场景 1: 空项目生成计划

**Given** 用户选择一个空工作目录并打开计划模式  
**When** 用户要求创建一个网页  
**Then** Agent 可以使用只读工具检查目录  
**And** 不创建或修改任何文件  
**And** 最终展示完整计划卡片

### 场景 2: 已有项目调研

**Given** 工作目录包含代码和配置  
**When** 用户开启计划模式并请求新增功能  
**Then** Agent 可以组合使用 `ls`、`rg`、`cat`、`head`、只读 `git` 等命令  
**And** 可以读取技能指南  
**And** 不因只读复合命令而终止计划模式

### 场景 3: 阻止写操作

**Given** 当前轮是计划模式  
**When** 模型尝试 `write`、`edit`、`apply_patch`、`git branch`、`sed -i`、文件重定向或其他写操作  
**Then** Main runtime 在收到 tool start 事件后立即 abort 当前 run  
**And** UI 不展示可能干扰用户的内部阻止消息
**And** 首次阻止后自动发起一次禁止使用工具的隐藏恢复请求，继续输出完整计划  
**And** 同一 turn 再次尝试写操作时终止，不循环恢复  
**And** 日志记录 tool、session 和判定原因

### 场景 4: 用户批准计划

**Given** 历史中已有完整计划  
**When** 用户点击“确认执行”或发送“按照计划实现吧”
**Then** 当前轮退出计划模式  
**And** Agent 可以正常修改文件和执行验证  
**And** 不重复输出计划

### 场景 4.1: 用户调整计划

**Given** 最新 assistant 消息包含完整计划并处于待确认状态
**When** 用户点击“调整方案”或直接输入修改诉求
**Then** 输入框保持计划模式
**And** 旧计划确认按钮失效
**And** Agent 重新输出一份新的计划
**And** 新计划完成后再次进入待确认状态

### 场景 5: 模型先输出短前言

**Given** 模型在调研后只输出一句前言  
**When** turn 到达稳定 final  
**Then** 客户端发送一次隐藏 recovery  
**And** 用户最终只看到完整计划  
**And** 不展示 recovery 指令或重复计划卡片

### 场景 6: Recovery 自动续写

**Given** recovery 第一次响应只有 thinking  
**When** OpenClaw 在同一 run 中自动发起可见续写  
**Then** LobsterAI 保持 turn 运行  
**And** 不因 token 间隔超过 800ms 提前完成  
**And** lifecycle end 后使用 `chat.history` 覆盖本地流式快照

### 场景 7: 从计划消息处分叉

**Given** 用户在计划消息的原消息操作区点击分叉  
**When** 该计划消息 metadata 意外残留 streaming 标记  
**Then** 新 session 仍包含完整计划卡片  
**And** 新消息 metadata 为稳定 final  
**And** 原 session 不发生变化

### 场景 8: 普通对话

**Given** 用户未打开计划模式  
**When** 用户提问、选择技能、添加附件或执行任务  
**Then** 所有流程与计划模式上线前一致  
**And** 出站提示中不存在任何计划模式标记

## 5. 功能需求

### FR-1: 输入入口

计划模式入口位于 Cowork 输入框加号弹层：

- 使用开关控件表示启用/禁用。
- 状态存储在当前 draft 的 collaboration mode 中。
- 新建任务和已有 session 的输入框都使用同一状态模型。
- 状态在当前 draft/session 上保留，直到用户手动关闭、新建会话重置空白 draft、或明确确认执行。
- 模型访问校验失败或提交失败时，不应提前丢失用户输入；模式是否保留遵循现有草稿失败语义。

### FR-2: Collaboration Mode 常量

模式值必须使用集中常量，禁止跨层裸字符串：

```typescript
export const CoworkCollaborationMode = {
  Default: 'default',
  Plan: 'plan',
} as const;
```

Renderer 的 UI 状态、service 参数和日志均使用该常量。

### FR-3: Plan prompt

`buildPlanModeSystemPrompt()` 生成当前轮 Plan prompt，至少包含：

- 计划模式优先于用户措辞和技能中的执行要求。
- 允许只读调研，禁止写入。
- 必要时追问无法从项目发现的产品决策。
- 最终使用与用户一致的语言。
- 最终只输出一个 `<proposed_plan>...</proposed_plan>`。
- 包含 Summary、Implementation Approach、Key Changes、Validation、Assumptions or Questions。
- UI 工作需要覆盖布局、视觉方向、响应式、素材和交互状态。
- 正常计划应具有 8-16 个具体条目或等价信息密度。

计划 marker 必须使用共享常量和精确行匹配，`# Plan Mode Execution Override` 不能被误判为计划模式。

### FR-4: 技能与套件

- 用户消息上的技能/套件标识必须保留。
- selected skill id 和 kit metadata 必须正常传递和持久化。
- OpenClaw 可以加载技能作为领域指导，但 Plan prompt 的“不执行”约束优先。
- 用户批准实现后，当前轮恢复正常 skill/kit routing。
- 计划模式不能永久清空用户选择的技能状态。

### FR-5: 工具安全策略

#### 明确阻止的工具

- `write`
- `edit`
- `apply_patch`
- `bash` 或等价不透明 shell 工具
- `write_file`、`create_file`、`delete_file`、`move_file` 等常见写工具别名
- `cmd`、`powershell`、`shell`、`terminal` 等无法逐段审计的不透明命令工具
- 其他已知直接写入工具

#### `exec` 只读策略

`exec` 不能按工具名整体阻止，必须解析 command：

- 支持单个只读命令。
- 支持由 `;`、`|`、`&&`、`||` 连接的只读命令组合。
- 解析时必须尊重单引号、双引号和转义字符。
- 每个子命令都必须独立通过允许列表。
- 允许把输出丢弃到 `/dev/null`、Windows `NUL` 或 PowerShell `$null`。
- 禁止输出到普通文件、输入/输出重定向、后台执行、命令替换和未闭合引号。
- `git` 只允许 `status`、`diff`、`log`、`show`、`rev-parse`、`ls-files` 等只读子命令。
- `find` 禁止 `-delete`、`-exec`、`-execdir`、`-fprint` 等有副作用选项。
- `sed` 允许只读打印，禁止 `-i`、`--in-place` 和写文件/执行表达式。
- `sort`、`tree` 允许标准输出，禁止 `-o`、`--output` 和 Windows `sort /o` 写文件选项。

示例：

```text
允许: ls -la src 2>/dev/null; echo "---"; cat package.json | head -50
允许: git status --short && rg -n "Plan Mode" src | head -20
允许: Get-Content app.log 2>$null | Select-Object -First 20
阻止: ls > files.txt
阻止: cat app.log | tee copy.log
阻止: sed -i "s/old/new/" file.ts
阻止: ls; rm -rf build
阻止: echo $(touch marker.txt)
```

新增或修改安全规则时，必须同时添加允许和阻止测试，不能只扩大允许列表。

### FR-6: 工具阻止行为

- Plan prompt 是第一层约束，要求模型不发起写工具。
- Main 在收到工具 `start` 事件时立即判定并 abort 当前危险 run，防止模型继续执行后续步骤。
- 首次阻止使用独立的 `planModeSafetyRecoveryPending` 状态标记为预期 abort；收到 `chat state=aborted` 后不得按超时或用户停止处理。
- 预期 abort 后发起一次隐藏 `chat.send`，明确禁止调用任何工具，并要求仅使用本轮已经收集的只读上下文输出完整计划。
- 安全恢复与短输出 recovery 共享 `planModeRecoveryAttempted` 的单次预算；同一 turn 再次调用危险工具时直接停止，避免无限 abort/retry。
- 安全恢复保持 session 为 `running`，不展示超时提示；恢复请求失败时清理 active turn 并回到 `idle`。
- 当前 OpenClaw 事件接口属于快速反应式防线，不是操作系统沙箱，也不能严格保证工具进程在事件到达前一个指令都未执行。实现和产品文案不得把它描述为强事务隔离。
- 如果 OpenClaw 后续提供真正的 pre-tool policy hook，应把同一安全判定前移到执行前，并保留当前事件层作为纵深防御。
- 不向对话流添加可见的内部阻止系统消息，避免“停止工具调用”提示误导用户以为任务失败。
- Main 日志记录 session id、tool name 和内部判定原因。
- read-only 命令误判属于 P0 回归，必须用真实 command 添加测试。

### FR-7: Proposed plan 协议

稳定计划格式：

```text
<proposed_plan>
## Summary
...
</proposed_plan>
```

- 标签大小写不敏感。
- 标签可以带未来扩展属性。
- Renderer 不显示标签本身。
- 流式期间遇到 `<proposed_` 等前缀时，不得把半个标签显示给用户。
- 开始标签出现但闭合标签尚未到达时，内容可以作为流式计划卡片展示，但不能标记为稳定 final。
- 普通正文可以出现在计划块之前；计划块与普通正文视觉分离。

### FR-8: 计划完整性与 Recovery

- `isPlanModeResponseComplete()` 只用于 Plan turn。
- 完整性判断结合正文长度、结构化行数和必要章节，不依赖单一字符数。
- tool-use stop reason 不能被包装为最终计划，也不能触发 recovery。
- 每 turn 仅允许一次 recovery，并记录 `planModeRecoveryAttempted`。
- recovery 发送前保存 turn 状态；发送失败时原子恢复。
- recovery 请求使用新的 idempotency key，并绑定到同一 LobsterAI session。
- recovery 自动续写等待窗口独立于普通 `CHAT_FINAL_COMPLETION_GRACE_MS`。
- 当前设计使用 15 秒 recovery follow-up grace；修改该值必须有时序测试依据。
- 完成前必须调用 `syncFinalAssistantWithHistory()`；历史全文优先于本地节流快照。

### FR-9: 批准计划检测

`isPlanImplementationApproval()` 支持明确的中英文执行意图，例如：

- 按照计划实现吧
- 按照刚才的计划开始实现
- 开始执行这个计划
- 计划没问题，直接开始开发
- Go ahead and implement the plan
- Implement it

以下内容不能误判为批准执行：

- 这个计划如何实现？
- 继续完善计划
- 解释一下计划

Renderer 负责主要模式切换，Main runtime 负责旧版本或异常 Renderer 的防御性兜底。

### FR-10: 计划卡片

计划卡片与普通 assistant 正文为同级视觉块：

- 标题使用 i18n 的“计划”/“Plan”。
- 背景、边框和标题使用语义主题 token。
- 操作按钮使用共享 `MessageActionButton`。
- 复制使用共享 `MessageCopyButton` 和 `MessageCopyIcon`。
- 下载保存 UTF-8 Markdown 文件。
- 支持展开/收起并提供 `aria-expanded`。
- 图标使用 `text-secondary`、`text-success` 等正式 token，不使用未注册 CSS 变量。
- 宽度跟随消息容器；窄屏不出现横向溢出。

### FR-11: 原消息操作

计划卡片不能取代原消息 metadata/action row：

- 时间和模型信息继续显示。
- 分叉按钮继续显示。
- 原复制按钮继续显示，并复制普通正文与计划正文的组合内容。
- 计划卡片复制按钮只复制计划正文。
- plan-only 消息的原操作区仍显示在卡片下方。

### FR-11.1: 计划待确认

计划输出完成后，Renderer 对当前 session 的最新有效计划维护内存态：

- 状态值为 `awaiting` 或 `handled`，不新增数据库表、字段或 message type。
- 只有当前 session 最新有效计划处于 `awaiting` 时展示“确认执行”和“调整方案”按钮。
- 新计划到达时，自动替换旧计划的待确认状态，旧按钮失效。
- 用户点击“确认执行”时，发送明确实现指令并使用 `CoworkCollaborationMode.Default`。
- 用户点击“调整方案”时，输入框聚焦并保持 `CoworkCollaborationMode.Plan`。
- 用户不点击按钮而直接输入时，明确执行意图等价于“确认执行”，其他输入默认视为“调整方案”。
- session 正在运行、计划生成失败、计划被中断或用户手动关闭计划模式时，不展示确认按钮。
- 待确认状态不能阻塞停止按钮；它不是 running 状态。
- Renderer 记录确认、调整和新计划待确认的 debug 日志，便于定位状态流转问题。

### FR-12: 下载和异常处理

- 使用 `Blob`、object URL 和临时 anchor 下载 Markdown。
- 下载后立即移除 anchor 并 revoke object URL。
- 组件卸载时清理复制/下载反馈 timer。
- 下载失败显示本地化 toast，并写 Renderer warn 日志。
- 不持有计划内容的额外长期缓存，避免内存增长。

### FR-13: 分叉语义

消息级分叉复制规则沿用 Cowork session fork 设计，并增加计划不变量：

- 分叉边界消息必须包含在新 session 中。
- 明确选中的非空 assistant 消息优先于陈旧 streaming 过滤。
- 复制 metadata 时删除 `isStreaming`、tool use id、request id、run id、OpenClaw session key 等运行态字段。
- 陈旧 streaming assistant 被选中时设置 `isFinal: true`。
- 记录 warn 日志，便于定位上游为何没有正确 finalize。

### FR-14: 持久化与升级兼容

- 本功能不新增数据库表或字段。
- assistant 原始内容继续存入 `cowork_messages.content`。
- 计划卡片通过 Renderer 解析生成，因此老版本消息仍可读取。
- 老版本错误持久化的 Plan prompt 在继续 session 时一次性清理。
- 老版本残缺计划不自动改写，避免篡改历史；后续分叉可以保留用户明确选择的原消息。
- 覆盖安装不需要 migration，macOS 和 Windows 使用相同数据语义。

## 6. 状态机与数据流

### 6.1 新计划轮次

```text
用户打开计划模式
  -> draft collaborationMode = plan
用户提交
  -> Renderer 构造 Plan prompt
  -> 保留技能/套件 metadata
  -> IPC start/continue session
Main
  -> runtime 使用本轮 Plan prompt
  -> session 仅持久化基础 system prompt
OpenClaw
  -> 只读调研
  -> assistant stream
Main
  -> 解析工具安全策略
  -> 规范化 stable final
  -> 必要时一次 recovery
Renderer
  -> 隐藏标签
  -> 普通正文和计划卡片分离展示
  -> 最新完整计划进入 awaiting_plan_confirmation
```

### 6.2 批准执行轮次

```text
用户: 按照计划实现吧
  -> Renderer 检测 approval
  -> effective mode = default
  -> 恢复 kit/skill routing
  -> 提交并关闭当前 session 的 plan mode
Main runtime defensive check
  -> 若仍收到 Plan prompt 且历史存在完整计划
  -> 追加 Plan Mode Execution Override
  -> planMode = false
OpenClaw
  -> 正常调用写工具和验证工具
```

### 6.3 待确认/调整流程

```text
assistant final plan
  -> Renderer 识别最新完整计划
  -> planConfirmation.state = awaiting
用户点击确认执行或输入明确执行意图
  -> mark handled
  -> draft collaborationMode = default
  -> onContinue(..., default)
用户点击调整方案
  -> mark handled
  -> draft collaborationMode = plan
  -> focus input
用户直接输入补充诉求
  -> mark handled
  -> onContinue(..., plan)
新 plan final
  -> 替换为新的 awaiting
```

### 6.4 Recovery 流程

```text
stable final
  -> 内容完整? 是 -> finalize
  -> 否，tool boundary? 是 -> 保持运行
  -> 否，已 recovery? 否 -> 发送一次 recovery
recovery final
  -> 完整? 是 -> history sync + finalize
  -> 不完整 -> 进入 15s follow-up wait
assistant 自动续写
  -> 取消静默完成 timer
  -> 持续更新计划消息
lifecycle end
  -> history sync
  -> 以完整权威文本覆盖本地消息
  -> finalize
```

### 6.5 消息展示流

```text
cowork_messages.content
  -> mapDisplayText
  -> parseProposedPlanBlock
       visibleText
       planText
  -> AssistantMessageItem
       MarkdownContent(visibleText)
       ProposedPlanBlock(planText)
       original metadata/actions
```

## 7. 日志与诊断

### 7.1 Main 日志

关键事件：

- 进入/退出计划模式。
- 清理旧 session 中持久化的 Plan prompt。
- 阻止工具调用及内部原因。
- 触发一次 plan recovery。
- recovery 请求失败并回滚。
- recovery 等待 OpenClaw 自动续写。
- 完成前从 history 同步计划。
- 分叉时保留带陈旧 streaming metadata 的选中消息。

日志要求：

- 使用英文自然语言和模块 tag。
- 错误日志包含 error 对象。
- 不在每个 token/delta 上写 info 日志。
- 不记录完整 system prompt、用户敏感内容或完整 shell command。

### 7.2 Renderer 日志

关键事件：

- 用户提交 Plan turn。
- 因批准实现退出计划模式。
- 最新计划进入待确认状态。
- 用户确认执行或调整计划。
- 下载计划成功或失败。
- 分叉计划消息请求。

Renderer 高频 hover、展开/收起和复制成功不需要 info 日志。

### 7.3 排障顺序

发生计划异常时按以下顺序检查：

1. `cowork_messages` 中原始 content、metadata、sequence。
2. `cowork_sessions.system_prompt` 是否错误包含 `# Plan Mode`。
3. LobsterAI `cowork.log` 中的 runtime mode、recovery 和 tool block 事件。
4. OpenClaw gateway 日志中的 run id、tool 参数、lifecycle。
5. OpenClaw session JSONL 中模型原始 assistant content。

如果 JSONL 完整而 SQLite 残缺，属于 LobsterAI 流式/完成时序问题；如果 JSONL 本身残缺，才属于模型或上游 provider 输出问题。

## 8. 跨平台与响应式

### 8.1 macOS/Linux shell

- 支持 `/dev/null` 丢弃输出。
- 支持 `ls`、`cat`、`rg`、`find`、`sed -n`、只读 `git` 等调研命令。
- 路径和引号解析不能假定路径没有空格。

### 8.2 Windows shell/PowerShell

- 支持 `dir`、`findstr`、`Get-ChildItem`、`Get-Content`、`Select-String`、`Select-Object`。
- 支持 `NUL` 和 `$null` 丢弃输出。
- 不依赖 POSIX-only path 或 shell API 完成核心模式判断。

### 8.3 UI

- 操作按钮使用稳定尺寸，不因 copied/downloaded 状态改变布局。
- 计划标题和操作区在窄屏保持可见。
- Markdown 长链接、长单词和代码块遵循现有 `MarkdownContent` 溢出策略。
- 在至少 390px 宽度和常见桌面分辨率下无横向页面溢出。
- 明暗主题以及 classic、paper、emerald、mocha、nord 等主题使用同一语义 token。

## 9. 失败模型

| 失败 | 预期行为 |
|------|----------|
| 模型输出短前言 | 最多一次 recovery |
| 模型仅输出 thinking | 等待自动续写并从 history 同步 |
| recovery 请求失败 | 恢复原 turn 状态并保留原响应 |
| recovery 自动续写 token 间隔较长 | 不使用普通 800ms timer 提前完成 |
| `chat.final` 缺失 | lifecycle fallback + history sync |
| 只读复合 exec | 逐段验证并允许 |
| 复合命令含一个写入子命令 | 阻止整条命令 |
| 模型首次调用 write/edit | 收到 tool start 后立即 abort 危险 run，不展示内部阻止消息，并自动发起一次无工具计划恢复 |
| 安全恢复再次调用写工具 | 终止 turn，不再次恢复 |
| 安全 abort 收到 `chat state=aborted` | 视为预期事件，不显示超时提示，不清理待恢复 turn |
| 安全恢复请求失败 | 清理 active turn、恢复 `idle`，依赖日志排查内部阻止原因 |
| Plan prompt 被旧版本持久化 | 下一次 continue 自动清理 |
| 用户批准但 UI 仍发送 Plan | Main execution override 兜底 |
| 最新计划待确认时用户直接补充修改 | 默认按计划调整发送，不直接执行 |
| 最新计划待确认时用户直接说“开始吧” | 等价确认执行，关闭 plan mode 并恢复 default |
| 用户点击旧计划按钮 | 旧按钮不展示或已失效，不执行过期计划 |
| 新建对话 | 空白 draft 不继承上一会话 plan mode 或待确认状态 |
| 计划消息 metadata 残留 streaming | 明确选中分叉时复制并 final 化 |
| 下载 Blob 失败 | toast + warn 日志，不影响消息 |
| 组件卸载 | 清理 timer 和 object URL |

## 10. 涉及文件

### Shared

- `src/shared/cowork/planMode.ts`
- `src/shared/cowork/planMode.test.ts`
- `src/shared/cowork/constants.ts` 或现有 collaboration mode 常量所有者

### Renderer

- `src/renderer/components/cowork/CoworkPromptInput.tsx`
- `src/renderer/components/cowork/skillSystemPrompt.ts`
- `src/renderer/components/cowork/AssistantMessageItem.tsx`
- `src/renderer/components/cowork/MessageActionButton.tsx`
- `src/renderer/components/cowork/ProposedPlanBlock.tsx`
- `src/renderer/components/cowork/proposedPlanParser.ts`
- `src/renderer/components/cowork/proposedPlanParser.test.ts`
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- `src/renderer/services/cowork.ts`
- `src/renderer/services/i18n.ts`

### Main

- `src/main/main.ts`
- `src/main/coworkStore.ts`
- `src/main/coworkStore.test.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`
- `src/main/i18n.ts`

## 11. 测试计划

### 11.1 单元测试

#### Prompt 和模式

- 精确识别 `# Plan Mode`。
- execution override marker 不被识别为 Plan mode。
- 普通 system prompt 不被识别为 Plan mode。
- 中英文批准实现语句为 true。
- 询问和完善计划语句为 false。

#### 普通对话隔离

- 默认模式出站内容不含 Plan marker。
- 默认模式不含 reminder。
- 默认模式不含 recovery instruction。
- 默认模式只发送一次正常 `chat.send`。

#### 工具策略

- 单个 macOS/Linux 只读命令允许。
- 单个 Windows/PowerShell 只读命令允许。
- `;`、`|`、`&&`、`||` 只读组合允许。
- 本次真实命令 `ls ...; echo; cat ... | head` 允许。
- 普通文件重定向阻止。
- `tee`、`rm`、`sed -i`、`git branch` 阻止。
- command substitution 和后台执行阻止。
- `find -delete/-exec/-fprint` 阻止。
- 真实误调用 `mkdir -p ...` 被阻止，并触发一次安全 abort。

#### 计划完整性和 recovery

- 缺少标签的稳定完整计划被规范化。
- 已有完整标签不嵌套。
- 短前言触发一次 recovery。
- tool-use final 不触发 recovery。
- recovery 失败恢复 turn 状态。
- recovery 最多一次。
- recovery 后不完整 final 进入 follow-up wait。
- deferred completion 从 history 回填完整计划。
- 首次危险工具调用 abort 后发送一次隐藏、无工具的安全恢复请求。
- 安全 abort 不产生 timeout 消息，session 在恢复期间保持 `running`。
- 同一 turn 第二次危险工具调用直接停止，不循环恢复。

#### 分叉

- 稳定历史按边界复制。
- 非选中的 streaming assistant 过滤。
- 选中的陈旧 streaming 计划保留。
- 复制后的计划 metadata 为 `isFinal: true`。
- selected text source id 正常 remap。

#### Renderer parser

- 完整标签拆分普通正文和计划正文。
- 无标签保持普通正文。
- 未闭合开始标签不显示标签文本。
- `<proposed_` 流式前缀不泄漏。
- 大小写和属性标签可解析。

### 11.2 集成测试

1. 空目录开启计划模式，模型使用 `ls` 后输出完整计划。
2. 已有项目使用复合只读命令调研，不出现工具阻止提示。
3. 模型尝试写文件时，Main 收到 tool start 后立即 abort；验证没有产生可见文件变更、自动恢复并输出完整计划，同时记录 OpenClaw 事件时序。
4. 计划生成后发送“按照计划实现吧”，实际写入文件且不重复计划。
5. recovery thinking-only 后自动续写，最终 SQLite 与 OpenClaw JSONL 的计划正文一致。
6. 从计划消息处分叉，新会话显示同一计划卡片。
7. 普通模式发送同类建站请求，正常执行而不是输出计划。

### 11.3 UI 手动验证

- 加号弹层开关、hover、关闭弹层和再次打开状态正确。
- 技能标识在计划用户消息上保留。
- 流式期间不显示标签。
- 计划卡片和普通正文分离。
- 卡片复制、下载、展开、收起正常。
- 原消息复制和分叉按钮仍存在。
- plan-only 与正文+plan 两类消息布局正确。
- 390px、常见桌面和宽屏无重叠、截断或横向溢出。
- classic light/dark 及至少两种彩色主题图标对比度正确。

### 11.4 构建验证

```bash
npm test -- openclawRuntimeAdapter coworkStore planMode proposedPlanParser skillSystemPrompt
npm run lint
npm run compile:electron
npm run build
git diff --check
```

## 12. 验收标准

以下条件必须全部满足：

1. 普通对话的出站 prompt、工具权限和消息展示不包含计划模式行为。
2. Plan prompt 不持久化到 session。
3. 计划模式可以完成只读项目调研，包括安全的复合 shell 命令。
4. 任何含写入风险的复合命令都被整体阻止。
5. 用户批准后同一会话开始执行，不重复计划。
6. 计划最终内容完整，SQLite 与 OpenClaw 权威历史一致。
7. 每 turn 最多一次 recovery，不出现无限重试。
8. 流式阶段不泄漏 `<proposed_plan>` 标签。
9. 计划卡片支持复制、下载、展开和收起。
10. 原消息复制与分叉能力保留。
11. 分叉后的新会话包含所选计划消息。
12. macOS 与 Windows 只读命令规则均有测试。
13. 所有用户可见字符串提供中英文翻译。
14. 无数据库 schema 变更，无覆盖安装 migration 风险。
15. 相关测试、lint、Electron 编译和完整构建通过。

## 13. 变更纪律

为避免同一问题反复出现，后续修改遵循以下规则：

1. 修改 Plan Mode 前先确认影响的是 Renderer draft、Main session、OpenClaw turn、message persistence 还是 UI parser，不跨层猜测。
2. 修复线上/手测问题时，先从 SQLite、LobsterAI 日志和 OpenClaw JSONL 还原真实事件顺序。
3. 每个真实回归必须把原始输入形态加入测试，例如完整 shell command、具体 approval 文案或 streaming metadata。
4. 任何放宽安全规则的改动必须同时增加一个允许用例和至少一个阻止用例。
5. 任何流式完成逻辑改动必须验证普通 final、tool-use final、thinking-only、recovery、lifecycle fallback 五条路径。
6. 任何计划卡片改动必须验证原消息 actions 没有消失。
7. 任何分叉过滤改动必须验证稳定消息、未完成消息和明确选中的陈旧 streaming 消息。
8. 不以“构建通过”代替产品路径测试；UI 和实际 OpenClaw 事件必须至少手动验证一次。
9. 如果实现需要违反本文系统不变量，必须先修改本文并说明迁移、兼容和风险。

## 14. 后续实现顺序

1. 保持共享 Plan marker、approval detection 和模式常量为唯一来源。
2. 固化 Main runtime 工具策略和真实命令回归集。
3. 固化 recovery 状态机和 history authoritative sync。
4. 固化 session prompt 的 per-turn 生命周期和旧数据清理。
5. 固化计划 parser、卡片和共享消息操作组件。
6. 固化消息级分叉的计划保留规则。
7. 补充 Electron 端到端自动化测试，覆盖真实 OpenClaw gateway 的 thinking-only recovery 和复合只读命令。
