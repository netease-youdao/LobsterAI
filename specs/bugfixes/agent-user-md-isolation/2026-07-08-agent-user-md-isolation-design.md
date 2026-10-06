# Agent USER.md 独立读写修复设计文档

## 1. 概述

### 1.1 问题

用户反馈：不同 Agent 设置页中的“关于你”（`USER.md`）内容会互相覆盖。只要在任意
Agent 中更新该内容，其它 Agent 再打开设置页或同步 workspace 后也会显示相同内容。

从用户视角看，“助手身份”（`IDENTITY.md`）和“助手性格”（`SOUL.md`）都能按 Agent 独立
配置，唯独“关于你”显示在每个 Agent 的设置面板里，却表现为全局共享。这与当前多 Agent
workspace 模型不一致。

当前问题还影响新建 Agent：

- 新建 Agent 弹窗会读取 main Agent 的 `USER.md` 作为初始值；
- 如果用户在新建弹窗里编辑“关于你”，保存时会先写 main Agent 的 `USER.md`；
- Agent 创建后，LobsterAI 的 config sync 会把 main `USER.md` 再复制到新 Agent workspace；
- 由于 OpenClaw 使用 `writeFileIfMissing` 创建 bootstrap 文件，LobsterAI 先写入后，
  OpenClaw 后续不会再写自己的默认 `USER.md` 模板。

### 1.2 根因

根因不是 SQLite 中 Agent 数据串写，也不是 OpenClaw runtime 只支持共享 `USER.md`。根因是
LobsterAI 集成层把 `USER.md` 的所有权和作用域接错了。

当前代码路径中：

| 文件 | 当前 LobsterAI 行为 | 正确语义 |
|------|---------------------|----------|
| `SOUL.md` | 非主 Agent 从 `agent.systemPrompt` 写入 `workspace-{agentId}/SOUL.md` | Agent 独立 |
| `IDENTITY.md` | 非主 Agent 从 `agent.identity` 写入 `workspace-{agentId}/IDENTITY.md` | Agent 独立 |
| `USER.md` | 从 main workspace 读取，再写入所有非主 Agent workspace | 应属于当前 Agent workspace |
| `AGENTS.md` | 每个 Agent workspace 各自同步 managed section | Agent 独立 |

关键代码路径：

- `AgentSettingsPanel` 打开任意 Agent 都调用 `coworkService.readBootstrapFile('USER.md')`；
- `AgentSettingsPanel` 保存非主 Agent 时仍调用 `coworkService.writeBootstrapFile('USER.md', userInfo)`；
- `AgentCreateModal` 打开时读取 main `USER.md`，创建前如果用户改过就写 main `USER.md`；
- `cowork:bootstrap:read/write` IPC 只接收 `filename`，主进程固定解析到
  `{stateDir}/workspace-main`；
- `syncPerAgentWorkspaces()` 从 main workspace 读取 `USER.md`，再写入每个
  `workspace-{agentId}/USER.md`。

这条链路把“当前 Agent 的 `USER.md` 编辑器”实现成了“main Agent `USER.md` 的全局编辑器”。

### 1.3 为什么 SOUL / IDENTITY 独立而 USER 共享

从历史提交看，多 Agent 初始设计明确包含：

- 每个 Agent 独立 workspace；
- 每个 Agent 独立 `SOUL.md`；
- 每个 Agent 独立 `IDENTITY.md`；
- 每个 Agent 独立 `AGENTS.md` managed section。

`USER.md` 并没有在初始多 Agent 数据模型中建模。后续 UI 优化把“关于你”tab 加进了
Agent 创建和设置页，但没有给它接入当前 Agent workspace，而是复用了既有 main bootstrap
读写 API，并在同步阶段把 main `USER.md` 分发给所有非主 Agent。

这更像是历史上的“用户画像应全局共享”假设被套进了 per-Agent 设置 UI，而不是当前
OpenClaw workspace 模型下的合理设计。OpenClaw 自身把 `USER.md` 定义为每个 agent
workspace 的 optional bootstrap 文件；文件不存在时由 OpenClaw `ensureAgentWorkspace()`
使用默认模板创建，不要求也不假设所有 Agent 共享同一份。

