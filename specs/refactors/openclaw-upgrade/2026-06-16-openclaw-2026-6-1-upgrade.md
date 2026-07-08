# OpenClaw 2026.6.1 升级适配设计文档

## 1. 概述

### 1.1 问题/动机

LobsterAI 当前正在将依赖的 OpenClaw 从 `v2026.4.14` 升级到 `v2026.6.1`。OpenClaw 迭代较快，LobsterAI 历史上对 `v2026.4.14` 维护了一组版本专属 patch，位于：

```text
scripts/patches/v2026.4.14/
```

升级基础版本后，`package.json` 中的 `openclaw.version` 已切换到 `v2026.6.1`。但如果不迁移对应 patch，LobsterAI 仍会写出依赖业务 patch 的配置字段，例如 `cron.skipMissedJobs`、`agents.defaults.cwd`、`agents.list[].cwd`。在未迁移 patch 时，OpenClaw 6.1 网关会在启动阶段拒绝这些字段，报出配置校验失败：

```text
Invalid config ... agents.defaults: Invalid input
cron: Invalid input
```

因此，本次升级不能只改 OpenClaw tag，还需要逐个判断旧 patch 是否仍然需要迁移到：

```text
scripts/patches/v2026.6.1/
```

### 1.2 目标

1. 保持 LobsterAI 可以依赖 `v2026.6.1` 的 OpenClaw runtime 启动网关。
2. 将仍然需要的业务 patch 迁移到 `scripts/patches/v2026.6.1/`。
3. 对每个旧 patch 给出清晰处理状态：已迁移、待处理或不再需要迁移。
4. 在 LobsterAI 侧补充测试，避免再次出现“配置生成依赖某个 patch，但对应版本 patch 未迁移”的问题。

## 2. 现状分析

### 2.1 已完成的基础改动

| 文件 | 改动 | 原因 |
|------|------|------|
| `package.json` | `openclaw.version` 改为 `v2026.6.1` | 切换目标 OpenClaw 版本 |
| `package.json` | Node 要求调整为 `>=24.15.0 <25` | OpenClaw 6.1 依赖要求更高的 Node 24 小版本 |
| `scripts/run-build-openclaw-runtime.cjs` | 设置 `CI=true` | 避免 pnpm 在非交互环境下因确认提示失败 |
| `scripts/build-openclaw-runtime.sh` | 复用 runtime 前检查 `node_modules`、`gateway.asar`、`dist/control-ui/index.html` | 防止构建中断后仅凭 `runtime-build-info.json` 误判 runtime 已完整 |
| `scripts/build-openclaw-runtime.sh` | 使用 `npm pack --ignore-scripts`，并在 LobsterAI 侧显式执行 OpenClaw prepack 中仍需要的 package metadata / smoke / changelog 步骤 | OpenClaw `v2026.4.15` 起移除了 `OPENCLAW_PREPACK_PREPARED` 跳过逻辑，`npm pack` 会重新触发 `prepack -> pnpm build`，导致 `tsdown` 二次构建 |

### 2.1.1 runtime 打包阶段的二次 tsdown 构建

本次升级调研发现，`npm run openclaw:runtime:host` 在 OpenClaw `v2026.6.1` 下可能出现同一次 runtime 构建中两次执行 `scripts/build-all.mjs` 的情况。第一轮来自 LobsterAI 的 `scripts/build-openclaw-runtime.sh` 主动执行 `pnpm build`；第二轮来自后续 `npm pack` 触发 OpenClaw `prepack`，而 `prepack` 在 `v2026.6.1` 中会再次执行 `pnpm build`。

历史原因是 LobsterAI 侧曾通过：

```bash
OPENCLAW_PREPACK_PREPARED=1 npm pack --pack-destination "$PACK_DIR"
```

要求 OpenClaw `prepack` 复用已有产物、跳过重建。该机制在 OpenClaw `v2026.4.14` 仍然有效，但上游提交 `c727388f93 fix(plugins): localize bundled runtime deps to extensions (#67099)` 删除了 `OPENCLAW_PREPACK_PREPARED` / `shouldSkipPrepack` 逻辑，首次进入稳定版 `v2026.4.15`。因此升级到 `v2026.6.1` 后，该环境变量不再生效。

当前选择不优先 patch OpenClaw，而是在 LobsterAI 侧调整打包流程：

1. `pnpm build` 保留，作为唯一一次 OpenClaw 完整构建入口；不再额外执行 `pnpm ui:build`，因为 OpenClaw 6.1 的 `build-all` 已包含 `ui:build`。
2. 在 `npm pack` 前显式执行 OpenClaw `prepack` 中仍有价值但不昂贵的非构建步骤：
   - `writePackageDistInventory(process.cwd())`，生成 `dist/postinstall-inventory.json`。
   - `node scripts/test-built-bundled-channel-entry-smoke.mjs`，验证 bundled channel entry 能从构建产物加载。
   - `node scripts/package-changelog.mjs prepare`，生成 tarball 使用的当前版本 changelog，并在 pack 后或异常退出时 restore。
3. 使用 `npm pack --ignore-scripts --pack-destination "$PACK_DIR"` 跳过 npm lifecycle，避免触发 OpenClaw `prepack` 中的第二次 `pnpm build`。

### 2.1.2 本地扩展 TypeBox 依赖暴露

升级到 OpenClaw `v2026.6.1` 后，网关启动日志中出现本地扩展加载失败：

```text
[plugins] ask-user-question failed to load ... Error: Cannot find module '@sinclair/typebox'
[plugins] lobster-media-generation failed to load ... Error: Cannot find module '@sinclair/typebox'
[plugins] mcp-bridge failed to load ... Error: Cannot find module '@sinclair/typebox'
```

复核后确认这不是偶发编译失败，也不是最后迁移的 OpenClaw patch 引入。`v2026.4.14` 的 OpenClaw 根 `package.json` 直接依赖 `@sinclair/typebox@0.34.49`，LobsterAI 本地扩展即使没有声明依赖，也能从 runtime 根 `node_modules` 向上解析到该包。`v2026.6.1` 根依赖中不再包含 `@sinclair/typebox`；6.1 虽在 `src/agents/sessions/extensions/loader.ts` 中为 session extension loader 内置 TypeBox alias，但 LobsterAI 的 `ask-user-question`、`lobster-media-generation`、`mcp-bridge` 是通过 gateway plugin loader 的 `plugins.load.paths` 从 `third-party-extensions` 加载，预编译后的 `.js` 还会优先走 native load，因此不会吃到 session extension loader 的 alias。

