# 后台进程快照移出 system prompt 缓存前缀

## 范围

针对固定版本 `v2026.8.1`，把 `## Runtime` 段里按轮变化的 `Active exec sessions:`
列表移到当前用户轮的隐藏运行时上下文载体中，system prompt 只保留稳定的
process 工具指引。对应上游 v2026.9.3 的 `#140799`。

触发问题：OpenAI Completions 通路把整段 system prompt 作为历史之前的一条
消息，后台进程在两轮之间启动或结束会改写请求最前面的字节，DeepSeek 等隐式
前缀缓存从头 miss。2026-09-22 的积分投诉中，两次 run 边界的首调各按全价重算
约 85 万 token；run 内部每个 attempt 只构建一次 system prompt，本来就能命中。

本次不改压缩阈值、`contextTokens`、心跳与 cron 的 runtime-only 轮次载体
安装逻辑、compaction hook 的结构化进程数据，也不改 process 工具本身。

## 实现

补丁：`scripts/patches/v2026.8.1/openclaw-active-exec-sessions-runtime-context.patch`。

- 新增 `src/agents/runtime-facts-prompt.ts`：`buildActiveProcessSessionRuntimeFacts`
  按 process 工具的 scope key 列出运行中的后台进程，行格式与原 system prompt
  一致（`- <id> running pid=… cwd=… :: <name>`），cwd 截断到 256 字符；没有进程时
  返回 `undefined`，不像上游那样输出 `none` 占位（上游 `#150286` 仍 open）。
- `src/agents/system-prompt.ts`：Runtime 段改为在 process 可用时输出固定的一行
  `Before input: process log; ...`，删除动态列表函数和 `activeProcessSessions`
  字段；`system-prompt-params.ts`、`runtime-prompt.ts`、
  `attempt-system-prompt-prepare.ts` 同步删除该数据流。
- `attempt-prompt-build.ts`：`prepareEmbeddedAttemptPromptContext` 新增必填
  `capabilityToolNames`、`sandboxSessionKey`，在非 runtime-only、非 raw probe、
  非 settled-tool-finalization 且 process 可调用时，把快照拼进
  `runtimeContextForHook`，随现有 `buildRuntimeContextCustomMessage` 生成的
  临时载体进入本轮 prompt；`attempt-settle.ts` 从 prepared tool catalog 的
  `toolSearchRunPlan` 和 setup 传入这两个字段。
- 测试：新增 `runtime-facts-prompt.test.ts`；`embedded-agent-runner/system-prompt.test.ts`
  改为断言 system prompt 不再包含快照但保留指引；`attempt-prompt-context.test.ts`
  新增用例：注册一个后台进程后，system prompt 保持 `Base system prompt` 不变，
  载体消息包含快照，无 process 工具、raw probe、其他 scope 均不输出。
  另外四个直接构造 prompt 阶段输入的测试补上新字段。
- LobsterAI 侧：补丁应用脚本增加强校验（新模块存在、system prompt 不再引用
  `activeProcessSessions`、prepare 阶段不再收集、build 与 settle 阶段的接线）；
  `v20260801UpgradeDecisions.test.ts` 登记补丁并断言关键 diff 行。顺带登记了
  今天 PR #2743 加入但未登记的 `openclaw-windows-private-directory-native.patch`，
  否则该测试在当前分支本来就失败。

已知取舍：runtime-only 轮次（心跳、cron）在 v2026.8.1 不安装载体，因此这些
轮次不再看到进程列表，可通过 `process list` 查询；上游 9.x 通过改 submit 阶段
让所有轮次都安装载体，本次没有回移那部分。

## 验证

在独立的 OpenClaw `v2026.8.1` worktree 中执行，未改动开发者的 sibling 工作区
（该工作区当前有 173 个文件的本地改动，补丁脚本会重置目标树，勿直接指向它）。

- 仅本补丁应用于干净 tag：相关 10 个测试文件 716 项通过（vitest 按项目矩阵
  展开为 24 个文件）；`pnpm tsgo:core` 退出码 0。
- 通过 `scripts/apply-openclaw-patches.cjs` 重置后按顺序应用全部 54 个补丁：
  全部成功，强校验通过；随后 12 个测试文件 1091 项通过（含 `attempt.test.ts`、
  `system-prompt-default-model.test.ts`、`compaction-runtime-context.test.ts`），
  `pnpm tsgo:core` 退出码 0。
- 触碰的 14 个上游文件逐个通过 `oxfmt --check`。
- LobsterAI：`npm test -- v20260801UpgradeDecisions` 19 项通过；改动的测试文件
  通过 CI 同规则的 ESLint。

未执行：运行时重建与 Electron 客户端回归。验收方法：开启 openclaw DEBUG 日志，
在同一会话里先让 agent 启动一个后台 `exec`（例如 dev server），再发两轮消息，
`[context-diag] pre-prompt` 里的 `systemPromptChars` 应保持不变，gateway 日志在
run 边界不再出现 `[prompt-cache] cache read dropped`，且模型在下一轮仍能引用
该后台进程的 session id。

## 后续升级

升级到包含 `#140799` 的上游版本后移除此补丁；届时检查上游是否已合并
`#150290`（空快照不输出 `none`），以及 runtime-only 轮次的载体安装行为。