### 1.4 目标

本修复目标：

1. “关于你”设置页必须读写当前 Agent workspace 的 `USER.md`；
2. main Agent 修改 `USER.md` 不再传播到非主 Agent；
3. 非主 Agent 修改 `USER.md` 不再修改 main Agent 或其它 Agent；
4. 新建 Agent 不再使用 main `USER.md` 作为默认值；
5. 新建 Agent 未显式填写“关于你”时，LobsterAI 不主动创建 `USER.md`，由 OpenClaw 在
   workspace 初始化/首次运行时按自身模板创建；
6. 不引入新的数据库字段来保存 `USER.md`，文件本身仍是权威来源。

### 1.5 非目标

- 不新增 `agents.user_info`、`agents.about_me` 等数据库字段。
- 不把 `USER.md` 合并进 `agent.identity` 或 `agent.systemPrompt`。
- 不修改 OpenClaw 的默认 `USER.md` 模板或 bootstrap 创建逻辑。
- 不通过 `agents.defaults.skipOptionalBootstrapFiles: ['USER.md']` 解决问题；这会阻止
  OpenClaw 创建默认 `USER.md`，与目标相反。
- 不在普通 config sync 中删除用户已有的 `USER.md` 内容。
- 不把 main `USER.md` 作为新 Agent 的 fallback、默认值或预填内容。

## 2. 用户场景

### 场景 A: 编辑非主 Agent 的“关于你”

**Given** 用户打开 Agent A 的设置页

**When** 用户修改“关于你”并保存

**Then** 只写入 `workspace-{agentA}/USER.md`

**And** `workspace-main/USER.md`、`workspace-{agentB}/USER.md` 保持不变。

### 场景 B: 编辑 main Agent 的“关于你”

**Given** 用户打开 main Agent 的设置页

**When** 用户修改“关于你”并保存

**Then** 只写入 `workspace-main/USER.md`

**And** 不再通过 `syncPerAgentWorkspaces()` 复制到任何非主 Agent workspace。

### 场景 C: 新建 Agent 未填写“关于你”

**Given** 用户打开新建 Agent 弹窗

**When** 用户不编辑“关于你”并创建 Agent

**Then** LobsterAI 不写 main `USER.md`

**And** LobsterAI 不写新 Agent 的 `USER.md`

**And** 后续 OpenClaw 初始化该 Agent workspace 时，如果 `USER.md` 缺失，由 OpenClaw 自己
使用默认模板创建。

### 场景 D: 新建 Agent 显式填写“关于你”

**Given** 用户在新建 Agent 弹窗中显式填写“关于你”

**When** Agent 创建成功

**Then** LobsterAI 将该内容写入新 Agent 的 `workspace-{agentId}/USER.md`

**And** 不修改 main Agent 的 `USER.md`

**And** 如果 Agent 创建失败，不写任何 workspace `USER.md`。

### 场景 E: 打开尚未创建 USER.md 的 Agent

**Given** 某 Agent workspace 中还没有 `USER.md`

**When** 用户打开 Agent 设置页

**Then** “关于你”编辑器显示为空

**And** 读取动作不创建文件

**And** 只有用户显式保存非空或显式清空已有内容时，才写入该 Agent 的 `USER.md`。

### 场景 F: 既有用户已经被 main USER.md 污染

**Given** 旧版本已经把 main `USER.md` 复制到多个非主 Agent workspace

**When** 用户升级到修复版本

**Then** 后续 main `USER.md` 修改不再继续覆盖非主 Agent

**And** 后续非主 Agent 修改只影响自己

**And** 修复不在后台静默删除已有 `USER.md`。如需清理历史污染，应提供显式、可回滚的修复
入口，且删除/移走前必须备份。

## 3. 功能需求

### FR-1: Bootstrap 文件读写 API 必须支持 Agent 作用域

Renderer 到 main process 的 bootstrap 文件读写 API 需要携带可选 Agent 上下文：

```typescript
readBootstrapFile(filename, { agentId })
writeBootstrapFile(filename, content, { agentId })
```

主进程根据 `agentId` 解析 workspace：