LobsterAI 侧修复策略：

1. 三个本地扩展的 `package.json` 显式声明 `@sinclair/typebox`。
2. 根 `package.json` 增加构建期 devDependency，保证 `scripts/precompile-openclaw-extensions.cjs` 执行 esbuild 时可解析该包。
3. 调整 `scripts/precompile-openclaw-extensions.cjs`：对没有自带 `node_modules` 的本地扩展，预编译时将普通 npm 依赖打进 `index.js`；对已经通过插件安装流程带有 `node_modules` 的第三方插件，继续保持 package external，避免重新打包大型第三方插件。

### 2.1.3 本地扩展 agent tool contract

TypeBox 修复后，`lobster-media-generation` 能成功加载并打印：

```text
[lobster-media-generation] registered lobsterai_image_generate and lobsterai_video_generate tools.
```

但端侧图片生成仍实际调用 OpenClaw 原生 `image_generate`。复核 OpenClaw 6.1 的 `src/plugins/registry.ts` 后确认，6.1 已要求插件在 manifest `contracts.tools` 中声明 agent tool 名称；否则 `api.registerTool()` 会被拒绝并记录诊断：`plugin must declare contracts.tools before registering agent tools`。旧版 LobsterAI 本地扩展没有该字段，因此会出现“插件模块已加载、register() 已执行，但工具未进入有效工具列表”的状态。

LobsterAI 侧处理：

1. `ask-user-question/openclaw.plugin.json` 声明 `contracts.tools: ["AskUserQuestion"]`。
2. `lobster-media-generation/openclaw.plugin.json` 声明 `contracts.tools: ["lobsterai_image_generate", "lobsterai_video_generate"]`。
3. 不将 OpenClaw 原生 `image_generate` / `video_generate` 加入 deny。当前目标是让 LobsterAI 工具正确暴露；原生媒体工具仍保留给 OpenClaw/skill 兼容场景。
4. `mcp-bridge` 不按同样方式修复：MCP 已迁移到 OpenClaw 原生 `mcp.servers`，当前生成的 `openclaw.json` 不包含 `plugins.entries["mcp-bridge"]`，实际工具由 OpenClaw 原生 MCP runtime 物化。旧 `mcp-bridge` 的工具名来自运行时 MCP 配置，不能用静态 `contracts.tools` 正确枚举；后续若彻底清理旧桥接，应移除扩展同步或保留为不可配置兼容项，而不是伪造静态 contract。

### 2.2 当前已迁移的 patch

当前 `scripts/patches/v2026.6.1/` 中已有：

```text
openclaw-cron-skip-missed-jobs.patch
openclaw-chat-send-cwd-decoupling.patch
openclaw-im-bound-agent-run-cwd.patch
openclaw-browser-blocked-hostnames.patch
openclaw-empty-sse-data.patch
openclaw-mcp-shared-runtime.patch
openclaw-aborted-tool-loop-breaker.patch
openclaw-skip-derive-prompt-segments-deadloop.patch
openclaw-subagent-cleanup-finalize-best-effort.patch
```

这些 patch 解决了本轮升级中暴露的业务字段兼容问题：

| 字段 | 所属 patch | 作用 |
|------|------------|------|
| `cron.skipMissedJobs` | `openclaw-cron-skip-missed-jobs.patch` | 启动时跳过离线期间错过的定时任务，不进行 catch-up replay |
| `chat.send.cwd` | `openclaw-chat-send-cwd-decoupling.patch` | 允许 LobsterAI 在 `chat.send` 请求中携带业务工作目录，并继续传递给 agent run |
| `agents.defaults.cwd` / `agents.list[].cwd` | `openclaw-im-bound-agent-run-cwd.patch` | 让 agent run 使用 LobsterAI 配置的业务工作目录，而不是只使用 OpenClaw workspace |
| `browser.ssrfPolicy.blockedHostnames` | `openclaw-browser-blocked-hostnames.patch` | 让浏览器访问控制支持 LobsterAI 配置的 hostname blocklist，并在 DNS 查询前阻断命中目标 |
| OpenAI-compatible 空 SSE `data:` frame | `openclaw-empty-sse-data.patch` | 在 OpenAI-compatible completions fetch 层过滤空 SSE data frame，避免 OpenAI SDK stream parser 因 provider 空事件报错或空转 |
| MCP runtime 共享 | `openclaw-mcp-shared-runtime.patch` | 让多个 LobsterAI 会话按 workspace + MCP config fingerprint 共享 stdio MCP runtime，避免短时间内产生 N×会话数量的 MCP 子进程 |
| Aborted tool loop | `openclaw-aborted-tool-loop-breaker.patch` | 对连续 aborted 工具结果增加专项断路与旧历史清理，避免空闲时持续烧 token |
| promptSegments fallback | `openclaw-skip-derive-prompt-segments-deadloop.patch` | 跳过仅用于 trace 的 `derivePromptSegments(rawUserText)` fallback，避免媒体 marker 触发诊断链路阻塞回复 |
| subagent cleanup finalize | `openclaw-subagent-cleanup-finalize-best-effort.patch` | cleanup 阶段 ended hook 失败只记录 warning，不再阻断 cleanup bookkeeping；同时修复 gateway bundle 下 runtime import 的 `dist/` 映射 |

### 2.3 已补充的 LobsterAI 侧测试

| 测试文件 | 覆盖内容 |
|----------|----------|
| `src/main/libs/openclawConfigSync.runtime.test.ts` | 验证配置同步仍会写出 patch 依赖字段：`cron.skipMissedJobs`、`agents.defaults.cwd`、`agents.list[].cwd`、`browser.ssrfPolicy.blockedHostnames`；同时确认不再写出旧的 `tools.web.fetch.useEnvProxy` / `useTrustedEnvProxy` |
| `src/main/libs/openclawPatches/` | 验证当前 `package.json` pinned 的 OpenClaw 版本目录下存在必要 runtime patch；按 patch 拆分测试文件 |

## 3. Patch 迁移状态

状态说明：

| 状态 | 含义 |
|------|------|
| 已迁移 | 已在 `scripts/patches/v2026.6.1/` 中建立对应 patch，并通过当前验证 |
| 待处理 | 仍需判断是否需要迁移；如需要，还需适配 6.1 源码并验证 |
| 不再需要迁移 | 经确认，OpenClaw 6.1 已内置等价能力，或 LobsterAI 不再依赖该 patch |

