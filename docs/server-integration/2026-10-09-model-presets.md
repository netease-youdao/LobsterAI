# 均衡 / 极致模型模式接入（2026-10-09）

## 变更摘要

新增两个模式：`balanced`（均衡）、`ultimate`（极致）。模式通过候选模型的非负整数权重选择真实文本模型。展示倍率仅用于 UI，真实模型列表、代理请求和计费契约保持原样，调用仍按真实模型扣费。

数据库迁移依次为 server 的 `sql/V102__model_presets.sql`、`sql/V103__model_preset_audiences.sql`。`model_presets` 以 `(audience, preset_id)` 独立存储两个人群的均衡 / 极致配置；候选表以 `(audience, preset_id, model_pricing_id)` 关联现有模型，无外键。全新安装的四个配置均无候选、未启用，均衡 / 极致展示倍率分别为 0.65、1.20。升级会保留原有开关和倍率，并按供应商将已有候选分入对应人群，保留其权重和顺序。

## 接口、认证与示例

所有接口使用 `{ "code": 0, "message": "success", "data": ... }`；业务错误为非零 `code` 和可读 `message`。

| 方法 | 路径 | 认证 / 用途 |
| --- | --- | --- |
| GET | `/api/admin/model-presets?audience=customer` | Admin IAM SSO Bearer，`models` 菜单权限；获取指定人群的两个配置 |
| PUT | `/api/admin/model-presets/{presetId}?audience=customer` | 同上；事务保存指定人群的单个模式并记录操作审计 |
| GET | `/api/model-presets/available` | 客户端 JWT Bearer，沿用当前个人 / 企业账号上下文；获取入口可用性 |
| POST | `/api/model-presets/{presetId}/resolve` | 同上；过滤候选后加权选择真实模型 |

Admin 的 `audience` 为 `customer`（C端用户可用）或 `employee`（网易员工可用），省略时默认 `customer`，非法值返回 `4000`。C端候选只能使用 `LobsterAI` 提供商，员工候选使用非 `LobsterAI` 提供商（现有员工目录为 `YoudaoInner`、`ZhiYun`），候选选择器与模型排序共用分组。每个人群的开关、倍率、候选、权重和保存操作完全独立；操作审计资源 ID 为 `customer:balanced` / `employee:balanced` 等。已有候选下线仍保留配置，执行时过滤；候选供应商变更到另一人群后需移除或重新配置。

客户端接口不接受人群覆盖参数：服务端从当前用户和 JWT 账号上下文决定。个人 OpenID 员工账号读取 `employee`，其他个人账号读取 `customer`；企业账号延续现有 `LobsterAI` 模型目录，读取 `customer`，即使登录身份是 OpenID。列表响应增加 `audience`，`presetId` 和解析请求、真实模型响应保持原契约，现有客户端无需更改调用方式。已绑定会话继续复用其真实模型，不受此配置拆分影响。

客户端两个接口携带现有 `X-LobsterAI-Client-Capabilities` 和客户端版本头（通过 `buildServerModelCapabilityHeaders`）。企业身份来自当前 JWT；不另传企业 ID。`kimi-k3-agentic-v1` 能力会参与 Kimi K3 候选兼容检查。

Admin GET 返回（示例模型 ID / 名称仅为示意）：

```json
{
  "code": 0,
  "message": "success",
  "data": [
    {
      "audience": "customer", "presetId": "balanced",
      "name": "均衡",
      "enabled": true,
      "costMultiplier": 0.65,
      "candidates": [
        { "audience": "customer", "presetId": "balanced", "modelPricingId": 3, "weight": 7, "sortOrder": 0,
          "modelId": "real-model-a", "modelName": "模型 A", "provider": "LobsterAI", "modelStatus": 1, "mediaType": null },
        { "audience": "customer", "presetId": "balanced", "modelPricingId": 7, "weight": 3, "sortOrder": 1,
          "modelId": "real-model-b", "modelName": "模型 B", "provider": "LobsterAI", "modelStatus": 1, "mediaType": null }
      ]
    },
    { "audience": "customer", "presetId": "ultimate", "name": "极致", "enabled": false, "costMultiplier": 1.2, "candidates": [] }
  ]
}
```

