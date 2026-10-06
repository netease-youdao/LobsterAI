# Kimi K3 全链路兼容与发布支持设计文档

> 状态：Implemented（客户端与 OpenClaw runtime 已完成；套餐服务端门禁和真实密钥 E2E 为发版前置）
>
> 适用范围：LobsterAI 自定义模型、内置 Moonshot Provider、套餐模型与 OpenClaw runtime
>
> 目标版本：本次 LobsterAI 发版

## 1. 概述

### 1.1 问题背景

LobsterAI 当前版本为 `2026.7.17`，固定使用 OpenClaw `v2026.6.1`。这一版本早于 OpenClaw 对 Kimi K3 的原生适配，当前代码和运行配置还存在以下问题：

1. 内置 Moonshot 模型目录只有 Kimi K2.6 / K2.5，没有 Kimi K3。
2. 用户可以手工添加 `kimi-k3`，但 LobsterAI 只能向 OpenClaw 写出通用模型字段，无法表达 K3 官方要求的 `thinkingLevelMap` 和 `compat`。
3. 自定义参数 `customParams` 会进入请求体 `extra_body`；它不能替代 OpenClaw transport metadata，也不应被用来粘贴官方 `compat` 配置。
4. OpenClaw 新版的原生 K3 wrapper 只对 `moonshot/kimi-k3` 生效，自定义 Provider 和 `lobsterai-server/<套餐模型 ID>` 不会自动命中。
5. 套餐模型虽然由服务端返回 `provider`、`apiFormat`、图片和思考能力等元数据，但没有受控的模型兼容档案、工具调用能力或 Agent 上线状态。
6. 当前运行适配器只特殊处理 `toolUse` 和 `error`。K3 现场运行达到 `stopReason=length`、`output=8192` 后，仍可能被标记为完成。

现场轨迹同时证明问题不是“OpenClaw 完全不认识 K3 工具调用”：

- 直连 `moonshot/kimi-k3` 时，旧 runtime 曾成功解析并执行一个结构化 `read` 工具调用，但续轮在 8192 token 处截断，没有继续写文件。
- 套餐路径 `lobsterai-server/kimi-k3-YoudaoInner` 加载了 105 个工具，但最终没有任何结构化工具事件，只输出了声称“已落盘”的普通文本。

因此，本次支持不能只是在模型列表中新增一个 ID，也不能只升级 OpenClaw。需要同时补齐：

1. LobsterAI 模型元数据与配置同步；
2. OpenClaw K3 请求、流式响应和多轮回放；
3. 自定义 Provider 与套餐 Provider 的兼容路由；
4. 截断、流异常和套餐灰度的失败保护。

### 1.2 根因链路

当前失败链路分为两层：

#### A. OpenClaw 版本能力缺口

OpenClaw 在 2026 年 7 月合并了以下关键修复：

- `#109202 feat(kimi): add Kimi K3 support`
- `#109556 fix: OpenAI-compatible provider compat and error-body surfacing`
- `#110518 fix: prevent repeated tool-call IDs from poisoning sessions`

当前 `v2026.6.1` 不包含这些修复。最新版 `v2026.7.2-beta.3` 已包含它们，但截至本文创建时还不是稳定版。

#### B. LobsterAI Provider 身份与兼容档案缺口

OpenClaw 的原生 K3 逻辑按 `provider=moonshot` 和 `model=kimi-k3` 匹配。LobsterAI 套餐模型必须继续使用：

```text
lobsterai-server/<服务端原始 modelId>
```

用户自定义 Provider 必须继续使用：

```text
custom_N/<用户原始 modelId>
```

这两类模型不能伪装成 Moonshot，也不能重写模型 ID，否则会造成 API Key、Base URL、套餐鉴权、会话引用和模型选择串路。

正确做法是把“Provider 身份”和“K3 协议兼容档案”分开：模型引用保持不变，通过受控兼容档案让 OpenClaw 应用同一套 K3 请求与回放规则。

### 1.3 目标

1. 内置 Moonshot Provider 默认提供 `kimi-k3`，并按 Kimi 官方 OpenClaw 配置运行。
2. 用户在任一内置或自定义 Provider 中配置 K3 时，可以获得完整的 K3 transport 与工具调用兼容。
3. LobsterAI 套餐 K3 保持 `lobsterai-server/<原始 modelId>`，同时应用与直连一致的 K3 协议规则。
4. 自定义 API Key、套餐 Token、Provider Base URL 和模型 ID 始终保持各自路由，不发生隐式切换。
5. 工具调用后的 `reasoning_content`、`tool_calls` 和 `tool_call_id` 能正确保存并回放。
6. `stopReason=length`、异常 SSE EOF 和缺失终止包不得显示为任务成功。
7. 套餐 K3 通过 `agenticReady` 进行服务端灰度和紧急关闭。
8. 不影响 `lobsterai-server` 下 GPT、Claude、Qwen、GLM 等非 K3 模型。
9. 新增和修改的 TypeScript 文件通过 changed-file ESLint、目标 Vitest、Electron 编译与打包验证。

### 1.4 非目标

本次不处理：

1. Kimi Code 的 `kimi/k3`、`k3[1m]` 或 Kimi Coding Plan 路径。
2. K2.x 系列的整体行为重构。
3. 自动识别任意第三方代理自定义的 K3 别名。
4. 把 OpenRouter `#110138` 的通用工具 Schema 方案直接引入所有 Provider。
5. 新增 K3 视频附件选择和上传 UI；本期只正确声明 runtime 能力。
6. 任意提高 Kimi 官方 OpenClaw 指南给出的 `maxTokens: 8192`。
7. 模型设置页面整体重做。
8. 根据模型自然语言判断“是否撒谎说已落盘”。
9. Provider 间自动 failover。
10. 允许用户或 LobsterAI 服务端远程注入任意 OpenClaw `compat` JSON。

## 2. 核心设计决策

### 2.1 Provider 身份与兼容档案分离

三条支持路径保持原始身份：

| 模型来源 | OpenClaw 模型引用 | 兼容档案 |
|---|---|---|
| 内置 Provider（含 Moonshot） | `<原 providerId>/<原始 modelId>` | 规范化后精确 `kimi-k3` 自动解析 |
| 用户自定义 Provider | `custom_N/<原始 modelId>` | 仅规范化后精确 `kimi-k3` 自动解析 |
| LobsterAI 套餐 | `lobsterai-server/<服务端原始 modelId>` | 仅接受服务端下发的受控枚举 |

禁止：

- 把 `custom_N` 或 `lobsterai-server` 重命名为 `moonshot`；
- 把套餐模型 ID 改成 `kimi-k3`；
- 根据 `modelId.includes('kimi-k3')` 模糊匹配套餐模型；
- 在用户 API Key 与套餐 Token 之间隐式切路；
- 跨 Provider 去重同名 K3。

### 2.2 使用受控运行档案，不提供用户兼容模式

共享层新增稳定常量：

```ts
export const ModelRuntimeProfile = {
  MoonshotKimiK3: 'moonshot-kimi-k3',
} as const;

export type ModelRuntimeProfile =
  typeof ModelRuntimeProfile[keyof typeof ModelRuntimeProfile];
```

