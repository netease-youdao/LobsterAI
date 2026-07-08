# OpenAI ChatGPT OAuth OpenClaw 路由兼容修复设计文档

## 1. 概述

### 1.1 问题

LobsterAI 升级到新版 OpenClaw 后，原先已经支持的 OpenAI ChatGPT OAuth 登录模式不再兼容。用户完成 ChatGPT OAuth 登录后，LobsterAI 仍会向 OpenClaw 写出旧版 Codex provider 配置：

```json5
{
  models: {
    providers: {
      "openai-codex": {
        api: "openai-codex-responses",
        auth: "oauth",
        models: [
          { id: "gpt-5.4", api: "openai-codex-responses" },
          { id: "gpt-5.5", api: "openai-codex-responses" },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "openai-codex/gpt-5.4" },
    },
  },
}
```

新版 OpenClaw 启动阶段会校验 `openclaw.json`，并拒绝 `openai-codex-responses`：

```text
Gateway failed to start: Invalid config at .../openclaw.json.
models.providers.openai-codex.api: Invalid input
models.providers.openai-codex.models.0.api: Invalid input
models.providers.openai-codex.models.1.api: Invalid input
```

因此 gateway 会反复启动失败，IM gateway、Cowork 运行时和依赖 OpenClaw 的能力都会不可用。

### 1.2 根因

OpenClaw 2026.6.1 已将 ChatGPT/Codex OAuth 的模型路由迁移为：

| 项 | 旧 LobsterAI 配置 | 新版 OpenClaw 期望 |
|----|------------------|-------------------|
| provider id | `openai-codex` | `openai` |
| model ref | `openai-codex/gpt-*` | `openai/gpt-*` |
| provider/model `api` | `openai-codex-responses` | `openai-chatgpt-responses` |
| OAuth profile provider | `openai-codex:*` legacy | `openai:*` / external Codex CLI profile |
| Codex runtime intent | 隐含在 provider id 中 | OpenClaw 默认对 `openai/gpt-*` 选择 Codex runtime；必要时用 provider/model scoped `agentRuntime` 表达 |

当前 LobsterAI 侧仍有三类旧假设：

1. `OpenClawProviderId.OpenAICodex = "openai-codex"` 仍被用于 OpenAI OAuth 模式。
2. `OpenClawApi.OpenAICodexResponses = "openai-codex-responses"` 仍被写入 provider 和 model。
3. 前端模型 ref 生成和匹配逻辑仍把 OpenAI OAuth 模型显示/保存为 `openai-codex/<model>`。

OAuth token 文件本身不是根因。LobsterAI 仍会把 `CODEX_HOME` 指向 app-managed `<userData>/codex`，新版 OpenClaw 也仍能从该目录读取 `auth.json` 中的 `tokens.access_token` / `tokens.refresh_token`，并识别为 `provider: "openai"` 的 OAuth credential。

### 1.3 目标

1. OpenAI ChatGPT OAuth 登录后，OpenClaw gateway 可以正常启动。
2. LobsterAI 生成新版 OpenClaw 接受的 canonical model route：`openai/gpt-*`。
3. OAuth 登录态继续复用现有 `<userData>/codex/auth.json`，不把 OAuth token 写入 `openclaw.json`。
4. 旧的 `openai-codex/*` 会话路由、agent model 配置和前端模型 ref 能平滑迁移或兼容读取。
5. 不通过长期 OpenClaw patch 恢复 `openai-codex-responses`，避免逆着新版 OpenClaw 迁移方向维护兼容债。

## 2. 用户场景

### 场景 1: 已登录 ChatGPT OAuth 的用户升级 OpenClaw

**Given** 用户在旧版本中已经通过 OpenAI ChatGPT OAuth 登录，并选择 `gpt-5.4` 或 `gpt-5.5` 作为默认模型  
**When** LobsterAI 启动新版 OpenClaw gateway  
**Then** `openclaw.json` 使用 `openai/gpt-*` 与 `openai-chatgpt-responses`，gateway 可以通过配置校验并启动

### 场景 2: 用户重新执行 OpenAI ChatGPT OAuth 登录