PUT `/api/admin/model-presets/balanced?audience=customer` 请求（员工模式使用 `?audience=employee`）：

```json
{
  "enabled": true,
  "costMultiplier": 0.65,
  "candidates": [
    { "modelPricingId": 3, "weight": 7 },
    { "modelPricingId": 7, "weight": 3 }
  ]
}
```

PUT 响应 `data` 是保存后的该模式配置。重复候选、负数 / 小数权重、非文本模型、跨人群候选、无效倍率会拒绝。启用至少需要一个模型已启用且权重大于零的候选。倍率非负，最多四位小数；权重为 0 到 2147483647 的整数。配置保存按候选提交顺序排序。

GET `/api/model-presets/available` 示例：

```json
{
  "code": 0,
  "message": "success",
  "data": [
    { "audience": "customer", "presetId": "balanced", "name": "均衡", "enabled": true,
      "costMultiplier": 0.65, "accessible": true, "supportsImage": true, "supportsThinking": true,
      "thinkingConfig": { "defaultLevel": "high", "options": [{ "level": "off", "openclawLevel": "off" }, { "level": "high", "openclawLevel": "high" }] },
      "requestCapabilities": ["lobsterai-options-v1"], "restrictionHint": null, "candidates": null },
    { "audience": "customer", "presetId": "ultimate", "name": "极致", "enabled": false,
      "costMultiplier": 1.2, "accessible": false, "supportsImage": false,
      "restrictionHint": "模型模式未启用", "candidates": null }
  ]
}
```

模式列表新增安全元数据 `supportsThinking`、`thinkingConfig`、`requestCapabilities`。统计范围只包含当前账号权限、正权重、模型状态及客户端能力过滤后的候选。只有所有有效候选都支持 thinking 才标记支持；所有候选都有合法配置且支持 `lobsterai-options-v1` 时，返回共同支持的语义档位交集（仅有 `off` 的交集不提供强度控制）。无共同档位或部分候选未配置档位时，只展示支持思考标记，解析后再使用真实模型的档位。模式列表中的 `openclawLevel` 仅供入口展示，执行必须使用解析出的真实模型映射。

均衡 / 极致入口始终展示“深度思考”标签，不显示思考强度档位、调整入口或开关。模式 KV 兼容原来的字符串偏好和对象偏好，但执行时忽略历史手动档位，首次解析、主动切换及续聊均使用真实模型的默认 thinking。已有绑定会话不能单独修改 thinking；重复选择当前模式不重新解析，也不提交 thinking 调整。

入口始终按均衡、极致排列。停用或当前账号无候选时 `accessible=false`，展示灰色入口和 `restrictionHint`。公开响应不返回候选配置。`supportsImage=true` 表示至少一个可用候选支持图片，首次发送含图片时仍需在解析请求中传 `requiresImage=true`。

POST `/api/model-presets/balanced/resolve` 请求：

```json
{ "sessionId": "客户端 SQLite 会话 UUID", "requiresImage": true }
```

