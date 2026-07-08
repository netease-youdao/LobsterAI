# Agent 身份设置后清理 AGENTS.md 历史身份块设计文档

## 1. 概述

### 1.1 问题

用户在 LobsterAI 的 Agent 设置页修改“身份描述”后，当前 Agent workspace 中的
`IDENTITY.md` 已经更新，但同一个 workspace 的 `AGENTS.md` 顶部可能仍残留历史生成的
身份块，例如：

```markdown
# AGENTS.md - Your Workspace

## Identity（必须遵守）

你的名字是"小小翻译家"。...

---

This folder is home. Treat it that way.
```

OpenClaw 会同时加载 `AGENTS.md` 和 `IDENTITY.md` 作为 bootstrap/context 文件。这样模型
可能同时看到“新的身份描述”和 `AGENTS.md` 中残留的旧身份指令。旧块还带有“必须遵守”
语义，容易覆盖或干扰新的 `IDENTITY.md`，表现为用户修改身份后 Agent 仍沿用旧角色。

从用户视角看，设置页保存成功，文件 `IDENTITY.md` 也确实更新，但新会话或继续会话中的
Agent 表现仍像旧身份。

### 1.2 根因

当前 LobsterAI 的路径和文件模型是：

| 文件 | 目标用途 |
|------|----------|
| `IDENTITY.md` | Agent 身份描述正文，是用户在身份设置页编辑的权威来源 |
| `SOUL.md` | Agent 性格、行为边界和系统提示 |
| `USER.md` | 关于用户的信息 |
| `AGENTS.md` | workspace 规则、技能策略、运行策略和 LobsterAI managed section |

非主 Agent 的 workspace 同步逻辑会把 `agent.identity` 写入
`workspace-{agentId}/IDENTITY.md`，再调用 `syncAgentsMd()` 生成/更新 `AGENTS.md`。

`syncAgentsMd()` 的设计会保留 marker 前的所有内容：

```text
<!-- LobsterAI managed: do not edit below this line -->
```

这对保护用户手写 `AGENTS.md` 内容是必要的，但也意味着历史版本或历史创建流程写入
`AGENTS.md` 用户区的 `## Identity（必须遵守）` 不会被后续同步自动删除或更新。

因此问题不是 `IDENTITY.md` 保存失败，而是 `AGENTS.md` 中存在另一个更旧、更强的身份
来源。

### 1.3 范围

本修复只处理 LobsterAI 历史生成的高置信 legacy identity block：

- 位于 `AGENTS.md` 的 LobsterAI managed marker 之前；
- 位于文件顶部默认模板区域；
- 标题精确匹配历史格式 `## Identity（必须遵守）`；
- 以水平分隔线 `---` 结束；
- 分隔线后紧跟 OpenClaw 默认模板锚点，例如 `This folder is home. Treat it that way.`
  或 `## First Run` / `## Session Startup` 等已知模板内容。

不处理任意用户自写的 `## Identity`、`## 身份`、项目规则、团队规范或 marker 后的 managed
section。

### 1.4 非目标

- 不改变 OpenClaw 的 bootstrap 文件加载顺序。
- 不把身份描述重新嵌入 `AGENTS.md`。
- 不做全局启动扫描，不在普通 config sync 时静默清理所有 Agent。
- 不删除或覆盖用户手写的 `AGENTS.md` 自定义规则。
- 不把旧 `AGENTS.md` 身份块合并回用户刚保存的 `IDENTITY.md`，避免把用户主动修改后的
  新身份回滚成旧身份。

## 2. 用户场景

### 场景 A: 修改非主 Agent 身份后清理旧 AGENTS.md 身份块

**Given** 用户打开某个非主 Agent 的设置页，该 Agent 的 `AGENTS.md` 顶部存在历史
`## Identity（必须遵守）` 块

**When** 用户修改身份描述并保存

**Then** `workspace-{agentId}/IDENTITY.md` 写入用户刚保存的新身份

**And** 同 workspace 的 `AGENTS.md` 中高置信历史身份块被移出 prompt 表面

**And** `AGENTS.md` 其它用户内容和 LobsterAI managed section 保持不变

