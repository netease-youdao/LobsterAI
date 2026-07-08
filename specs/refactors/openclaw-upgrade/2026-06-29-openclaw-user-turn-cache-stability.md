# OpenClaw 用户轮次缓存稳定性修复设计文档

## 1. 概述

### 1.1 问题/动机

LobsterAI 在 2026-06-16 将 OpenClaw 从 `v2026.4.14` 升级到
`v2026.6.1`。升级后，DeepSeek V4 Pro 用户反馈长会话 token 消耗明显增加。
日志分析显示，问题不是持续无缓存，而是同一个长会话在部分新用户轮次突然只能命中
较短的公共前缀：

- 用户日志中 85 次 DeepSeek V4 Pro 调用的整体缓存覆盖率约为 `79.37%`；
- 14 次低命中调用集中在两个长会话中；
- 低命中调用的 input 为约 31 万至 43 万 token，cache read 仅约 6.5 万至
  10.9 万 token，覆盖率约 `17%` 至 `23%`；
- 相同会话的其他调用可达到 `99%` 以上；
- 低命中和高命中调用均使用 `thinking=high`，并且对应 system prompt 字符数稳定。

同一用户轮次内的工具续调通常仍能达到 `96%` 至 `99.9%` 的缓存覆盖率，而进入
下一条用户消息后可能骤降。这说明 provider 本身支持缓存，主要问题位于用户消息从
“当前轮”转为“历史轮”时的请求序列化边界。

### 1.2 目标

1. 保证同一条用户消息作为当前轮和历史轮发送给模型时具有字节稳定的文本表示。
2. 保留 OpenClaw 的用户时区时间戳能力，但只在统一的 LLM boundary 生成时间戳。
3. 保持带附件、多文本块、IM envelope、cron marker 和跨会话 prompt 的现有语义。
4. 以 `v2026.6.1` 版本专属 patch 回补上游修复，不在 LobsterAI 业务层复制
   OpenClaw 的 transcript/runtime 逻辑。
5. 明确后续 OpenClaw 升级时的 patch 移除条件。

## 2. 现状分析

### 2.1 与历史 DeepSeek patch 的关系

升级审计中未迁移以下两个旧 patch：

- `openclaw-deepseek-v4-thinking-mode.patch`
- `openclaw-deepseek-mimo-reasoning-replay.patch`

该决策仍然成立。OpenClaw `v2026.6.1` 已包含 DeepSeek V4 thinking wrapper、
OpenAI-compatible replay family hooks，以及 `reasoning_content` 回填和保留逻辑。
本次问题也同时出现在 thinking 模式相同的高、低缓存调用中，因此不是上述 DeepSeek
能力缺失，也没有证据表明固定的 `thinkingSignature="reasoning_content"` 是缓存失效源。

### 2.2 `v2026.6.1` 的用户消息不对称

`v2026.6.1` 同时存在以下行为：

1. Gateway 的 `chat.send` / `agent` 等入口通过 `injectTimestamp()` 修改当前轮的
   `BodyForAgent`。
2. 新的 user-turn transcript recorder 独立保存裸用户文本和 timestamp。
3. Pi SDK 中的当前用户消息通常是单文本块数组：
   `[{ type: "text", text: "..." }]`。
4. 同一消息在下一轮从 JSONL transcript 载入时是普通字符串。
5. `normalizeMessagesForLlmBoundary()` 只清理历史 metadata，没有统一当前轮和历史轮
   的内容形态，也没有从消息自身 timestamp 统一生成时间戳。

因此同一条用户消息在连续两次 provider 请求中的序列化字节发生变化。对于需要重发
完整历史的 `openai-completions`、`anthropic-messages` 等 transport，变化点之后的
prompt prefix 无法复用缓存。长会话会将这一问题放大为大量重复 input token。

工具续调发生在同一用户轮次的内存状态中，没有经过“当前轮数组 -> transcript 字符串”
转换，因此仍能保持高缓存命中；这与现场日志一致。

### 2.3 上游修复

OpenClaw 在 `v2026.6.1` 发布后的 commit
`1af55bc6654f898fc4c39bad3204eb504d160089` 中修复了该问题：