| Agent | workspace |
|-------|-----------|
| main | `{stateDir}/workspace-main` |
| 非主 Agent | `{stateDir}/workspace-{agentId}` |

如果 `agentId` 为空，为兼容旧调用可默认 main，但新代码应显式传入当前 Agent id。

### FR-2: IPC channel 名称应集中管理

当前 `cowork:bootstrap:read/write` 是裸字符串。后续修改该通道时，应补到共享常量中，避免
继续扩散裸 IPC 字符串。

建议新增或复用共享常量位置：

```text
src/shared/cowork/constants.ts
```

### FR-3: 主进程必须校验目标 Agent

读写非 main Agent workspace 前，主进程必须确认 Agent 存在：

1. `agentId === main` 时允许；
2. 非 main 时，`AgentManager.getAgent(agentId)` 必须存在；
3. 不允许 renderer 传任意路径；
4. `filename` 继续走现有 allowlist，只允许 `IDENTITY.md`、`SOUL.md`、`USER.md`。

### FR-4: Agent 设置页按当前 Agent 读取 USER.md

`AgentSettingsPanel` 加载时：

- main Agent：
  - `IDENTITY.md` 继续从 main workspace 读取；
  - `SOUL.md` 继续从 main workspace 读取；
  - `USER.md` 从 main workspace 读取。
- 非主 Agent：
  - `identity` 继续来自 `agent.identity`；
  - `systemPrompt` 继续来自 `agent.systemPrompt`；
  - `USER.md` 从当前 Agent workspace 读取。

不要因为非主 Agent 的 `USER.md` 缺失而回退读取 main `USER.md`。

### FR-5: Agent 设置页按当前 Agent 保存 USER.md

`AgentSettingsPanel` 保存时：

- main Agent：
  - 保存 `IDENTITY.md` 到 main workspace；
  - 保存 `SOUL.md` 到 main workspace；
  - 保存 `USER.md` 到 main workspace。
- 非主 Agent：
  - `identity` 和 `systemPrompt` 继续经 Agent 数据模型保存，并由 config sync 写入
    `IDENTITY.md` / `SOUL.md`；
  - `USER.md` 通过 agent-scoped bootstrap write 写入当前 Agent workspace。

非主 Agent 保存 `USER.md` 不应触发 main workspace 写入。

### FR-6: 新建 Agent 不预填 main USER.md

`AgentCreateModal` 打开时：

- `userInfo` 初始值为空；
- `initialUserInfoRef` 初始值为空；
- 不调用 `readBootstrapFile('USER.md')` 读取 main；
- 用户未改动“关于你”时，创建流程不写 `USER.md`。

如果用户显式填写了“关于你”，应先创建 Agent，拿到新 Agent id 后，再写入
`workspace-{agentId}/USER.md`。

### FR-7: Config sync 不再同步 USER.md

`syncPerAgentWorkspaces()` 不应读取 main `USER.md`，也不应写入非主 Agent 的 `USER.md`。

它仍然负责 LobsterAI 自己持有的数据：

- `SOUL.md`：来自 `agent.systemPrompt`；
- `IDENTITY.md`：来自 `agent.identity`；
- `AGENTS.md`：managed section 和运行策略；
- `MEMORY.md` / `memory/`：必要的目录和空文件初始化。

`USER.md` 由 OpenClaw workspace bootstrap 或用户显式编辑负责。

### FR-8: 历史污染修复必须显式且可回滚

本次核心修复是阻止后续覆盖。对于已经被旧版本复制的 `USER.md`，不应在普通启动或普通
config sync 中直接删除。

如需要处理历史污染，应单独实现显式 repair：

1. 只扫描非主 Agent workspace；
2. 仅当 `workspace-{agentId}/USER.md` 与 `workspace-main/USER.md` 内容完全相同，且用户
   明确执行“重置/修复 Agent USER.md”时才处理；
3. 处理前将原文件完整备份到不参与 OpenClaw bootstrap 注入的位置，例如
   `workspace-{agentId}/.lobsterai/migrations/`；
4. 处理方式优先为移动/重命名原文件，让 OpenClaw 下次自行创建默认模板；
5. 不处理与 main 不同的 `USER.md`，避免误删用户真实定制内容。

