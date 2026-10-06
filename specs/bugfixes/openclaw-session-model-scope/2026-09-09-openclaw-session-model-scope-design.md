# OpenClaw 会话切换模型意外改写默认模型修复设计

## 1. 概述

### 1.1 问题

LobsterAI 升级到 OpenClaw `v2026.8.1` 后，多会话切换模型回测发现：已有会话通过
`sessions.patch` 选择模型时，OpenClaw 还可能把该选择写成 agent 默认模型，或写入
共享默认模型。用户只是想在当前对话尝试另一个模型，却影响了后续继承默认配置的请求。

LobsterAI 已有独立的会话模型与 agent 偏好。OpenClaw 的额外写入只修改其配置文件，
不会同时更新 LobsterAI 保存的 agent 偏好，可能造成界面偏好与运行时默认值不一致；
下一次 LobsterAI 配置同步又会按本地偏好重建默认值。

本次显式同步 `agents.defaults.modelSelectionScope = "session"`，恢复普通会话模型
切换只影响当前会话的语义。主动修改 agent 或共享默认模型的原有入口继续生效。

### 1.2 根因与版本差异

| 版本或上游变更 | 行为 |
| --- | --- |
| `v2026.6.1` | `sessions.patch(model)` 更新会话模型 override，没有随后把选择持久化到默认模型的逻辑，也没有 `modelSelectionScope` 配置。 |
| 2026-07-29，[上游提交 eee5e029e36 / PR #115717](https://github.com/openclaw/openclaw/commit/eee5e029e36dada3f35204ec464cd1096a22fab5) | 引入 sticky model：满足授权等条件的会话模型选择可写入生效的默认配置层。 |
| 2026-08-27，[上游提交 ce4a680544a / PR #127813](https://github.com/openclaw/openclaw/commit/ce4a680544a3502f98d3c9dc49ab9b9e77e7c43b) | 引入 `session`、`agent`、`global` 三种 scope；省略配置仍走兼容用的 `effective` 行为。 |
| 本项目固定的 `v2026.8.1` | 已包含上述两项变更；配置缺省并不等于 `session`，需要在 LobsterAI 配置同步中明确选择。 |

当前上游 `sessions.patch` 的默认值写入要求调用方具有 `operator.admin`，且 patch
包含字符串模型。缺省 scope 下，还要求会话保留用户选择的 provider/model override。
目标 agent 有显式默认模型时写该 agent；否则写共享默认模型。它不是每次请求必然
写配置，也不是任意一个会话切模型就会把所有会话的实际模型一起切掉。

上游依据是固定版本中的 `src/gateway/server-methods/sessions-patch-model-selection.ts`、
`src/agents/sticky-model-selection.ts` 和 `src/agents/agent-scope.ts`。
`session` 由上游原生支持，LobsterAI 无需新增版本补丁。

### 1.3 与 system 缓存修复的关系

此前的 [默认模型与 system 缓存隔离修复](../../refactors/openclaw-upgrade/2026-09-09-default-model-prompt-cache.md)
已移除 system Runtime 文本中的 `default_model`，保留实际运行的 `model`。它解决的是
默认配置变化导致已有会话 system 前缀变化的问题。

本次处理的是会话选择意外写回默认配置的问题。两项改动分别约束提示文本和默认值
写入，不能互相替代；本次也不承诺固定的缓存命中率，真实模型切换、历史变化和
供应商缓存策略仍会影响缓存。

## 2. 用户场景

以下普通切换场景假设 agent 原有模型配置有效，且没有同时主动修改默认偏好。

| 场景 | 修改后的预期 |
| --- | --- |
| agent 默认模型为 A，在已有会话 S1 中选择 B | S1 后续请求使用 B；agent 与共享默认模型保持原值。 |
| 同一 agent 的 S2 使用 A，S1、S2 交替发消息或重复同步模型 | 两个会话各自按其模型选择运行，不因另一会话的 patch 改写默认值。 |
| 另一 agent 的会话切换到 B | 该会话可以使用 B，两个 agent 的默认模型和共享默认模型均不因此被改写。 |
| 在没有当前会话的新对话页面选择 C | 继续通过 LobsterAI 保存当前 agent 的模型偏好，后续新会话可以使用 C。 |
| 主动修改 agent 或共享默认模型 | 配置正常同步；没有固定 override 的请求按原有规则继承新默认值，固定为 B 的会话仍可使用 B。 |
| Gateway 重新连接 | 已落盘的会话模型选择仍可恢复，不需要把它写成默认模型。 |

## 3. 功能需求

1. 正常生成 OpenClaw 配置时，统一写入 `agents.defaults.modelSelectionScope = "session"`。
2. 已有配置缺省或原为 `agent`、`global` 时，下一次正常配置同步统一为 `session`；
   相同输入重复同步不产生额外配置变更。
3. 保留现有会话 patch、模型校验、override 持久化和请求路由，不迁移或清空会话记录。
4. 保留 LobsterAI 主动保存 agent 偏好、修改共享默认模型及修复无效 agent 模型的路径。
5. 沿用现有配置投递、热加载和重启处理，不增加 IPC、UI 开关或新的 Gateway 重启策略。

## 4. 实现方案

在 `src/main/libs/openclawConfigSync.ts` 定义 `OPENCLAW_MODEL_SELECTION_SCOPE` 常量，
并在正常配置生成的 `agents.defaults` 中引用它：

```json
{
  "agents": {
    "defaults": {
      "modelSelectionScope": "session"
    }
  }
}
```

上游收到配置后，普通 `sessions.patch(model)` 仍更新会话，但其
`persistSessionPatchModelSelection()` 在 `session` scope 下直接跳过默认值写入。
用户选择不再额外触发这类 sticky config 写入。

模型偏好仍由 LobsterAI 按现有路径同步到 `agents.entries.<agentId>.model` 和
`agents.defaults.model`。新对话页面的 `usePersistAgentModelSelection()` 继续调用
`agentService.updateAgent()`；已有会话继续走 `coworkService.patchSession()`。

变更文件：

| 文件 | 内容 |
| --- | --- |
| `src/main/libs/openclawConfigSync.ts` | 新增 scope 常量和配置字段。 |
| `src/main/libs/openclawConfigSync.runtime.test.ts` | 新增 3 个参数化回归用例，覆盖旧 scope 替换、显式默认模型变更与重复同步。 |
| 本文档 | 记录行为、边界和验证结果。 |

## 5. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| 会话选择恰好等于生效默认模型，或清除 override | 上游仍可清除会话 pin，使其继续继承默认值；`session` 不是把所有会话永久锁定在创建时模型的开关。 |
| 新对话页面选择模型 | 当前产品会保存 agent 偏好，此行为保留。需要测试会话隔离时，应在已经建立的会话内切换模型。 |
| 已有会话选择模型时，原 agent 模型已经无效 | UI 原有修复分支仍可能主动调用 `agentService.updateAgent()`；本次只禁止 OpenClaw 的隐式 sticky 写入。 |
| 原生 `/model --agent` 或 `/model --global` | 上游显式命令 scope 优先于配置偏好，且仍须通过 owner/admin 授权；本配置不是禁止一切默认模型修改的权限规则。 |
| IM、cron 或原生请求 | 已指定模型的请求继续使用自己的选择；继承默认值的请求仍会受主动默认配置变更影响。本次不改这些入口的选模策略。 |
| 旧 sticky 写入已使默认配置与 LobsterAI 偏好不一致 | 正常同步按 LobsterAI 当前保存的偏好重建默认值，不把旧 sticky 结果反向导入本地偏好，不清理会话 override。 |
| 退出登录或暂时没有可用模型配置 | 保留现有最小配置流程：已有非 provider 配置继续保留；全新最小配置不额外注入该字段。恢复正常模型配置同步后再写入 `session`。 |
| 模型不可用、权限不足、模型锁定或 fallback | 继续遵守已有校验与路由规则；本次不放宽这些限制。 |
| 升级或回滚 OpenClaw | 升级时复核 schema、普通 session patch 和显式 scope 命令。若回退到不支持该字段的旧版，应同时回退本改动，并在启动旧 Gateway 前重新生成兼容配置。 |

## 6. 验收标准与验证记录

### 6.1 已完成的自动化验证

在基于 `feat/openclaw-v2026.8.1` 的 `5210f6f25` 独立 worktree 中，新增的 3 个
用例先因配置缺少 `session` 而失败，加入配置字段后通过。覆盖：

- 首次生成配置时使用 `session`。
- 将缺省、`agent`、`global` 三种旧配置统一为 `session`，并按 LobsterAI 偏好恢复默认模型。
- 显式修改 main agent 模型时，worker 和共享默认模型保持各自原值。
- 显式修改共享默认模型时正确同步新值，worker 模型不受影响。
- 上述状态重复同步均返回 `changed: false`。

相关 Vitest 共 **139 项通过、2 项跳过**。跳过的是打包 runtime CLI 的 schema 验证，
原因是新 worktree 没有 `vendor/openclaw-runtime/current/openclaw.mjs`。
两份修改文件的严格 ESLint 和 Electron TypeScript 编译通过。

复现命令，在 LobsterAI 工作区执行：

```sh
node node_modules/vitest/vitest.mjs run src/main/libs/openclawConfigSync.runtime.test.ts src/main/libs/openclawAgentModels.test.ts src/renderer/components/cowork/agentModelSelection.test.ts --reporter=dot --silent
node node_modules/eslint/bin/eslint.js --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/openclawConfigSync.ts src/main/libs/openclawConfigSync.runtime.test.ts
npm run --ignore-scripts compile:electron
```

编译命令执行实际 Electron `tsc`，但跳过 npm 生命周期脚本，避免重建共用依赖目录中的
原生模块；不代表完成安装包构建或打包 runtime 验证。

### 6.2 已完成的源码 Gateway 冒烟

使用已应用 LobsterAI 版本补丁的 OpenClaw `v2026.8.1` 源码 Gateway、独立临时状态目录、
具有 `operator.admin` 的真实 Gateway 客户端和本地模拟 OpenAI Completions 服务。
外部通道和插件关闭，模型调用只发往本地模拟服务。

1. 设置共享默认模型和 main 默认模型为 A，worker 默认模型为 C，scope 为 `session`。
2. main 会话 S1 选择 A 并发送；S2 选择 B 并发送；返回 S1 发送，实际请求仍为 A。
3. 对 S2 重复 patch B 三次；worker 会话也选择 B 并发送。
4. 确认整个 `agents` 配置未被这些 session patch 改写；只读检查返回的会话 SQLite，
   确认 S2 的 provider/model override 已落盘。
5. 主动把 main 默认模型改为 C，日志确认 `config hot reload applied`。新 main 会话
   实际使用 C，S2 仍使用 B；共享默认模型保持 A，worker 默认模型保持 C。
6. 重新连接 Gateway，再次发送 S2，实际模型仍为 B。

共 7 次模拟模型请求成功，无 `persisted sticky model selection` 日志；配置热加载成功，
未触发恢复重启，Gateway 正常关闭。该结果验证了源码 Gateway 协议及请求模型，
不等于 Electron 图形界面或真实供应商缓存命中率已经回测。

### 6.3 待 QA 完成的产品冒烟

- [ ] 启动本分支应用并完成正常模型配置同步，确认生成配置含 `modelSelectionScope: "session"`。
- [ ] 在同一 agent 下先建立两个会话，再分别选择 A/B，交替发送；核对实际请求模型、
  会话选择和 agent 默认偏好，确认切换一个已有会话不会改写默认值。
- [ ] 在另一 agent 的已有会话重复切换，确认其默认偏好及其他 agent 均未被隐式修改。
- [ ] 在新对话页面主动选择 C，确认该 agent 偏好被保存，新会话使用 C，已有 B override 会话仍使用 B。
- [ ] 重启应用后继续已有会话，确认选择与实际请求一致；检查配置投递失败、异常重启和模型切换错误日志。
- [ ] 使用真实供应商继续长会话缓存回测，并结合实际请求的 model/system 与缓存 token
  判断变化；不以模型自报身份或单次缓存百分比代替请求证据。