```text
fix(agents): stabilize user-turn serialization across turns to preserve prompt cache (#90811)
```

`v2026.6.1` 发布于 2026-06-03，该修复于 2026-06-07 合入，因此当前 pinned tag
不包含它。经 `git merge-base --is-ancestor` 和 release tag 检查，首个包含该修复的
稳定版本是 `v2026.6.5`。

## 3. 方案设计

### 3.1 最小移植策略

新增版本专属 patch：

```text
scripts/patches/v2026.6.1/openclaw-user-turn-cache-stability.patch
```

该 patch 只移植上游 `1af55bc665` 的用户轮次缓存稳定性改动和相应测试，不引入该
commit 之后的其他 OpenClaw 功能或重构。移植覆盖所有使用同一 transcript/LLM
boundary 的入口，避免只修 LobsterAI 桌面 `chat.send` 后，CLI、TUI、agent 或重启
恢复入口继续产生不一致历史。

核心行为如下：

1. Gateway、agent、TUI 和 restart sentinel 不再给当前用户文本临时加时间戳。
2. `normalizeMessagesForLlmBoundary()` 成为时间戳的单一生成位置。
3. 时间戳来自消息自身固定的 `timestamp` 和配置的用户时区，不使用发送时的 wall
   clock `now`。
4. 当前轮 runtime timestamp 与提前持久化的 user-turn timestamp 不同时，使用
   `currentUserTimestampOverride` 对齐当前轮和未来历史轮。
5. 只有一个 text block 的用户消息统一折叠为字符串；包含图片或其他附件的多块消息
   保持数组形态。
6. 已带 channel timestamp envelope、`Current time:` cron marker 或 inter-session
   prompt 前缀的消息不重复加时间戳。
7. 历史 inbound metadata 继续清理，但保留已有 envelope，并在清理后保持稳定格式。

### 3.2 回归门禁

OpenClaw patch 内保留上游的字节一致性测试，核心断言是：

- 第一轮作为当前消息时使用单 text block 数组；
- 第二轮中同一消息作为历史消息时使用 transcript 字符串；
- 两次经过 LLM boundary 后，第一轮消息的 `JSON.stringify(content)` 完全相等；
- 时间戳均来自第一轮消息自身 timestamp，而不是第二轮的当前时间。

同时覆盖附件消息、已有时间戳 envelope、cron marker、历史 inbound metadata、CLI
prompt 和各 gateway 入口。

LobsterAI 侧增加 patch 决策测试和强应用校验，防止 patch 文件存在但因部分冲突被
`apply-openclaw-patches.cjs` 误判为已应用。

### 3.3 Patch 移除条件

后续将 pinned OpenClaw 升级到 `v2026.6.5` 或更高稳定版本时，可以移除
`openclaw-user-turn-cache-stability.patch`，但必须同时满足：

1. 新 tag 仍包含上游 commit `1af55bc6654f898fc4c39bad3204eb504d160089`
   或等价后续实现；
2. 新版本仍通过 current-turn 与 historical-turn 字节一致性测试；
3. 新版本升级审计确认没有重新在 gateway 和 LLM boundary 双重注入时间戳；
4. 移除 patch 后从干净 tag 执行 `npm run openclaw:patch` 和 runtime 构建均通过。

由于 OpenClaw patch 按 pinned 版本目录加载，升级时不应把本 patch 机械复制到新的
版本目录。应优先验证上游实现并删除对应 patch 决策测试中的“必须存在”要求。

## 4. 实施步骤

1. 从 `release/2026.6.29` 创建修复分支。
2. 在干净 `v2026.6.1` 上应用现有 LobsterAI patch，建立移植基线。
3. 移植上游 `1af55bc665`，处理与现有 runtime safety patch 的单一上下文冲突。
4. 生成 `openclaw-user-turn-cache-stability.patch`。
5. 增加 patch 内容、应用结果和回归测试的 LobsterAI 侧门禁。
6. 从干净 tag 重新应用全部 patch，运行 OpenClaw 定向测试、LobsterAI 测试、lint、
   Electron 编译/构建和 runtime 构建。

