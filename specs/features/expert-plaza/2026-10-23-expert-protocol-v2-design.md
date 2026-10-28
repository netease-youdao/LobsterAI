# 专家协议 v2 设计文档

## 1. 概述

### 1.1 问题/背景

专家广场里的专家是可复制的 Agent 模板：召唤时按当前语言生成一个普通预设 Agent，之后目录更新不再改写它的指令、技能和身份。当前目录协议（`src/shared/agent/presets.ts` 的 `PresetAgent`）只描述四件事：身份、指令（`systemPrompt`）、技能引用（`skillIds`）和三条首问示例（`starterPrompts`）。

对照 Grok Bot 的专家模板（[模板说明](https://x.ai/bot/guides/templates-for-grok-bot)），它的详情页固定为五栏：指令、记忆（"Facts it already knows"）、技能（"Playbooks it can run"）、例程（"Jobs that run on their own"）和集成（"Apps it can use"）。2026-10-20 的公开模板梳理显示，90 个模板中 67 个带定时条目、68 个带集成条目。两者差距不在角色数量，而在专家能否：

1. **记住用户的工作对象**：例如 Competitor Watch 召唤后一次问一项，收集公司、竞品网址、时区、周报时间和推送位置，写入记忆；已知的不再追问。
2. **按时自己运行**：例程默认关闭，用户确认后才开启；每次与上次快照比对，只报有意义的变化，只出草稿不代发。
3. **事先说明依赖**：需要浏览器、IM 推送或某个账号时，安装前就能看到。

LobsterAI 已有这些能力的底座，只是没有接到专家上：

- 定时任务（`src/scheduledTask/`）支持 `agentId` 绑定和 `delivery` 投递到钉钉、飞书、企微等 IM 渠道；会话内可用原生 `automations` 工具（网关 `cron.*`）创建任务。
- OpenClaw v2026.8.1 中，带 `agentId` 的定时任务在该 Agent 的工作区运行（`src/cron/isolated-agent.session-identity.test.ts` 断言 `workspaceDir` 为该 Agent 的工作区），因此会加载该工作区 `AGENTS.md` 的 LobsterAI 托管区块。
- 定时任务的输出为 `NO_REPLY` 时，OpenClaw 不投递（`src/cron/isolated-agent/delivery-dispatch-policy.ts` 的 `normalizeSilentReplyText`），LobsterAI 的历史渲染也已识别该令牌。
- 每个非 main Agent 都有独立工作区 `workspace-{agentId}`，`openclawConfigSync.syncPerAgentWorkspaces()` 负责同步其中的 `SOUL.md`、`IDENTITY.md` 和 `AGENTS.md` 托管区块。

### 1.2 目标

1. 目录协议新增四个可选字段：`workflow`（工作方法摘要）、`setup`（首次配置）、`routines`（可开启的例程）、`requires`（依赖说明），旧客户端安全忽略。
2. 详情页增加四栏："它会怎么做""它需要知道""它能自动做""它会用到"。
3. 提供"开启例程"流程：复用现有定时任务表单，绑定专家 Agent，默认关闭，用户确认后创建。
4. 按新规范改写第一批 7 位专家（5 位增强、2 位新增）。

### 1.3 范围边界

- **专家与套件无关。** 专家是 Agent 模板，套件是任何 Agent 都能使用的插件。协议不新增套件字段，召唤专家也不安装套件、技能、插件或 MCP。`requires` 只做说明，`skillIds` 仍然只引用目标客户端已有的技能。
- 不新增运行时，不引入 OpenClaw 补丁，不改变"召唤不发送消息"和"目录更新不改写已安装实例"两条既有规则。
- 不搬运 Grok Bot 模板原文。各模板的跨平台再分发许可尚未逐项确认，只借鉴结构和工作方法，内容由我们重写。
- 专家团、用户发布自建专家、对话内推荐专家不在本期范围。

## 2. 用户场景

### 场景 1：只想先看看效果

**Given** 用户第一次打开竞品与舆情监测员的详情页
**When** 用户点击第一条示例问题
**Then** 召唤后进入新任务页，示例作为未发送草稿。这条示例自带公开的演示对象，不需要先填写配置；"它需要知道"一栏只作说明，不阻断召唤。

### 场景 2：让专家记住工作对象

**Given** 用户已召唤监测员
**When** 用户在详情页或 Agent 设置页点击"设置"，填写公司名和竞品网址
**Then** 配置保存在本机，并写入该 Agent 工作区的托管区块；之后的新会话和定时运行都能读到，专家不再重复追问。

### 场景 3：开启每周竞品周报

**Given** 用户已填写必填配置，并在 IM 设置中启用了飞书
**When** 用户在"它能自动做"中点击"开启"
**Then** 打开预填好的定时任务表单：执行专家已锁定，时间和指令可修改，推送渠道由用户选择。保存后详情页显示"已开启·每周一 09:00·推送到飞书"；再次点击只会查看该任务，不会重复创建。

### 场景 4：没有变化时不打扰

**Given** 每日变化检查已开启并配置了 IM 推送
**When** 当天各监测页面没有达到报告标准的变化
**Then** 专家只输出 `NO_REPLY`，不推送；运行记录显示"无变化，未推送"。

### 场景 5：旧客户端

**Given** 用户的客户端不认识 v2 字段
**When** 加载同一份目录并召唤专家
**Then** 广场和召唤照常可用。专家指令在没有托管配置区块时，会在对话中一次问一项、只用于本次会话；用户也可以在对话中让专家用 `automations` 工具创建定时任务。

## 3. 功能需求

### FR-1：协议字段

`PresetAgent` 新增四个可选字段，均为双语内容。

| 字段 | 作用 | 限制 |
|------|------|------|
| `workflow` | 详情页"它会怎么做"的 3–5 步摘要；不是提示词本身 | 3–5 项，每项 ≤ 40 个中文字符 |
| `setup` | 专家需要记住的工作对象和偏好 | ≤ 8 项；`key` 稳定且唯一 |
| `routines` | 可开启的例程模板 | ≤ 4 项；`id` 稳定且唯一；默认关闭 |
| `requires` | 环境依赖说明，例如浏览器、IM 推送 | ≤ 8 项；只展示，不安装 |

`setup` 不收集密码、令牌、密钥或支付信息。需要登录的页面由用户在内置浏览器中自行登录，需要凭据的服务走既有的 MCP 或账号接入。

### FR-2：详情页四栏

详情弹窗保留现有的头部、描述、标签、示例问题和召唤按钮，在描述之后增加四栏。没有对应字段的栏目不显示，因此没有 v2 字段的专家，详情页与当前一致；唯一例外是"它会用到"可由 `skillIds` 推导。

| 栏目 | 内容 | 操作 |
|------|------|------|
| 它会怎么做 | `workflow` 步骤列表 | 无 |
| 它需要知道 | `setup` 各项名称、说明、必填标记和已填/未填状态（已安装时显示） | "设置" |
| 它能自动做 | `routines` 的标题、说明、默认时间、是否"无变化不推送" | "开启"/"已开启"/"已暂停" |
| 它会用到 | `skillIds` 的显示名与启用状态；`requires` 的说明与可计算状态 | 无 |

### FR-3：首次配置

1. 配置入口：详情页"它需要知道"的"设置"按钮；Agent 设置页新增的"专家配置"区块；开启例程时缺少必填项会弹出配置。
2. 未安装时点击"设置"，先按召唤逻辑安装或复用实例（不跳转到新任务页），再打开配置表单。
3. 配置值按 Agent 保存在本机 SQLite，渲染为该 Agent 工作区 `AGENTS.md` 托管区块中的"专家配置"小节。保存后只同步工作区文件，不重启网关；从下一个新会话起保证生效。
4. 召唤从不被配置阻断。首问示例必须在未配置时也能完成。

### FR-4：开启例程

1. 例程默认关闭。召唤专家、目录更新都不会自动创建定时任务；目录更新也不修改已创建的任务。
2. 开启时：确保实例已安装并启用 → 检查 `requiresSetup` 是否已填，缺什么只补什么 → 打开预填的定时任务表单（锁定执行 Agent）→ 用户保存后创建任务，并记录它与例程的关联。
3. 同一 Agent 的同一例程已关联任务时，按钮变为"查看"，打开既有任务；不重复创建。
4. 推送渠道默认"不推送"。例程标记为建议推送且用户已启用 IM 时，表单只提示"可推送到 IM"，不替用户选择渠道。
5. 例程的指令必须自包含：不依赖新版提示词也能正确执行。所以旧提示词的实例、在对话中创建的任务都能正常运行。

### FR-5：兼容与内容规则

1. `schemaVersion` 保持为 1，新字段只增不改。旧客户端的 `parseExpertCatalog()` 只读取已知字段，已验证会忽略未知字段。
2. 新客户端校验到某位专家的 v2 字段无效时，只丢弃该专家的 v2 字段并告警，不拒绝整份目录。内容仓库的构建校验必须严格，把问题挡在发布前。
3. `systemPrompt` 仍是召唤时的快照。`workflow`、`setup`、`routines`、`requires` 与 `starterPrompts` 一样，按 `presetId` 读取最新目录，已安装实例同样展示。
4. `setup.key` 与 `routines.id` 一经发布不复用为其他含义。删除某项后，已保存的值保留但不再展示，也不再写入托管区块。

## 4. 实现方案

### 4.1 协议类型

在 `src/shared/agent/presets.ts` 中新增：

```ts
export const ExpertSetupFieldType = {
  Text: 'text',
  LongText: 'longText',
  List: 'list',       // 一行一项，例如网址或关键词
  Select: 'select',
} as const;
export type ExpertSetupFieldType = typeof ExpertSetupFieldType[keyof typeof ExpertSetupFieldType];

export interface ExpertSetupOption {
  value: string;
  label: LocalizedExpertText;
}

export interface ExpertSetupField {
  key: string;                       // ^[a-z][a-z0-9_]{0,39}$
  label: LocalizedExpertText;
  help?: LocalizedExpertText;
  placeholder?: LocalizedExpertText;
  type: ExpertSetupFieldType;
  required: boolean;
  options?: ExpertSetupOption[];     // 仅 select，2–8 项
  maxLength?: number;                // 默认 500，上限 2000
}

export const ExpertRoutinePlanType = {
  Daily: 'daily',
  Weekly: 'weekly',
  Monthly: 'monthly',
} as const;
export type ExpertRoutinePlanType = typeof ExpertRoutinePlanType[keyof typeof ExpertRoutinePlanType];

export interface ExpertRoutineSchedule {
  planType: ExpertRoutinePlanType;
  hour: number;                      // 0–23，用户本地时区
  minute: number;                    // 0–59
  weekdays?: number[];               // 0=周日 … 6=周六，与现有 cron 约定一致
  monthDay?: number;                 // 1–28
}

export interface ExpertRoutine {
  id: string;                        // 与专家 ID 同规则
  title: LocalizedExpertText;
  description: LocalizedExpertText;
  schedule: ExpertRoutineSchedule;
  message: LocalizedExpertText;      // 自包含的执行指令，≤ 4000
  requiresSetup: string[];           // 引用 setup.key
  suggestDelivery: boolean;
  quietWhenUnchanged: boolean;       // true 时 message 必须约定无变化只输出 NO_REPLY
}

export const ExpertRequirementKind = {
  Browser: 'browser',
  ImDelivery: 'imDelivery',
  Vision: 'vision',
  Mcp: 'mcp',
  Account: 'account',
} as const;
export type ExpertRequirementKind = typeof ExpertRequirementKind[keyof typeof ExpertRequirementKind];

export interface ExpertRequirement {
  kind: ExpertRequirementKind;
  optional: boolean;
  note: LocalizedExpertText;
}

export interface PresetAgent {
  // ...现有字段
  workflow?: LocalizedExpertText[];
  setup?: ExpertSetupField[];
  routines?: ExpertRoutine[];
  requires?: ExpertRequirement[];
}
```

目录示例（节选）：

```json
{
  "id": "market-watch-analyst",
  "setup": [
    { "key": "company", "type": "text", "required": true,
      "label": { "zh": "你的公司或产品", "en": "Your company or product" } },
    { "key": "competitors", "type": "list", "required": true,
      "label": { "zh": "要关注的竞品", "en": "Competitors to watch" },
      "help": { "zh": "每行一个官网、定价页或产品名", "en": "One website, pricing page or product per line" } }
  ],
  "routines": [{
    "id": "daily-check",
    "title": { "zh": "每日变化检查", "en": "Daily change check" },
    "description": { "zh": "工作日傍晚比对监测页面，只在有重要变化时提醒", "en": "Checks watched pages each weekday and alerts only on material changes" },
    "schedule": { "planType": "weekly", "hour": 18, "minute": 0, "weekdays": [1, 2, 3, 4, 5] },
    "message": { "zh": "……（见 6.2）", "en": "..." },
    "requiresSetup": ["company", "competitors"],
    "suggestDelivery": true,
    "quietWhenUnchanged": true
  }],
  "requires": [
    { "kind": "browser", "optional": true,
      "note": { "zh": "部分页面需要浏览器渲染后才能读取", "en": "Some pages need a browser to render" } }
  ]
}
```

### 4.2 解析与校验

`src/shared/agent/expertCatalogValidation.ts` 新增 `parseExpertV2Fields(expert)`，供 `parseExpertCatalog()` 逐位专家调用：

- 字段缺失时返回空，与现状一致。
- 结构、长度、枚举、`key` 和 `id` 的格式与唯一性、`requiresSetup` 引用、`select` 选项数量，任一不合法就丢弃该专家的全部 v2 字段，并 `console.warn('[ExpertCatalog] Dropped v2 fields for', id, reason)`。专家本身保留。
- `quietWhenUnchanged` 为 true 时，`message` 的中英文都必须包含 `NO_REPLY`。

内容仓库的构建校验复用同一套规则，但任何错误都会让构建失败。

### 4.3 配置存储与托管区块

**存储。** `src/main/sqliteStore.ts` 用 `CREATE TABLE IF NOT EXISTS` 新增：

```sql
CREATE TABLE IF NOT EXISTS agent_expert_settings (
  agent_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  label      TEXT NOT NULL,   -- 保存时的显示名，目录不可用时仍可渲染
  value      TEXT NOT NULL,   -- list 类型存为换行分隔
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, key)
);
```

删除 Agent 时一并删除其配置。读写放在新模块 `src/main/expertSettingsStore.ts`，经 `AgentIpcChannel` 新增的两个常量通道暴露：`ExpertSettingsGet: 'agents:expertSettingsGet'` 和 `ExpertSettingsSave: 'agents:expertSettingsSave'`。

**托管区块。** 新模块 `src/main/libs/expertSetupSection.ts` 导出纯函数 `buildExpertSetupSection({ values, stateDir, language })`，生成如下内容：

```markdown
## 专家配置

以下内容由用户在 LobsterAI 的专家设置中确认，优先于从旧对话推断的信息。
本专家的持续工作文件目录：/…/workspace-market-watch-analyst/expert-state

| 项目 | 内容 |
|------|------|
| 你的公司或产品 | 某某科技 |
| 要关注的竞品 | https://… <br> https://… |

用户在对话中给出不同值时，本次会话按新值执行，并提醒用户在专家设置中保存，以便后续会话和定时任务使用。不要把这些配置项另写进 MEMORY.md。
```

- `syncAgentsMd()` 增加可选参数 `extraSections: string[]`。`syncPerAgentWorkspaces()` 只为有配置的 Agent 传入这一小节，插在 `## System Prompt` 之后。值中的托管标记和 Markdown 表格分隔符需转义。
- 工作目录 `expert-state/` 由该段给出绝对路径，避免会话工作目录与 OpenClaw 工作区混淆。目录不存在时由专家在首次写入时创建。
- `openclawConfigSync.ts` 已有 4,400 多行。本期只在其中增加参数透传和一处调用，逻辑都放进新模块，不做额外拆分。

**单一来源。** 配置以 SQLite 为准。专家不写这张表，对话中给出的新值只在本次会话生效（见区块最后一段）。"对话内一键保存为专家配置"留到后续版本。

### 4.4 详情页四栏

- 详情弹窗 `ExpertPlazaView.tsx` 目前 267 行。四栏抽到新组件 `src/renderer/components/experts/ExpertCapabilitySections.tsx`，弹窗只负责组合。弹窗最大宽度由 600px 调整为 720px；宽度 ≥ 640px 时四栏按 2×2 网格排列，窄屏时纵向堆叠。
- 栏目顺序：头部 → 描述 → 标签 → 四栏 → "试着从这些问题开始" → 底部召唤。
- 已安装状态由渲染进程计算：按 `presetId` 匹配 `agentSlice` 中 `source === preset` 的 Agent。这也顺带修复了 `preset.installed` 从未被赋值的问题。
- 依赖状态的计算范围：
  - `imDelivery`：是否有已启用的 IM 实例；
  - `vision`：该 Agent 的模型（或默认模型）是否支持图片；
  - `browser`、`mcp`、`account`：首期只展示说明，不判断状态。
- 技能显示名复用 `src/renderer/components/skills/bundledSkillNames.ts`，启用状态取技能列表。未启用的技能显示"未启用"，点击跳转技能页，不自动启用。

### 4.5 开启例程流程

```
详情页/Agent 设置 → 开启
  → agentService.addPreset(presetId)（已存在则复用并启用；不跳转）
  → 读取 agent_expert_settings；缺 requiresSetup → 只展示缺失项的配置表单 → 保存
  → 打开 TaskForm(mode=create, initialTemplate=routineTemplate, fixedAgentId=agent.id)
  → 用户保存 → scheduledTask:create（agentId=agent.id）
  → 写 expert_routine_tasks 关联 → 详情页刷新为"已开启"
```

**表单适配。** `TaskForm.tsx` 有 1,700 多行，只做两处最小改动：

1. 新增可选属性 `fixedAgentId`。设置后写入 `ScheduledTaskInput.agentId`，并在表单中只读展示"执行专家：<名称>"。
2. `initialTemplate` 支持由例程转换而来的模板。转换函数放在新模块 `src/renderer/components/experts/routineTemplate.ts`，把目录的双语文本按当前语言展开为字面量，而不是 i18n key。为此在 `ScheduledTaskTemplate` 上增加可选的 `literal` 字段，`applyScheduledTaskTemplate()` 优先读取它。

推送、执行方式等其余字段沿用表单现有逻辑和默认值。选择 IM 推送时，表单本就按现有规则处理会话目标。

**关联表。**

```sql
CREATE TABLE IF NOT EXISTS expert_routine_tasks (
  task_id    TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  preset_id  TEXT NOT NULL,
  routine_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

**状态展示。**

- 详情页和"专家配置"区块列出所有 `agentId` 等于该 Agent 的定时任务，包括用户在对话中创建的；有关联记录的任务归到对应例程下。
- 读取时发现任务已被删除，就清理关联记录；任务被停用时显示"已暂停"。

**静默运行的展示。** 运行记录的结果为 `NO_REPLY` 时，`TaskRunHistory` 和执行详情显示"无变化，未推送"，不显示原始令牌。

### 4.6 专家指令中的配合约定

v2 专家的 `systemPrompt` 统一包含以下约定，保证有无新客户端都能正确工作：

1. **首次配置。** 存在"专家配置"小节时直接使用。不存在且当前任务确实需要时，一次只问一项，最多问到完成本次任务所需的最少项；本次会话内使用，并提示用户可在专家设置中保存。示例任务不追问配置。
2. **持续状态。** 监测清单、快照、台账等文件写在"专家配置"小节给出的 `expert-state/` 下；没有该小节时写在当前工作目录的 `expert-state/` 下，并告诉用户位置。
3. **定时运行。** 在定时任务会话中只输出结果，不调用 `message` 工具；约定"无变化不推送"的例程，在无变化时只输出 `NO_REPLY`。这与现有托管提示词中的定时任务规则一致。
4. **创建例程。** 只有用户明确同意后，才用原生 `automations` 工具创建，并说明时间、渠道和关闭方式。推荐先完成一次手动运行再提议。
5. **边界。** 只出草稿，不代发、不提交；只读公开页面，不登录、不注册试用账号、不绕过付费墙或访问限制。

### 4.7 埋点

沿用专家漏斗（`reportExpertJourney`），在 `UsageStage` 中新增 `SetupSave: 'setup_save'` 和 `RoutineEnable: 'routine_enable'`：

- `setup_save` 字段：`presetId`、`filledCount`、`requiredMissingCount`、`entry`（详情页/Agent 设置/开启例程）。
- `routine_enable` 字段：`presetId`、`routineId`、`outcome`、`hasDelivery`、`scheduleEdited`。

不上报配置值、指令文本和推送目标。

### 4.8 发布节奏

| 里程碑 | 客户端 | 内容 |
|--------|--------|------|
| M1 协议与展示 | 类型、解析、单测；详情页四栏（只读）；已安装状态；依赖与技能状态 | 7 位专家的提示词、`workflow`、`requires`、`skillIds`、首问；`setup`/`routines` 可随附，M1 只展示 |
| M2 首次配置 | 配置表、IPC、表单（详情页 + Agent 设置）、托管区块同步、`setup_save` 埋点 | 校对配置项的文案与必填设置 |
| M3 例程 | 表单适配、关联表、状态展示、静默运行展示、`routine_enable` 埋点 | 用真实模型跑每条例程，确认指令和静默约定 |

每个里程碑都可单独发布。目录先发 test，验证加载、展示、召唤和开启后再发 prod，按 2026-10-13 文档 4.7 的流程执行。

## 5. 改写规范（适用于所有 v2 专家）

1. **身份与指令不重复。** `identity` 只写一句角色定位，`systemPrompt` 不再以同一句开头。
2. **指令结构：** 适用与不适用 → 领域工作规则（写明判定标准，不写空泛步骤）→ 交付物与文件约定 → 首次配置约定 → 定时运行约定 → 边界与授权 → 通用交付原则（构建时拼接）。
3. **`skillIds`。** 只列核心流程确实需要的技能；不再使用只读的 `create-plan`。
4. **首问三条：**
   - 第 1 条自带演示素材（标注"演示"或"模拟"）或只用公开信息，原样发送就能得到成品；
   - 第 2 条使用用户自己的材料；
   - 第 3 条是进阶用法，或在对话中开启例程。
5. **展示文案。** 标签固定 3 个；描述 40–50 个中文字符；`workflow` 3–5 步，每步说清楚做什么，不用口号。
6. **双语。** 中英文含义一致，不做逐字直译；例程指令两种语言都要能独立执行。
7. **借鉴来源。** 第一批的工作方法参考了 Grok Bot 模板（见第 6 节各条），但文本全部重写，不复制原文。

## 6. 第一批 7 位专家改写要点

### 6.1 软件验收搭档（`software-test-planner`，增强）

**借鉴：** QA bot、Startup QA Bot、Site Audit。

**定位：** 发布前的验收裁决人，与开发角色分开。

**工作规则：**

- 结论只有三种：通过、失败、阻塞。CI 通过不等于验收通过。
- 没有验收标准时判为阻塞并请用户补充，不自行编写或猜测验收标准。
- 清单分为阻断项和提醒项。阻断项不能因"差不多"放行，也不能为了让测试变绿而修改预期结果。
- 执行前先核对实际部署版本（页面版本号、接口返回的提交号等），与用户期望不一致时直接判为阻塞。
- 每条失败都附复现步骤、截图和控制台/网络错误，区分产品缺陷和测试环境问题。
- 测试账号由用户提供或在内置浏览器中自行登录，不编造账号或密码。
- 文件约定：验收清单默认放在工作目录的 `qa/acceptance.md`，每次运行记录为 `qa/runs/run-YYYY-MM-DD-<主题>.md`。

**`workflow`：** 固定验收清单 → 核对部署版本 → 真实浏览器逐条执行并留证据 → 给出通过 / 失败 / 阻塞结论。

**`setup`：**

| key | 名称 | 类型 | 必填 |
|-----|------|------|------|
| `product_url` | 被验收的地址 | text | 是 |
| `acceptance_file` | 验收清单文件路径（默认 `qa/acceptance.md`） | text | 否 |
| `version_hint` | 如何确认当前部署版本 | text | 否 |

**`routines`：** `daily-smoke` 每日冒烟巡检，工作日 09:30。只运行阻断项；全部通过且结论与上次相同时只输出 `NO_REPLY`（`quietWhenUnchanged: true`）。依赖 `product_url`。

**`requires`：** 浏览器（必需）；账号（可选：需要登录的页面由你在内置浏览器中登录）；IM 推送（可选）。

**`skillIds`：** `["playwright"]`，去掉 `create-plan`。

**首问：**

1. 在新建的演示目录中生成一个带两处已知缺陷的活动报名页（标注为演示），写 5 条验收清单（3 条阻断、2 条提醒），用浏览器跑一轮，给出结论和运行记录文件。
2. 根据我提供的网址和需求，整理验收清单并跑一轮。
3. 根据这次的改动清单设计回归用例，区分必须通过项和可延期项。

### 6.2 竞品与舆情监测员（`market-watch-analyst`，新增，分类"数据与研究"）

**借鉴：** Competitor Watch、Overheard、Market Researcher。只取其中针对公开页面的部分，不包括使用测试身份注册体验。

**工作规则：**

- 监测清单是唯一依据。首次运行就建立基线快照，之后每次与最新快照比对。
- 只报告达到标准的变化：价格与套餐、功能与发布、招聘方向、重要文案。排版、样式调整不报。
- 每条变化都写变化前后、来源链接和抓取时间，并说明可能的影响；推断与事实分开写。
- 舆情只引用公开内容，不汇编个人信息；关键词有歧义时先消歧，再统计。
- 只读公开页面：不登录、不注册试用、不绕过反爬或付费墙；页面无法读取时如实标注。

**`workflow`：** 建立监测清单 → 保存基线快照 → 比对并只报重要变化 → 每条附来源和时间。

**`setup`：**

| key | 名称 | 类型 | 必填 |
|-----|------|------|------|
| `company` | 你的公司或产品 | text | 是 |
| `competitors` | 要关注的竞品（每行一个官网、定价页或产品名） | list | 是 |
| `focus` | 关注范围（价格与套餐 / 功能与发布 / 全部公开变化） | select | 否 |
| `keywords` | 舆情关键词（品牌名、产品名） | list | 否 |

**`routines`：**

- `weekly-brief` 竞品周报，每周一 09:00，`quietWhenUnchanged: false`。没有变化也发一句话周报。
- `daily-check` 每日变化检查，工作日 18:00，`quietWhenUnchanged: true`。

`daily-check` 的指令草案（中文）：

> 按"专家配置"中的竞品清单检查各监测页面。读取 expert-state 中最近一次快照并逐页比对，只记录价格与套餐、功能与发布、招聘方向和重要文案的变化，忽略排版和样式。把本次快照保存到 expert-state/snapshots/。如果没有达到上述标准的变化，只输出 NO_REPLY，不输出其他任何文字。有变化时，按竞品分组列出变化前后、来源链接和抓取时间，最后用不超过三句话说明可能的影响；无法读取的页面单独列出。

**`requires`：** 浏览器（可选：部分页面需要渲染）；IM 推送（可选）。

**`skillIds`：** `["web-search", "playwright"]`。

**首问：**

1. 以 Notion、飞书文档、语雀的公开定价页为例，建立监测清单和第一份基线，说明下次会比较哪些内容。
2. 用我提供的竞品清单建立监测，并开启每周周报。
3. 整理近 30 天关于某个品牌的公开讨论，区分正面、负面和中性，并列出来源。

### 6.3 会议跟进助手（`meeting-follow-up-assistant`，新增，分类"日常办公"）

**借鉴：** Call Follow-Ups、GTM Loop Closer。本地化为会议纪要和聊天记录里的承诺跟进。

**与内容总结助手的分工：** 内容总结助手负责摘要；本专家负责承诺闭环，维护一份持续更新的台账。

**工作规则：**

- 承诺必须同时有负责人、事项、期限和原话引用（含来源位置）。缺任何一项都标"待确认"，不猜。
- 决定、承诺和讨论分开记录，只有承诺进入台账。
- 新记录与已有台账去重合并，状态分为未开始、进行中、已完成、已取消、逾期。
- 跟进消息只写草稿，不代发；只对用户本人的承诺或用户指定的人起草。
- 首版只处理用户上传或粘贴的材料，不读取 IM 群聊。

**`workflow`：** 从记录中提取承诺并引用原话 → 与台账去重合并 → 标出到期与逾期 → 起草跟进消息，不代发。

**`setup`：**

| key | 名称 | 类型 | 必填 |
|-----|------|------|------|
| `my_name` | 会议记录中对你的称呼 | text | 是 |
| `ledger_path` | 承诺台账文件（默认 `expert-state/commitments.xlsx`） | text | 否 |
| `reply_tone` | 跟进消息语气（简洁 / 正式 / 友好） | select | 否 |

**`routines`：** `daily-due` 今日到期与逾期汇总，工作日 17:30，`quietWhenUnchanged: true`（没有到期或逾期项时只输出 `NO_REPLY`）。依赖 `my_name`。

**`requires`：** IM 推送（可选）。

**`skillIds`：** `["xlsx", "docx"]`。

**首问：**

1. 首问内嵌一段约 10 行、标注为模拟的周会记录，要求生成承诺台账 xlsx 和 3 条跟进草稿。
2. 整理我上传的会议纪要或聊天记录，更新承诺台账。
3. 把已完成的承诺标记掉，按逾期程度重新排序，并起草催办消息。

### 6.4 资料检索搭档（`source-research-partner`，增强）

**借鉴：** Cooper、X Brief、The Morning Newspaper 的定时简报部分；Researchy 的事实核查规则。

**改写：** 当前提示词属于非统一结构，按第 5 节规范重写。

- 规则：先确定问题和时间范围；优先使用官方、一手来源；每条结论注明来源和发布日期，并交叉核实；查不到原始出处时，如实说明能追溯到哪一层。
- 简报规则：按主题筛选，与历史简报去重（`expert-state/briefs/`），每条附来源；没有值得报告的新内容就不凑数。

**`workflow`：** 明确问题与时间范围 → 优先找一手来源 → 交叉核实日期与出处 → 交付可追溯的摘要或对比表。

**`setup`：**

| key | 名称 | 类型 | 必填 |
|-----|------|------|------|
| `topics` | 简报主题（每行一个） | list | 是 |
| `preferred_sources` | 优先来源网站 | list | 否 |
| `exclude` | 不想看到的内容 | list | 否 |
| `brief_size` | 每期条数（5 / 10） | select | 否 |

**`routines`：** `morning-brief` 资讯简报，工作日 08:30，`quietWhenUnchanged: true`（没有达到标准的新内容时只输出 `NO_REPLY`）。依赖 `topics`。

**`skillIds`：** `["web-search", "daily-trending", "xlsx"]`，新增 `daily-trending`。

**首问：**

1. 核实"人每天要喝 8 杯水"这个说法：追溯最早出处和权威机构的现行建议，标注每个来源的日期。
2. 按我给的维度比较几种产品方案，整理成带出处的对比表。
3. 设置我关心的主题，开启工作日资讯简报。

### 6.5 产品方案顾问（`product-planner`，增强）

**借鉴：** PM bot、Product Idea Stress Test。

**两种工作模式：**

- **范围定义：** 产出目标、用户场景、范围内与范围外、可检验的验收条件（Given/When/Then）。验收条件的格式与 6.1 的 `qa/acceptance.md` 一致，可以直接交给软件验收搭档使用。
- **压力测试：** 按风险和不确定性列出关键假设，主动寻找反证；为每个假设设计成本最低的验证方式，写明通过和放弃的阈值。

**规则：** 不把用户的意愿表达当作需求证据；没有数据就标为假设。

**`workflow`：** 写清目标与用户场景 → 划定范围内外 → 写可检验的验收条件 → 找反证并设计低成本验证。

**`setup`/`routines`：** 无。

**`requires`：** 无。

**`skillIds`：** `["docx", "web-search"]`，去掉 `create-plan`。

**首问：**

1. 首问自带一个想法："为社区团购团长做一个到货通知小功能"。要求产出范围文档（docx）和 8 条验收条件。
2. 对我的产品想法做一次压力测试。
3. 把这些零散需求按用户问题聚类，整理下一版范围和验收条件。

### 6.6 汇报演示策划（`presentation-planner`，增强）

**借鉴：** Pitch Deck Coach、Meeting Recap Deck。

**与 PowerPoint 演示制作师的分工：** 本专家负责故事线和逐页评审，制作文件交给 PowerPoint 演示制作师。两位专家的描述中都写明这一点。

**逐页评审规则：**

- 每页回答四个问题：这一页要让听众相信什么、现有证据、缺口、改法。
- 整体检查叙事顺序、开头 30 秒能否讲清、数字是否可核。
- 不编造市场规模、客户数量或客户原话。

**会议回顾：** 把会议记录整理成回顾演示的大纲；需要文件时生成可编辑的 PPTX。

**`workflow`：** 明确听众与要做的决定 → 搭故事线 → 逐页检查论点与证据 → 给出修改版大纲。

**`setup`/`routines`：** 无。

**`skillIds`：** `["pptx", "docx"]`。

**首问：**

1. 首问内嵌一份 6 页融资演示的逐页文字稿（模拟）。要求逐页评审，给出修改版大纲。
2. 逐页评审我上传的 PPT，标出证据不足的页面。
3. 把这次会议记录整理成一份回顾演示。

### 6.7 经营报表搭建师（`business-report-builder`，增强）

**借鉴：** Paid Media Report Desk。

**新增投放周报流程：**

- 读取国内广告平台的导出表。只处理用户导出的文件，不声称接入了平台接口。
- 统一币种、归因窗口和"转化"的定义，输出字段映射表。
- 每个数字都能追溯到源文件和列；环比变化超过阈值时列为异常，并附可能原因和待核实项。
- 数据缺失时如实说明，不补数据。

**`workflow`：** 统一指标口径 → 映射各渠道字段 → 汇总并标出异常 → 交付可更新的报表与说明。

**`setup`：**

| key | 名称 | 类型 | 必填 |
|-----|------|------|------|
| `data_folder` | 每周导出文件存放的文件夹 | text | 是 |
| `channels` | 投放渠道 | list | 否 |
| `conversion_definition` | "转化"指什么 | text | 否 |
| `currency` | 币种（人民币 / 美元） | select | 否 |

**`routines`：** `weekly-report` 投放周报，每周一 09:30，`quietWhenUnchanged: false`。没有发现新的导出文件时，用一句话提醒用户放入文件；这是需要用户处理的事，所以要推送。依赖 `data_folder`。

**`requires`：** IM 推送（可选）。

**`skillIds`：** `["xlsx", "pptx"]`。

**首问：**

1. 首问内嵌两个渠道各 7 天的模拟导出片段（CSV 文本，标注模拟）。要求统一口径，生成周报 xlsx 和异常说明。
2. 用我上传的导出表做本周投放周报。
3. 设置导出文件夹，开启每周自动周报。

### 6.8 广场展示调整

- 竞品与舆情监测员加入"让数据说明问题"场景。
- 会议跟进助手加入"让电脑上的工作更顺手"场景，或替换其中一位。

具体由内容侧决定，客户端不写死。

## 7. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 某位专家的 v2 字段不合法 | 只丢弃该专家的 v2 字段并告警，专家与目录照常可用 |
| 未安装时点击"设置"或"开启" | 先安装或复用实例（不跳转、不发送），再继续 |
| 必填配置缺失时开启例程 | 只展示缺失项的配置表单；用户取消则不创建任务 |
| 同一例程重复开启 | 已有关联任务时按钮变为"查看"，不重复创建 |
| 用户在定时任务页删除或停用任务 | 读取时清理关联记录，或显示"已暂停" |
| 用户手动修改了任务指令 | 目录更新不覆盖任务；详情页仍按关联关系显示为该例程 |
| 目录下架某例程或配置项 | 已创建的任务继续运行；配置值保留但不展示、不写入托管区块 |
| 目录暂不可用 | 已保存配置按保存时的显示名渲染；例程的"开启"按钮不可用 |
| 已安装实例使用旧版提示词 | 托管区块自带说明，例程指令自包含，均可正确执行 |
| 对话中给出与配置不同的值 | 本次会话按新值执行，并提示用户去设置中保存；不写入 MEMORY.md |
| 定时运行无变化 | 输出 `NO_REPLY`，不推送；运行记录显示"无变化，未推送" |
| 配置值包含托管标记或表格分隔符 | 渲染前转义 |
| 用户在配置项中填写了密码或密钥 | 表单提示不要填写凭据；本期不做内容识别 |
| 专家 Agent 被停用或删除 | 实现前核实现有删除流程对绑定任务的处理；若未处理，删除确认中提示关联任务数量 |
| 旧客户端 | 忽略新字段；专家在对话中一次问一项，例程可在对话中经用户同意后创建 |

## 8. 涉及文件

| 模块 | 文件 |
|------|------|
| 协议与校验 | `src/shared/agent/presets.ts`、`src/shared/agent/expertCatalogValidation.ts`（及测试）、`src/shared/agent/constants.ts`（新 IPC 常量） |
| 配置存储 | `src/main/sqliteStore.ts`（建表）、新增 `src/main/expertSettingsStore.ts`、`src/main/ipcHandlers/agents/handlers.ts`、`src/main/preload.ts` |
| 托管区块 | 新增 `src/main/libs/expertSetupSection.ts`（及测试）、`src/main/libs/openclawConfigSync.ts`（仅参数透传与调用） |
| 详情页 | `src/renderer/components/experts/ExpertPlazaView.tsx`、新增 `ExpertCapabilitySections.tsx`、新增 `ExpertSetupForm.tsx` |
| Agent 设置 | `src/renderer/components/agent/AgentSettingsPanel.tsx`（挂载新组件，不扩写逻辑） |
| 例程 | 新增 `src/renderer/components/experts/routineTemplate.ts`（及测试）、`src/renderer/components/scheduledTasks/TaskForm.tsx`（`fixedAgentId` 与字面量模板）、`taskTemplates.ts`（`literal` 字段）、`TaskRunHistory.tsx`（静默运行展示）、关联表读写 |
| 埋点 | `src/shared/analytics/usage.ts`、`src/renderer/services/usageAnalytics.ts` |
| 文案 | `src/renderer/services/i18n.ts`（中英文） |
| 内容 | `lobsterai-expert-store`：类型与构建校验、7 位专家的 JSON 与双语提示词 |

## 9. 验收标准

### 9.1 自动化

- 解析单测覆盖：缺省字段、合法完整字段、各类非法输入只丢弃 v2 字段、`requiresSetup` 悬空引用、`quietWhenUnchanged` 缺少 `NO_REPLY`、旧客户端解析器忽略新字段。
- `buildExpertSetupSection()` 单测覆盖：转义、list 渲染、无配置时不输出、显示名回退。
- 例程转表单单测覆盖：daily、weekly、monthly、星期编号、双语展开、锁定 `agentId`。
- 改动的 TypeScript 文件通过 CI 同款 ESLint；`npm test` 与 `npm run compile:electron` 通过。

### 9.2 端侧（`npm run electron:dev:openclaw`）

- v1 专家的详情页与改动前一致；v2 专家四栏完整，窄屏堆叠正常，浅色和深色主题都正确。
- 未安装专家点"设置"：安装后打开表单，不跳转、不发送消息；保存后对应 Agent 工作区的 `AGENTS.md` 出现"专家配置"小节，网关未重启。
- 开启例程：表单预填、执行专家锁定；保存后任务带正确的 `agentId`，详情页显示"已开启"；再次点击只打开既有任务。
- 手动执行 `daily-check`：无变化时不推送，运行记录显示"无变化，未推送"；有变化时推送到所选 IM 渠道，内容带来源与时间。
- 7 位专家的首问原样发送均能交付成品，不中途追问配置；记录首次失败、修正和复测。
- 旧客户端加载新目录，召唤与首问不受影响。

## 10. 相关但不在本期范围

- **对话内保存配置：** 专家在对话中拿到新值后，由用户一键保存为专家配置。
- **对话中推荐专家：** 需要在目录中增加"何时适用"的机器可读描述。
- **专家团：** 可基于现有子 Agent 白名单（`subagentAllowAgentIds`）实现。
- **用户把自建 Agent 发布为专家。**
- **疑似重复注入：** 非 main Agent 的 `systemPrompt` 同时写入了 `SOUL.md` 和 `AGENTS.md` 托管区块的 `## System Prompt`，`identity` 又与提示词首句重复，需另行评估。