用户配置不保存 `compatibilityMode`，模型编辑表单也不暴露兼容模式。对于内置
和自定义模型，仅当最终 transport 为 `openai-completions`，且规范化后的模型
ID 精确等于 `kimik3` 时应用 `moonshot-kimi-k3`。`my-kimi-prod` 等任意别名
不会命中，也不能由用户手动强制启用。

服务端只能下发 `ModelRuntimeProfile` 白名单中的值。未知值必须忽略并记录 warning，不能写入 `openclaw.json`。

### 2.3 K3 官方运行档案为唯一数据源

`moonshot-kimi-k3` 展开为：

```json
{
  "reasoning": true,
  "input": ["text", "image", "video"],
  "contextWindow": 1048576,
  "maxTokens": 8192,
  "thinkingLevelMap": {
    "off": null,
    "minimal": "max",
    "low": "max",
    "medium": "max",
    "high": "max",
    "xhigh": "max",
    "max": "max"
  },
  "compat": {
    "maxTokensField": "max_tokens",
    "supportsUsageInStreaming": false,
    "requiresStringContent": true,
    "supportsReasoningEffort": true,
    "supportedReasoningEfforts": [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]
  }
}
```

该配置来自 Kimi 官方 OpenClaw 指南。服务端或用户不能覆盖这些 transport 字段。

> 2026-09-22 更新：`maxTokens` 由 8192 改为 1048576，与 OpenClaw `v2026.8.1` 内置 Moonshot
> 目录一致。8192 不是 OpenClaw 的限制，而是 Kimi 官方 OpenClaw 指南给出的“单次回复上限”；
> K3 API 文档写明 `max_completion_tokens` 默认 131072、最大 1048576。本次为产品决策，
> 取代 §1.4 第 6 条和 §11.3 的“不提高 8192”约定；已有用户的官方 K3 条目会由 renderer 的
> 能力修复逻辑自动刷新到新值，套餐与自定义 K3 通过 runtime profile 一起生效。

### 2.4 本次发版不默认使用 OpenClaw Beta

截至 2026-07-23，包含 K3 核心修复的版本为 `v2026.7.2-beta.3`。本次生产发版的默认方案是：

1. 继续固定当前已验证的 `v2026.6.1`；
2. 以版本限定 patch 回补 `#109202`、`#109556` 中本次所需部分和 `#110518`；
3. 使用 `v2026.7.2-beta.3` 做兼容对照，不作为默认生产 pin；
4. 如果发版冻结前出现包含上述修复的稳定 tag，则改用该稳定 tag，并删除重叠 patch。

Tag ancestry 已核对：`v2026.7.2-beta.3` 包含 `#109202` 的 landed commit
`42ff5ec`、`#109556` 的 `0c989568` 和 `#110518` 的 `6def1a9`。

不能同时把“Beta 升级”和“旧版 patch”作为生产默认路径。

### 2.5 套餐和自定义 Provider 由本地兼容插件接管

新增本地 OpenClaw extension：

```text
lobsterai-model-compat
```

职责：

1. 按完整 `provider/model` 精确读取 LobsterAI 生成的受控 profile 映射。
2. 注册受控 API owner `lobsterai-model-compat`，并委托真实的 model-level
   transport。
3. 仅对映射为 `moonshot-kimi-k3` 的模型应用 K3 wrapper 和 replay policy。
4. 对同一 Provider 下其他模型完全 passthrough。
5. 复用 OpenClaw 上游 K3 实现，不复制一份容易漂移的私有协议代码。

> 2026-09-22 更新：升级到 OpenClaw `v2026.8.1` 后，上游把 K3 请求契约合并进了
> `createMoonshotThinkingWrapper`，且只对 `provider === "moonshot"` 生效，不再导出
> `createMoonshotKimiK3Wrapper`；随之退役的 `openclaw-kimi-k3-support.patch` 曾是该
> 导出的唯一来源，扩展因此在 Gateway 启动时加载失败。第 5 条改为：扩展在
> `kimiK3StreamWrapper.ts` 内自行维护与上游 `sanitizeAlwaysThinkingPayload`、
> `ensureMoonshotToolCallReasoningContent` 相同的契约，不再依赖 SDK 导出。
> `tests/openclaw-extensions/pluginSdkImportContract.test.ts` 用
> `openclaw-extensions/plugin-sdk-exports.json` 校验本地扩展对 SDK 的具名导入；
> 重建 runtime 后执行 `npm run openclaw:sdk-contract` 刷新该快照。
>
> 同日发现第二个 8.1 差异：Gateway 启动和热重载只会导入“配置里被 agent 模型引用到的
> provider id”对应的插件，`lobsterai-server` 不对应任何插件，`api` owner 提示在启动计划里
> 不会被查询；而运行发生在已准备好的 plugin generation 内，不允许按需加载。结果是套餐模型的
> 首次运行拿不到本扩展的 hook。修法是在 `openclaw.plugin.json` 声明
> `activation.onStartup: true` 与 `activation.onProviders: ["lobsterai-server"]`，让扩展进入
> 每一代 Gateway 插件集合；`plugins.entries` 里的显式 `enabled: true` 仍是前提。

它不负责：

- 鉴权；
- Token 刷新；
- 套餐路由；
- 工具权限；
- sandbox、cwd 或审批策略；
- 任意请求体转发。

`openclawTokenProxy.ts` 继续只承担套餐鉴权、透明传输和 SSE 完整性检查。

## 3. 用户场景

### 场景 1：新用户使用内置 Moonshot K3

- **Given** 用户配置 Moonshot 中国区 API Key
- **And** 使用官方 `https://api.moonshot.cn/v1` OpenAI Chat Completions 路由
- **And** 未启用 Kimi Coding Plan
- **When** 用户在模型列表中选择 Kimi K3
- **Then** LobsterAI 使用 `moonshot/kimi-k3`
- **And** 生成完整 K3 profile
- **And** 使用用户自己的 Moonshot API Key
- **And** 可以完成真实工具调用和多轮回放

### 场景 2：已有用户升级后不出现重复 K3

- **Given** 用户已经手工添加 `kimi-k3`、`Kimi_K3` 或 `kimi.k3`
- **When** LobsterAI 执行本次模型目录迁移
- **Then** 不再添加第二个等价 K3
- **And** 保留用户原有名称、排序、自定义参数和选择状态
- **And** 为该模型解析正确的 K3 profile

### 场景 3：自定义 Provider 使用标准 K3 ID

- **Given** 用户创建 `custom_0`，Base URL 指向真实 Kimi K3 OpenAI-compatible 接口
- **And** 模型 ID 精确等价于 `kimi-k3`
- **When** 保存模型配置
- **Then** 模型引用保持 `custom_0/<原始 modelId>`
- **And** 自动应用 K3 profile
- **And** API Key 只发往用户配置的 Base URL

### 场景 4：自定义 Provider 使用别名

- **Given** 用户代理把 K3 命名为 `my-kimi-prod`
- **When** 保存并使用该模型
- **Then** LobsterAI 按普通 OpenAI-compatible 模型处理
- **And** 不提供手动强制启用 K3 profile 的入口
- **And** 同 Provider 下其他模型保持原行为

