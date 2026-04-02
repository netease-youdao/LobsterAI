# 审计：LobsterAI Provider 配置 vs OpenClaw 官方文档

> 基于 https://docs.openclaw.ai/concepts/model-providers 对当前代码进行交叉审计

## 1. Provider ID 映射审计

### 当前映射 vs OpenClaw 官方 Provider ID

| LobsterAI ProviderName | 当前 OpenClawProviderId | OpenClaw 官方 Provider ID | 状态 |
|---|---|---|---|
| `openai` | `openai` | `openai` | ✅ 正确 |
| `anthropic` | `anthropic` | `anthropic` | ✅ 正确 |
| `gemini` | `google` | `google` | ✅ 正确 |
| `moonshot` | `moonshot` | `moonshot` | ✅ 正确 |
| `moonshot:codingPlan` | `kimi-coding` | `kimi-coding` | ✅ 正确 |
| `volcengine` | `volcengine` | `volcengine` | ✅ 正确 |
| `minimax` | `minimax` | `minimax` | ✅ 正确 |
| `xiaomi` | `xiaomi` | `xiaomi` | ✅ 正确 |
| `openrouter` | `openrouter` | `openrouter` | ✅ 正确 |
| `ollama` | `ollama` | `ollama` | ✅ 正确 |
| `zhipu` | `zhipu` | ⚠️ `zai` | ❌ **不匹配** |
| `deepseek` | `deepseek` | ❓ 未列为官方 provider | ⚠️ **未确认** |
| `qwen` | `qwen` | ❓ 未列为官方 provider | ⚠️ **未确认** |
| `youdaozhiyun` | `youdaozhiyun` | ❓ 未列为官方 provider | ⚠️ **未确认** |
| `stepfun` | `stepfun` | ❓ 未列为官方 provider | ⚠️ **未确认** |

---

## 2. 发现的问题

### 问题 1：Zhipu Provider ID 不匹配（严重）

**现状**：LobsterAI 使用 `OpenClawProviderId.Zhipu = 'zhipu'`
**OpenClaw 官方**：使用 `zai` 作为 GLM/Zhipu 的 provider ID

> 文档原文：
> - Provider: `zai`
> - Auth: `ZAI_API_KEY`
> - Example model: `zai/glm-5`
> - Aliases: `z.ai/*` and `z-ai/*` normalize to `zai/*`

**实际影响**：由于 LobsterAI 使用 `models.mode: 'replace'` 注入完整 provider 配置（baseUrl + api + apiKey + models），`zhipu` 会被 OpenClaw 当作**自定义 provider** 处理，基本推理功能不受影响——请求会正确发送到我们指定的 `baseUrl`。

**但存在功能缺失**：OpenClaw 官方的 `zai` bundled plugin 包含 GLM 专属的 plugin-owned behavior（如 `isBinaryThinking`、`cache-TTL policy`、`usage auth + quota fetching`、`GLM-5 forward-compat fallback` 等）。使用 `zhipu` 而非 `zai` 时，这些 plugin 逻辑不会被触发。如果这些逻辑对 GLM 模型的正常工作不是必需的（基本推理只依赖 transport 层），则无实际影响。

**建议**：将 `OpenClawProviderId.Zhipu` 的值从 `'zhipu'` 改为 `'zai'` 可以获得 OpenClaw 官方 plugin 的完整支持，但这不是紧急修复——当前功能可以正常工作。

### 问题 2：Volcengine Coding Plan 缺少独立 Provider ID

**现状**：LobsterAI 将 volcengine 的 codingPlan 模式直接用 `volcengine` provider ID 处理，没有单独的 codingPlan 路由。

**OpenClaw 官方**：Volcengine 有独立的 coding provider：

> - Provider: `volcengine` (coding: `volcengine-plan`)
> - Coding models (`volcengine-plan`):
>   - `volcengine-plan/ark-code-latest`
>   - `volcengine-plan/doubao-seed-code`
>   - `volcengine-plan/kimi-k2.5`

**影响**：当用户在 LobsterAI 中启用 volcengine 的 codingPlan 模式时，生成的配置使用 `volcengine` 作为 provider ID，而 OpenClaw 期望的是 `volcengine-plan`。这可能导致 coding 模型无法被正确路由。

**建议**：
1. 在 `OpenClawProviderId` 中添加 `VolcenginePlan: 'volcengine-plan'`
2. 在 `PROVIDER_REGISTRY` 中添加 `volcengine:codingPlan` 组合键，类似 `moonshot:codingPlan` → `kimi-coding` 的模式

### 问题 3：DeepSeek 未列为 OpenClaw 官方内置 Provider

**现状**：LobsterAI 将 deepseek 映射到 `OpenClawProviderId.DeepSeek = 'deepseek'`

**OpenClaw 官方**：文档中未将 `deepseek` 列为内置 provider 或 bundled plugin。

