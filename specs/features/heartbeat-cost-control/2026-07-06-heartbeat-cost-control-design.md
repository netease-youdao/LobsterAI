# 心跳(主动巡检)空闲消耗治理设计文档

## 1. 概述

### 1.1 问题/背景

有用户反馈"什么也没做,积分也在持续消耗"。排查确认消耗来自 OpenClaw 心跳机制:LobsterAI 在
`src/main/libs/openclawConfigSync.ts` 的 `agents.defaults` 中固定写入:

```ts
heartbeat: {
  every: '1h',
  target: 'none',
  lightContext: true,
  isolatedSession: true,
},
```

该配置作用于**所有启用的 agent**(main + 每个自定义 agent),每个 agent 的 workspace 独立心跳。
2026-05 的 commit `68d2329e` 已做过一轮优化(30m/全上下文 ≈28k tokens → 1h/轻上下文 ≈5-7k
input tokens),但没有降到零。

心跳的真实成本取决于 workspace 中 `HEARTBEAT.md` 的内容,而不是定时器本身:runtime 在文件
"有效为空"时会直接跳过,**不产生任何模型调用**。当前被扣积分的用户来自两个写入源头:

1. **旧版模板缺陷**:老版本 runtime 初始化 workspace 时写入的 `HEARTBEAT.md` 模板含普通正文
   (如 `Keep this file empty unless you want a tiny checklist. Keep it small.`),不满足
   "有效为空"判定,导致每小时真实调用一次模型,模型读完只回 `HEARTBEAT_OK`,纯粹空烧。
   OpenClaw 自带 `doctor-heartbeat-template-repair` 就是修这个的,但 LobsterAI 从未替用户
   执行过。
2. **agent 自发写入**:LobsterAI 托管的 AGENTS.md 段落明确鼓励
   `Use HEARTBEAT.md for proactive background checks and reminders.`,agent 一旦写入待办
   且不清理,此后每小时持续消耗,且心跳会话被 UI 过滤(`heartbeatSessionKeys`),用户完全
   看不到钱花在哪。

### 1.2 目标

1. 空闲用户(巡检清单为空)的心跳成本归零,且**默认自动生效**,老用户升级即受益,无需任何
   用户操作。
2. 收敛 agent 对 `HEARTBEAT.md` 的写入:仅在用户明确要求持续关注某事项时才写入,事项结束
   必须清理。
3. 不改变心跳机制的启用状态,定时任务(提醒送达、IM 投递、cron 唤醒)行为完全不受影响。

### 1.3 非目标

- **不做用户设置项**(开关/频率/巡检模型选择)和巡检清单可视化。评估结论:巡检清单为空时
  本来就零消耗,对绝大多数用户"默认修好"即等价于"关闭",额外的开关和概念解释反而增加
  理解成本。若后续出现真实需求(如重度巡检用户要求换便宜模型),另立新日期的迭代 spec。
- 不做 per-agent 粒度的心跳策略。
- 不修改 OpenClaw runtime、不新增版本补丁(全部用现有配置字段与 LobsterAI 侧文件操作实现)。
- 不调整 `every` 间隔与 `target`/`lightContext`/`isolatedSession` 现有取值。

## 2. 现状与根因分析(runtime 行为核实)

以下行为已在当前 pinned runtime(`vendor/openclaw-runtime/current`)源码中逐条核实,是本方案
成立的依据:

### 2.1 心跳执行前的门控(preflight)

周期心跳触发时,runtime 先读取 workspace 的 `HEARTBEAT.md`:

- 内容"有效为空"(仅标题行、空行、裸列表符、空代码围栏)且无解析出的任务、无到期
  commitments → 直接跳过(`empty-heartbeat-file`),**不发起模型调用,零成本**。
- 内容含任意普通正文 → 正常执行,产生模型调用。
- **文件缺失(ENOENT)→ 不跳过,照常执行并产生模型调用**(反直觉:修复时必须写入空模板,
  绝不能删除文件)。

### 2.2 cron 唤醒绕过文件门控

cron 触发的心跳(`shouldBypassFileGates`:cron 唤醒、exec 事件、wake payload)**不经过**上述
空文件检查。因此提醒型定时任务的送达与 `HEARTBEAT.md` 内容无关,本方案对定时任务零影响。

### 2.3 为什么不做"关闭心跳"开关

`resolveHeartbeatIntervalMs` 对 `every: '0'`/空值/非法值返回 null → 整个心跳机制视为
disabled → `runHeartbeatOnce` 直接返回 `skipped: disabled`。而提醒型定时任务(`SystemEvent`
payload,`wakeMode: 'now'`)的送达正是走 `runHeartbeatOnce`,`next-heartbeat` 唤醒则等待周期
心跳。即"硬关闭"会让提醒任务静默失效,而"空清单跳过"已经把空闲成本降为零——**保持心跳
启用 + 保证清单默认为空**是同时满足零消耗与定时任务可靠性的唯一简单解。