### 场景 5：套餐 K3 灰度开放

- **Given** `/api/models/available` 返回套餐 K3
- **And** `runtimeProfile=moonshot-kimi-k3`
- **And** `supportsToolCalling=true`
- **And** `agenticReady=true`
- **When** 用户选择套餐 K3
- **Then** 模型引用保持 `lobsterai-server/<服务端原始 modelId>`
- **And** 请求继续经过套餐 Token Proxy
- **And** K3 兼容插件应用协议适配
- **And** 不影响其他套餐模型

### 场景 6：套餐 K3 尚未通过 Agent 验证

- **Given** 套餐服务端返回 `agenticReady=false`
- **When** 用户查看或尝试选择该模型
- **Then** 模型可以按产品配置保持可见
- **But** 不能启动新的 Agent 执行任务
- **And** 显示“该模型正在进行任务能力验证”的中英文提示

### 场景 7：K3 多轮工具调用

- **Given** K3 首轮返回 `reasoning_content + tool_calls`
- **When** OpenClaw 执行工具并发起下一轮请求
- **Then** 完整回放原 assistant message
- **And** 每个工具结果与原始 `tool_call_id` 配对
- **And** 重复工具 ID 不污染其他轮次或会话

### 场景 8：K3 输出达到上限

- **Given** K3 返回部分文本或 thinking
- **And** `stopReason=length`
- **When** LobsterAI 收到最终事件
- **Then** 保留已有部分文本和已完成工具结果
- **And** 不显示“任务已完成”
- **And** 会话进入可恢复的不完整状态
- **And** 用户可以继续该任务

## 4. 功能需求

### FR-1：模型身份和兼容档案必须独立

1. 模型身份继续由 `providerKey + modelId` 决定。
2. `runtimeProfile` 只影响 transport、thinking 和 replay，不改变 Provider/model 引用。
3. 自定义模型、套餐模型和内置模型即使 ID 相同，也必须分别保留。
4. OpenClaw 配置和 UI 使用同一套模型身份规则。

### FR-2：建立集中、可测试的 K3 profile resolver

解析优先级：

1. 所有 K3 profile 必须先满足最终 model-level
   `api=openai-completions`；不满足时 fail closed。
2. 套餐模型：只使用服务端返回且通过白名单校验的 `runtimeProfile`，并要求
   `apiFormat=openai`。
3. 内置或自定义模型：规范化后的模型 ID 精确等于 `kimik3` 时自动启用。
4. `my-kimi-prod` 等别名不启用，也不提供显式覆盖。
5. 其他情况：不猜测。

resolver 输入必须包含最终 `providerId`、`modelId`、`api` 和模型来源，不能只
接收模型名称。

规范化只用于判断等价身份：

```text
trim -> lowercase -> 删除非字母数字字符
```

不能用包含匹配或前缀匹配。

### FR-3：补齐模型元数据

用户模型配置增加：

- `supportsVideo?: boolean`
- `maxTokens?: number`

套餐模型元数据增加：

- `runtimeProfile?: ModelRuntimeProfile`
- `supportsVideo?: boolean`
- `maxTokens?: number`
- `supportsToolCalling?: boolean`
- `agenticReady?: boolean`

其中：

- `supportsToolCalling` 表示供应商声明的能力；
- `agenticReady` 表示 LobsterAI 已完成真实端到端验证；
- 两者不能合并为同一个字段。

### FR-4：内置 Moonshot 目录与迁移

1. 在 Moonshot `defaultModels` 首位加入 Kimi K3。
2. 使用新的 Moonshot 最近模型迁移版本，不能复用已完成的旧 marker。
3. 当前 Moonshot 旧迁移已经使用版本 1，本次使用版本 2。
4. 同一 Provider 内按规范化 ID 去重。
5. 已有等价模型不新增、不覆盖。
6. 不把 `custom_N` 中的 K3 迁移到内置 Moonshot。
7. 不修改历史 agent、session 或 scheduled task 的 Provider/model 引用。

### FR-5：用户模型按 ID 自动识别

规则：

1. 所有内置和自定义 Provider 都使用同一条识别规则。
2. 最终 API 为 OpenAI-compatible，且模型 ID 规范化后精确等于 `kimik3` 时
   自动启用 K3 profile。
3. Anthropic API 格式不得命中。
4. 自定义别名不识别，也不提供兼容模式下拉框。
5. 非 K3 模型默认不改变。
6. 用户不能在 UI 中编辑原始 `compat` 或 `thinkingLevelMap`。

### FR-6：套餐 API 使用受控元数据契约

`/api/models/available` 的 K3 模型返回示例：

```json
{
  "modelId": "kimi-k3-YoudaoInner",
  "modelName": "Kimi K3",
  "provider": "moonshot",
  "apiFormat": "openai",
  "runtimeProfile": "moonshot-kimi-k3",
  "supportsImage": true,
  "supportsVideo": true,
  "supportsThinking": true,
  "supportsToolCalling": true,
  "agenticReady": false,
  "contextWindow": 1048576,
  "maxTokens": 8192
}
```

客户端要求：

1. 所有新字段在 startup warmup、`auth:getModels`、main cache、preload 类型、renderer 映射中完整传递。
2. 元数据序列化必须包含这些字段，否则服务端更新不能触发 config sync。
3. K3 profile 的官方字段以客户端 profile registry 为最终值；服务端数值不能覆盖 K3 固定配置。
4. 未知 profile 忽略并 warning。
5. 套餐模型启动新 Run 前必须存在当前进程已认证、已刷新过的精确 metadata；缺失时先刷新一次，仍失败则拒绝 Run。
6. metadata 更新只影响下一次 turn，不热切换正在执行的请求。

服务端兼容门禁：

1. 新客户端在模型目录请求和套餐推理请求中发送受控 capability
   `kimi-k3-agentic-v1`；该 capability 不是鉴权凭据。
2. 未携带 capability 的旧客户端不能仅靠 `agenticReady=false` 保护，因为旧版本
   会忽略未知字段。服务端必须不向其返回套餐 K3。
3. 即使旧客户端持有缓存模型 ID，套餐推理接口也必须拒绝该客户端发起 K3
   请求，不能把它降级成普通 OpenAI-compatible 模型。
4. capability、客户端版本门槛和 `agenticReady` 三者都满足后，服务端才允许新
   K3 Run。
5. capability 的 header/请求字段名称使用共享常量，并加入服务端契约测试；
   具体载体沿用现有版本或能力上报通道，不新建可伪装成鉴权的机制。

### FR-7：OpenClaw 配置必须写入模型层 transport metadata

`openclawConfigSync.ts` 的 Provider Model 类型增加：

- `thinkingLevelMap`
- `compat`

K3 profile 必须写到：

```text
models.providers.<provider>.models[]
```

不能写到：

```text
agents.defaults.models.<ref>.params.extra_body
```

`customParams` 继续只用于请求体参数。

OpenClaw `v2026.6.1` 的 TypeScript model type 虽然已有
`thinkingLevelMap`，严格 Zod `ModelDefinitionSchema` 尚未接受该字段；仅修改
LobsterAI 输出会导致 Gateway 拒绝配置。本次版本 patch 必须同时补齐：

