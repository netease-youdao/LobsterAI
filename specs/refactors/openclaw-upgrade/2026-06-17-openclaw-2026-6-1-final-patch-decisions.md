# OpenClaw 2026.6.1 最后四个 Patch 处理决策文档

## 1. 概述

### 1.1 问题/动机

LobsterAI 当前分支已将 OpenClaw pinned version 升级到 `v2026.6.1`。历史上 `v2026.4.14` 目录中仍有四个待处理 patch：

- `openclaw-aborted-tool-loop-breaker.patch`
- `openclaw-skip-derive-prompt-segments-deadloop.patch`
- `openclaw-subagent-cleanup-finalize-best-effort.patch`
- `openclaw-widen-incomplete-turn-retry-guard.patch`

这些 patch 都属于运行时可靠性兜底或诊断链路防护，不能只看是否能机械套用；需要逐个确认其引入背景、对应 LobsterAI PR/commit、OpenClaw 6.1 上游是否已覆盖，以及迁移/不迁移后的端侧验收方式。

### 1.2 目标

1. 为四个最后处理的 patch 留下自包含的调研记录。
2. 按调研结论迁移仍有必要的 patch 到 `scripts/patches/v2026.6.1/`。
3. 明确不迁移 patch 的上游覆盖依据与端侧验收方式。
4. 缩小长期 patch 面，避免把已被 OpenClaw 6.1 用更安全方式覆盖的旧逻辑继续叠加。

## 2. 现状分析

### 2.1 `openclaw-aborted-tool-loop-breaker.patch`

引入位置：

