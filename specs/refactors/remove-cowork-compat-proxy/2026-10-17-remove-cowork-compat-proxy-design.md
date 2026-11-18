# 移除 Cowork OpenAI 兼容代理设计文档

## 1. 概述

### 1.1 问题/动机

`src/main/libs/coworkOpenAICompatProxy.ts`（约 3000 行）和 `src/main/libs/coworkFormatTransform.ts`（约 430 行）是 Claude Agent SDK 时期的产物。SDK 只会发 Anthropic Messages 请求，为了接入非 Anthropic 格式的服务，主进程在本地起了一个 HTTP 代理：

- 收 `POST /v1/messages`（Anthropic 格式）；
- 转成 OpenAI Chat Completions 或 Responses 请求发给上游；
- 再把上游的流式响应（含工具调用、思考内容、用量）转回 Anthropic 事件。

Agent 运行时换成 OpenClaw 之后，主链路已经不经过这个代理：OpenClaw 原生支持 `anthropic-messages`、`openai-completions`、`openai-responses`、`google-generative-ai` 等传输层，`openclawConfigSync.buildProviderSelection()` 直接把用户配置渲染成 OpenClaw 的 provider 配置。

但代理仍在启动链路上，并被几个外围功能依赖，带来三个问题：

1. **维护负担**：每支持一种新协议，代理和 OpenClaw 都要各做一遍。例如这次新增 OpenAI Responses，就要同时改 `resolveUpstreamAPIType()` 和 `buildProviderSelection()`。
2. **隐性故障**：`check-api-config` 通过 `resolveCurrentApiConfig()` 判断有没有可用模型。对 OpenAI 格式的 provider，代理没启动时这个函数会返回错误 `OpenAI compatibility proxy is not running.`。结果是用户明明配了模型，开始会话时却被引导去登录或订阅。
3. **行为分叉**：辅助功能和 OpenClaw 打到的端点、用的协议可能不一致。例如 OpenAI provider 改了 Base URL 时，代理按 `provider === 'openai'` 走 Responses，OpenClaw 只在 `api.openai.com` 时才走 Responses。

### 1.2 目标

- 删除 Anthropic ↔ OpenAI 转换代理，以及 Claude Agent SDK 时期遗留的接口和死代码。
- 保留 OpenClaw 正在使用的 Copilot 本地透传，拆成独立小模块；`openclaw.json` 前后完全一致，不触发网关重启。
- 桌面助手的快捷问答改为直连上游。协议和端点由 `buildProviderSelection()` 决定，与 OpenClaw 保持一致。
- `check-api-config` 不再依赖任何本地代理是否启动。

### 1.3 非目标

- 不改 Copilot 的接入方式，不切换到 OpenClaw 原生的 `github-copilot` provider（见第 8 节）。
- 不改 `openclawTokenProxy`（LobsterAI 服务端模型的鉴权代理）。

---

## 2. 现状分析

### 2.1 代理的 HTTP 路由

| 路由 | 用途 | 当前调用方 | 结论 |
|------|------|-----------|------|
| `POST /v1/messages` | Anthropic → OpenAI Chat/Responses 双向转换（代理主体） | 桌面助手快捷问答（OpenAI 格式 provider、LobsterAI 服务端模型） | 迁移后删除 |
| `POST /v1/copilot/chat/completions`、`/copilot/chat/completions` | Copilot 透传：注入短期 Copilot token 和 IDE 请求头，401/403 时刷新重试一次 | OpenClaw 的 `lobsterai-copilot` provider（`baseUrl = http://127.0.0.1:<port>/v1/copilot`） | **保留**，拆为独立模块 |
| `POST /v1/chat/completions`、`/chat/completions` | 按 `upstreamConfig` 透传并注入 IDE 请求头 | 无。OpenClaw 配置里只有 Copilot 指向本代理 | 删除 |
| `POST /v1/messages/count_tokens` | Claude SDK 的 token 计数 | 无 | 删除 |
| `POST /api/event_logging/batch` | Claude SDK 的遥测上报 | 无 | 删除 |
| `GET /healthz` | 健康检查 | 启动检查 | 随 Copilot 模块保留 |