**Given** 用户在设置页选择 OpenAI 的 ChatGPT OAuth 模式  
**When** OAuth 登录成功并写入 `<userData>/codex/auth.json`  
**Then** LobsterAI 同步 OpenClaw 配置时不写 API key，不写旧 `openai-codex` provider，而是让 OpenClaw 通过 `CODEX_HOME` 读取 `openai` OAuth profile

### 场景 3: 旧会话中保存了 `openai-codex/gpt-*`

**Given** OpenClaw sessions store 或 LobsterAI agent 配置中存在旧模型 ref  
**When** 配置同步或会话恢复发生  
**Then** LobsterAI 将受管 session route 迁移为 `provider=openai`、`model=gpt-*`，或者在读取旧 ref 时兼容解析到当前 OpenAI OAuth 模型

### 场景 4: 用户从 OAuth 切回 API Key

**Given** 用户从 OpenAI ChatGPT OAuth 模式切回 API Key 模式  
**When** OpenClaw 配置同步  
**Then** OpenAI provider 回到普通 `openai-completions` / `openai-responses` 路由，不能错误沿用 `openai-chatgpt-responses` 或 OAuth auth

## 3. 功能需求

### FR-1: OpenAI OAuth 生成 canonical OpenClaw provider

当 `providerName === "openai"` 且 `authType === "oauth"` 时，`buildProviderSelection()` 应生成：

```json5
{
  providerId: "openai",
  primaryModel: "openai/gpt-5.4",
  providerConfig: {
    baseUrl: "https://chatgpt.com/backend-api/codex",
    api: "openai-chatgpt-responses",
    auth: "oauth",
    models: [
      { id: "gpt-5.4", api: "openai-chatgpt-responses" },
    ],
  },
}
```

`baseUrl` 可以继续写 `https://chatgpt.com/backend-api/codex`。新版 OpenClaw 会将它解析为 `/codex/responses` endpoint。也可以后续统一为上游默认 `https://chatgpt.com/backend-api`，但这不是本次修复的必要条件。

### FR-2: 不再写旧 API enum

LobsterAI 不应继续向 `openclaw.json` 写出：

- `api: "openai-codex-responses"`
- `models.providers["openai-codex"]`
- `agents.defaults.model.primary: "openai-codex/<model>"`

旧常量可以短期保留为 migration/compat 名称，但不能作为新配置输出路径。

### FR-3: 保持 OAuth 凭证安全边界

OpenAI ChatGPT OAuth token 仍只存储在 `<userData>/codex/auth.json`。`openclaw.json` 中不写：

- OAuth access token
- OAuth refresh token
- 从 token 派生出的 `apiKey`

OpenClaw gateway 环境变量继续设置：

```text
CODEX_HOME=<LobsterAI userData>/codex
```

### FR-4: 迁移旧 model ref

LobsterAI 需要兼容或迁移以下旧形态：

| 旧形态 | 新形态 |
|--------|--------|
| `openai-codex/gpt-5.4` | `openai/gpt-5.4` |
| `openai-codex/gpt-5.5` | `openai/gpt-5.5` |
| `modelProvider: "openai-codex"` + `model: "gpt-*"` | `modelProvider: "openai"` + `model: "gpt-*"` |
| 前端 model `openClawProviderId: "openai-codex"` | `openClawProviderId: "openai"` |

迁移范围优先覆盖 LobsterAI 受管 session store 和 agent 配置。非受管 OpenClaw 内部文件可以依赖新版 OpenClaw `doctor --fix` 作为额外修复工具，但不能把 doctor 作为 LobsterAI 新配置输出的前置条件。

### FR-5: 前端模型选择与后端配置一致

设置页、应用初始化和模型 ref helper 中，OpenAI OAuth 模型应统一显示/保存为 `openai/<model>`。旧 `openai-codex/<model>` 只作为历史兼容输入被解析，不再作为新值生成。

## 4. 实现方案

### 4.1 更新 OpenClaw API / provider 常量

在 `src/shared/providers/constants.ts` 中新增新版 API 常量：

```ts
OpenAIChatGPTResponses: 'openai-chatgpt-responses'
```

处理旧常量：

- `OpenAICodexResponses` 不再用于新配置输出。
- 如短期仍保留，注释标记为 legacy，并限制只在旧 ref 迁移或测试 fixture 中使用。
- 不建议将 `OpenClawProviderId.OpenAICodex` 用作 OAuth 输出 provider；它应只代表历史兼容 provider id。