**And** 原始 `AGENTS.md` 被完整备份到不参与 bootstrap 注入的位置。

### 场景 B: 修改主 Agent 身份后清理旧 AGENTS.md 身份块

**Given** 用户打开主 Agent 设置页并修改身份描述

**When** 保存成功后主 workspace 的 `IDENTITY.md` 已更新

**Then** `workspace-main/AGENTS.md` 中高置信历史身份块被清理

**And** 清理动作不会因为 `agentService.updateAgent()` 与 `writeBootstrapFile()` 的异步顺序
提前读取旧 `IDENTITY.md`。

### 场景 C: AGENTS.md 中有用户手写 Identity 规则

**Given** 用户自己在 `AGENTS.md` 中写了 `## Identity` 或其它身份相关说明，但结构不符合
LobsterAI 历史生成模板

**When** 用户保存 Agent 身份

**Then** 不自动删除该内容，只保留在 `AGENTS.md`

**And** 可以记录 warning 或在后续 UI 中提示存在可能冲突的身份规则，但本次修复不强制
处理低置信内容。

### 场景 D: 用户把身份清空

**Given** 用户在设置页把身份描述清空并保存

**When** 当前 workspace 的 `AGENTS.md` 顶部存在高置信历史身份块

**Then** 仍清理 `AGENTS.md` 的旧身份块

**And** 不把旧身份块重新写回空的 `IDENTITY.md`

**And** 用户清空身份的意图保持不变。

### 场景 E: 清理失败

**Given** 保存身份成功，但清理 `AGENTS.md` 或写备份时失败

**When** 主进程捕获该错误

**Then** 身份保存结果不回滚

**And** 记录带 Agent id、workspace 和错误原因的 warning

**And** 不写半截 `AGENTS.md`，避免造成数据损坏。

## 3. 功能需求

### FR-1: 清理只在用户保存身份后触发

迁移/清理动作必须绑定到“用户在 Agent 设置页保存身份描述”这一用户意图上。

触发条件：

1. 设置页保存成功；
2. `identity` 字段参与本次保存；
3. 当前保存链路已经确定目标 Agent id；
4. 主进程能解析对应 Agent workspace。

不应在以下时机自动清理：

- 应用启动；
- 普通 OpenClaw config sync；
- 技能启用/禁用触发的 `AGENTS.md` 同步；
- 仅修改 `pinned`、模型、工作目录、技能绑定等非身份字段；
- 后台 IM polling 或 scheduled task 同步。

### FR-2: 清理逻辑运行在 main process

Renderer 不直接读写 `AGENTS.md`。Renderer 只负责在设置页保存完成后触发一个明确的
主进程动作，例如：

```typescript
agents.cleanupLegacyIdentityBlock(agentId)
```

主进程负责：

1. 解析 Agent workspace；
2. 读取当前 `AGENTS.md`；
3. 识别高置信 legacy block；
4. 写入备份；
5. 原子写回清理后的 `AGENTS.md`；
6. 返回清理结果。

### FR-3: 主 Agent 与非主 Agent 都必须支持

主 Agent workspace：

```text
{stateDir}/workspace-main
```

非主 Agent workspace：

```text
{stateDir}/workspace-{agentId}
```

主 Agent 当前设置页会直接调用 `writeBootstrapFile('IDENTITY.md', identity)`；非主 Agent
则通过 `agent.identity` 和 OpenClaw config sync 写入自己的 `IDENTITY.md`。

实现时不得假设两者保存顺序相同。主 Agent 的 cleanup 应在 bootstrap write 成功之后触发；
非主 Agent 的 cleanup 应在对应 `IDENTITY.md` 已同步或可由主进程确认写入之后触发。

### FR-4: 只清理高置信历史块

自动清理必须同时满足以下条件：

1. 目标内容位于 managed marker 之前；
2. 文件开头允许存在 UTF-8 BOM 和空白行；
3. 第一段标题为 `# AGENTS.md - Your Workspace`；
4. 其后第一项二级标题为精确字符串 `## Identity（必须遵守）`；
5. identity block 后存在单独一行 `---`；
6. `---` 后的非空内容命中 OpenClaw 默认模板锚点；
7. 被移除内容长度在合理上限内，例如不超过 `20_000` 字符，避免误吞大段用户规则。