Copilot 走本地透传是有意设计的（见 `specs/bugfixes/github-copilot-token-refresh-gateway-restart/`）：Copilot API token 约 30 分钟刷新一次，由主进程在每个请求上注入；OpenClaw 配置里只放稳定的 `${LOBSTER_PROXY_TOKEN}`，token 刷新时不需要改配置，也就不会重启网关。

### 2.2 主进程中依赖代理的入口

| 入口 | 位置 | 现状 | 结论 |
|------|------|------|------|
| `resolveCurrentApiConfig()` / `getCurrentApiConfig()` | `claudeSettings.ts` | OpenAI 格式时调用 `configureCoworkOpenAICompatProxy()`，返回代理地址 | 删除，调用方改用 `resolveRawApiConfig()` |
| 快捷问答 `resolveQuickAnswerModel()` | `desktopCompanion/quickAnswerService.ts` | Gemini 走原生；其余一律以 Anthropic 格式发给代理（OpenAI 格式带代理 token） | 改用一次性文本客户端（3.3） |
| `check-api-config` IPC | `main.ts` | `resolveCurrentApiConfig()`；`probeModel` 分支调用 `probeCoworkModelReadiness()` | 改用 `resolveRawApiConfig()`，去掉 `probeModel` |
| 服务端模型判断（会话未指定模型时的兜底） | `main.ts` | `resolveCurrentApiConfig().providerMetadata.providerName` | 改用 `resolveRawApiConfig()` |
| `startCoworkOpenAICompatProxy()` / `stop…` | `main.ts` 启动与退出 | 在首次 config sync 之前启动 | 改为启动 Copilot 模块 |
| `registerProxyTokenRefresher(LobsteraiServer)` | `main.ts` | 只服务于 `/v1/messages` 转发到服务端时的 401 刷新 | 删除（`openclawTokenProxy` 有自己的刷新逻辑） |
| `registerProxyTokenRefresher(Copilot)` | `main.ts` | 只服务于 `/v1/chat/completions` 透传；Copilot 路由直接用 `copilotTokenManager` | 删除 |
| `setCoworkProxySessionId()` | `agentEngine/openclawRuntimeAdapter.ts` | 只给 `/v1/messages` 转发到服务端时注入 `session_id` 日志字段 | 删除 |
| Copilot descriptor `resolveRuntimeBaseUrl` | `openclawConfigSync.ts` | `getCoworkOpenAICompatProxyBaseURL('local') + '/v1/copilot'` | 改调 Copilot 模块，地址不变 |
| `LOBSTER_PROXY_TOKEN` 环境变量兜底 | `openclawConfigSync.ts` | `getProxyAuthToken() \|\| getCoworkOpenAICompatProxyToken()` | 改为只用 loopback 状态里的 token |

### 2.3 已无调用方的死代码

| 代码 | 说明 |
|------|------|
| `getEnhancedEnv()`（`coworkUtil.ts`）、`buildEnvForConfig()`（`claudeSettings.ts`） | 给子进程注入 `ANTHROPIC_*` 环境变量，SDK 时期使用，现在没有调用方 |
| `probeCoworkModelReadiness()`、`resolveSessionTitleApiConfig()`（`coworkUtil.ts`） | 只被 `check-api-config` 的 `probeModel` 分支使用，渲染进程从未传过 `probeModel: true`；会话标题已改由服务端 `/api/desktop-tools/session-title` 生成 |
| `get-api-config`、`save-api-config` IPC 及渲染进程封装 `coworkService.getApiConfig()` / `saveApiConfig()` | 渲染进程无调用方 |
| `coworkConfigStore.ts` 的 `loadCoworkApiConfig()` / `saveCoworkApiConfig()` / `deleteCoworkApiConfig()` | 读写 `userData/api-config.json`，现在只有 `save-api-config` 写、没有人读 |
| `coworkFormatTransform.ts` 的 `anthropicToOpenAI()`、`openAIToAnthropic()`、`formatSSEEvent()`、`mapStopReason()`、`buildOpenAIChatCompletionsURL()` | 只被代理使用 |