> 截至 2026-06-16，本轮已确认 `openclaw-browser-duplicate-launch.patch`、`openclaw-web-fetch-env-proxy.patch`、`openclaw-extra-body-passthrough.patch`、`openclaw-codex-use-native-transport.patch` 不再需要迁移：前两者分别已由 OpenClaw 6.1 browser ensure 串行化与 `tools.web.fetch.useTrustedEnvProxy` 覆盖；后两者已由 OpenClaw 6.1 的 `embedded-agent-runner` extra params 与 native Codex responses stream resolution 覆盖。

| v2026.4.14 patch | 当前状态 | 处理方式 / 说明 |
|------------------|----------|-----------------|
| `openclaw-aborted-tool-loop-breaker.patch` | 已迁移 | 已迁移到 `v2026.6.1`；OpenClaw 6.1 的 generic no-progress breaker 只覆盖同签名无进展循环，未覆盖 aborted 专项累计、跨参数 aborted total threshold 与旧 session history 中大量 `assistant tool-only + toolResult Aborted` pair 清理 |
| `openclaw-browser-blocked-hostnames.patch` | 已迁移 | 已迁移到 `v2026.6.1`；6.1 原生 schema 仅支持 `allowedHostnames` / `hostnameAllowlist`，本补丁补回 `blockedHostnames` 类型、schema、浏览器配置归一化、SSRF policy 比较/合并与 DNS 前阻断测试 |
| `openclaw-browser-duplicate-launch.patch` | 不再需要迁移 | OpenClaw 6.1 已在 `server-context.availability.ts` 中通过 `profileState.ensureBrowserAvailable` 串行化同 profile 的并发 ensure，并已有 `server-context.ensure-browser-available.waits-for-cdp-ready.test.ts` 覆盖并发复用场景 |
| `openclaw-chat-send-cwd-decoupling.patch` | 已迁移 | 已迁移到 `v2026.6.1`；6.1 将协议 schema 移至 `packages/gateway-protocol`，本次适配让 `ChatSendParamsSchema` 接受 `cwd`，并由 `chat.send` handler 传入 `replyOptions.cwd` |
| `openclaw-chat-send-image-attachment-30mb.patch` | 不再需要迁移 | OpenClaw 6.1 已将 `chat.send` 附件接收上限改为读取 `agents.defaults.mediaMaxMb`，默认 20MiB；LobsterAI 当前在生成配置中显式写出 `agents.defaults.mediaMaxMb: 30`，以配置化方式保留旧补丁的 30MB 业务诉求。注意 OpenClaw 6.1 对图片另有单图 `MAX_IMAGE_BYTES = 6MiB` 的模型输入保护，图片超过 6MiB 时会在 gateway 阶段被显式拒绝，本轮接受该行为变化 |
| `openclaw-codex-use-native-transport.patch` | 不再需要迁移 | OpenClaw 6.1 已在 `src/agents/embedded-agent-runner/stream-resolution.ts` 中将 `provider=openai` 且 `api=openai-chatgpt-responses` 的模型路由到 `openclaw-native-codex-responses`，并已有 `stream-resolution.test.ts` 覆盖 OAuth key 透传与 system prompt 清理 |
| `openclaw-cron-skip-missed-jobs.patch` | 已迁移 | 已迁移到 `v2026.6.1`；让 schema 和 cron runtime 支持 `cron.skipMissedJobs` |
| `openclaw-deepseek-mimo-reasoning-replay.patch` | 不再需要迁移 | OpenClaw 6.1 已在 DeepSeek / Xiaomi provider 中内置 replay family hooks，并在 provider stream shared / Xiaomi tests 中覆盖 `reasoning_content` 保留、空 reasoning 回填、禁用 thinking 时剥离等场景；注意旧补丁曾把 `mimo-v2-flash` 标为 reasoning，6.1 上游未这样标记，如业务侧仍需要该模型 thinking 需单独确认 |
| `openclaw-deepseek-v4-thinking-mode.patch` | 不再需要迁移 | OpenClaw 6.1 已内置 DeepSeek V4 thinking profile、stream wrapper 和 unowned OpenAI-compatible proxy/custom fallback，覆盖 DeepSeek V4 replay 时 `reasoning_content` 回填与 thinking level 处理 |
| `openclaw-disable-model-pricing-bootstrap.patch` | 不再需要迁移 | OpenClaw 6.1 已将 model pricing refresh 改为按 `models.pricing.enabled` gating、lazy import，并在 scheduled services 激活后启动；注意上游默认值是启用，只有显式 `models.pricing.enabled: false` 才会禁用。LobsterAI 当前改为在生成配置中显式写出该字段，并清理已失效的 `OPENCLAW_SKIP_MODEL_PRICING=1` env |
| `openclaw-empty-sse-data.patch` | 已迁移 | 已迁移到 `v2026.6.1`；补充 OpenAI-compatible completions fetch 包装，过滤空 SSE `data:` frame，并对连续空 frame 设置上限，避免 provider 异常流导致 parser 报错或空转 |
| `openclaw-extra-body-passthrough.patch` | 不再需要迁移 | OpenClaw 6.1 已在 `src/agents/embedded-agent-runner/extra-params.ts` 支持 `extra_body` / `extraBody`，并已有 `embedded-agent-runner-extraparams.test.ts` 覆盖 payload 合并与非法值跳过；但 thinking 展示不只依赖参数透传，还要求模型元数据明确标记 `supportsThinking` / `reasoning: true` |
| `openclaw-facade-runtime-static-import.patch` | 不再需要迁移 | OpenClaw 6.1 已将 facade activation check 的加载逻辑拆分到 facade loader / resolution，并通过 `plugin-module-loader-cache` 复用 plugin source loader；当前 6.1 runtime 构建和本地运行未复现旧 bundle 加载失败。如后续 packaged runtime 的 facade activation check 再失败，再单独重开 |
| `openclaw-gateway-startup-profiler.patch` | 不再需要迁移 | OpenClaw 6.1 已提供 `OPENCLAW_GATEWAY_STARTUP_TRACE`、`startupTrace.measure()` 与 diagnostics timeline startup spans；旧补丁属于临时启动耗时诊断，不再作为 LobsterAI 必要 patch 保留 |
| `openclaw-im-bound-agent-run-cwd.patch` | 已迁移 | 已迁移到 `v2026.6.1`；让 schema 和 reply runtime 支持 agent run cwd |
| `openclaw-jiti-alias-prenormalize.patch` | 不再需要迁移 | OpenClaw 6.1 已在 `sdk-alias.ts` 中内置 `normalizePluginLoaderAliasMapForJiti()`、`Symbol.for("pathe:normalizedAlias")` 标记、按 alias 内容缓存以及 `buildPluginLoaderJitiOptions()` 入口归一化；上游 `sdk-alias.test.ts` 已覆盖 pre-normalize marker 与相同内容复用 |
| `openclaw-mcp-shared-runtime.patch` | 已迁移 | 已迁移到 `v2026.6.1`；OpenClaw 6.1 虽有 session MCP runtime idle eviction，但 runtime manager 仍按 sessionId 创建缓存，不能避免 LobsterAI 多会话短期产生 N×会话的 stdio MCP 进程；本补丁在保留 6.1 idle sweep / lease / peek 语义基础上，改为按 workspace + MCP config fingerprint 共享 runtime，并用 session 引用关系控制释放 |
| `openclaw-mcp-stdio-process-tree-kill.patch` | 不再需要迁移 | OpenClaw 6.1 已新增 `OpenClawStdioClientTransport`，stdio MCP transport close 时调用 `killProcessTree()`，并追加 `SIGKILL` 兜底；旧补丁的 Windows 子进程树清理目标已由上游覆盖 |
| `openclaw-memory-atomic-reindex-ebusy-retry.patch` | 不再需要迁移 | OpenClaw 6.1 的 `manager-atomic-reindex.ts` 已对 `EBUSY` / `EPERM` / `EACCES` transient file errors 做 rename / rm 重试，并有 `manager.atomic-reindex.test.ts` 覆盖成功重试、重试耗尽和 cleanup transient error 场景 |
| `openclaw-qwen-coding-plan-qwen36-plus.patch` | 不再需要迁移 | OpenClaw 6.1 仍在内置 Qwen Coding Plan catalog 中隐藏 `qwen3.6-plus`，但 embedded runner 已支持显式 `models.providers.qwen.models[]` 配置优先于 conditional suppression；LobsterAI 当前会显式写出 provider model，因此本场景暂不迁移旧补丁，保留观察 |
| `openclaw-qwen-vision-catalog-fallback.patch` | 不再需要迁移 | OpenClaw 6.1 已将 `models.providers[*].models[*]` 合并进 model catalog，LobsterAI 写出的 `input: ["text", "image"]` 可被识图能力判断读取；实测 Qwen plan mode `qwen3.7-plus` 可正常识图 |
| `openclaw-skip-derive-prompt-segments-deadloop.patch` | 已迁移 | 已迁移到 `v2026.6.1`；OpenClaw 6.1 仍保留 `derivePromptSegments(rawUserText)` fallback，而该 fallback 只服务 trace/diagnostics，不应阻塞 auto-reply 正文交付 |
| `openclaw-subagent-cleanup-finalize-best-effort.patch` | 已迁移 | 已迁移到 `v2026.6.1`；OpenClaw 6.1 已覆盖部分 announce helper failure 和 Windows path normalization，但 cleanup finalize 中 ended hook failure 仍可能冒泡，本补丁改为 best-effort，并补 gateway bundle root 到 `dist/` runtime import 映射 |
| `openclaw-web-fetch-env-proxy.patch` | 不再需要迁移 | 旧补丁字段为 `tools.web.fetch.useEnvProxy`；OpenClaw 6.1 已提供 `tools.web.fetch.useTrustedEnvProxy`、cache key 隔离和 env proxy dispatcher 测试。LobsterAI 当前配置同步不再写出旧字段，也不自动写出新字段 |
| `openclaw-widen-incomplete-turn-retry-guard.patch` | 不再需要迁移 | OpenClaw 6.1 已在 subagent announce delivery 中对 `incomplete terminal response` / `code=incomplete_result` 做更窄的 transient retry guard，并有 direct announce fallback 覆盖；旧补丁无条件放宽 incomplete retry guard，风险高于收益 |
| `zz-openclaw-first-response-timing-logs.patch` | 不再需要迁移 | 旧补丁只增加首包耗时排查日志，不改变业务行为；当前升级主线不依赖这类 verbose diagnostics，避免继续扩大 OpenClaw patch 面。如后续重新专项排查首包延迟，再临时引入诊断手段 |