如果任一条件不满足，则不自动修改 `AGENTS.md`。

### FR-5: 清理前必须完整备份

只要准备写回清理后的 `AGENTS.md`，就必须先完整备份原文件。

推荐备份位置：

```text
<agent-workspace>/.lobsterai/migrations/
```

推荐文件名：

```text
agents-md-before-legacy-identity-cleanup-<timestamp>-<hash>.md
```

要求：

- 备份整个原始 `AGENTS.md`，而不是只备份被移除片段；
- `.lobsterai/migrations/` 不属于 OpenClaw bootstrap 文件名，避免再次注入 prompt；
- 如果相同内容已备份过，可复用或跳过重复备份，但实现上必须保持幂等；
- 备份失败时不修改 `AGENTS.md`。

### FR-6: 不覆盖用户刚保存的 IDENTITY.md

本修复的权威输入是用户刚保存的身份设置。清理时不得把 `AGENTS.md` 中的旧身份块再写回
`IDENTITY.md`。

如果 `IDENTITY.md` 为空，也应尊重用户当前保存结果。把旧块恢复到 `IDENTITY.md` 只适合
单独的一次性离线修复工具，不属于本次“设置页保存后清理”范围。

### FR-7: 清理结果可观测但不打断保存

主进程返回结构化结果，便于日志和后续 UI 展示：

```typescript
type LegacyIdentityCleanupResult =
  | { status: 'cleaned'; backupPath: string; removedChars: number }
  | { status: 'skipped'; reason: 'no-agents-md' | 'no-legacy-block' | 'low-confidence' }
  | { status: 'failed'; error: string };
```

设置页保存主流程不因 cleanup skipped 而失败。`failed` 需要记录 warning；是否展示非阻断
toast 可后续决定。

## 4. 实现方案

### 4.1 新增 legacy identity block 解析器

建议新增纯函数，便于单元测试：

```typescript
export function removeLegacyAgentsMdIdentityBlock(content: string): {
  changed: boolean;
  nextContent: string;
  removedContent?: string;
  reason?: 'no-legacy-block' | 'low-confidence';
}
```

候选位置：

```text
src/main/libs/openclawAgentsMdIdentityMigration.ts
```

核心规则：

1. 只处理 marker 前内容；
2. marker 后 managed section 原样拼回；
3. 清理后保留 `# AGENTS.md - Your Workspace` 和默认模板正文；
4. 保持原文件换行风格，不制造大规模格式 churn；
5. 重复运行时返回 `changed: false`。

示例输入：

```markdown
# AGENTS.md - Your Workspace

## Identity（必须遵守）

旧身份正文

---

This folder is home. Treat it that way.

<!-- LobsterAI managed: do not edit below this line -->

## System Prompt
...
```

示例输出：

```markdown
# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

<!-- LobsterAI managed: do not edit below this line -->

## System Prompt
...
```

### 4.2 新增 main process cleanup 方法

建议在 OpenClaw config/workspace 相关模块中新增方法：

```typescript
cleanupLegacyAgentsMdIdentityBlockForAgent(agentId: string): LegacyIdentityCleanupResult
```

职责：

1. 根据 `agentId` 解析 workspace：
   - `main` -> `getMainAgentWorkspacePath(stateDir)`；
   - 非主 Agent -> `path.join(stateDir, `workspace-${agentId}`)`。
2. 如果 `AGENTS.md` 不存在，返回 `skipped: no-agents-md`。
3. 读取文件并调用纯解析器。
4. 如果不需要修改，返回 skipped。
5. 创建 `.lobsterai/migrations/`。
6. 写完整备份。
7. 用现有 `atomicWriteFile()` 或等价安全写法写回 `AGENTS.md`。

日志建议：

```text
[OpenClawConfigSync] Cleaned legacy AGENTS.md identity block for agent <agentId>; backup=<path>
```

失败日志使用 `console.warn`，不要吞掉错误原因。

### 4.3 设置页保存后触发 cleanup

候选 renderer 位置：

```text
src/renderer/components/agent/AgentSettingsPanel.tsx
```