### 2.4 为什么快捷问答不直接复用 OpenClaw 运行时

快捷问答（选中文本 → 翻译/解释）要求约 1 秒出首字、不带工具、不新建会话。OpenClaw 网关目前没有"裸模型单次调用"的接口：

- `POST /v1/chat/completions`、`POST /v1/responses`（`gateway.http.endpoints.*`）会经 `agentCommandFromGatewayIngress()` 跑一个完整的 agent 回合，带系统提示、工具定义和工作区上下文；
- `chat.send` 同样是 agent 回合；
- `models.probe` 只做健康检查（admin 权限，最多 8 个 token）。

因此复用的是 OpenClaw 的**路由决策**而不是运行时：快捷问答调用与 config sync 相同的 `buildProviderSelection()`，拿到传输层类型（`api`）和 `baseUrl`，用一个只支持纯文本流式的轻量客户端直连上游。这样 DashScope 地址改写、Responses、自定义 Gemini、Base URL 规范化等规则只写一次，快捷问答和 OpenClaw 永远打到同一个端点。

---

## 3. 方案设计

### 3.1 改造前后对比

```
改造前
  OpenClaw ──openai-completions──▶ 127.0.0.1:<compat>/v1/copilot ──▶ api.githubcopilot.com
  快捷问答 ──anthropic /v1/messages──▶ 127.0.0.1:<compat> ──转换──▶ 上游（Chat/Responses）
  check-api-config ──▶ resolveCurrentApiConfig()（OpenAI 格式要求代理在运行）

改造后
  OpenClaw ──openai-completions──▶ 127.0.0.1:<同一端口>/v1/copilot ──▶ api.githubcopilot.com
  快捷问答 ──buildProviderSelection() 决定协议──▶ 上游（或 token proxy / Copilot 透传）
  check-api-config ──▶ resolveRawApiConfig()（不依赖任何本地代理）
```

### 3.2 Copilot 本地透传模块

新文件 `src/main/libs/copilotLoopbackProxy.ts`，从现有代理中原样迁出 Copilot 相关逻辑。

公开接口：

```ts
export async function startCopilotLoopbackProxy(options: {
  authToken?: string;            // 即 LOBSTER_PROXY_TOKEN
  preferredPort?: number | null;
}): Promise<void>;
export async function stopCopilotLoopbackProxy(): Promise<void>;
export function getCopilotLoopbackPort(): number | null;
export function getCopilotLoopbackBaseUrl(): string | null; // http://127.0.0.1:<port>
```

必须保持不变的行为：

- 端口：继续使用原 `OpenClawLoopbackService.CompatProxy` 记住的端口。常量改名为 `CopilotProxy`，持久化的值 `'compatProxy'` 不变，保证 `openclaw.json` 中 Copilot 的 `baseUrl` 不变；
- 路径：`/v1/copilot/chat/completions` 和 `/copilot/chat/completions`；
- 鉴权：`Authorization: Bearer <LOBSTER_PROXY_TOKEN>`，`/healthz` 免鉴权；
- 来源校验：保留 `isAllowedProxyHost()`；
- 上游：通过 `copilotTokenManager` 取 token 和 baseUrl，注入 IDE 请求头，401/403 时刷新并重试一次；
- 网络：继续用 `session.defaultSession.fetch`（走系统代理设置），流式响应原样透传。

预计 200 行左右，加对应单测。

### 3.3 一次性文本客户端

新文件 `src/main/libs/oneShotModelClient.ts`：只做纯文本、单轮或少量多轮、流式输出，不支持工具。

```ts
export type OneShotTarget = {
  api: OpenClawTransportApi;  // 来自 buildProviderSelection()
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
};

export function resolveOneShotTarget(): { target: OneShotTarget } | { error: string };

export async function streamOneShotText(
  target: OneShotTarget,
  request: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    maxTokens: number;
    signal: AbortSignal;
    onTextDelta: (text: string) => void;
  },
): Promise<{ text: string }>;
```

`resolveOneShotTarget()` 的规则：