### 3.1 `extra_body` 与 thinking 展示复核

2026-06-17 复核 PR #2019 后确认，`openclaw-extra-body-passthrough.patch` 仍不需要迁移：OpenClaw 6.1 已内置 `extra_body` / `extraBody` payload 合并逻辑，LobsterAI 生成的 `openclaw.json` 也会把模型自定义参数写到 `agents.defaults.models["provider/model"].params.extra_body`。

本次排查还发现，OpenClaw 6.1 只有在模型配置 `reasoning: true` 且 thinking level 非 `off` 时，才会把 OpenAI-compatible stream 中的 `reasoning_content` / `reasoning` / `reasoning_text` 转为 thinking 事件。因此，仅写出 `extra_body` 还不够，模型元数据也需要通过明确的 `supportsThinking` 来源同步为 `reasoning: true`。

注意：qianfan `deepseek-v3.2` 当前仍在 LobsterAI 配置迁移黑名单 `REMOVED_PROVIDER_MODELS.qianfan` 中，`openclaw.json` 中缺少该模型是预期的配置过滤结果，不作为本轮升级验证样本。

LobsterAI 侧处理边界：`customParams` 只作为厂商请求参数透传到 `extra_body`，不再反向推断模型是否支持 thinking。套餐模型依赖服务端模型 metadata 下发的 `supportsThinking`；内置 provider 模型依赖 LobsterAI 静态模型表中的精确 `supportsThinking`；自定义模型需要用户显式配置 `supportsThinking: true` 后才会同步为 OpenClaw `reasoning: true`。同时，LobsterAI 的 assistant stream/history thinking 提取增加了顶层 `reasoning_content` / `reasoning` / `reasoning_text` 兜底。

2026-06-17 继续补齐自定义模型配置入口：模型编辑弹窗新增与“支持图像输入”并列的“支持思考输出”开关，用于显式写入 `supportsThinking: true`；模型列表同步显示“思考”徽标。该开关只负责模型元数据，不会从 `customParams` / `extra_body` 自动推断；如 Qwen 这类厂商还需要 `enable_thinking` 等请求参数，仍由用户在自定义参数中显式配置。