保存流程应在以下步骤之后触发 cleanup：

1. `agentService.updateAgent()` 成功；
2. 主 Agent 的 `IDENTITY.md` / `SOUL.md` / `USER.md` bootstrap write 成功；
3. 非主 Agent 的必要 profile 同步已由主进程 update/sync 完成或 cleanup IPC 内部完成；
4. IM bindings 保存不影响 identity cleanup，但最终关闭/刷新前可以等待 cleanup 返回。

触发条件：

```typescript
const identityChanged = changedFields.includes('identity');
if (identityChanged) {
  await agentService.cleanupLegacyIdentityBlock(agentId);
}
```

如果 cleanup 失败，保存仍视为成功；记录 telemetry/log，必要时显示非阻断提示。

### 4.4 非主 Agent 的同步顺序

非主 Agent 的 `IDENTITY.md` 当前由 `syncPerAgentWorkspaces()` 写入，因此不能只在 renderer
保存返回后立刻假设文件已落盘。

推荐方案：

1. `AgentIpcChannel.Update` 检测 `updates.identity !== undefined` 且身份值发生变化；
2. 对身份变更的保存，主进程触发一次可等待的 targeted workspace sync，至少确保当前
   agent 的 `IDENTITY.md` 写入；
3. 在同一个主进程流程中清理该 agent workspace 的 `AGENTS.md`；
4. 返回 update 结果和可选 cleanup 结果。

如果为了保持现有 update handler 的 fire-and-forget 行为，也可以新增独立 cleanup IPC，但
该 IPC 内部必须先确认目标 workspace 的 `IDENTITY.md` 与数据库中的 `agent.identity` 对齐，
必要时执行一次 targeted sync 后再清理。

### 4.5 主 Agent 的同步顺序

主 Agent 的身份内容目前由设置页通过 `coworkService.writeBootstrapFile('IDENTITY.md', identity)`
写入主 workspace。

推荐方案：

1. 保持现有主 Agent bootstrap write；
2. 在三个 bootstrap write 都成功后调用 cleanup IPC；
3. cleanup IPC 只清理 `AGENTS.md`，不重写 `IDENTITY.md`；
4. 后续可单独考虑把主 Agent profile 写入也收敛到 main process，但这不是本次修复必须项。

### 4.6 与 `syncAgentsMd()` 的关系

`syncAgentsMd()` 继续负责：

- 保留 marker 前用户内容；
- 写入 marker 后 LobsterAI managed section；
- 嵌入 system prompt、browser/web-search/memory/scheduled-task 等策略。

legacy identity cleanup 不应变成 `syncAgentsMd()` 每次调用的默认副作用。可以复用同一个
文件写入 helper，但必须由身份保存动作显式触发。

## 5. 边界情况

| 场景 | 处理方式 |
|------|----------|
| `AGENTS.md` 不存在 | 返回 `skipped: no-agents-md`，不创建空文件 |
| `AGENTS.md` 没有 legacy identity block | 返回 `skipped: no-legacy-block` |
| 有 `## Identity` 但不符合历史模板 | 返回 `skipped: low-confidence`，不修改 |
| legacy block 在 marker 后 | 不处理，marker 后由 `syncAgentsMd()` 管理 |
| 文件顶部有 BOM 或空白 | 允许识别，但写回时保留合理换行 |
| `---` 后不是默认模板锚点 | 不处理，避免误删用户文档 |
| 被识别 block 超过长度上限 | 不处理并记录低置信原因 |
| 备份目录创建失败 | 不修改 `AGENTS.md`，返回 failed |
| 备份写成功但 atomic write 失败 | 保留备份，原 `AGENTS.md` 应保持旧内容 |
| 用户连续保存多次 | 第一次 cleaned，后续 skipped；不会重复删除其它内容 |
| 用户清空身份 | 清理旧块，但不恢复旧身份到 `IDENTITY.md` |
| 工作目录和 Agent workspace 不同 | cleanup 只操作 Agent workspace，不碰用户项目 cwd |

## 6. 涉及文件

### `src/main/libs/openclawAgentsMdIdentityMigration.ts`

新增纯解析和清理逻辑。

### `src/main/libs/openclawConfigSync.ts`