响应 `data` 与 `/api/models/available` 的安全真实模型元数据相同，不含上游凭据或地址：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "modelId": "real-model-a",
    "modelName": "模型 A",
    "provider": "LobsterAI",
    "apiFormat": "openai",
    "runtimeProfile": null,
    "supportsImage": true,
    "supportsThinking": true,
    "thinkingConfig": { "defaultLevel": "medium", "options": [{ "level": "medium", "openclawLevel": "medium" }] },
    "requestCapabilities": ["lobsterai-options-v1"],
    "accessible": true
  }
}
```

元数据其余字段沿用真实模型可用列表，包括上下文窗口、工具能力、模型描述及真实模型的 `costMultiplier`。解析响应倍率属于真实模型；模式入口的展示倍率只读取模式列表。

解析先按当前账号权限、模型启用状态、文本 API 格式、客户端运行时能力、图片要求过滤，再按剩余正权重归一化随机选择。无候选或模式停用返回 `40300`，配置非法返回 `4000`。`sessionId` 必填且最多 128 字符；它用于客户端绑定身份，server 不保存会话粘性。重复调用 resolve 可以重新抽取，因此续聊不能重复调用此接口。

## 选模责任与兼容性

- Server 负责配置、账号 / 能力过滤及单次权重选择；代理始终接收真实 `modelId`。
- Electron 主进程首次发送前解析并持久化 `model_preset_id`、真实 `model_override` 和有效 thinking。未指定档位时使用真实模型默认值；用户显式选择的合法档位在续聊、重试、重启时保留。入口按有效候选展示思考能力和共同档位，绑定后展示真实模型档位，调整 thinking 不重新选择模型。
- 手动切换先解析并成功 `sessions.patch` 真实模型，再保存。失败保留本地旧选择；运行中的会话阻止改变模式绑定。相同会话的并发解析复用同一次请求。
- 调整权重、删除候选、停用模式只影响后续选择；已绑定会话继续使用仍有效的真实模型。失效模型需要用户切换，不自动换模型。
- 模式偏好按账号、agent 存到 KV；真实 Agent 默认模型继续用于原有子 agent 规则。IM 和定时任务沿用原有方式。
- 每轮消息保存模式及真实模型 ID，展示 `均衡（real-model-a）` / `极致（real-model-b）`；会话主动切换和配置变更不改历史标签。
- 旧 server 对模式接口返回 404 时仍加载普通模型列表。新接口不会向原始模型目录插入模式伪模型。

## 发布顺序

数据库迁移 V102 → V103 → server → admin → 客户端。已应用 V102 的环境仅需新增 V103；不能在旧表结构上直接发布此版本 server。全新安装默认关闭两个人群的四个配置，由 Admin 分别配置并启用；升级时沿用原有开关和倍率，并拆分候选。上线前使用实际账号确认权限、图片候选及客户端能力。此次代码实现未执行部署或线上配置。

## 客户端接入步骤与源码依据

1. `auth.ts` 并行加载普通目录、模式入口和当前账号 / agent 的偏好。模式仅在聊天模型选择器的服务端组置顶。
2. `modelPresets.ts` 主进程模块调用解析接口；SQLite 保存真实模型引用 `lobsterai-server/<modelId>`。模式逻辑 ID 为 `model-preset:balanced` / `model-preset:ultimate`，不得传给 OpenClaw 或代理。
3. 主会话用显式 override 固定真实模型，每次发送校验网关解析值；模型不一致阻止发送。均衡 / 极致不提供思考强度调整，使用解析后的真实模型默认档位；续聊 / 重试 / 重启发送前也恢复真实模型默认值，防止历史手动档位继续生效。默认配置撤销时清空网关的旧 thinking override。普通模型的有效用户档位和子 agent 的 thinking 规则继续沿用原有行为。
4. `CoworkStore.addMessage` 保存当轮模式和真实 ID，`updateMessage` 保留这些快照。标签从消息快照生成，而非实时配置或当前会话模型。
5. 原生 OpenClaw v2026.8.1 的子 agent 选模和 thinking 不修改，保持主 A → 子 B → 返回请求方 A。

核对的 OpenClaw v2026.8.1 源码位置：

- `src/agents/model-selection.ts` 的 `resolveConfiguredSubagentSpawnModelSelection` 首先读取显式 model。
- `src/agents/model-selection-config.ts` 的 `resolveSubagentConfiguredModelSelection` 依次读取目标 Agent 的 `subagents.model`、全局 `subagents.model`、目标 Agent 默认 model；前者为空时由 `resolveSubagentSpawnModelSelection` 使用全局默认 model。
- `src/agents/subagents/spawn/subagent-spawn-thinking.ts` 保留显式 thinking、配置默认、调用方继承及非法值处理；模型档位合法性仍由网关执行。
- `src/agents/subagents/announce/` 将子结果投递给 `requesterSessionKey`，不替换请求方模型 override。
- `src/agents/agent-scope.ts` 的 `resolveEffectiveModelFallbacks` 对用户显式会话 override 返回空 fallback，模式主模型不因底层失败降级为另一模型；服务端同模型供应商路由照常工作。

验收时覆盖首次选择、续聊 / 重试 / 重启、手动切换、主 A / 子 B / 返回 A、thinking 和历史标签。此次依用户要求仅运行 lint、build 和 Electron 编译，没有启动 dev server 或浏览器验收。
