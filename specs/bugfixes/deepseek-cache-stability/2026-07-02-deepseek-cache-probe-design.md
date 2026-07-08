# DeepSeek 长会话缓存稳定性修复设计文档

## 1. 概述

### 1.1 问题

LobsterAI 的 DeepSeek V4 Flash / Pro 长会话出现 prompt cache 命中率从 90% 以上下降到约 50% 的情况。用户侧表现为短输入和连续工具调用仍产生较高积分消耗。

本地会话 `0df7bfb2-4015-49b9-8977-8a4d0bcf9efe` 已观察到稳定坏形态：

- 2026-07-02 17:06 至 17:11，连续调用命中率约为 91% 至 99%。
- 17:12 出现上游 error 后，17:14 至 17:16 的 `cacheRead` 固定在 78,592 tokens，命中率约为 49%。
- 17:24 的新 user turn 首次调用恢复至 95.8%，进入工具循环后又固定在约 50%。
- 17:46 的新 user turn 首次调用只有 4.2%，后续工具循环稳定在约 50%。

初始 trajectory 只能证明缓存断点存在，无法确定最终 provider payload 中首个变化字段。为此增加最终 provider payload 指纹探针，并在 2026-07-02 19:10 的复现中定位到实际变化源。

### 1.2 根因

OpenClaw v2026.6.1 在实时请求组装时，同时执行两层 tool result 截断：

1. 单条 tool result 不超过 64,000 字符；
2. 全部 tool result 合计不超过 `4 × 64,000 = 256,000` 字符。

第二层聚合预算会在每次 LLM 调用前重新计算，并优先削减最旧的 tool result。随着工具循环产生新结果，同一条历史消息被连续改写：

```text
message[46]: 40,886 -> 40,454 -> 39,715 -> 30,920 bytes
```

这破坏了 DeepSeek 基于请求前缀的 prompt cache。实测中 system message、238 个 tool 定义和其他顶层参数保持不变，但相邻请求从历史 `message[46]` 开始不同，缓存命中率仅为 49.6% 至 52.4%。对应 gateway 日志在同一请求前明确记录：

```text
[tool-result-truncation] Truncated 31 tool result(s) for prompt history
(maxChars=64000 aggregateBudgetChars=256000)
```

因此，本次低缓存并非 system prompt 动态段、tool schema、套餐代理或 `stopReason=error/aborted` replay 导致；error/aborted 只是较早的怀疑方向，不是这次已复现坏 case 的根因。

### 1.3 已排除项