1. `thinkingLevelMap` 的配置 Schema；
2. `lobsterai-model-compat` 的 `ModelApi` 枚举与 Schema；
3. config parse、public schema 和 Gateway startup 测试。

生成配置在构建测试中通过不等于可发布；打包后的 Gateway 必须真实加载这份
配置并达到 ready。

### FR-8：兼容插件必须按精确模型守卫

`lobsterai-model-compat` 使用完整模型引用映射：

```json
{
  "modelProfiles": {
    "custom_0/my-kimi-prod": "moonshot-kimi-k3",
    "lobsterai-server/kimi-k3-YoudaoInner": "moonshot-kimi-k3"
  }
}
```

要求：

1. 只接受已知 profile 枚举。
2. 模型引用必须精确匹配。
3. 非映射模型不修改 payload、stream、replay 或 tool schema。
4. 插件不得读取或记录 API Key、Token、完整 prompt 或完整 reasoning。
5. 插件配置变化进入 OpenClaw 配置影响分类，不能造成 gateway 重启循环。
6. Provider 聚合规则必须确定：无 K3 时保留原 Provider API；包含至少一个 K3
   时 Provider API 设为 compat owner，并为每个 model 写出显式真实 API。
7. K3 model-level API 不是 `openai-completions` 时拒绝生成；非 K3 模型按自身
   API 委托。
8. 同一 Provider 中模型顺序变化不能改变 owner 选择或最终 transport。

### FR-9：K3 请求必须符合官方协议

对已解析为 K3 的请求：

1. 顶层发送 `reasoning_effort: "max"`；K3 始终开启思考，OpenClaw 的
   `off -> null` 映射只用于防止通用层发送无效的关闭值，不能关闭 K3 思考。
2. 删除 K2.x 的 `thinking`。
3. 删除 camelCase `reasoningEffort`。
4. 删除 K3 不支持的采样字段。
5. 不请求流式 usage。
6. 使用 `max_tokens`，不使用 `max_completion_tokens`。
7. 保持 `tool_choice=auto|none|required` 语义。
8. 纯文本 content 按 K3 兼容要求序列化为字符串。
9. 图片或视频 content 保持对象数组，不能被错误字符串化。

### FR-10：K3 多轮回放和工具 ID

1. 保存流式 `delta.reasoning_content`。
2. 保存完整 assistant `tool_calls`。
3. 下一轮回放完整 assistant message，而不是只回放 `content`。
4. 工具结果保留原始 `tool_call_id` 配对。
5. 复用 OpenClaw `#110518` 的重复工具调用 ID 修复。
6. 跨 Provider 或切换模型时，不盲目回放 K3 专用 reasoning。
7. 不从普通文本合成 reasoning 或伪造工具调用。

### FR-11：K3 profile 保留字段不能被 `customParams` 覆盖

对 K3 profile，下列类别由 runtime 管理：

- thinking / reasoning effort；
- token 上限字段；
- streaming usage；
- K3 不支持的采样参数。

处理规则：

1. 新建或编辑模型时，如果 `customParams` 包含冲突 key，表单阻止保存并列出 key。
2. 旧配置中已有冲突 key 时，配置同步过滤这些 key，并只记录 key 名 warning。
3. 非冲突自定义参数继续透传。
4. 过滤逻辑使用集中常量和测试，不在多处维护裸字符串。

### FR-12：修正不完整终止语义

新增集中终止原因常量并处理：

| 终止原因 | LobsterAI 行为 |
|---|---|
| 正常 stop / 完整结束 | `completed` |
| `toolUse` / `tool_use` | 保持 `running`，等待工具及续轮 |
| `length` | 保留部分结果，标记截断，不得 `completed` |
| `error` | `error` |
| 异常 SSE EOF / 缺失终止包 | `error` |
| 用户主动停止 | 沿用现有停止语义 |

首版可以继续使用现有 session `error` 状态承载不完整结果，但消息 metadata 必须包含：

```ts
{
  isFinal: true,
  isTruncated: true,
  stopReason: 'length',
}
```

同时插入用户可见的中英文系统提示，说明部分内容已保留、任务未确认完成，可以继续。

不允许用“零工具调用”作为所有回复的通用失败条件。普通聊天在 `tool_choice=auto` 下可以合法无工具；只有明确 `tool_choice=required` 却没有结构化工具调用时，才属于协议失败。

### FR-13：套餐 K3 必须可灰度、可关闭

1. 服务端先下发 `runtimeProfile`，但保持 `agenticReady=false`。
2. 客户端完整支持后，内部账号先启用。
3. 通过真实 Agent 矩阵后，服务端分批设置 `agenticReady=true`。
4. 紧急情况下，服务端可以立即设置 `agenticReady=false` 或隐藏模型。
5. 关闭后阻止新 Run，但不删除用户会话、不清除模型选择、不终止已在执行的 Run。

### FR-14：日志与安全

只允许记录：

- profile 名称；
- Provider/model 引用；
- 请求中关键字段是否存在；
- tool 数量；
- reasoning/text 长度；
- stop reason；
- HTTP 状态和脱敏错误摘要。

禁止记录：

- API Key；
- 套餐 Token；
- 完整请求正文；
- 完整 prompt；
- 完整 `reasoning_content`；
- 工具结果中的敏感文件内容。

K3 profile 不能改变工具权限、审批、sandbox、cwd 或工具集合。

## 5. 实现方案

### 5.1 共享类型与 Profile Registry

新增：

```text
src/shared/providers/modelRuntimeProfiles.ts
```

该模块包含：

1. `ModelRuntimeProfile`
2. K3 官方 profile 常量
3. K3 保留请求字段常量
4. 模型 ID 规范化函数
5. `resolveModelRuntimeProfile()`，输入模型身份和最终 transport
6. 服务端 profile 白名单解析函数

`src/shared/providers/types.ts` 和 Provider registry 的模型结构补充新字段。main、renderer 和 tests 均从共享模块导入值对象与类型，不复制字符串。

### 5.2 Profile 解析数据流

```text
内置/用户 ProviderConfig.models[]
                │
       resolveDescriptor / transport
                │
                ├─ final providerId / modelId
                └─ final api / source
                │
                ▼
      resolveModelRuntimeProfile()
                │
                ├─ 规范化后精确 kimi-k3 自动识别
                ├─ 任意别名不识别
                └─ 非 OpenAI Completions fail closed
                │
                ▼
       buildProviderSelection()
                │
                ├─ 展开 OpenClaw model compat
                ├─ 收集 modelProfiles 插件配置
                └─ 保持 provider/model 引用
```

套餐路径：

```text
/api/models/available
          │
          ▼
startupCacheWarmup / auth:getModels
          │
          ▼
updateServerModelMetadata()
          │
          ├─ 白名单校验 runtimeProfile
          ├─ 记录 agenticReady/tool capability
          └─ metadata 变化触发 config sync
          │
          ▼
lobsterai-server provider + modelProfiles
```

### 5.3 内置 Moonshot K3 与配置迁移