### 2.4 行为矩阵

| HEARTBEAT.md 状态 | 周期心跳 | cron 唤醒(提醒送达) |
|---|---|---|
| 有效为空 | 跳过,零调用 | 照常执行 |
| 文件缺失 | **执行,烧 token** | 照常执行 |
| 有实质内容 | 执行,烧 token | 照常执行 |

### 2.5 已知旧模板(需修复的目标)

runtime doctor 定义了 5 种历史模板变体(prose 版、heading+fenced 版、fenced 版、fenced+Related
版、docs 页拷贝版),匹配方式为**归一化后整文件与已知模板逐行精确相等**(混入任何用户自写行
即不匹配),替换为标准空模板:

```markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.
# Add tasks below when you want the agent to check something periodically.
```

LobsterAI 侧修复采用同一算法与同一目标模板,保证与 runtime 未来行为一致。

## 3. 用户场景

### 场景 1: 老用户升级后空闲不再消耗

**Given** 用户的 workspace 是老版本初始化的,`HEARTBEAT.md` 为旧版 prose 模板,每小时被扣积分
**When** 升级到新版本并启动应用
**Then** 模板被自动替换为标准空模板,此后周期心跳全部零成本跳过,用户无需任何操作

### 场景 2: 用户明确要求持续盯某事时,心跳才产生消耗

**Given** 用户对 agent 说"每小时帮我看下这个 issue 有没有新回复"
**When** agent 将该事项写入 `HEARTBEAT.md`
**Then** 心跳按小时执行巡检并在有情况时提醒;事项完成或用户取消后,agent 按新话术约束删除
对应条目,消耗随之停止

### 场景 3: 日常对话不再触发 agent 自发写入巡检清单

**Given** 用户在普通对话中提到某个待办,但没有要求持续关注
**When** agent 处理该请求
**Then** agent 不将其写入 `HEARTBEAT.md`(优先使用定时任务/cron 满足确定时间点的需求),
巡检清单保持为空

### 场景 4: 提醒型定时任务完全不受影响

**Given** 用户设有每天 9 点的 IM 提醒任务,且 `HEARTBEAT.md` 为空
**When** 到达触发时间
**Then** cron 唤醒绕过空文件门控,提醒正常执行并送达 IM

## 4. 功能需求

### FR-1: 存量 HEARTBEAT.md 模板修复(默认自动)

- 每次 OpenClaw 配置同步遍历 main 与所有启用 agent 的 workspace,对 `HEARTBEAT.md` 执行:
  - 归一化(按行 trim、忽略空行)后,整文件与 5 种已知旧模板之一**逐行精确相等** → 整体
    替换为标准空模板;
  - 文件缺失 → 写入标准空模板(缺失反而烧 token,见 2.1);
  - 其余内容(用户/agent 写入的真实事项,含"旧模板 + 自写行"混合)→ 一律不动。
- 幂等:替换后的标准空模板不再命中匹配,不会重复重写。
- 禁用状态的 agent 不参与同步(无心跳零成本),重新启用后下次同步自动处理。

### FR-2: AGENTS.md 心跳引导收敛

实现中核实:workspace 的 AGENTS.md 由两部分拼装——marker 之上为"用户区"(首次 seed 自
bundled runtime 模板 `docs/reference/templates/AGENTS.md`,此后永不重写),marker 之下为
LobsterAI 托管区(每次同步重写)。runtime 模板含 `## 💓 Heartbeats - Be Proactive!` 段,
主动教模型"不要只回 HEARTBEAT_OK"、自发把邮箱/日历/天气轮询写入 `HEARTBEAT.md`——这是
agent 自发写入的主要教唆源。收敛需三处齐动:

- **托管区新增 `## Heartbeat Policy` 段**(每次同步下发,覆盖全部存量 workspace),开头
  明确声明压过文件内先前的一切心跳引导。要点:仅当用户**明确要求持续关注**时才写入;
  绝不自发发明例行检查;事项完成或取消后立即删除;确定时间点/周期优先用 cron;心跳无事
  可做时回 `HEARTBEAT_OK`,不找活干。
- **seed 模板前剥除 "Be Proactive!" 段**(精确匹配已知标题,删至下一个 H2 标题),新
  workspace 不再种入矛盾引导;标题未命中(如 runtime 升级改文案)则原样通过,由托管区
  策略兜底。
- **fallback 模板常量**(bundled 模板缺失时使用)的 `## Heartbeats` 措辞同步收敛。

### FR-3: 心跳避让进行中会话

heartbeat 渲染块追加 `skipWhenBusy: true`:agent 的会话/子 agent 通道忙碌时顺延本轮心跳,
避免与用户正在进行的对话抢并发额度。

## 5. 实现方案