1. 五次 run 的 system prompt 均为 49,622 字符，hash 均为 `5476a5b39b30...`。
2. skills prompt hash、tool schema 字符数和 trajectory 中保留的 tool fingerprint 均一致。
3. OpenClaw pinned commit 的共享 `transformMessages()` 已过滤 `stopReason=error` 和 `stopReason=aborted`；额外 provider 过滤属于重复逻辑。
4. 本分支先前移植的 [openclaw/openclaw#95311](https://github.com/openclaw/openclaw/pull/95311) 尚未证明能解决 LobsterAI 的实际坏 case，且会改变 DeepSeek 请求布局，因此本轮已移除。
5. 19:10 复现中，最终请求的 system message hash、`envelopeHash`、`toolsHash` 和全部 238 个 tool 定义在连续调用间保持一致。

相关背景：

- [openclaw/openclaw#94518](https://github.com/openclaw/openclaw/issues/94518)
- [openclaw/openclaw#95311](https://github.com/openclaw/openclaw/pull/95311)
- [openclaw/openclaw@a60947fb3e](https://github.com/openclaw/openclaw/commit/a60947fb3e92f45ea7eb2581da8877b10a8bebb2)
- [netease-youdao/LobsterAI#2219](https://github.com/netease-youdao/LobsterAI/pull/2219)

## 2. 目标

1. 在不记录消息正文、tool schema 或凭证的前提下，定位相邻 DeepSeek V4 请求的首个结构差异。
2. 区分 system/message replay、tool inventory 和其他顶层参数变化。
3. 将请求指纹与 provider 返回的 `input`、`cacheRead` 和 `stopReason` 关联。
4. 同时覆盖直接 DeepSeek 和 `lobsterai-server` 套餐 DeepSeek V4 模型。
5. 保证实时请求中未变化的历史 tool result 保持字节稳定，同时继续限制单条超大结果和保留 overflow recovery 能力。

## 3. 实现方案

诊断 patch：

```text
scripts/patches/v2026.6.1/zz-openclaw-deepseek-cache-probe.patch
```

诊断点位于 `openai-transport-stream.ts`：完成 `onPayload`、code-mode 和兼容性调整后，在 OpenAI SDK 发出最终请求前记录 request probe；stream 完成或失败时记录 result probe。

仅当 `provider/model` 标识匹配 DeepSeek V4 时启用。日志统一使用：

```text
[DeepSeekCacheProbe]
```

请求日志字段：

| 字段 | 含义 |
|---|---|
| `payloadHash` | 最终请求对象的 SHA-256 截断值 |
| `envelopeHash` | 排除 `messages`、`tools` 后的顶层参数指纹 |
| `toolsHash` | 完整有序 tools 数组指纹 |
| `commonMessages` | 当前请求与上一请求从第 0 条开始完全相同的 message 数量 |
| `firstDiff` | 首个变化的 message 下标；`-1` 表示上一请求 messages 是当前请求的完整前缀 |
| `commonTools` | 相邻请求相同的 tool 前缀数量 |
| `firstToolDiff` | 首个变化的 tool 下标 |
| message manifest | 每条 message 的 `index:role:utf8Bytes:hash`，不含正文 |

结果日志记录 `input`、`cacheRead`、`promptTokens`、命中率和 `stopReason`。request/result 通过八位 probe id 关联。

进程内最多保留 100 个 session/model 快照，避免诊断状态无界增长。

### 3.1 修复 patch

```text
scripts/patches/v2026.6.1/openclaw-live-tool-result-cache-stability.patch
```

该 patch 定向移植上游提交 `a60947fb3e` 的缓存稳定性改动：

- 实时 prompt projection 传入 `aggregateMaxCharsOverride=null`，关闭会随历史增长而重新分配的聚合截断；
- 继续对每条 tool result 应用 `toolResultMaxChars`，DeepSeek V4 当前仍为 64,000 字符；
- 持久化 session recovery 和 context overflow recovery 继续使用聚合预算，不改变其防溢出行为；
- 增加“历史增长后既有 projection 保持字节一致”的回归测试。

这不是关闭 tool result 防护。它只把固定总预算从正常实时请求路径移除，避免为了节省尚未溢出的上下文而反复改写可缓存历史；真正接近上下文上限时仍由既有 precheck、compaction 和 recovery 处理。

## 4. 复现与修复验证

1. 重新构建并启动 OpenClaw runtime。
2. 打开上述已有长会话，发送短消息，例如“继续阅读”。
3. 允许模型连续执行数次 read/exec 工具调用，不要在首个调用后立即停止。
4. 在 gateway 日志中筛选：

```powershell
Select-String -Path "$env:APPDATA\LobsterAI\openclaw\logs\gateway-*.log" -Pattern '\[DeepSeekCacheProbe\]'
```

5. 按相同 probe id 对齐 request、messages、diff/toolDiff 和 result。

修复前预期可见：

- `[tool-result-truncation]` 包含 `aggregateBudgetChars=256000`；
- 连续 tool loop 的 `firstDiff` 落在既有历史 tool message；
- 该 message 的字节数逐轮减少；
- `hitPercent` 维持在约 50%。

修复后预期可见：

- 实时截断日志不再包含 `aggregateBudgetChars`；
- 未超过单条 64,000 字符上限的历史 tool message 不再被截断；
- 相邻请求的既有 messages 构成完整稳定前缀，通常表现为 `firstDiff=-1`；
- 缓存命中率随新增尾部消息小幅变化，而不再固定丢失约一半前缀。

## 5. 判读规则

| 现象 | 优先排查方向 |
|---|---|
| `firstDiff=0` | system/developer message 构造变化 |
| `firstDiff=1` 或首条历史 user 变化 | user-turn 时间戳、内容形态或 instruction replacement |
| 首个变化为历史 assistant/tool | reasoning、tool call ID/arguments 或 tool result replay |
| `firstDiff=-1` 且 `toolsHash` 不变 | LobsterAI payload 前缀稳定，继续排查套餐代理或 DeepSeek cache backend |
| `firstToolDiff>=0` | tool 动态注册、排序或 schema 序列化变化 |
| `envelopeHash` 变化 | reasoning effort、tool choice、采样参数等顶层字段变化 |

## 6. 安全与边界

- 不输出消息正文、tool description/schema、API key、URL query 或 headers。
- session id 只输出 SHA-256 截断值。
- hash 用于同一进程内比较，不作为安全签名。
- 使用 warn 级别是为了确保本地复现日志可见；定位完成后应删除该 patch，不随正式修复长期保留。
- 正式保留的是 `openclaw-live-tool-result-cache-stability.patch`；诊断 patch 仅用于本轮端侧复验。

## 7. 验收标准

1. 全部 OpenClaw version patch 可从 clean pinned commit 顺序应用。
2. `src/agents/embedded-agent-runner/tool-result-truncation.test.ts` 通过新增的字节稳定性用例。
3. `src/agents/openai-transport-stream.test.ts` 通过。
4. 连续新增 tool result 时，既有实时 prompt projection 不发生二次截断或 hash 变化。
5. 单条超过 `toolResultMaxChars` 的结果仍被截断，持久化和 overflow recovery 的聚合保护仍然生效。
6. 非 DeepSeek V4 模型不产生 probe 日志。
7. 直接 DeepSeek V4 和套餐 DeepSeek V4 均产生 request/result 日志。
8. 日志不包含用户正文和 tool schema 原文。