`src/shared/providers/constants.ts` 增加：

```ts
{
  id: 'kimi-k3',
  name: 'Kimi K3',
  supportsImage: true,
  supportsVideo: true,
  supportsThinking: true,
  contextWindow: 1_048_576,
  maxTokens: 8_192,
}
```

`src/renderer/services/config.ts`：

1. 在 `RECENT_PROVIDER_MODEL_MIGRATIONS` 中增加 Moonshot version 2。
2. 复用现有规范化身份去重。
3. 已有等价 K3 时不插入 canonical duplicate。
4. profile resolver 对等价 ID 生效，但不强制改写用户保存的原始 ID。
5. 新安装用户从默认配置直接获得 K3；老用户通过一次性迁移获得。

### 5.4 自定义模型 UI 与持久化

`Settings.tsx` 和 `ModelSettingsSection.tsx` 不增加兼容模式状态或选择器。

UI 行为：

1. 模型 ID 和最终 API 格式满足 K3 规则时自动应用 profile。
2. 模型编辑框不显示“兼容模式 / Compatibility Mode”。
3. 历史 `compatibilityMode` 在配置归一化时移除，不能覆盖 ID 识别结果。
4. K3 冲突 `customParams` 阻止保存。
5. K3 自动参数提示进入 renderer i18n 的中英文词典。

### 5.5 套餐元数据传递

需要同步修改所有套餐模型入口：

1. `startupCacheWarmup.ts`
2. `main.ts` 的 `auth:getModels`
3. `claudeSettings.ts` 的 `ServerModelMetadata`
4. metadata cache 序列化与相等性判断
5. `electron.d.ts`
6. `auth.ts`
7. `modelSlice.ts`

必须保证：

- 首次启动 warmup 与登录后 `auth:getModels` 使用同一结构；
- profile 或 `agenticReady` 变化会触发 config sync；
- UI 状态和 OpenClaw catalog 不会出现两套不同结果；
- 无 metadata 的套餐模型不能启动新 Run。
- 新客户端通过现有服务请求通道上报 `kimi-k3-agentic-v1`；
- 服务端对未上报 capability 的旧客户端隐藏并拒绝套餐 K3。

### 5.6 OpenClaw 配置生成

扩展 `OpenClawProviderSelection`：

```ts
export const OpenClawApiOwner = {
  LobsterAIModelCompat: 'lobsterai-model-compat',
} as const;

type OpenClawProviderApi =
  | OpenClawBuiltInProviderApi
  | typeof OpenClawApiOwner.LobsterAIModelCompat;

type OpenClawModelCompat = {
  maxTokensField?: 'max_tokens';
  supportsUsageInStreaming?: boolean;
  requiresStringContent?: boolean;
  supportsReasoningEffort?: boolean;
  supportedReasoningEfforts?: string[];
};

type OpenClawThinkingLevelMap = Record<string, string | null>;
```

`OpenClawApiOwner.LobsterAIModelCompat` 必须同时存在于 LobsterAI 类型和当前
OpenClaw runtime 的 `MODEL_APIS` / Zod Schema 中，并由契约测试保证两侧一致。
不能只用 TypeScript 类型断言绕过 runtime 校验。

直连输出示例：

```json
{
  "models": {
    "providers": {
      "moonshot": {
        "baseUrl": "https://api.moonshot.cn/v1",
        "api": "openai-completions",
        "models": [{
          "id": "kimi-k3",
          "name": "Kimi K3",
          "api": "openai-completions",
          "reasoning": true,
          "input": ["text", "image", "video"],
          "contextWindow": 1048576,
          "maxTokens": 8192,
          "thinkingLevelMap": {
            "off": null,
            "minimal": "max",
            "low": "max",
            "medium": "max",
            "high": "max",
            "xhigh": "max",
            "max": "max"
          },
          "compat": {
            "maxTokensField": "max_tokens",
            "supportsUsageInStreaming": false,
            "requiresStringContent": true,
            "supportsReasoningEffort": true,
            "supportedReasoningEfforts": [
              "minimal",
              "low",
              "medium",
              "high",
              "xhigh",
              "max"
            ]
          }
        }]
      }
    }
  }
}
```

套餐输出保持原始引用：

```json
{
  "models": {
    "providers": {
      "lobsterai-server": {
        "baseUrl": "http://127.0.0.1:<proxy-port>/v1",
        "api": "lobsterai-model-compat",
        "models": [{
          "id": "kimi-k3-YoudaoInner",
          "name": "Kimi K3",
          "api": "openai-completions",
          "reasoning": true,
          "input": ["text", "image", "video"],
          "contextWindow": 1048576,
          "maxTokens": 8192,
          "thinkingLevelMap": {
            "off": null,
            "minimal": "max",
            "low": "max",
            "medium": "max",
            "high": "max",
            "xhigh": "max",
            "max": "max"
          },
          "compat": {
            "maxTokensField": "max_tokens",
            "supportsUsageInStreaming": false,
            "requiresStringContent": true,
            "supportsReasoningEffort": true,
            "supportedReasoningEfforts": [
              "minimal",
              "low",
              "medium",
              "high",
              "xhigh",
              "max"
            ]
          }
        }]
      }
    }
  },
  "plugins": {
    "entries": {
      "lobsterai-model-compat": {
        "enabled": true,
        "config": {
          "modelProfiles": {
            "lobsterai-server/kimi-k3-YoudaoInner": "moonshot-kimi-k3"
          }
        }
      }
    }
  }
}
```

当一个自定义或套餐 Provider 同时包含 K3 和其他模型时：

1. Provider 层 `api` 可以使用 `lobsterai-model-compat` 作为插件 owner。
2. 每个 model 层继续保留真实 transport `api`。
3. 插件只修改 `modelProfiles` 中精确命中的模型。
4. 非 K3 模型的最终请求和回放必须与改动前一致。
5. LobsterAI 本地类型只加入该受控 owner 常量，不能把
   `OpenClawProviderApi` 放宽为任意字符串。

Provider merge 使用与输入顺序无关的确定性规则：

1. 先解析并收集该 Provider 的全部 model-level API 与 runtime profile。
2. 没有 K3 profile 时，沿用现有 Provider API 聚合结果。
3. 存在至少一个 K3 profile 时，所有 K3 model-level API 必须为
   `openai-completions`；否则整个 K3 配置 fail closed。
4. 校验通过后，Provider API 设为 compat owner，并为每个模型写出显式
   model-level API。
5. 非 K3 模型继续委托各自 API；模型排序、默认模型变化和目录刷新不能改变该
   决策。

`plugins.allow` 同步加入该本地扩展，且保留现有 allowlist 语义。

### 5.7 `lobsterai-model-compat` 本地扩展

新增目录：

```text
openclaw-extensions/lobsterai-model-compat/
├── index.ts
├── openclaw.plugin.json
└── package.json
```

manifest：

1. 声明固定插件 ID。
2. 声明严格 `configSchema`：
   - 只允许 `modelProfiles`；
   - key 必须是完整模型引用；
   - value 必须是 profile 白名单；
   - `additionalProperties: false`。
3. 不声明工具，不改变工具 inventory。