已按 OpenClaw 6.1 manifest / provider catalog 中明确的 `reasoning: true`，以及业务侧确认的模型能力，补齐 LobsterAI 当前静态模型表中的精确模型，例如 DeepSeek V4 / Reasoner、Kimi K2.5 / K2.6、Zhipu GLM、MiniMax M3、Volcengine 当前内置模型、Youdao DeepSeek Reasoner、Qianfan GLM / DeepSeek V4、Xiaomi MiMo、OpenAI GPT-5.4 / GPT-5.5、Gemini 3.x、Anthropic Claude 4.x，以及 OpenRouter 中对应的 Claude / GPT / Gemini 模型。Qwen 3.5 / 3.6 待后续确认；其他未确认模型不做泛化标记。

### 3.2 Qwen provider alias 复核

2026-06-17 排查 `Unknown model: qwen-oauth/qwen3.6-plus` 后确认，LobsterAI 生成的 `openclaw.json` 已经包含 `qwen-portal/qwen3.6-plus` 与显式 provider model，但 OpenClaw 6.1 的 Qwen 插件将 `qwen-portal` 作为 `qwen-oauth` 的 catalog/auth alias，而标准 DashScope API key provider 的运行时 id 是 `qwen`。因此在标准 `dashscope.aliyuncs.com/compatible-mode/v1` 场景下，LobsterAI 不应继续写出 `qwen-portal`，否则 OpenClaw 可能在运行时按 `qwen-oauth/qwen3.6-plus` 解析并找不到模型。

本轮优先在 LobsterAI 侧修复：`ProviderRegistry` 的 Qwen OpenClaw provider id 改为 `qwen`，使内置 Qwen / 标准 DashScope 自定义使用 `qwen/qwen3.6-plus` 进入 OpenClaw。后续复核两个 Qwen 旧补丁后确认，LobsterAI 当前显式写出 provider model 的路径不再需要迁移旧 patch；但 OpenClaw 原生 wizard/default catalog 对 Qwen Coding Plan 的默认展示策略仍与 LobsterAI 显式配置路径不同。

### 3.3 Qwen 旧补丁迁移复核

2026-06-17 复核 `openclaw-qwen-vision-catalog-fallback.patch` 后确认，旧补丁的核心诉求已由 OpenClaw 6.1 覆盖：`loadModelCatalog()` 会合并 `buildConfiguredModelCatalog()`，而后者会从 `models.providers[*].models[]` 读取 `input`、`reasoning`、`contextWindow` 等显式模型元数据。LobsterAI 生成 Qwen provider model 时会写出 `input: ["text", "image"]`，并且用户已验证 plan mode 下 `qwen3.7-plus` 可以正常识图，因此该补丁不再迁移。

2026-06-17 复核 `openclaw-qwen-coding-plan-qwen36-plus.patch` 后确认，OpenClaw 6.1 仍保留内置限制：Qwen Coding Plan endpoint 的默认 catalog 不 advertise `qwen3.6-plus`，且 manifest 中仍有 conditional suppression。但 embedded runner 已新增显式配置优先逻辑：当 `models.providers.qwen.models[]` 中显式声明 `qwen3.6-plus` 时，可以绕过基于 baseUrl 的 conditional suppression。LobsterAI 当前正是显式写 provider model 的集成方式，因此不再迁移旧补丁；若未来改为依赖 OpenClaw 原生 Qwen wizard/default catalog，则需重新评估该结论。

### 3.4 启动、诊断与 loader 性能类旧补丁复核

2026-06-17 复核 `openclaw-gateway-startup-profiler.patch` 后确认，OpenClaw 6.1 已内置 gateway startup trace：入口、CLI run-main 与 gateway server runtime 都可以通过 `OPENCLAW_GATEWAY_STARTUP_TRACE` 输出阶段耗时，`server.impl.ts` 中还通过 `startupTrace.measure()` 写入 startup spans / marks。旧补丁主要用于临时定位启动耗时，不再需要作为 LobsterAI 常驻 patch 迁移。

`zz-openclaw-first-response-timing-logs.patch` 同样属于临时诊断补丁，只在 chat / auto-reply / embedded runner 链路中增加首包耗时日志，不改变运行时语义。当前升级目标是缩小长期 patch 面，因此不继续迁移；如果后续再次专项排查首包延迟，应优先临时打开上游已有 tracing 或另起一次性诊断补丁。

2026-06-17 复核 `openclaw-disable-model-pricing-bootstrap.patch` 后确认，OpenClaw 6.1 已把 pricing refresh 从初始 runtime setup 中拆出：`server-runtime-services.ts` 会按 `models.pricing.enabled` 判断、lazy import pricing cache，并在 scheduled services 激活后启动；上游测试已覆盖禁用 pricing 不导入、初始 setup 不启动 pricing、scheduled services 激活后再启动，以及停止后 import 才完成也不会启动的场景。因此旧的 `OPENCLAW_SKIP_MODEL_PRICING` 环境变量补丁不再迁移。需要注意，OpenClaw 6.1 的默认判断是 `config.models?.pricing?.enabled !== false`，所以字段缺失时默认仍为启用；从 `C:\Users\yangwn\AppData\Roaming\LobsterAI\openclaw\logs\gateway-2026-06-17.log` 看，当天 `model-pricing`、`pricing bootstrap`、`pricing refresh`、`OpenRouter pricing`、`LiteLLM pricing` 均无命中，且多次 gateway ready 后的请求健康检查通常在几十毫秒到约 1.5 秒内完成，未看到 pricing 导致的 15s 级启动卡顿。

为保持旧补丁“完全禁用远端价格刷新”的业务效果，LobsterAI 当前选择在配置生成阶段显式写出 `models.pricing.enabled: false`，并清理 `openclawEngineManager.ts` 中已失效的 `OPENCLAW_SKIP_MODEL_PRICING=1` 环境变量。这样禁用逻辑留在 LobsterAI 侧配置中，不再需要 patch OpenClaw。

2026-06-17 复核 `openclaw-facade-runtime-static-import.patch` 后确认，OpenClaw 6.1 已重构 facade activation check 的运行时加载路径：`facade-runtime.ts` 通过 facade loader / resolution 与 `plugin-module-loader-cache` 复用 plugin source loader，当前 6.1 runtime 构建和本地运行未复现旧版需要 static import 规避的 bundle 加载失败。因此该补丁不再迁移；风险是 packaged runtime 中若再次出现 facade activation check 加载异常，需要基于 6.1 的新 loader cache 重新定位，而不是直接套回旧补丁。