**可能的解释**：
1. DeepSeek 可能通过 `models.providers` 自定义配置使用（OpenAI 兼容），此时 provider ID 可以是任意字符串
2. OpenClaw 可能有未在该文档页面列出的支持

**影响**：如果 `models.providers.deepseek` 是作为自定义 provider 注入的（`models.mode: 'replace'`），则 provider ID 可以是任意值，不会有问题。我们的用法确实是通过 `models.providers` 注入完整配置，所以这可能不是实际问题。

### 问题 5：同样适用的未列为官方的 Provider

以下 provider 同样未在 OpenClaw 文档中列为官方 provider：
- `qwen` — 可能对应 `modelstudio`（阿里云 Model Studio）
- `youdaozhiyun` — LobsterAI 专有
- `stepfun` — 未列出

**注意**：由于 LobsterAI 使用 `models.mode: 'replace'` 模式注入完整 provider 配置（含 baseUrl、api、apiKey、models），这些自定义 provider ID 不需要与 OpenClaw 内置 provider 匹配。OpenClaw 会将它们作为自定义 provider 处理。但如果 OpenClaw 对某些 provider ID 有特殊的内部逻辑（如 plugin-owned behavior），使用不匹配的 ID 会导致这些特殊逻辑不被触发。

### 问题 6：遗留的硬编码字符串

`openclawConfigSync.ts` 中仍有几处硬编码字符串未使用常量：

| 位置 | 硬编码值 | 应替换为 |
|---|---|---|
| 第 762 行 | `'lobsterai-server'` | `ProviderName.LobsteraiServer` |
| 第 770 行 | `'lobsterai-server'` | `ProviderName.LobsteraiServer` |
| 第 778 行 | `'openai-completions'` | `OpenClawApi.OpenAICompletions` (cast) |
| 第 785 行 | `'lobsterai-server'` | `OpenClawProviderId.LobsteraiServer` |

### 问题 7：缺少 OpenClaw 支持的 Provider

OpenClaw 官方文档列出了以下 LobsterAI 目前不支持但 OpenClaw 已支持的 provider：

| OpenClaw Provider ID | 描述 | 优先级 |
|---|---|---|
| `openai-codex` | OpenAI Codex（OAuth 认证） | 低（不同认证模式） |
| `github-copilot` | GitHub Copilot | 低（不同认证模式） |
| `google-vertex` | Google Vertex AI | 中 |
| `google-gemini-cli` | Gemini CLI OAuth | 低 |
| `zai` | Z.AI / GLM（对应当前 zhipu） | 高（见问题 1） |
| `xai` | xAI / Grok | 中 |
| `mistral` | Mistral AI | 中 |
| `groq` | Groq | 中 |
| `cerebras` | Cerebras | 低 |
| `kilocode` | Kilo Gateway | 低 |
| `vllm` | vLLM 本地推理 | 低 |
| `sglang` | SGLang 本地推理 | 低 |
| `byteplus` | BytePlus ARK（国际版火山引擎） | 中 |
| `huggingface` | Hugging Face Inference | 低 |
| `together` | Together AI | 低 |
| `nvidia` | NVIDIA | 低 |
| `qianfan` | 百度千帆 | 中 |
| `modelstudio` | 阿里云 Model Studio | 中（可能对应 qwen） |

这不是 bug，只是功能覆盖差距。但如果用户在 LobsterAI 中配置了这些 provider，当前的 fallback 逻辑会将其路由到 `lobster` provider ID，这可能不是用户预期的行为。

---

## 3. 严重程度评估

| 问题 | 严重程度 | 立即影响 | 建议动作 |
|---|---|---|---|
| #1 Zhipu → `zai` | 🟡 中 | 基本推理正常（自定义 provider），但缺失 zai plugin 专属功能 | 改为 `zai` 可获得完整 plugin 支持 |
| #2 Volcengine coding plan | 🟡 中 | Volcengine coding 模型路由可能不正确 | 添加 `volcengine-plan` provider ID |
| #6 硬编码字符串 | 🟢 低 | 功能正常，但违反代码规范 | 替换为常量 |
| #3/#4 非官方 provider | 🟢 低 | 通过 models.providers 自定义注入，可正常工作 | 无需立即处理 |
| #5 缺少 provider 覆盖 | ℹ️ 信息 | 功能差距，非 bug | 按需迭代 |

---

## 4. 建议优先处理

1. **Zhipu → `zai` 映射**：当前以自定义 provider 方式工作，基本推理正常。改为 `zai` 可获得 OpenClaw 官方 plugin 的 GLM 专属优化（binary thinking、cache TTL、usage quota 等），但非紧急。
2. **添加 `volcengine-plan` 支持**：仿照 `moonshot:codingPlan` → `kimi-coding` 模式。
3. **清理硬编码字符串**：4 处小改动，低风险。