- LobsterAI PR：[#2049](https://github.com/netease-youdao/LobsterAI/pull/2049)
- LobsterAI commit：`5fffc70d fix(openclaw): prevent aborted tool loops from burning tokens`
- 后续补修：[#2051](https://github.com/netease-youdao/LobsterAI/pull/2051)，commit `b46bf747 fix: re fix tool loop breaker`
- 设计文档：`specs/bugfixes/openclaw-aborted-tool-loop-token-burn/2026-05-25-openclaw-aborted-tool-loop-token-burn-design.md`

引入背景：

用户反馈空闲时仍持续消耗 token。现场 trace 显示某个 run 已累计数千条 `assistant tool_calls + tool: Aborted` 历史，其中 `exec {"command":"dir"}` 重复三千多次。旧 OpenClaw 没有对连续 aborted 工具结果设置专项硬断路，也没有在发送模型请求前清理旧污染历史，导致每次新请求继续携带越来越大的无效上下文。

OpenClaw 6.1 上游状态：

- OpenClaw PR [#80668](https://github.com/openclaw/openclaw/pull/80668)，commit `678b2510b2 fix: abort generic no-progress tool loops`，已让 generic no-progress tool loop 在 critical threshold 后阻断。
- 但 6.1 没有 `aborted_tool_loop` 专项 detector，没有跨不同参数累计 aborted total threshold，也没有清理旧 session history 中成批 aborted tool pair 的逻辑。
- LobsterAI 侧已显式写出 `tools.loopDetection.enabled=true`，但仅依赖上游 generic breaker 不能覆盖旧污染会话和跨参数 aborted 循环。

结论：迁移。

迁移策略：

- 在 6.1 的 `src/agents/tool-loop-detection.ts` 上补 `aborted_tool_loop` detector。
- 将 `Aborted`、`Operation aborted`、`Request was aborted`、`cancelled/canceled` 归一为稳定 aborted outcome。
- 同签名 aborted 达到 8 次 critical 阻断，任意 aborted 累计达到 20 次 critical 阻断。
- 在 `sanitizeSessionHistory()` 前置清理旧 `assistant tool-only + toolResult Aborted` pair，只保留最近 3 组诊断证据，且不制造孤儿 tool result。

端侧验收：

1. 构造同一工具同一参数连续返回 `Aborted`，确认 run 在有限次数内停止，UI 退出 running。
2. 构造不同参数连续返回 `Operation aborted`，确认累计阈值生效。
3. 打开或继续含大量历史 aborted pair 的旧会话，确认下一次模型请求不再携带成百上千条旧 aborted 轮次。
4. 检查 gateway 日志，断路后不再继续出现同一 run 的 provider request。

### 2.2 `openclaw-skip-derive-prompt-segments-deadloop.patch`

引入位置：

- LobsterAI PR：[#1834](https://github.com/netease-youdao/LobsterAI/pull/1834)
- LobsterAI commit：`1ec7c2c1 fix: upgrade openclaw-weixin to 2.1.10 and add openclaw patches`

引入背景：

`runReplyAgent()` 在构造 raw trace 时，如果 `runResult.meta?.promptSegments` 缺失，会 fallback 调用 `derivePromptSegments(rawUserText)`。旧现场显示，当输入包含图片附件 marker，例如 `[media attached: ...jpg (image/*)]` 时，该 fallback 可能卡死。该函数只用于 trace/diagnostics prompt segmentation，不影响回复交付。

OpenClaw 6.1 上游状态：

- `src/auto-reply/reply/agent-runner.ts` 仍保留 `runResult.meta?.promptSegments ?? derivePromptSegments(rawUserText)`。
- 未找到 OpenClaw 上游针对 `derivePromptSegments`、图片附件 marker 或 promptSegments deadloop 的合并 PR/commit。
- `promptSegments` 仍是可选 meta 字段，因此 fallback 路径仍可能被走到。

结论：迁移。

迁移策略：

- 在 OpenClaw 6.1 中移除 `derivePromptSegments(rawUserText)` fallback。
- 只使用 `runResult.meta?.promptSegments`。
- 接受 raw trace 缺少 fallback prompt segment 的诊断降级，优先保证回复链路不被诊断函数阻断。

端侧验收：

1. 开启 raw trace 或相关诊断链路。
2. 通过 IM/auto-reply 发送包含图片或媒体附件 marker 的消息。
3. 确认 gateway 不挂死，回复可正常投递。
4. raw trace 中可以没有 fallback prompt segment，但不能影响 `toolSummary`、`completion` 和最终回复。

### 2.3 `openclaw-subagent-cleanup-finalize-best-effort.patch`

引入位置：

- LobsterAI PR：[#2044](https://github.com/netease-youdao/LobsterAI/pull/2044)
- LobsterAI commit：`79988fe9 fix(openclaw): prevent subagent cleanup finalize from blocking on hook failure`
- 设计文档：`specs/bugfixes/openclaw-subagent-cleanup-finalize/2026-05-25-openclaw-subagent-cleanup-finalize-design.md`

引入背景：

Windows 用户启动 gateway 或继续会话时反复出现 `subagent cleanup finalize failed`。用户提供的 `runs.json` 中大量 run 已 `status: ended` 且已公告 completion，但缺少 `cleanupCompletedAt`。每次启动后这些 run 被重复恢复、重复执行 cleanup finalize，再次因 ended hook 或 runtime lazy import 失败而无法收敛。

OpenClaw 6.1 上游状态：

- commit `e01a885d18 fix: complete ended subagent cleanup after helper failures` 已处理 browser/MCP helper failure 后 cleanup 继续收敛，commit message 标注 `Fixes #82306`、`Supersedes #75462`。
- OpenClaw PR [#72731](https://github.com/openclaw/openclaw/pull/72731)，commit `cf499101a2 fix(agents): normalize Windows runtime imports`，已规范 Windows 动态 import specifier。
- 但 6.1 的 `finalizeSubagentCleanup(... didAnnounce=true ...)` 仍会在 cleanup bookkeeping 前 `await emitCompletionEndedHookIfNeeded(...)`；hook/import 抛错仍可能阻断 `cleanupCompletedAt`。
- LobsterAI Windows runtime 当前优先通过 `gateway-bundle.mjs` fast path 启动，根目录没有 `subagent-registry.runtime.js`，真实文件位于 `dist/`。上游 #72731 解决 Windows 路径规范化，不解决 `gateway-bundle.mjs` 作为 base URL 时相对导入应映射到 `dist/` 的问题。

结论：迁移。

迁移策略：

- 在 6.1 已有 helper failure 修复基础上窄补 `emitCompletionEndedHookBestEffort()`。
- `announced-cleanup-finalize`、`deferred-announce-give-up`、`resumed-announce-give-up` 三条 cleanup 终局路径中，ended hook 失败只记录 warning，不阻断 bookkeeping。
- 在 `runtime-import.ts` 中，当 base module 是 `gateway-bundle.mjs` 且 specifier 是 `./...` 时，解析到 `./dist/...`。

端侧验收：

1. 使用 ended/announced/缺少 `cleanupCompletedAt` 的 `runs.json` fixture 启动 gateway。
2. 模拟 `emitSubagentEndedHookForRun()` 或 runtime lazy import 抛错，确认 cleanup 仍写入完成状态。
3. 第二次启动同一 state，不再重复打印同一批 `subagent cleanup finalize failed`。
4. Windows bundle 场景确认不再尝试加载根目录 `subagent-registry.runtime.js`，而是解析到 `dist/subagent-registry.runtime.js`。

### 2.4 `openclaw-widen-incomplete-turn-retry-guard.patch`

引入位置：

- LobsterAI PR：[#1834](https://github.com/netease-youdao/LobsterAI/pull/1834)
- LobsterAI commit：`1ec7c2c1 fix: upgrade openclaw-weixin to 2.1.10 and add openclaw patches`

引入背景：

旧 OpenClaw 仅对 GPT-5 类 provider/model 应用 reasoning-only / empty-response retry。非 frontier 模型，例如 Volcengine、Ollama、部分 OpenAI-compatible 模型，可能返回 reasoning/thinking 内容但没有 visible text，最终表现为 `payloads=0`、空回复或 incomplete-turn 提示。旧 patch 直接移除 provider gate，让 retry guard 对所有 provider 生效。

OpenClaw 6.1 上游状态：

- `src/agents/embedded-agent-runner/run/incomplete-turn.ts` 已改为 `shouldApplyNonVisibleTurnRetryGuard()`。
- 上游已覆盖 strict-agentic GPT-5、Gemini、Ollama、OpenAI Responses / ChatGPT Responses / Azure Responses、Anthropic messages、Bedrock Converse Stream、OpenAI completions 等路径。
- 相关上游 PR 包括 [#66750](https://github.com/openclaw/openclaw/pull/66750)、[#71362](https://github.com/openclaw/openclaw/pull/71362)、[#85603](https://github.com/openclaw/openclaw/pull/85603)、[#88574](https://github.com/openclaw/openclaw/pull/88574)，以及 commit `7562afdca3 fix(ollama): suppress disabled reasoning output`。
- 6.1 仍不是“所有 provider 无条件重试”，但这是有意的 replay-safety 收窄。继续套旧 patch 会扩大副作用，可能让上游刻意不自动重试的 provider/API 进入盲目 retry。

结论：不迁移。

端侧验收：

1. 使用 OpenAI-compatible thinking 模型跑 reasoning-only / empty visible 场景，确认可继续生成 visible answer 或进入明确 incomplete-turn 错误。
2. 使用 Ollama thinking 模型跑空 visible 场景，确认 6.1 自带 retry guard 生效。
3. 使用真实 zero-token empty stop 场景，确认不会无限 retry。
4. 不应在 `scripts/patches/v2026.6.1/` 出现 `openclaw-widen-incomplete-turn-retry-guard.patch`。

## 3. 方案设计

| patch | 处理方式 | 依据 |
|------|----------|------|
| `openclaw-aborted-tool-loop-breaker.patch` | 迁移 | 上游 generic breaker 只覆盖同签名 no-progress，不覆盖 aborted 专项累计和旧历史清理 |
| `openclaw-skip-derive-prompt-segments-deadloop.patch` | 迁移 | OpenClaw 6.1 仍保留 fallback，未见上游修复 |
| `openclaw-subagent-cleanup-finalize-best-effort.patch` | 迁移 | 上游修了 helper failure 和 Windows path normalization，但未覆盖 ended hook failure 阻断 bookkeeping 与 bundle-root 到 dist 映射 |
| `openclaw-widen-incomplete-turn-retry-guard.patch` | 不迁移 | OpenClaw 6.1 已用更窄的 non-visible retry guard 覆盖主要路径，旧 patch 无条件放宽风险更高 |

## 4. 实施步骤

1. 新增本文档记录调研结论。
2. 新增 `scripts/patches/v2026.6.1/openclaw-aborted-tool-loop-breaker.patch`。
3. 新增 `scripts/patches/v2026.6.1/openclaw-skip-derive-prompt-segments-deadloop.patch`。
4. 新增 `scripts/patches/v2026.6.1/openclaw-subagent-cleanup-finalize-best-effort.patch`。
5. 不新增 `openclaw-widen-incomplete-turn-retry-guard.patch`。
6. 补充 LobsterAI 侧 patch 存在性/决策测试。

## 5. 涉及文件

| 文件 | 说明 |
|------|------|
| `scripts/patches/v2026.6.1/openclaw-aborted-tool-loop-breaker.patch` | 迁移 aborted loop 专项断路与旧历史清理 |
| `scripts/patches/v2026.6.1/openclaw-skip-derive-prompt-segments-deadloop.patch` | 跳过 promptSegments fallback |
| `scripts/patches/v2026.6.1/openclaw-subagent-cleanup-finalize-best-effort.patch` | cleanup ended hook best-effort 与 bundle runtime import 映射 |
| `src/main/libs/openclawPatches/` | patch 存在性和不迁移决策测试 |

## 6. 验证计划

基础验证：

```bash
npm run openclaw:patch
npx vitest run src/main/libs/openclawPatches src/main/libs/openclawConfigSync.runtime.test.ts
npm run build
```

可选 OpenClaw 侧 focused 验证：

```bash
node_modules/.bin/vitest.cmd run src/agents/tool-loop-detection.test.ts --reporter verbose --pool forks
node_modules/.bin/vitest.cmd run src/agents/embedded-agent-runner/sanitize-session-history.tool-result-details.test.ts --reporter verbose --pool forks
node_modules/.bin/vitest.cmd run src/shared/runtime-import.test.ts --reporter verbose --pool forks
```

端侧手工验收按第 2 节每个 patch 的验收说明执行。重点观察 `C:\Users\yangwn\AppData\Roaming\LobsterAI\openclaw\logs` 中是否仍存在 runaway tool loop、重复 subagent cleanup finalize 或 bundle runtime import 失败。