### 4.2 调整 `openclawConfigSync` 的 OpenAI OAuth descriptor

修改 `PROVIDER_REGISTRY[`${ProviderName.OpenAI}:oauth`]`：

| 字段 | 新值 |
|------|------|
| `providerId` | `OpenClawProviderId.OpenAI` |
| `resolveApi()` | `OpenClawApi.OpenAIChatGPTResponses` |
| `normalizeBaseUrl()` | `OPENAI_CODEX_BASE_URL` 或上游默认 `https://chatgpt.com/backend-api` |
| `resolveApiKey()` | `undefined` |

同时调整 `OpenClawProviderApi` union，加入 `openai-chatgpt-responses`，移除或 legacy 化 `openai-codex-responses`。

### 4.3 移除 LobsterAI 手写 Codex headers 依赖

新版 OpenClaw 的 `openai-chatgpt-responses` provider 会基于 OAuth token 设置：

- `Authorization`
- `chatgpt-account-id`
- `originator`
- `User-Agent`
- `OpenAI-Beta`

因此 LobsterAI 侧的 `buildOpenAICodexHeaders()` 不应再作为新版路径的必要条件。推荐策略：

1. 对新版 `providerId=openai` + `api=openai-chatgpt-responses` 不写 `headers`。
2. 如果保留 legacy 兼容分支，只在旧 `openai-codex` 输出路径上使用该函数。
3. 登录状态读取 `readOpenAICodexAuthFile()` 仍保留给设置页状态展示和登录校验。

### 4.4 更新前端模型 ref 映射

调整以下位置中 OpenAI OAuth 的 provider id 计算：

| 文件 | 当前行为 | 目标行为 |
|------|----------|----------|
| `src/renderer/App.tsx` | OpenAI OAuth 返回 `OpenAICodex` | 返回 `OpenAI` |
| `src/renderer/components/settings/modelProviderUtils.ts` | OpenAI OAuth 返回 `OpenAICodex` | 返回 `OpenAI` |
| `src/renderer/utils/openclawModelRef.ts` | `openai/*` fallback 到 `openai-codex/*` | 反向兼容：旧 `openai-codex/*` 解析到当前 `openai/*` |

更新后，新模型列表中的 OpenAI OAuth 模型 ref 应为：

```text
openai/gpt-5.4
openai/gpt-5.5
```

### 4.5 迁移受管 session store

`OpenClawConfigSync.syncManagedSessionStore()` 已会基于 `providerSelection.primaryModel` 同步 LobsterAI 受管 session route。修复后 `providerSelection.primaryModel` 会从 `openai-codex/gpt-*` 变为 `openai/gpt-*`，因此该路径可以覆盖多数受管 session。

需要额外确认：

1. `shouldMigrateManagedModelRefs` 对本次 provider id 变化会返回 true。
2. `resolveQualifiedAgentModelRef()` 能识别旧 `openai-codex/gpt-*` 并迁到新 provider。
3. `LegacyQualifiedProviderMigration` 方向需要调整：以前是 `openai -> openai-codex` 兼容，现在应支持 `openai-codex -> openai`。
4. 对 channel session 或非 `agent:*:lobsterai:*` session，只做安全兼容解析，不做过度重写，避免误改 OpenClaw 非 LobsterAI 管理的状态。

### 4.6 不把 `openclaw doctor --fix` 作为主修复

新版 OpenClaw 文档说明 `doctor --fix` 可以迁移 legacy `openai-codex/*` model refs 和 `openai-codex:*` auth profiles。但 LobsterAI 的 `openclaw.json` 是由 `OpenClawConfigSync` 持续生成的：

```text
LobsterAI config sync -> openclaw.json
```

