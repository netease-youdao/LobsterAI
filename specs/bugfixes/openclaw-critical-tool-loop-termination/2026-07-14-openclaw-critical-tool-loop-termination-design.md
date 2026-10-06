# OpenClaw Critical 工具循环终止 Agent Run 修复设计

## 1. 问题与根因

LobsterAI 当前固定使用 OpenClaw `v2026.6.1`。该版本已经具备原生工具循环检测：当重复调用达到 critical 阈值时，`before_tool_call` 返回 `deniedReason: "tool-loop"`，并记录类似 `Session execution blocked` 的日志。

问题在于，这个 critical 分支只阻止当前工具调用。被阻止的调用仍以普通 tool result 返回给模型，Agent run 本身没有进入终止态。模型可以在下一轮继续调用工具，再次触发相同 veto，造成 provider request 和 token 消耗持续增长。因此，日志宣称 session 已 blocked，而实际只 blocked 了一次 tool call。

直接原因可以概括为：

```text
critical loop detected
  -> current tool call vetoed
  -> veto returned as an ordinary tool result
  -> Agent starts another provider turn
  -> model calls a tool again
  -> repeat
```

本修复不调整 OpenClaw 的 loop detector、阈值、工具签名或 outcome hash。正常任务需要依次 `web_fetch` 100 个不同网址时，是否构成 loop 仍完全由 OpenClaw 原生检测器判断；只有原生检测器已经给出 critical `tool-loop` veto 后，本修复才负责终止当前 run。

## 2. 用户场景

### 场景 1：单个工具触发 critical loop

- **Given** OpenClaw 原生循环检测已判定某次工具调用为 critical
- **When** before-tool-call hook 返回 `deniedReason: "tool-loop"`
- **Then** 当前 tool result 必须携带 run 终止标记
- **And** 当前 turn 结束后不得再次请求模型

### 场景 2：混合并行工具批次

- **Given** 同一 assistant message 同时发起一个 critical loop 工具和一个正常工具
- **When** 两个工具并行执行
- **Then** 正常工具允许完成并记录结果
- **And** 整个 turn 完成后终止 Agent run
- **And** 不得因为正常结果没有 `terminate` 而进入下一轮模型请求

### 场景 3：普通插件 veto

- **Given** 工具被 `plugin-before-tool-call` 或 `plugin-approval` 拒绝
- **When** 该拒绝不是 OpenClaw critical loop
- **Then** 继续保持原有非终止语义
- **And** 模型仍可改用其他工具或方案完成任务

### 场景 4：合法的大批量抓取

- **Given** 用户任务确实需要访问大量不同网址
- **When** OpenClaw 原生 detector 没有输出 critical `tool-loop`
- **Then** 本修复不参与判断，也不限制工具调用总数

## 3. 功能需求

1. 只有 `deniedReason === "tool-loop"` 的 blocked result 才增加 `terminate: true`。
2. `plugin-before-tool-call`、`plugin-approval` 及默认 veto 不增加 `terminate`。
3. 单工具和全部结果均为 critical veto 的批次，应通过 agent-core 现有 `shouldTerminateToolBatch()` 结束。
4. 混合批次中，只要任一已完成 tool result 是 critical `tool-loop` veto，就应在 turn 边界结束，不再发起 provider request。
5. 混合批次中的正常 sibling 工具必须完成，不能通过全局 abort 粗暴中断。
6. Agent wrapper 必须把 agent-core 已有的 `shouldStopAfterTurn` 能力暴露并转发给 loop config。
7. 本修复不得修改原生循环检测算法、阈值或 `web_fetch` 的业务行为。
8. 本修复不得替代用户主动停止场景的 `openclaw-stop-loop-after-aborted-tool-run.patch`；两者分别处理 critical loop 和 abort boundary。

## 4. 实现方案

新增版本补丁：

```text
scripts/patches/v2026.6.1/openclaw-terminate-run-on-critical-tool-loop.patch
```

补丁采用两层终止机制：

1. 结果级终止
   - `buildBlockedToolResult()` 先归一化 `deniedReason`。
   - critical `tool-loop` veto 返回 `terminate: true`。
   - 该层覆盖单工具和全部结果均终止的批次。
2. turn 级终止
   - `AgentOptions` 和 `Agent` 暴露并转发 agent-core 已存在的 `shouldStopAfterTurn` hook。
   - `createAgentSession()` 在 turn 完成后检查所有 tool result；任一结果的 `details.deniedReason` 为 `tool-loop` 即返回 `true`。
   - 该层覆盖“critical veto + 正常结果”的混合并行批次。