runtime：

1. 注册 ID 为 `lobsterai-model-compat` 的 API owner。
2. owner 根据 model-level `api` 委托真实 transport，禁止递归委托自身。
3. 为 `lobsterai-server` 提供 hook alias。
4. 为配置中使用本插件作为 `api` owner 的 `custom_N` 提供同样 hook。
5. 从插件配置建立不可变精确映射。
6. 对 K3 调用上游共享 wrapper 和 replay policy。
7. 对其他模型返回 `undefined` 或等价 passthrough。

如果目标 OpenClaw 没有公开可复用的 K3 SDK helper，版本 patch 只负责把上游实现暴露为稳定的 plugin-sdk 导出；本地扩展不得复制整套 K3 逻辑。

### 5.8 OpenClaw 版本限定 Patch

本次基于 `v2026.6.1` 的默认交付建议拆分为可审阅的小 patch：

```text
scripts/patches/v2026.6.1/
├── openclaw-kimi-k3-support.patch
├── openclaw-openai-compatible-replay-errors.patch
├── openclaw-repeated-tool-call-id.patch
└── openclaw-lobsterai-model-compat-api.patch
```

要求：

1. 语义对齐上游已合并 PR，不盲目复制冲突代码。
2. `openclaw-kimi-k3-support.patch` 必须包含 K3 wrapper、replay、官方 profile
   所需字段及 `thinkingLevelMap` Zod Schema；不能只加入模型目录。
3. `openclaw-lobsterai-model-compat-api.patch` 只加入受控 API owner、必要的
   plugin-sdk 导出和配置校验，不放宽为任意 API 字符串。
4. 每个 patch 有对应的 patch decision / behavior test。
5. OpenClaw targeted tests 至少覆盖：
   - 完整 K3 配置通过严格解析；
   - 非法 `thinkingLevelMap` key/type 或未知 API owner 被拒绝；
   - 本地 compat owner 能被插件加载；
   - Gateway 使用生成配置成功达到 ready。
6. `apply-openclaw-patches.cjs` 可重复执行。
7. sibling OpenClaw checkout 中不能保留未转成 patch 的手工修改。
8. 升级到包含修复的稳定版本时删除已上游化 patch，并保留
   LobsterAI-specific API owner patch，直到上游提供等价的动态插件 API
   Schema。

尚未合并的 `#110138` 不作为必选依赖。只有真实测试证明 K3 因 `anyOf` / `oneOf` 等 Schema 返回明确错误时，才增加 K3 profile 限定的最小规范化，并满足：

- 不扩大参数权限；
- 不删除 `required`、类型或审批相关约束；
- 无法安全转换时禁用该工具并报告兼容错误；
- 不影响其他 Provider。

### 5.9 Token Proxy 边界

`openclawTokenProxy.ts` 保持：

- 套餐鉴权和刷新；
- 目标 URL 路由；
- 向 LobsterAI 套餐服务附加客户端版本和
  `kimi-k3-agentic-v1` capability header；
- 请求和流式响应透明转发；
- 现有 SSE 终包与异常 EOF 检查；
- 脱敏错误传播。

capability header 由本地固定常量生成，不从 OpenClaw 请求或用户
`customParams` 读取；它只用于服务端版本/能力门禁，不替代 Bearer 鉴权。

禁止在 Token Proxy 中：

- 根据模型名全局改写请求；
- 把套餐 Provider 伪装成 Moonshot；
- 重写工具 Schema；
- 保存 reasoning；
- 改变工具调用 ID；
- 吞掉流错误后返回正常完成。

### 5.10 运行终态

`openclawRuntimeAdapter.ts` 增加：

1. `GatewayStopReason.Length`
2. `isIncompleteStopReason()`
3. 截断消息 metadata
4. 中英文不完整提示
5. 保留 partial assistant 和已完成工具结果
6. session 不进入 `completed`

首版不自动重试 `length`，避免重复工具副作用和不可控 token 消耗。用户主动点击继续时开启新 turn。

### 5.11 配置同步与 Gateway 生效

1. profile、插件精确映射和套餐 metadata 都参与 config fingerprint。
2. 多次相同 metadata 响应不重复写配置。
3. metadata 变化通过现有 config sync/hot reload 路径生效。
4. 如果插件 owner 变化必须重启 Gateway，使用现有 config impact 分类进行一次受控重启。
5. 不在 active Run 中热切换；变化只影响下一 turn。
6. 测试必须证明不会出现 config sync 与 gateway restart 循环。

## 6. 状态与边界处理

| 场景 | 处理方式 |
|---|---|
| 任意内置或自定义 Provider + OpenAI 路由 + 等价 `kimi-k3` | 自动应用 K3 profile |
| Anthropic 路由 | 不应用 K3 OpenAI profile |
| Moonshot 已有等价 K3 | 不重复添加，保留用户配置 |
| `custom_N/kimi-k3` | 自动应用 K3 profile |
| `custom_N/<alias>` | 不猜测，按普通模型运行 |
| 历史 `compatibilityMode` | 配置归一化时移除，不影响 profile |
| 套餐 profile 未知 | 忽略、warning、禁止 Agent Run |
| 套餐 metadata 缺失 | 刷新一次，仍缺失则禁止 Run |
| 旧客户端无 K3 capability | 服务端隐藏模型并拒绝推理 |
| `supportsToolCalling=false` | 不允许作为 Agent 执行模型 |
| `agenticReady=false` | 可见但不可启动新任务 |
| customParams 与 profile 冲突 | 新配置阻止保存；旧配置过滤并 warning |
| 同 Provider 混合 K3 和普通模型 | 插件只修改精确映射 K3 |
| 自定义和套餐 K3 同 ID | 分别保留，不跨 Provider 去重 |
| 正常聊天没有工具 | 可以正常完成 |
| `tool_choice=required` 无工具调用 | 协议失败 |
| `stopReason=length` | 保留部分结果，不得完成 |
| 异常 SSE EOF | error，不得完成 |
| profile 更新发生在 active Run | 当前 Run 不变，下一 turn 生效 |
| 紧急关闭套餐 K3 | 服务端 `agenticReady=false`，阻止新 Run |

## 7. 涉及文件

### 7.1 共享与 Renderer

- `src/shared/providers/modelRuntimeProfiles.ts`（新增）
- `src/shared/providers/types.ts`
- `src/shared/providers/constants.ts`
- `src/shared/providers/index.ts`
- `src/shared/providers/constants.test.ts`
- `src/renderer/config.ts`
- `src/renderer/services/config.ts`
- `src/renderer/services/config.test.ts`
- `src/renderer/components/Settings.tsx`
- `src/renderer/components/settings/ModelSettingsSection.tsx`
- `src/renderer/services/i18n.ts`
- `src/renderer/services/auth.ts`
- `src/renderer/services/auth.test.ts`
- `src/renderer/store/slices/modelSlice.ts`
- `src/renderer/types/electron.d.ts`

### 7.2 Main Process