## 4. 实现方案

### 4.1 抽取 Agent workspace 解析

当前主进程已有 cleanup legacy identity block 使用的局部函数：

```typescript
const resolveAgentWorkspacePath = (agentId: string): string => {
  const stateDir = getOpenClawEngineManager().getStateDir();
  return agentId === AgentId.Main
    ? getMainAgentWorkspacePath(stateDir)
    : path.join(stateDir, `workspace-${agentId}`);
};
```

建议将其提升为主进程内可复用 helper，或移动到合适的 OpenClaw integration helper 文件中。

要求：

- main 和非 main 的路径规则必须与 `buildManagedAgentEntries()` / OpenClaw
  `resolveAgentWorkspaceDir()` 保持一致；
- 非 main Agent 不存在时返回错误；
- 不接受 renderer 传入的 workspace path。

### 4.2 扩展 preload / renderer 类型

涉及文件：

- `src/main/preload.ts`
- `src/renderer/types/electron.d.ts`
- `src/renderer/services/cowork.ts`

目标 API：

```typescript
type BootstrapFileOptions = {
  agentId?: string;
};
```

读写函数都接收该 options，并透传到 IPC。

### 4.3 修改主进程 IPC handler

涉及文件：

- `src/main/main.ts`
- `src/shared/cowork/constants.ts`（如补 IPC 常量）

处理流程：

1. 校验 `filename` 仍走 `openclawMemoryFile.ts` 的 allowlist；
2. 解析 `agentId`，默认 main；
3. 校验 Agent 存在；
4. 解析 workspace；
5. `readBootstrapFile(workspace, filename)` 或
   `writeBootstrapFile(workspace, filename, content)`；
6. 写入后仍可触发 `syncOpenClawConfig({ reason: 'bootstrap-updated' })`，但
   `syncPerAgentWorkspaces()` 不再复制 `USER.md`，因此不会造成回写污染。

### 4.4 修改 AgentSettingsPanel

涉及文件：

```text
src/renderer/components/agent/AgentSettingsPanel.tsx
```

加载逻辑：

```typescript
const nextUserInfo = await coworkService.readBootstrapFile('USER.md', { agentId });
```

保存逻辑：

```typescript
const bootstrapWrites = isMainAgent
  ? [
      coworkService.writeBootstrapFile('IDENTITY.md', identity, { agentId }),
      coworkService.writeBootstrapFile('SOUL.md', systemPrompt, { agentId }),
      coworkService.writeBootstrapFile('USER.md', userInfo, { agentId }),
    ]
  : [
      coworkService.writeBootstrapFile('USER.md', userInfo, { agentId }),
    ];
```

可进一步优化：只有 `userInfo` 变化时才写 `USER.md`，避免无意义修改文件 mtime。但该优化不是
正确性的前提。

### 4.5 修改 AgentCreateModal

涉及文件：

```text
src/renderer/components/agent/AgentCreateModal.tsx
```

改动点：

1. 打开弹窗时不读取 main `USER.md`；
2. `userInfo` 和 `initialUserInfoRef` 初始化为空；
3. 创建 Agent 前不写任何 `USER.md`；
4. Agent 创建成功且用户显式填写/修改了 `userInfo` 后，写入新 Agent workspace：

```typescript
const agent = await agentService.createAgent(...);
if (agent && userInfo !== initialUserInfoRef.current) {
  await coworkService.writeBootstrapFile('USER.md', userInfo, { agentId: agent.id });
}
```

如果写 `USER.md` 失败：

- Agent 已创建，不应自动删除 Agent；
- 应提示保存“关于你”失败；
- 后续用户可在 Agent 设置页重试保存。

### 4.6 修改 OpenClaw config sync

涉及文件：

```text
src/main/libs/openclawConfigSync.ts
```

从 `syncPerAgentWorkspaces()` 中移除：

```typescript
const userContent = readBootstrapFile(mainWorkspaceDir, 'USER.md');
...
const userPath = path.join(agentWorkspace, 'USER.md');
this.syncFileIfChanged(userPath, userContent);
```