不直接把 `shouldTerminateToolBatch()` 从 `every()` 改为 `some()`，因为 `terminate` 是通用 agent-core 结果字段，改变其全局批处理语义可能影响其他调用方。不在 detector 或 before-tool-call hook 中调用 `AbortController.abort()`，因为这会把安全熔断混同为用户取消，并可能中断同批次的正常工具结果及事件收尾。

LobsterAI 同时增加：

- patch 强校验，避免应用状态被误判；
- patch 内容契约测试，固定双层终止和非 critical veto 的兼容边界；
- OpenClaw 行为测试，断言混合批次的正常 sibling 完成、provider 仅调用一次且只产生一个 `agent_end`。

## 5. 边界与兼容性

| 场景 | 预期行为 |
|---|---|
| 单个 critical loop veto | 当前 turn 收尾后结束 run，不再调用模型 |
| 同批次全部为 critical loop veto | 通过结果级 `terminate` 结束 |
| critical veto 与正常工具混合 | 正常工具完成；turn 级 hook 随后结束 run |
| 普通插件策略拒绝 | 不终止，保留模型恢复能力 |
| 100 个不同 URL 的合法抓取 | detector 未判 critical 时不受本补丁限制 |
| 用户主动 `/stop` | 继续由 abort boundary 补丁负责 |
| 已排队 steering/follow-up | 不注入已判定异常的旧 run；队列本身不在本补丁中清空 |

本补丁结束的是当前 Agent run，不删除 session，也不改变已有 transcript。用户之后仍可在同一会话发起新的正常任务。

## 6. 上游依据与补丁生命周期

上游关联项（核查日期：2026-07-14）：

- Issue [#106231](https://github.com/openclaw/openclaw/issues/106231)：`Loop detection blocks exec but does not terminate stuck agent run`，当前为 open。
- 参考 PR [#106297](https://github.com/openclaw/openclaw/pull/106297)：`fix(agents): terminate agent run on critical loop detection instead of continuing indefinitely`，当前为 open、未合并，核查 head SHA 为 `59977a726886274d04a036be59c7392972d67db9`。

本补丁参考 #106297 的双层方案并适配 OpenClaw `v2026.6.1`，但不能因为 PR 已存在就认定固定版本已经修复。未来升级 OpenClaw 时，应根据目标稳定 tag 的实际代码决定是否去除补丁：

1. 确认 #106297 已合并且目标稳定 tag 包含其合并提交，或目标 tag 已包含语义等价实现；仅 PR 关闭、issue 关闭或 main 分支存在代码都不足以作为移除依据。
2. 核对目标代码同时覆盖结果级终止和混合批次的 turn 级终止，不能只确认其中一层。
3. 在目标 tag 上验证：单 critical veto、全部 veto、混合并行批次、普通插件 veto、steering/follow-up 队列和用户主动 stop。
4. 确认第一次 critical loop 后不再出现同一 run 的后续 provider request，并确认正常 sibling 工具和事件生命周期完整收尾。
5. 验证通过后，不要把本 patch 迁移到新版本目录；删除或调整 `criticalToolLoopTerminationPatch.test.ts`，并移除 `apply-openclaw-patches.cjs` 中对应强校验。

若上游最终采用与 #106297 不同的实现，应按上述行为标准做语义审计，而不是机械地保留或删除补丁。

## 7. 验收标准

1. 新 patch 能与 LobsterAI 其余 `v2026.6.1` patches 一起从干净 tag 顺序应用。
2. critical `tool-loop` blocked result 包含 `terminate: true`。
3. 普通插件 veto 的 `terminate` 仍为 `undefined`。
4. 混合并行批次中正常 sibling 工具执行完成。
5. 单 critical 和混合批次的 provider turn 均不超过 1 次，且只发出一次 `agent_end`。
6. OpenClaw 原生 loop detection E2E 中所有 critical 分支均验证 `terminate: true`。
7. LobsterAI patch 内容测试和强校验通过。
8. 现场日志中首次 critical `Session execution blocked` 后，不再出现同一 run 的下一次 provider request。

## 8. 验证计划

OpenClaw focused tests：

```bash
node scripts/run-vitest.mjs \
  packages/agent-core/src/agent.critical-tool-loop.test.ts \
  src/agents/agent-tools.before-tool-call.blocked-result.test.ts

node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.e2e.config.ts \
  src/agents/agent-tools.before-tool-call.e2e.test.ts \
  --testNamePattern "loop detection behavior"
```

LobsterAI 验证：

```bash
npm run openclaw:patch
npm test -- src/main/libs/openclawPatches/criticalToolLoopTerminationPatch.test.ts
npm run compile:electron
```

手工回放时，使用可控的 fake tool 或测试模型反复请求同一参数并返回相同无进展结果；观察 critical 日志后的 provider request 次数。不要使用真实第三方 URL 批量请求作为回归手段，以免产生额外费用。