1. `resolveRawApiConfig()` 得到当前默认模型；
2. 用与 config sync 相同的参数调用 `buildProviderSelection()`，取 `providerConfig.api` 和 `providerConfig.baseUrl`；
3. 凭据：
   - `providerConfig.apiKey` 是 `${LOBSTER_PROXY_TOKEN}` 时（服务端模型走 token proxy、Copilot 走 3.2 的透传），替换为 loopback 状态里的 token；
   - 其他情况用 `resolveRawApiConfig()` 已解析出的真实 key。
4. 不支持的传输层直接返回错误，界面显示"当前模型暂不支持快捷问答"：
   - `openai-chatgpt-responses`（ChatGPT OAuth）；
   - 没有 apiKey 的 OAuth provider（如 xAI OAuth），它们的凭据在 OpenClaw 的 auth-profiles 里。
   这两类目前经代理也无法工作，属于把隐性失败变成显性提示。

四种传输层的适配：

| `api` | 请求地址 | 鉴权 | 请求体要点 | 流式解析 |
|-------|---------|------|-----------|---------|
| `anthropic-messages` | `buildAnthropicMessagesUrl(baseUrl)` | `x-api-key` + `anthropic-version` | `system`、`messages`、`max_tokens`、`stream: true` | `content_block_delta.text_delta`（沿用现有 `readAnthropicStreamEvent`） |
| `openai-completions` | `${baseUrl}/chat/completions` | `Authorization: Bearer` | system 作为首条消息；`max_tokens`，OpenAI 官方 gpt-5/o 系列用 `max_completion_tokens`（沿用现有判断） | `choices[0].delta.content` |
| `openai-responses` | `${baseUrl}/responses` | `Authorization: Bearer` | system 放入 `input` 而不用 `instructions`，也不发 `store`（均与 OpenClaw 对非官方端点的策略一致）；`max_output_tokens` | `response.output_text.delta` |
| `google-generative-ai` | `${baseUrl}/models/{model}:streamGenerateContent?alt=sse` | `x-goog-api-key` | `systemInstruction`、`contents`、`generationConfig.maxOutputTokens`（沿用现有实现） | `candidates[].content.parts[].text`（沿用现有 `readGeminiStreamEvent`） |

注意事项：

- 地址拼接与 OpenClaw 一致：`baseUrl` 用 selection 规范化后的值（已去掉 `/chat/completions`、`/responses` 后缀，Gemini 已带版本号），客户端只追加端点路径；
- 不主动添加思考相关参数，与现状保持一致；
- 错误展示沿用快捷问答现有逻辑：`extractApiErrorSnippet()` 显示上游错误信息，取不到时显示 HTTP 状态码。

预计 250 行左右，加对应单测。

### 3.4 调用方迁移

- **快捷问答**：`resolveQuickAnswerModel()` 改为 `resolveOneShotTarget()`；`buildQuickAnswerHttpRequest()` 和两个流式解析函数并入或改调 `oneShotModelClient`。并发控制、中止、窗口归属校验、埋点保持不变。
- **`check-api-config`**：改用 `resolveRawApiConfig()`，删除 `probeModel` 参数（preload、渲染进程类型同步删除）。返回值改为 `{ hasConfig, error }`，不再返回 `config`：原始配置里有真实 API Key，而渲染进程（`CoworkView`、`CompanionComposer`）只读 `hasConfig`。
- **服务端模型兜底判断**（`main.ts`）：改用 `resolveRawApiConfig()`。

### 3.5 删除清单