- `src/main/libs/claudeSettings.ts`
- `src/main/libs/startupCacheWarmup.ts`
- `src/main/main.ts`
- `src/main/libs/openclawConfigSync.ts`
- `src/main/libs/openclawConfigSync.test.ts`
- `src/main/libs/openclawConfigSync.runtime.test.ts`
- `src/main/libs/openclawConfigImpact.ts`
- `src/main/libs/openclawConfigImpact.test.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`
- `src/main/libs/openclawExtensionManifests.test.ts`
- `src/main/libs/openclawTokenProxy.ts`（补 capability header 与测试，不增加
  K3 payload 改写）

### 7.3 本地 OpenClaw 扩展与 Patch

- `openclaw-extensions/lobsterai-model-compat/index.ts`（新增）
- `openclaw-extensions/lobsterai-model-compat/openclaw.plugin.json`（新增）
- `openclaw-extensions/lobsterai-model-compat/package.json`（新增）
- `tests/openclaw-extensions/lobsterai-model-compat/`（新增）
- `scripts/patches/<openclaw.version>/openclaw-kimi-k3-support.patch`（按版本决定）
- `scripts/patches/<openclaw.version>/openclaw-openai-compatible-replay-errors.patch`（按版本决定）
- `scripts/patches/<openclaw.version>/openclaw-repeated-tool-call-id.patch`（按版本决定）
- `scripts/patches/<openclaw.version>/openclaw-lobsterai-model-compat-api.patch`（按版本决定）
- `src/main/libs/openclawPatches/kimiK3PatchDecisions.test.ts`（新增）

### 7.4 服务端契约

服务端仓库不在本目录，但 `/api/models/available` 需要按 FR-6 增加受控字段，
并支持 capability/客户端版本过滤、`agenticReady` 灰度和套餐推理接口的二次
拒绝门禁。

## 8. 发布、灰度与回滚

### 8.1 发布步骤

1. 服务端先支持新 metadata、客户端 capability 门禁和推理拒绝逻辑；对未上报
   `kimi-k3-agentic-v1` 的旧客户端隐藏并拒绝套餐 K3。
2. 套餐 K3 对新客户端保持 `agenticReady=false`。
3. 客户端完成共享 profile、配置生成、本地兼容插件和失败终态。
4. 在 `v2026.6.1` patch runtime 与 `v2026.7.2-beta.3` 上运行同一套 K3 行为测试。
5. 内部账号验证：
   - 内置 Moonshot；
   - `custom_N`；
   - 套餐 K3。
6. macOS、Windows packaged runtime 各完成一次真实 smoke。
7. 套餐 K3 对内部账号设置 `agenticReady=true`。
8. 观察通过后按小流量逐步开放。
9. 发版冻结前如果出现合格稳定 OpenClaw tag，切换稳定 tag 并删除重叠 patch；否则按本文默认方案发布。

### 8.2 观察指标

按 Provider/model/profile 聚合，不记录正文：

- Run 总数；
- 有结构化工具调用的 Run 比例；
- `stopReason=length` 比例；
- `tool_choice=required` 但无工具调用次数；
- 工具参数校验错误；
- 重复 tool ID 修复次数；
- SSE 异常 EOF；
- config sync 次数；
- gateway reload/restart 次数；
- K3 Run error 比例。

### 8.3 回滚

1. 套餐服务端立即设置 `agenticReady=false` 或隐藏 K3。
2. 服务端同时拒绝套餐 K3 推理，旧客户端不能绕过客户端 UI 门禁。
3. 客户端阻止新的套餐 K3 Run，不能退化成无 profile 的普通 OpenAI-compatible 请求。
4. OpenClaw runtime 可以恢复上一固定版本并重新生成配置。
5. 回滚不删除用户自定义 K3，不重写模型 ID，不清空会话。
6. 已在执行的 Run 不做热切换。
7. Moonshot version 2 migration marker 防止回滚后再次升级时重复插入 K3。

## 9. 测试与验证计划

### 9.1 共享与配置单元测试

1. profile 白名单接受 `moonshot-kimi-k3`，拒绝未知值。
2. 内置 Provider 等价 K3 ID + OpenAI Completions 自动识别。
3. `custom_N` 等价 K3 ID + OpenAI Completions 自动识别。
4. 等价 K3 ID + Anthropic API fail closed。
5. `custom_N` 任意别名不识别。
6. K3 profile 展开值与官方配置精确一致。
7. K3 保留参数冲突被识别。

### 9.2 Renderer 迁移和 UI 测试

1. 新安装 Moonshot 只有一个 K3。
2. 老用户获得 Moonshot version 2 K3。
3. 已有 `kimi-k3` 不重复。
4. 已有 `Kimi_K3` / `kimi.k3` 不重复且不被覆盖。
5. 自定义 Provider 模型不被迁移到 Moonshot。
6. 模型编辑框不显示兼容模式。
7. 历史 compatibilityMode 被移除且不能覆盖 ID 识别。
8. 冲突 customParams 阻止保存。
9. 中英文提示完整。

### 9.3 套餐元数据测试

1. startup warmup 传递所有新字段。
2. `auth:getModels` 传递相同字段。
3. metadata 序列化包含 profile、tool capability 和 `agenticReady`。
4. profile 变化触发 config sync。
5. 相同 metadata 不触发重复 sync。
6. 未知 profile fail closed。
7. `agenticReady=false` 不允许启动 Agent Run。
8. metadata 缺失时刷新一次后给出明确错误。
9. 未上报 `kimi-k3-agentic-v1` 的旧客户端看不到套餐 K3。
10. 旧客户端使用缓存 K3 ID 发起推理时被服务端拒绝。
11. capability 已上报但 `agenticReady=false` 时仍拒绝。
12. Token Proxy 上报固定 capability 与客户端版本，且不接受请求体覆盖。

### 9.4 OpenClaw 配置快照

至少覆盖：

1. `moonshot/kimi-k3` 完整配置。
2. `custom_0/kimi-k3` 保持 Provider/model ID。
3. `custom_0/<alias>` 不产生 profile 映射。
4. `lobsterai-server/<套餐 ID>` 保持原始 ID 和 loopback Token Proxy。
5. 套餐 K3 和普通套餐模型共存。
6. 自定义 K3 与套餐 K3 同时存在且不串 Base URL/API Key。
7. `agents.defaults.models` 完整 allowlist 保持现有行为。
8. profile transport 字段不进入 `extra_body`。
9. 非冲突 customParams 正常透传。
10. `plugins.allow` 和 `plugins.entries` 正确。
11. 混合 Provider 的 K3/非 K3 排序变化不改变 API owner 或 transport。
12. 完整生成配置通过目标 OpenClaw 严格 Schema 并能启动 Gateway。

### 9.5 本地兼容插件测试

1. 未映射模型完全 passthrough。
2. API owner 对非 K3 正确委托 model-level transport。
3. model-level `api` 指回 owner 自身时拒绝加载，不发生递归。
4. 精确映射 K3 在包括历史 `off` 设置在内的场景都发送
   `reasoning_effort=max`。