如果只运行 doctor，下一次 LobsterAI sync 仍会写回旧配置。因此 doctor 只能作为用户已有 OpenClaw 状态的补充修复，不是产品内兼容的根治方案。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 用户没有 ChatGPT OAuth 登录文件，但配置为 OAuth 模式 | 设置页 status 应显示未登录；OpenClaw 启动可通过配置校验，但模型调用会给出缺少 OpenAI OAuth profile 的可诊断错误 |
| 用户同时有 OpenAI API Key 和 ChatGPT OAuth | `authType` 决定路由；OAuth 模式走 `openai-chatgpt-responses`，API Key 模式走普通 OpenAI API |
| 用户切换 OAuth/API Key 后已有会话继续旧模型 | 受管 session store 在 config sync 中迁移；前端旧 ref 兼容解析，避免 UI 找不到当前模型 |
| 旧 `openai-codex` provider 残留在 existing `openclaw.json` | 下一次 LobsterAI sync 应输出新 `openai` provider 并覆盖 managed config |
| OpenClaw 后续继续调整 ChatGPT API enum | `OpenClawApi` 常量和 `buildProviderSelection()` 测试应作为第一层告警 |
| 系统代理开启 | 保留 `request.proxy.mode = "env-proxy"`，由 OpenClaw transport 处理代理，不把 token 暴露到配置 |
| baseUrl 使用 `/codex` 或不带 `/codex` | 当前可继续用 `/codex`；OpenClaw 会补 `/responses`。如改为不带 `/codex`，需要补充测试避免 endpoint 重复拼接 |

## 6. 涉及文件

| 文件 | 说明 |
|------|------|
| `src/shared/providers/constants.ts` | 新增 `openai-chatgpt-responses` 常量，legacy 化旧 Codex API/provider 常量 |
| `src/main/libs/openclawConfigSync.ts` | 调整 OpenAI OAuth provider selection、provider config、headers 输出和 session route 迁移 |
| `src/main/libs/openclawConfigSync.runtime.test.ts` | 更新 OAuth 配置生成断言，覆盖 `openai/gpt-*` 与 `openai-chatgpt-responses` |
| `src/main/libs/openclawAgentModels.ts` | 调整旧 provider/model ref 解析和迁移方向 |
| `src/main/libs/openclawAgentModels.test.ts` | 覆盖旧 `openai-codex/*` 到新 `openai/*` 的兼容解析 |
| `src/renderer/App.tsx` | 应用初始化时模型列表 OpenClaw provider id 生成 |
| `src/renderer/components/settings/modelProviderUtils.ts` | 设置页模型 provider id 生成和认证状态判断 |
| `src/renderer/components/settings/modelProviderUtils.test.ts` | 覆盖 OpenAI OAuth provider id 与 auth configured 行为 |
| `src/renderer/utils/openclawModelRef.ts` | 新旧 model ref 匹配兼容 |

## 7. 验收标准

### 自动化验证

```bash
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/shared/providers/constants.ts \
  src/main/libs/openclawConfigSync.ts \
  src/main/libs/openclawAgentModels.ts \
  src/renderer/App.tsx \
  src/renderer/components/settings/modelProviderUtils.ts \
  src/renderer/utils/openclawModelRef.ts

npm test -- openclawConfigSync.runtime openclawAgentModels modelProviderUtils
```

### 配置输出验收

完成修复后，OpenAI OAuth 模式下生成的 `openclaw.json` 必须满足：

1. `models.providers.openai` 存在。
2. `models.providers.openai.api === "openai-chatgpt-responses"`。
3. `models.providers.openai.auth === "oauth"`。
4. `models.providers.openai.models[].api === "openai-chatgpt-responses"`。
5. `agents.defaults.model.primary` 为 `openai/gpt-*`。
6. 不存在 `models.providers["openai-codex"]`。
7. 不存在 `openai-codex-responses`。

### 手工验证

1. 启动 `npm run electron:dev`。
2. 在设置页选择 OpenAI ChatGPT OAuth 并确认登录状态。
3. 触发配置同步后检查 gateway 日志：
   - 不再出现 `Invalid config ... openai-codex-responses`。
   - gateway 能进入 healthy/ready。
4. 使用 `gpt-5.4` 或 `gpt-5.5` 发送一条 Cowork 消息。
5. 确认 session patch 不再报 `model not allowed: openai-codex/gpt-*`。
6. 切回 OpenAI API Key 模式，确认普通 OpenAI provider 仍按 API Key 路由。

### 不做项

1. 不新增 OpenClaw patch 重新接受 `openai-codex-responses`。
2. 不要求用户手动运行 `openclaw doctor --fix` 才能启动 LobsterAI。
3. 不把 OAuth access token / refresh token 写入 renderer config 或 `openclaw.json`。
4. 不改变 MiniMax、GitHub Copilot 或其他 provider 的 OAuth 行为。