同步注释也要从 `SOUL.md, IDENTITY.md, USER.md, AGENTS.md` 改为
`SOUL.md, IDENTITY.md, AGENTS.md`，避免后续开发误判 ownership。

### 4.7 测试覆盖

建议新增或更新以下测试：

1. `openclawConfigSync` 测试：
   - main workspace 存在 `USER.md`；
   - 非主 Agent enabled；
   - 执行 sync 后，非主 Agent workspace 不应被写入 main `USER.md`。
2. main process bootstrap IPC 测试或纯 helper 测试：
   - `agentId=main` 解析到 `workspace-main`；
   - `agentId=custom` 解析到 `workspace-custom`；
   - 不存在 Agent 返回失败；
   - 非 allowlist filename 返回失败。
3. renderer service / component 测试：
   - `AgentSettingsPanel` 读取 `USER.md` 时传当前 `agentId`；
   - 非主 Agent 保存 `USER.md` 时传当前 `agentId`；
   - `AgentCreateModal` 打开时不读取 main `USER.md`；
   - 新建 Agent 未填写 `userInfo` 时不写 `USER.md`；
   - 新建 Agent 填写 `userInfo` 时创建成功后写入新 Agent id。

## 5. 边界情况

| 场景 | 处理方式 |
|------|----------|
| `USER.md` 不存在 | 读取返回空字符串，不创建文件；由 OpenClaw 后续初始化默认模板 |
| 用户显式清空已有 `USER.md` | 保存空内容到当前 Agent workspace，表示用户明确清空 |
| 非主 Agent 被删除后仍打开设置页 | 主进程校验 Agent 不存在，读写返回失败 |
| Agent id 含非法路径字符 | 不直接拼用户路径；只接受已存在 Agent id，并按 stateDir 规则解析 |
| main 与非主 Agent 的 `USER.md` 内容刚好相同 | 不自动删除；除非用户显式执行可回滚 repair |
| 写入 `USER.md` 成功但 config sync 失败 | 文件保存仍成立，记录 sync warning；不回滚用户文件 |
| 新建 Agent 成功但写 `USER.md` 失败 | 保留 Agent，提示“关于你”保存失败，用户可重试 |
| OpenClaw 默认模板更新 | LobsterAI 不内置模板，因此自动跟随 OpenClaw runtime |

## 6. 验收标准

### 6.1 行为验收

1. 修改 main Agent 的“关于你”后，非主 Agent 的 `USER.md` 不变化。
2. 修改 Agent A 的“关于你”后，Agent B 和 main 的 `USER.md` 不变化。
3. 新建 Agent 未填写“关于你”时，main `USER.md` 不变化，新 Agent workspace 不被
   LobsterAI 写入 main 内容。
4. 新建 Agent 填写“关于你”时，该内容只出现在新 Agent workspace。
5. 删除非主 Agent 的 `USER.md` 后打开设置页，不会回退显示 main 内容。
6. OpenClaw 首次运行新 Agent 时，缺失的 `USER.md` 可由 OpenClaw 自己创建默认模板。

### 6.2 代码验收

1. `syncPerAgentWorkspaces()` 不再读取或写入 `USER.md`。
2. `cowork:bootstrap:read/write` 支持 Agent 作用域，并校验 Agent 存在。
3. 新增或触碰的 IPC channel 名称使用共享常量。
4. 不新增 `agents` 表字段。
5. 不写入 `skipOptionalBootstrapFiles: ['USER.md']`。
6. 不修改 OpenClaw 源码或 OpenClaw 默认模板。

### 6.3 测试验收

至少运行：

```bash
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <touched-files>
npm test -- openclawConfigSync
```

如修改 renderer 组件测试或新增组件测试，还应运行对应 Vitest 过滤项。

### 6.4 手动验证

使用 `npm run electron:dev` 或 `npm run electron:dev:openclaw` 验证：

1. 创建 Agent A 和 Agent B；
2. 分别在两个 Agent 中填写不同“关于你”；
3. 重启应用后再次打开设置页确认内容仍独立；
4. 检查 OpenClaw state 目录：
   - `workspace-main/USER.md`
   - `workspace-{agentA}/USER.md`
   - `workspace-{agentB}/USER.md`
5. 确认三者内容互不覆盖。