2026-06-17 复核 `openclaw-jiti-alias-prenormalize.patch` 后确认，旧补丁目标是减少启动阶段大量 `createJiti()` 调用时 pathe `normalizeAliases()` 的重复排序与解析成本。OpenClaw 6.1 已在 `src/plugins/sdk-alias.ts` 中内置更完整的实现：`buildPluginLoaderJitiOptions()` 会先调用 `normalizePluginLoaderAliasMapForJiti()`，该函数设置同一个 `Symbol.for("pathe:normalizedAlias")` marker，按 alias 内容生成 cache key 并复用归一化结果，同时处理 chained alias、Windows drive target 与 cyclic alias 边界。上游 `sdk-alias.test.ts` 已覆盖“pre-normalizes and marks alias maps for source transforms”及相同内容复用，因此该启动性能补丁不再需要迁移。

### 3.5 图片附件、reasoning replay 与运行时可靠性补丁复核

2026-06-17 复核 `openclaw-chat-send-image-attachment-30mb.patch` 后确认，OpenClaw 6.1 不再硬编码旧版 5MB 限制，而是通过 `resolveChatAttachmentMaxBytes()` 读取 `agents.defaults.mediaMaxMb`，未配置时默认 20MiB。因此 LobsterAI 不再迁移该 OpenClaw patch，而是在配置同步阶段显式写出 `agents.defaults.mediaMaxMb: 30`，与 LobsterAI 侧 `chat.send` frame 30MB 级别限制保持一致。

需要额外区分的是，OpenClaw 6.1 在附件接收上限之外，对图片类型新增了单图 `MAX_IMAGE_BYTES = 6 * 1024 * 1024` 的模型输入保护。该限制逐个图片判断，不是多张图片的总和；即使 `agents.defaults.mediaMaxMb` 配置为 30，单张图片只要超过 6MiB，仍会在 gateway 解析阶段报 `image exceeds size limit`。4.14 旧补丁的行为是先允许 30MiB 内图片进入 media offload，再由 agent 侧尝试加载/压缩到 6MiB 内；6.1 选择提前拒绝，以避免后续 runner 丢图但对用户表现为成功响应。本轮接受这一行为变化，不再恢复 4.14 的宽松 offload 语义。验证重点从“patch 是否应用”改为“生成的 `openclaw.json` 是否包含 `agents.defaults.mediaMaxMb: 30`，并确认小于 6MiB 的图片可正常发送、超过 6MiB 的图片当前预期被 OpenClaw 6.1 显式拒绝”。

2026-06-17 复核 DeepSeek / MiMo reasoning 相关两个旧补丁后确认，OpenClaw 6.1 已上游化主要能力：DeepSeek provider 内置 V4 thinking profile、stream wrapper、replay family hooks；Xiaomi provider 内置 MiMo thinking wrapper、OpenAI-compatible replay policy，并在自定义 / proxy provider 路径中补了 DeepSeek V4 与 MiMo reasoning model 的 `reasoning_content` 回填 fallback。因此 `openclaw-deepseek-v4-thinking-mode.patch` 与 `openclaw-deepseek-mimo-reasoning-replay.patch` 均不再迁移。唯一需要保留的差异说明是：旧补丁曾把 Xiaomi `mimo-v2-flash` 也标记为 reasoning，而 OpenClaw 6.1 上游仅对明确 reasoning 的 MiMo 型号启用 thinking profile；如 LobsterAI 后续要支持 `mimo-v2-flash` thinking，需要单独基于实际厂商能力确认。

2026-06-17 复核运行时可靠性类旧补丁后确认，`openclaw-memory-atomic-reindex-ebusy-retry.patch` 已由 OpenClaw 6.1 memory atomic reindex 的 transient file error retry 覆盖，且覆盖范围扩展到 rename 与 rm；`openclaw-mcp-stdio-process-tree-kill.patch` 已由 OpenClaw 6.1 自带 `OpenClawStdioClientTransport` 和 `killProcessTree()` 覆盖，并额外有 `SIGKILL` 兜底。

继续复核 `openclaw-mcp-shared-runtime.patch` 后确认，该补丁仍有迁移必要。其旧引入背景是 LobsterAI desktop 每个对话使用独立 gateway session key，OpenClaw 旧 runtime manager 又按 sessionId 创建 MCP runtime，导致配置 N 个 stdio MCP server、打开 M 个对话时短期产生 N×M 个 Node.js 子进程。OpenClaw 6.1 已新增 session MCP runtime idle eviction，可以在 TTL 后清理不用的 session runtime，但它仍不能把多个活动会话合并为同一套 MCP stdio 子进程，也不能满足“连续新建多个对话时进程数始终约等于 MCP server 数”的桌面端诉求。因此本轮将该 patch 迁移到 6.1 当前的 `src/agents/agent-bundle-mcp-runtime.ts`：保留上游新增的 `sweepIdleRuntimes`、`activeLeases`、`peekSession`、`sessionIdleTtlMs`，同时把 runtime pool 从 sessionId key 改为 workspace + MCP config fingerprint key，并通过 `fingerprintBySessionId` / `refsByFingerprint` 维护 session 引用关系。配置变更时，当前 session 会迁移到新 fingerprint；旧 runtime 只有在最后一个引用释放或 idle sweep 命中后才 dispose。

### 3.6 最后四个 patch 处理结论

2026-06-17 按 `specs/refactors/openclaw-upgrade/2026-06-17-openclaw-2026-6-1-final-patch-decisions.md` 对最后四个 patch 逐个复核后确认：

| patch | 结论 | 依据 |
|------|------|------|
| `openclaw-aborted-tool-loop-breaker.patch` | 迁移 | 上游 generic breaker 只覆盖同签名 no-progress，不覆盖 aborted 专项累计和旧历史清理 |
| `openclaw-skip-derive-prompt-segments-deadloop.patch` | 迁移 | OpenClaw 6.1 仍保留 trace promptSegments fallback，未见上游修复 |
| `openclaw-subagent-cleanup-finalize-best-effort.patch` | 迁移 | OpenClaw 6.1 覆盖了部分 helper failure，但未覆盖 ended hook failure 阻断 cleanup 与 gateway bundle root 到 `dist/` 的 runtime import 映射 |
| `openclaw-widen-incomplete-turn-retry-guard.patch` | 不迁移 | OpenClaw 6.1 已用更窄的 incomplete terminal response retry guard 覆盖主要路径，旧补丁无条件放宽 guard 风险更高 |

对应新增 `v2026.6.1` patch 三个，并补充 LobsterAI 侧 patch 清单测试，显式断言 `openclaw-widen-incomplete-turn-retry-guard.patch` 不出现在当前版本 patch 目录。