## 5. 涉及文件

| 文件 | 说明 |
|------|------|
| `scripts/patches/v2026.6.1/openclaw-user-turn-cache-stability.patch` | 上游用户轮次缓存稳定性修复及测试 |
| `scripts/apply-openclaw-patches.cjs` | 增加实际源码强校验，拒绝部分应用 |
| `src/main/libs/openclawPatches/userTurnCacheStability.test.ts` | LobsterAI 侧 patch 决策与源码应用测试 |
| `specs/refactors/openclaw-upgrade/2026-06-29-openclaw-user-turn-cache-stability.md` | 背景、方案、移除条件和验证记录 |

## 6. 验证计划

### 6.1 Patch 与静态门禁

```bash
npm run openclaw:patch
npx vitest run src/main/libs/openclawPatches
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/main/libs/openclawPatches/userTurnCacheStability.test.ts
```

### 6.2 OpenClaw 定向测试

至少运行：

```bash
node scripts/run-vitest.mjs \
  src/agents/embedded-agent-runner/run/attempt.llm-boundary.cache-stability.test.ts \
  src/agents/embedded-agent-runner/run/attempt.llm-boundary.test.ts
```

并覆盖 patch 修改的 CLI、gateway timestamp、media-only persistence 和 runner context
测试文件。

### 6.3 构建与运行时

```bash
npm run compile:electron
npm run build
npm run openclaw:runtime:host
```

runtime 构建完成后，确认 bundle 包含 LLM boundary canonicalization 和 per-message
timestamp 实现，并再次运行 LobsterAI patch source/runtime 门禁。

### 6.4 端侧复测建议

构建安装后使用相同 agent/system prompt 连续发送至少两条消息，分别覆盖 DeepSeek V4
Pro thinking on/off 和一个非 DeepSeek 对照模型。验收重点不是冷启动首轮是否命中，
而是第二轮请求中第一轮用户消息的序列化 hash 是否保持一致，以及 cache read 是否随
历史长度增长。长会话不应再从接近全量缓存骤降为只命中固定 system prefix。

### 6.5 本次实现验证结果

2026-06-29 在 Windows x64、Node `v24.15.0` 环境完成以下验证：

| 验证项 | 结果 |
|--------|------|
| 从干净 `v2026.6.1` 应用全部版本 patch | 通过；12/12 patch 前向应用成功，新 patch 强校验通过 |
| OpenClaw LLM boundary 测试 | 通过；2 个文件、26 个用例，包括 current/history 字节一致性门禁 |
| OpenClaw CLI、runner context、media persistence 完整测试 | 通过；3 个文件、173 个用例 |
| OpenClaw gateway 变更断言 | 通过；agent timestamp 2 个用例、restart continuation 1 个用例 |
| OpenClaw restart sentinel 完整测试 | 通过；26 个用例 |
| OpenClaw `agent.test.ts` 完整文件 | Windows 本地连续超过 360 秒无输出；本次修改的 2 个定向用例均通过 |
| LobsterAI OpenClaw patch 测试 | 通过；13 个文件、33 个用例，包含源码和 runtime bundle 门禁 |
| 新增 TypeScript 测试 ESLint | 通过；0 error、0 warning |
| `npm run compile:electron` | 通过 |
| `npm run build` | 通过；仅保留既有 Vite chunk/dynamic import warning |
| `npm run openclaw:runtime:host` | 通过；完成 build、pack、bundle、plugins、extensions、channel deps 和 prune |
| runtime bundle 内容检查 | 通过；包含 `currentUserTimestampOverride`、`runtimeTimestamp`、`alternateText` 及 canonicalization 实现 |

另执行 LobsterAI 官方完整 `npm test`：147 个文件中 145 个通过，1568 个用例中
1565 个通过、1 个跳过。初次运行有两个失败：data migration 用例因并发负载超过
5 秒，单文件复跑后 19/19 通过；另一个是现有 Windows `localfile` URL 路径分隔符
断言（期望反斜杠、实际正斜杠），单文件复跑仍稳定失败。该文件及其实现不在本次
diff 中，未作为本修复的一部分扩大处理范围。