| 文件 | 删除内容 |
|------|---------|
| `src/main/libs/coworkOpenAICompatProxy.ts` | 整个文件（Copilot 部分先迁到 `copilotLoopbackProxy.ts`） |
| `src/main/libs/coworkOpenAICompatProxy.test.ts` | 转换相关测试；Copilot 与 host 校验测试迁到新模块 |
| `src/main/libs/coworkFormatTransform.ts` | 转换函数与 `OpenAIStreamChunk` 等类型；`AnthropicApiFormat`、`normalizeProviderApiFormat()` 移入 `claudeSettings.ts`，随后删除本文件及测试 |
| `src/main/libs/claudeSettings.ts` | `resolveCurrentApiConfig()`、`getCurrentApiConfig()`、`buildEnvForConfig()`、对代理模块的 import；`ApiConfigResolution` 里只服务于代理的字段 |
| `src/main/libs/coworkUtil.ts` | `getEnhancedEnv()`、`probeCoworkModelReadiness()`、`resolveSessionTitleApiConfig()` |
| `src/main/libs/coworkConfigStore.ts` | 整个文件；`CoworkApiConfig` 类型移入 `claudeSettings.ts` |
| `src/main/main.ts` | `get-api-config`、`save-api-config` IPC；两个 `registerProxyTokenRefresher`；代理启动/停止改为 Copilot 模块 |
| `src/main/preload.ts`、`src/renderer/types/electron.d.ts`、`src/renderer/services/cowork.ts` | `getApiConfig`、`saveApiConfig`、`probeModel` |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | `setCoworkProxySessionId()` 两处调用 |
| `src/shared/auth/constants.ts` | `AuthRefreshReason.CompatProxy`（先确认埋点和服务端没有按该值统计） |

净变化预计：删除约 3000 行源码和约 800 行测试，新增约 450 行源码和对应测试。

### 3.6 兼容性约束

| 约束 | 做法 |
|------|------|
| `openclaw.json` 改造前后逐字节一致 | Copilot 的 `baseUrl`、`apiKey` 占位符、端口都不变；验证时比对文件 |
| `LOBSTER_PROXY_TOKEN` 不变 | 仍由 loopback 状态统一生成，Copilot 模块、token proxy 和 dsh 共用 |
| 启动顺序 | Copilot 模块仍在首次 `syncOpenClawConfig('startup')` 之前启动，避免首次写入后再改 `baseUrl` 触发热重载 |
| Copilot 启动失败 | 与现在一致：记录错误，Copilot provider 不可用，不影响其他 provider |
| 快捷问答在 Anthropic、Gemini provider 上的行为 | 请求与现在相同 |

---

## 4. 实施步骤

每一步单独提交，前两步可以独立发布。

**Step 1：删除死代码（不改变行为）**

- 删除 2.3 中的死代码，以及 `/v1/chat/completions` 透传、`count_tokens`、`event_logging` 路由；
- 删除 `registerProxyTokenRefresher(Copilot)`；
- `check-api-config` 去掉 `probeModel`。

**Step 2：拆出 Copilot 透传**

- 新建 `copilotLoopbackProxy.ts` 及测试；
- `main.ts` 改为启动和停止该模块，端口记忆键不变；
- `openclawConfigSync` 的 Copilot descriptor 和 `LOBSTER_PROXY_TOKEN` 兜底改调新模块；
- 此时旧代理只剩 `/v1/messages`，仍在运行。

**Step 3：新增一次性文本客户端**

- 新建 `oneShotModelClient.ts` 及测试，覆盖四种传输层的请求构造、流式解析、凭据占位符替换和不支持的传输层。

**Step 4：迁移调用方**

- 快捷问答切到新客户端；
- `check-api-config` 和服务端模型兜底判断改用 `resolveRawApiConfig()`。

**Step 5：删除旧代理**

- 按 3.5 删除剩余代码和测试；
- 删除 `registerProxyTokenRefresher(LobsteraiServer)`、`setCoworkProxySessionId()`、`AuthRefreshReason.CompatProxy`；
- 全量 `npm test`、`npm run compile:electron`、`npm run build`。

---

## 5. 涉及文件

| 文件 | 变更 |
|------|------|
| `src/main/libs/copilotLoopbackProxy.ts`（新） | Copilot 透传 |
| `src/main/libs/oneShotModelClient.ts`（新） | 一次性文本客户端 |
| `src/main/libs/coworkOpenAICompatProxy.ts` | 删除 |
| `src/main/libs/coworkFormatTransform.ts` | 删除（两个函数迁出） |
| `src/main/libs/claudeSettings.ts` | 删除代理相关函数 |
| `src/main/libs/coworkUtil.ts` | 删除死代码 |
| `src/main/libs/coworkConfigStore.ts` | 删除读写函数 |
| `src/main/libs/openclawConfigSync.ts` | Copilot `baseUrl` 与 token 兜底改调新模块 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 删除 `setCoworkProxySessionId` 调用 |
| `src/main/desktopCompanion/quickAnswerService.ts` | 改用一次性文本客户端 |
| `src/main/main.ts` | 启动/停止、IPC、token refresher |
| `src/main/preload.ts`、`src/renderer/types/electron.d.ts`、`src/renderer/services/cowork.ts` | 删除无用 IPC 封装 |
| `src/shared/auth/constants.ts` | 删除 `CompatProxy` 刷新原因 |