## 4. 实施步骤

### 4.1 已完成

1. 将 OpenClaw pinned version 切换到 `v2026.6.1`。
2. 调整 Node 版本要求为 `>=24.15.0 <25`。
3. 迁移 `openclaw-cron-skip-missed-jobs.patch`。
4. 迁移 `openclaw-im-bound-agent-run-cwd.patch`。
5. 迁移 `openclaw-chat-send-cwd-decoupling.patch`，修复 `chat.send` 携带 `cwd` 时被协议校验拒绝的问题。
6. 在 LobsterAI 侧补充 patch 存在性和配置输出测试。
7. 修复 runtime 构建复用时对残缺产物的误判。
8. 重新构建 host runtime，确认 `node_modules`、`gateway.asar`、`dist/control-ui/index.html` 都存在。
9. 迁移 `openclaw-browser-blocked-hostnames.patch`，补齐浏览器 SSRF blocklist 配置链路。
10. 确认 `openclaw-browser-duplicate-launch.patch`、`openclaw-web-fetch-env-proxy.patch` 不再需要迁移，并补充 LobsterAI 侧决策测试。
11. 迁移 `openclaw-empty-sse-data.patch`，补齐 OpenAI-compatible completions 空 SSE frame 过滤。
12. 确认 `openclaw-extra-body-passthrough.patch`、`openclaw-codex-use-native-transport.patch` 不再需要迁移，并补充 LobsterAI 侧决策测试。
13. 调整 `scripts/build-openclaw-runtime.sh`，避免 OpenClaw `v2026.6.1` 在 `npm pack` 阶段通过 `prepack` 触发第二次 `pnpm build` / `tsdown`；相关构建验证按本轮要求暂未执行，待手动测试。
14. 修复 thinking 模型元数据同步：通过明确的 `supportsThinking` 来源写出 OpenClaw `reasoning: true`，`customParams` 仅保留为 `extra_body` 透传；同时补充 `reasoning_content` 顶层字段提取兜底。
15. 修复 Qwen 标准 provider id：LobsterAI 侧改为向 OpenClaw 写出 `qwen/qwen3.6-plus`，避免 `qwen-portal` 被 OpenClaw 6.1 视为 `qwen-oauth` alias 后触发 `Unknown model: qwen-oauth/qwen3.6-plus`。
16. 复核两个 Qwen 旧补丁：确认 `openclaw-qwen-vision-catalog-fallback.patch` 与 `openclaw-qwen-coding-plan-qwen36-plus.patch` 在 LobsterAI 显式 provider model 路径下均不再需要迁移。
17. 补齐自定义模型 `supportsThinking` 配置入口：模型编辑弹窗新增“支持思考输出”开关，保存后写入模型元数据，并继续保持 `customParams` 只作为 `extra_body` 透传参数。
18. 复核启动/诊断/构建规避/loader 性能类旧补丁：确认 `openclaw-gateway-startup-profiler.patch`、`zz-openclaw-first-response-timing-logs.patch`、`openclaw-disable-model-pricing-bootstrap.patch`、`openclaw-facade-runtime-static-import.patch`、`openclaw-jiti-alias-prenormalize.patch` 均不再需要迁移。
19. 将远端 model pricing refresh 的禁用方式从失效的 `OPENCLAW_SKIP_MODEL_PRICING=1` env 迁移为 LobsterAI 生成配置中的 `models.pricing.enabled: false`。
20. 复核图片附件、DeepSeek/MiMo reasoning replay、memory atomic reindex 与 MCP stdio process-tree kill 旧补丁：确认 `openclaw-chat-send-image-attachment-30mb.patch` 由 LobsterAI 配置 `agents.defaults.mediaMaxMb: 30` 替代，同时接受 OpenClaw 6.1 对图片新增的单图 6MiB gateway 拒绝行为；其余四项由 OpenClaw 6.1 上游能力覆盖，不再迁移。
21. 迁移 `openclaw-mcp-shared-runtime.patch` 到 `v2026.6.1`：在保留 OpenClaw 6.1 MCP idle eviction 与 runtime lookup 能力的前提下，恢复 LobsterAI 需要的跨会话 MCP runtime 共享。
22. 迁移最后三个仍需保留的 patch：`openclaw-aborted-tool-loop-breaker.patch`、`openclaw-skip-derive-prompt-segments-deadloop.patch`、`openclaw-subagent-cleanup-finalize-best-effort.patch`；确认 `openclaw-widen-incomplete-turn-retry-guard.patch` 不迁移。
23. 修复 OpenClaw 6.1 下本地扩展加载 `@sinclair/typebox` 失败：三个位于 `openclaw-extensions/` 的本地插件显式声明依赖，根 `package.json` 提供构建期依赖，预编译脚本对无 `node_modules` 的本地扩展内联普通 npm 依赖。

### 4.2 待处理

当前最后四个 patch 已完成处理，`v2026.4.14` 目录中本轮纳入评估的长期 patch 均已有迁移或不迁移结论。后续若新增运行时异常，按以下流程处理：

```bash
npm run openclaw:patch
npm run openclaw:runtime:host
npx vitest run src/main/libs/openclawPatches src/main/libs/openclawConfigSync.runtime.test.ts
npm run build
```

## 5. 涉及文件

| 文件 / 目录 | 说明 |
|-------------|------|
| `package.json` | OpenClaw 版本与 Node 版本要求 |
| `scripts/patches/v2026.4.14/` | 旧版本 patch 来源 |
| `scripts/patches/v2026.6.1/` | 新版本 patch 目标目录 |
| `scripts/run-build-openclaw-runtime.cjs` | OpenClaw runtime 构建入口适配 |
| `scripts/build-openclaw-runtime.sh` | runtime 构建与完整性检查 |
| `scripts/precompile-openclaw-extensions.cjs` | 本地 OpenClaw 扩展预编译；无 `node_modules` 的本地扩展内联普通 npm 依赖 |
| `openclaw-extensions/ask-user-question/openclaw.plugin.json` | 声明 `AskUserQuestion` agent tool contract，适配 OpenClaw 6.1 插件工具注册要求 |
| `openclaw-extensions/lobster-media-generation/openclaw.plugin.json` | 声明 `lobsterai_image_generate` / `lobsterai_video_generate` agent tool contracts，确保工具进入有效工具列表 |
| `openclaw-extensions/ask-user-question/package.json` | 显式声明 `@sinclair/typebox` 依赖 |
| `openclaw-extensions/lobster-media-generation/package.json` | 显式声明 `@sinclair/typebox` 依赖 |
| `openclaw-extensions/mcp-bridge/package.json` | 显式声明 `@sinclair/typebox` 依赖 |
| `src/main/libs/openclawConfigSync.ts` | LobsterAI 生成 OpenClaw 配置的核心逻辑 |
| `src/main/libs/openclawConfigSync.runtime.test.ts` | 配置输出测试 |
| `src/main/libs/openclawPatches/` | pinned OpenClaw 版本 patch 覆盖测试 |
| `src/main/libs/openclawExtensionManifests.test.ts` | 本地扩展 manifest tool contract 覆盖测试 |