复用 workspace 路径解析、atomic write 或新增对 cleanup helper 的调用入口。不要把 cleanup
变成普通 `syncAgentsMd()` 的默认行为。

### `src/main/main.ts`

新增或扩展 Agent IPC：

- 识别身份保存动作；
- 对非主 Agent 保证 `IDENTITY.md` 同步顺序；
- 暴露 cleanup 结果；
- 记录失败 warning。

### `src/main/preload.ts`

向 renderer 暴露 cleanup IPC。

### `src/renderer/services/agent.ts`

新增 `cleanupLegacyIdentityBlock(agentId)` 包装方法，或把 cleanup result 合并到 update
返回值。

### `src/renderer/components/agent/AgentSettingsPanel.tsx`

在保存成功且 `identity` 字段发生变化后触发 cleanup。cleanup 失败不回滚身份保存。

### `src/renderer/types/electron.d.ts`

补充 preload 暴露的类型。

### 测试文件

建议新增：

```text
src/main/libs/openclawAgentsMdIdentityMigration.test.ts
```

必要时扩展：

```text
src/main/libs/openclawConfigSync.runtime.test.ts
src/renderer/services/agent.test.ts
```

## 7. 验收标准

1. 用户在非主 Agent 设置页修改身份并保存后，该 Agent 的 `IDENTITY.md` 包含新身份。
2. 同一次保存后，如果 `AGENTS.md` 顶部存在高置信 `## Identity（必须遵守）` 历史块，该块
   从 prompt 表面移除。
3. 清理后的 `AGENTS.md` 仍保留原来的默认模板内容、用户其它规则和 LobsterAI managed
   section。
4. 清理前完整备份原始 `AGENTS.md` 到 `<workspace>/.lobsterai/migrations/`。
5. 备份失败时不修改 `AGENTS.md`。
6. 用户手写但不符合历史模板的 identity 相关内容不会被自动删除。
7. 用户把身份清空保存时，旧 `AGENTS.md` 身份块不会被重新写回 `IDENTITY.md`。
8. 仅修改模型、技能、工作目录、pin 状态等非 identity 字段时，不触发 cleanup。
9. 主 Agent 和非主 Agent 都能按各自 workspace 清理，不会操作用户项目 cwd。
10. 重复保存同一身份不会重复创建无意义修改，也不会继续删除其它 `AGENTS.md` 内容。
11. cleanup skipped 或 failed 不会导致身份保存失败；failed 有可定位日志。
12. 新建会话时 Agent 不再同时收到旧 `AGENTS.md` 身份和新 `IDENTITY.md` 身份。

## 8. 验证计划

### 单元测试

覆盖 `removeLegacyAgentsMdIdentityBlock()`：

1. 清理标准历史块并保留 marker 后内容。
2. 清理无 marker 的标准历史块。
3. 保留普通用户自写 `## Identity`。
4. 保留没有 `---` 分隔线的内容。
5. 保留 `---` 后不匹配默认模板锚点的内容。
6. 处理 BOM、空白行和不同换行风格。
7. 重复运行幂等。
8. 超长 block 返回 low-confidence。

### 主进程测试

覆盖 cleanup helper：

1. 写备份后 atomic write 清理 `AGENTS.md`。
2. `AGENTS.md` 不存在时 skipped。
3. 备份失败时不写回。
4. main agent workspace 和非主 agent workspace 路径解析正确。

### Renderer/service 测试

覆盖设置页或 service 层：

1. `identity` changed 时调用 cleanup。
2. `identity` 未变化时不调用 cleanup。
3. cleanup failed 不阻断保存成功路径。

### 手动验证

1. 构造一个非主 Agent workspace，在 `AGENTS.md` 顶部加入历史 `## Identity（必须遵守）`
   块。
2. 在设置页修改该 Agent 身份并保存。
3. 确认 `IDENTITY.md` 是新身份。
4. 确认 `AGENTS.md` 不再包含历史身份块。
5. 确认 `.lobsterai/migrations/` 下存在原始 `AGENTS.md` 备份。
6. 新建该 Agent 会话，询问身份，确认不再沿用旧身份。
7. 对主 Agent 重复以上流程。