---

## 6. 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| Copilot 透传迁移后路径、端口或 token 变化 | `openclaw.json` 变化触发网关重启，或 Copilot 401 | 端口记忆键、路径、token 均不变；验证时比对 `openclaw.json` |
| 快捷问答请求与 OpenClaw 不一致 | 某些 provider 快捷问答失败 | 协议和地址来自同一个 `buildProviderSelection()`；按 provider 矩阵手测 |
| 第三方 OpenAI 兼容端点对 `max_tokens` 字段敏感 | 400 错误 | 沿用现有 `max_completion_tokens` 判断；Responses 用 `max_output_tokens` |
| 服务端模型改走 token proxy | 鉴权刷新、账号头、企业版校验的行为与快捷问答现在直连服务端时不同 | 这正是 OpenClaw 访问服务端模型的同一条路径；补充 401/402 透传的单测，并手测额度不足的提示 |
| 删除 `api-config.json` 读写 | 无（无读取方） | 不删除用户磁盘上已有的文件 |

---

## 7. 验证计划

### 7.1 单元测试

- `copilotLoopbackProxy`：鉴权失败 401、`/healthz` 免鉴权、非 loopback Host 拒绝、401/403 刷新重试一次、IDE 请求头注入；
- `oneShotModelClient`：四种传输层的 URL、请求头、请求体快照；SSE 解析（含多事件分包）；`${LOBSTER_PROXY_TOKEN}` 替换；不支持的传输层返回错误；中止；
- `check-api-config`：代理未启动时 OpenAI 格式 provider 仍返回 `hasConfig: true`；
- 快捷问答：现有测试改为基于新客户端。

### 7.2 手动验证（`npm run electron:dev`）

| 场景 | 预期 |
|------|------|
| 快捷问答：Anthropic 格式、OpenAI Chat Completions、OpenAI Responses、Gemini 的自定义 provider 各一次 | 正常流式输出 |
| 快捷问答：LobsterAI 服务端模型 | 正常输出；额度不足时能看到上游错误信息 |
| 快捷问答：Copilot | 正常输出 |
| 快捷问答：ChatGPT OAuth | 显示"当前模型暂不支持快捷问答" |
| Copilot 对话，并等待一次 token 刷新（约 30 分钟） | 对话正常，网关不重启 |
| 升级前后比对 `openclaw.json` | 无差异 |
| 主日志 | 不再出现 `[CoworkProxy]`；Copilot 请求日志正常 |

---

## 8. 后续（不在本次范围）

- **IM 旧 handler（已处理）**：`imChatHandler` 和定时任务意图识别通过 `getLLMConfig()` 取"第一个启用且有 apiKey 的 provider"，并固定按 OpenAI 格式请求。核查后发现两者都已没有调用方：`IMGatewayManager` 只创建 `IMChatHandler` 而从不调用；意图识别只在 `IMCoworkHandler.processMessage()` 里使用，而该入口随旧 NIM 直连网关（dcc6f27a）一起失去了调用方。因此没有迁到 `oneShotModelClient`，而是连同 `getLLMConfig` 和 `createScheduledTask` 回调一起删除。`IMCoworkHandler.processMessage()` 及只供它使用的代码随后也已删除。
- **Copilot 改用 OpenClaw 原生 provider**：OpenClaw 自带 `github-copilot` provider，通过 `COPILOT_GITHUB_TOKEN` 自行换取短期 token。上游在 v2026.10.x 修复了 Copilot 模型首轮失败的问题（openclaw/openclaw#167941）。升级 OpenClaw 后可以评估切换，届时 `copilotLoopbackProxy.ts` 也可以删除。