## 6. 验证计划

当前已完成验证：

```bash
npm run openclaw:patch
npx vitest run src/main/libs/openclawPatches src/main/libs/openclawConfigSync.runtime.test.ts
npm run openclaw:runtime:host
npm run build
```

本轮 browser/web access 补丁迁移额外验证：

```bash
npm run openclaw:patch
npx vitest run src/main/libs/openclawPatches src/main/libs/openclawConfigSync.runtime.test.ts
```

结果：

| 命令 | 结果 | 说明 |
|------|------|------|
| `npm run openclaw:patch` | 通过 | 从干净 OpenClaw 6.1 源码重置后，4 个 `v2026.6.1` patch 均成功应用 |
| `npx vitest run src/main/libs/openclawPatches src/main/libs/openclawConfigSync.runtime.test.ts` | 通过 | 6 个测试文件、30 个用例通过 |
| `node_modules/.bin/vitest.cmd run src/infra/net/ssrf.pinning.test.ts --reporter verbose --testTimeout=10000 --pool forks`（OpenClaw 侧） | 未完成 | 在当前 Windows 会话中 90 秒无输出超时；本次先以 `openclaw:patch` 与 LobsterAI 侧测试作为有效验证，后续如需可在 OpenClaw 独立环境继续跑目标测试 |

本轮 Provider / OpenAI-compatible 传输兼容性补丁迁移额外验证：

```bash
npm run openclaw:patch
npx vitest run src/main/libs/openclawPatches src/main/libs/openclawConfigSync.runtime.test.ts
npm run build
```

结果：

| 命令 | 结果 | 说明 |
|------|------|------|
| `npm run openclaw:patch` | 通过 | 从干净 OpenClaw 6.1 源码重置后，5 个 `v2026.6.1` patch 均成功应用 |
| `npx vitest run src/main/libs/openclawPatches src/main/libs/openclawConfigSync.runtime.test.ts` | 通过 | 8 个测试文件、34 个用例通过 |
| `npm run build` | 通过 | LobsterAI TypeScript / Vite / Electron 构建通过；仅有既有 Vite warning |
| `node_modules/.bin/vitest.cmd run src/agents/openai-transport-stream.test.ts --reporter verbose --testNamePattern "empty SSE\|non-event-stream" --testTimeout=10000 --pool forks`（OpenClaw 侧） | 未完成 | 在当前 Windows 会话中 90 秒无输出超时；本次先以 `openclaw:patch`、LobsterAI 侧测试和构建作为有效验证，后续如需可在 OpenClaw 独立环境继续跑目标测试 |

runtime 打包二次构建修复记录：

| 命令 / 场景 | 结果 | 说明 |
|------|------|------|
| `npm run openclaw:runtime:host` | 未执行 | 本轮按要求只调整脚本与文档，不启动 OpenClaw runtime 构建；待手动测试确认日志中只出现一次 `[build-all] tsdown`，且 `[2/7] Packing npm tarball` 后不再出现 `openclaw@2026.6.1 prepack` / 第二轮 `scripts/build-all.mjs` |

最后四个 patch 处理与本地扩展 TypeBox 修复验证：

```bash
npm run openclaw:patch
npx vitest run src/main/libs/openclawPatches
node scripts/test-projects.mjs src/agents/tool-loop-detection.test.ts src/agents/embedded-agent-runner/sanitize-session-history.tool-result-details.test.ts src/shared/runtime-import.test.ts src/agents/subagent-registry-lifecycle.test.ts
npm run openclaw:extensions:local
npm run openclaw:precompile
node -e "Promise.all(['ask-user-question','lobster-media-generation','mcp-bridge'].map(async id=>{ const p='file:///'+process.cwd().replace(/\\\\/g,'/')+'/vendor/openclaw-runtime/current/third-party-extensions/'+id+'/index.js'; const m=await import(p); console.log(id, Object.keys(m).join(',')); }))"
npx vitest run src/main/libs/openclawExtensionManifests.test.ts
```

| 命令 | 结果 | 说明 |
|------|------|------|
| `npm run openclaw:patch` | 通过 | 从干净 OpenClaw 6.1 源码重置后，9 个 `v2026.6.1` patch 均成功应用 |
| `npx vitest run src/main/libs/openclawPatches` | 通过 | 11 个测试文件、27 个用例通过；覆盖前三个 patch 存在与 `openclaw-widen-incomplete-turn-retry-guard.patch` 缺失 |
| OpenClaw 目标测试 | 通过 | `tool-loop-detection`、`sanitize-session-history`、`runtime-import`、`subagent-registry-lifecycle` 相关目标测试通过 |
| `npm run openclaw:extensions:local` | 通过 | 三个本地扩展同步到当前 runtime |
| `npm run openclaw:precompile` | 通过 | 3 个本地扩展编译、8 个已有 `node_modules` 的第三方插件跳过、0 errors |
| 直接 import 三个 runtime 插件 | 通过 | `ask-user-question`、`lobster-media-generation`、`mcp-bridge` 均可加载，未再触发 `Cannot find module '@sinclair/typebox'` |
| `npx vitest run src/main/libs/openclawExtensionManifests.test.ts` | 通过 | 覆盖 `ask-user-question` 与 `lobster-media-generation` 的 `contracts.tools` 声明；`mcp-bridge` 为已迁移前的旧动态桥接路径，当前 MCP 走 `mcp.servers`，不声明静态工具 contract |

后续每迁移一个 patch，应至少完成：

1. `npm run openclaw:patch`：确认 patch 可从干净 OpenClaw 6.1 源码应用。
2. `npm run openclaw:runtime:host`：确认 runtime 可完整生成。
3. 针对 patch 行为补 LobsterAI 侧测试或 OpenClaw 侧临时验证。
4. `npm run build`：确认 LobsterAI TypeScript/Vite 构建仍通过。