5. 删除 K2 thinking 和 camelCase reasoning。
6. 不发送 streaming usage。
7. 使用 `max_tokens`。
8. 纯文本使用字符串 content。
9. 图片/视频仍使用对象数组。
10. `tool_choice=auto|none|required` 不被破坏。
11. 首轮 `reasoning_content + tool_calls` 被保存。
12. 续轮完整回放 reasoning、tools 和 tool results。
13. 重复工具 ID 不污染会话。
14. profile 配置包含未知值时拒绝加载。
15. compat owner 未进入 OpenClaw `MODEL_APIS` / Schema 时 targeted test 明确失败。

### 9.6 Runtime Adapter 测试

1. 正常 stop 仍完成。
2. `toolUse` / `tool_use` 仍保持运行。
3. `length` 保留部分文本但不完成。
4. `length` 后已完成工具结果不回滚。
5. 异常 SSE EOF 不完成。
6. 普通 auto 聊天无工具可完成。
7. required-tool 无工具调用报告协议失败。

### 9.7 真实集成矩阵

三条路径都必须执行：

| 维度 | 用例 |
|---|---|
| 路径 | 内置 Moonshot / `custom_N` / 套餐 K3 |
| 工具规模 | 1 个工具 / 当前完整约 105 个工具 |
| Schema | 普通 object / 含 `anyOf` / 含 `oneOf` |
| 轮次 | 单工具一轮 / 连续多轮工具调用 |
| 流 | streaming / 异常 EOF |
| 输入 | 纯文本 / 图片；视频仅验证 runtime 配置与协议，不验收新 UI |

执行型 smoke 必须：

1. 创建临时文件；
2. 回读并核对内容；
3. 修改文件；
4. 再次回读；
5. 轨迹中存在真实 tool lifecycle；
6. 文件系统中存在真实结果。

不能只依据最终文本或 `finalStatus=success` 判断通过。

### 9.8 构建与质量门禁

```bash
npm test -- providers
npm test -- config
npm test -- auth
npm test -- openclawConfigSync
npm test -- openclawRuntimeAdapter
npm test -- openclawExtensionManifests
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <changed-ts-files>
npm run compile:electron
npm run build
npm run openclaw:runtime:host
```

OpenClaw patch 自带的 targeted tests 也必须通过。

## 10. 验收标准

1. 新安装的 Moonshot 模型目录只有一个 Kimi K3。
2. 已有等价 K3 升级后不重复、不被覆盖。
3. `moonshot/kimi-k3` 使用用户 Moonshot Key 完成真实文件创建、修改和回读。
4. `custom_N/kimi-k3` 使用用户自定义 Key/Base URL 完成相同任务。
5. 自定义别名不应用 K3 profile，模型编辑框不存在手动兼容模式。
6. 套餐 K3 使用 `lobsterai-server/<原始 modelId>` 完成相同任务。
7. 自定义和套餐路径并存时不串 API Key、Token、Base URL 或模型引用。
8. 三条路径均正确回放 `reasoning_content + tool_calls + tool_call_id`。
9. 单工具和约 105 工具场景均产生结构化工具调用。
10. 不出现 XML 或普通文本伪工具调用被当成真实执行。
11. 重复工具调用 ID 不污染后续轮次。
12. K3 配置快照与官方 profile 一致。
13. profile 字段不进入 `extra_body`。
14. 非 K3 套餐模型请求和回放行为不变。
15. `stopReason=length` 保留部分结果但绝不显示完成。
16. 异常 SSE EOF 绝不显示完成。
17. metadata 缺失或未知 profile 时套餐 K3 fail closed。
18. `agenticReady=false` 可以立即阻止新的套餐 K3 Run。
19. 未携带 K3 capability 的旧客户端既看不到套餐 K3，也无法用缓存 ID 调用。
20. Anthropic 路由不被自动套用 K3 OpenAI profile。
21. 完整配置通过打包 OpenClaw 的严格 Schema，Gateway 成功达到 ready。
22. 混合 K3/非 K3 Provider 的模型排序不改变 owner 或最终 transport。
23. 配置更新不产生 Gateway 重启循环。
24. macOS、Windows packaged runtime 各通过一次真实 smoke。
25. 日志不包含凭据、完整 prompt 或完整 reasoning。

## 11. 风险与后续项

### 11.1 Beta 与 Patch 漂移

在旧版本回补上游修复会产生维护成本。通过行为测试和 patch decision tests 锁定语义；第一个合格稳定版发布后优先删除补丁。

### 11.2 插件 Owner 覆盖混合 Provider

自定义或套餐 Provider 可能同时包含多种模型。插件必须用完整模型引用精确守卫，非 K3 passthrough 是硬性回归门禁。

### 11.3 8192 输出截断

> 2026-09-22 更新：见 §2.3 的更新说明，上限已改为 1048576，本节保留为历史记录。

本期遵循 Kimi 官方 OpenClaw 配置，不自行提高上限。如果代表性 Agent 任务仍高频达到 `length`，则本次发版不得以“提高 token 上限”静默掩盖，需要单独评估延迟、费用和官方兼容性。

### 11.4 工具 Schema 差异

`#110138` 尚未合并。只有受控矩阵复现明确 Schema 错误后才做 K3 限定规范化；不能提前引入全局 Schema 重写。

### 11.5 服务端与客户端发布顺序

旧客户端会忽略新增 metadata，所以仅设置 `agenticReady=false` 无法保护旧版本。
服务端必须先上线 capability/版本过滤和推理拒绝，再返回套餐 K3；没有
`kimi-k3-agentic-v1` 的客户端一律隐藏并拒绝。`agenticReady` 只用于通过该
能力门禁后的新客户端灰度。

### 11.6 OpenClaw 严格 Schema

`v2026.6.1` 的 runtime type 与严格 Zod Schema 不完全一致，且 `ModelApi` 是
固定枚举。若只修改 LobsterAI 配置生成，Gateway 会在启动阶段拒绝配置。因此
“打包 Gateway 真实加载并 ready”是硬性门禁，不能用 TypeScript 编译或配置
快照测试替代。

## 12. 参考资料

1. Kimi OpenClaw 指南：<https://platform.kimi.com/docs/guide/use-kimi-in-openclaw>
2. Kimi K3 模型与工具调用：<https://platform.kimi.com/docs/guide/kimi-k3-quickstart>
3. OpenClaw PR `#109202`：<https://github.com/openclaw/openclaw/pull/109202>
4. OpenClaw PR `#109556`：<https://github.com/openclaw/openclaw/pull/109556>
5. OpenClaw PR `#110518`：<https://github.com/openclaw/openclaw/pull/110518>
6. OpenClaw PR `#110138`：<https://github.com/openclaw/openclaw/pull/110138>
7. OpenClaw `v2026.7.2-beta.3`：
   <https://github.com/openclaw/openclaw/releases/tag/v2026.7.2-beta.3>
8. `specs/features/model-custom-params/2026-05-19-model-custom-params-design.md`
9. `specs/bugfixes/openclaw-model-allowlist-switch/2026-05-22-openclaw-model-allowlist-switch-fix-design.md`
10. `specs/bugfixes/deepseek-mimo-reasoning-content-replay/2026-05-16-deepseek-mimo-reasoning-content-replay-design.md`
11. `specs/refactors/openclaw-upgrade/2026-06-16-openclaw-2026-6-1-upgrade.md`