1. 新增 `src/main/libs/openclawHeartbeatRepair.ts`:
   - 导出 `repairHeartbeatFile(workspacePath)` 纯逻辑函数,返回是否发生修复;
   - 已知脏行集合与标准空模板文案与 runtime doctor(`doctor-heartbeat-template-repair`)
     保持逐字一致;
   - 配套 `openclawHeartbeatRepair.test.ts`(Vitest),覆盖:四种旧模板变体、CRLF/尾随空白、
     用户真实内容不动、文件缺失补写、幂等不重写。
2. 在 `openclawConfigSync.ts` 的 per-agent workspace 同步流程(`syncPerAgentWorkspaces`
   一侧)调用修复,覆盖 main 与所有自定义 agent workspace;修复失败仅 `console.warn`,
   不阻断配置同步。
3. FR-2 三处(均为英文 workspace 指令,非 UI 字符串,不涉及 i18n):
   - `openclawConfigSync.ts` 新增 `MANAGED_HEARTBEAT_POLICY_PROMPT` 并加入 `syncAgentsMd`
     的托管 sections(置于 scheduled-task 提示之前,沿用"后置覆盖"惯例);
   - `readBundledOpenClawAgentsTemplate()` 返回前经
     `stripProactiveHeartbeatSection()`(实现在 `openclawHeartbeatRepair.ts`,纯函数可测)
     剥除模板中的 "Be Proactive!" 段;
   - `FALLBACK_OPENCLAW_AGENTS_TEMPLATE` 的 `## Heartbeats` 措辞收敛。
4. heartbeat 渲染块追加 `skipWhenBusy: true`(FR-3)。

改动全部位于主进程配置同步链路,无 UI、无数据库、无 IPC 变更。

## 6. 边界情况

| 场景 | 处理方式 |
|------|---------|
| `HEARTBEAT.md` 含用户/agent 真实事项 | 行集合匹配不命中,绝不修改 |
| `HEARTBEAT.md` 缺失 | 补写标准空模板(缺失会导致周期心跳照常烧 token) |
| CRLF 换行、尾随空白的旧模板 | 归一化后再匹配 |
| 用户手动清空为 0 字节文件 | 空内容即"有效为空",保持不动 |
| 多 agent | 修复覆盖 main + 全部 `workspace-{agentId}` |
| 升级后再次启动 | 修复幂等,内容一致不重写(mtime 不变) |
| workspace 尚未初始化(目录不存在) | 跳过,待 runtime 初始化后下次同步再处理 |
| 配置变更的生效方式 | `skipWhenBusy` 属 `agents.defaults` 变更,经 config 文件热加载;需验证不触发 gateway 重启循环 |
| 自配 API Key 用户(不走积分) | 行为一致,节省的是其 API 费用 |
| IM 渠道提醒 | cron 唤醒绕过空文件门控(2.2),不受影响 |
| 存量已有真实巡检事项的用户 | 不动其清单(视为用户意图);新话术约束 agent 在事项结束后清理 |
| 存量 AGENTS.md 用户区已含 "Be Proactive!" 段 | 用户区不重写;托管区 `## Heartbeat Policy` 以后置覆盖方式压制(与 scheduled-task 提示同一机制) |
| runtime 升级后模板心跳段标题变化 | 剥除函数标题不命中则原样保留,托管区策略仍生效;升级 pinned 版本时需复核标题常量 |
| 心跳会话的 UI 过滤 | `heartbeatSessionKeys` 过滤逻辑保持不变 |

## 7. 涉及文件

- `src/main/libs/openclawHeartbeatRepair.ts`(新增)
- `src/main/libs/openclawHeartbeatRepair.test.ts`(新增)
- `src/main/libs/openclawConfigSync.ts`(修复调用、`## Heartbeats` 话术、`skipWhenBusy`)

## 8. 验收标准

1. 含四种旧模板变体之一的 workspace 升级后首次启动即被替换为标准空模板;含真实事项的文件
   保持原样;重复启动不重写(mtime 不变);`HEARTBEAT.md` 缺失时被补写为标准空模板。
2. 默认配置下应用空置 24 小时,gateway 日志中周期心跳全部为 `skipped: empty-heartbeat-file`,
   无任何心跳模型调用;多 agent 场景同样成立。
3. 提醒型定时任务(SystemEvent + `wakeMode: now`)在清单为空时准时执行且 IM 送达正常。
4. 生成的 `openclaw.json` 中 `agents.defaults.heartbeat` 含 `skipWhenBusy: true`,且配置
   同步不触发 gateway 反复重启。
5. 同步后各 workspace 的 AGENTS.md 托管区含 `## Heartbeat Policy` 段;新建 workspace 的
   用户区不含 "Be Proactive!" 段。新话术生效后,普通对话不再导致 agent 自发写入
   `HEARTBEAT.md`(人工回归:含"帮我盯着 X"与不含持续关注意图的两类对话)。
6. touched 文件通过
   `npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0`;
   `npm test -- heartbeat` 通过;`npm run compile:electron` 通过。
