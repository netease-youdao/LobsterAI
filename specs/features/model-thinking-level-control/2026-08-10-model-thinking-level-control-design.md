# 模型思考强度控制设计文档

> 状态：Implemented（待生产发布）
>
> 适用范围：LobsterAI Electron、`lobsterai-server` 与 OpenClaw runtime
>
> 目标版本：`2026.8.10`

## 1. 概述

### 1.1 问题背景

套餐模型原有的 `supportsThinking` 只能表达模型是否支持思考，不能表达用户可选等级、默认等级，以及产品等级在 OpenClaw 中的运行时别名。`runtimeProfile` 用于 Kimi K3 等完整 transport 兼容档案，也不适合承载用户可选列表。

以 DeepSeek V4 Flash/Pro 为例，产品希望提供 `off`、`high`、`max` 三档，但 OpenClaw 会话控制不接受 `max`，需要以 `xhigh` 通过运行时校验。与此同时，关闭思考可能表现为“不发送 `reasoning_effort`”，server 无法区分旧客户端没有设置与新客户端明确选择 `off`。

本功能因此采用 server 下发模型级配置、LobsterAI 持久化产品等级、OpenClaw 使用运行时别名、server 在最终代理边界消费版本化选项的方案。

### 1.2 目标

1. 由 server 动态下发每个套餐模型允许的等级、默认值和 OpenClaw 映射。
2. 客户端不按 DeepSeek 型号或 `YoudaoInner` 后缀硬编码规则。
3. 会话和 Agent 均可持久化用户选择。
4. 使用版本化内部参数明确表达 `off`、`high`、`max` 等产品语义。
5. 通过客户端与模型双向能力协商控制新协议启用。
6. 保持旧客户端 DeepSeek V4 Pro/Pro Thinking 的既有行为。
7. 未登录或无套餐权限时，思考控件与模型选择保持相同的禁用状态。

### 1.3 非目标

1. 不移除或复用 `runtimeProfile`。
2. 不向用户开放任意 OpenClaw `compat`、`thinkingLevelMap` 或供应商请求 JSON。
3. 不改变套餐登录、订阅、额度、定价和可见性规则。
4. 不通过改写模型 ID、删除员工后缀或伪装 Provider 完成适配。
5. 本功能未发布过，不兼容早期 `levels: string[]` 结构。

## 2. 用户场景

### 场景 1：调整支持模型的思考强度

- **Given** 用户已登录、模型可访问且下发合法思考配置
- **When** 用户从模型详情选择思考等级
- **Then** 当前会话立即使用并持久化该等级

### 场景 2：受限模型不可修改

- **Given** 用户未登录或模型不可访问
- **When** 用户悬浮或点击模型详情
- **Then** 可以查看模型信息，但不能修改思考强度

### 场景 3：Agent 继承思考等级

- **Given** Agent 已保存模型及有效思考等级
- **When** 用户创建该 Agent 的新会话
- **Then** 新会话继承该等级；失效等级回落到模型当前默认值

### 场景 4：新旧协议兼容

- **Given** 客户端或 server 只有一侧支持新协议
- **When** 用户发起模型请求
- **Then** 客户端不发送内部选项，server 继续执行旧客户端规则

## 3. 协议设计

### 3.1 字段职责

| 字段 | 职责 |
|---|---|
| `supportsThinking` | 模型是否具备思考能力 |
| `thinkingConfig` | 用户可选产品等级、OpenClaw 映射和默认值 |
| `runtimeProfile` | 模型 transport/replay 等完整运行档案 |
| `requestCapabilities` | 当前模型接受的 LobsterAI 内部请求协议 |

只有 `supportsThinking=true` 且 `thinkingConfig` 合法时，客户端才把模型视为可调整思考强度。`thinkingConfig` 不代表套餐授权，访问控制仍使用既有字段。

### 3.2 模型元数据契约

`GET /api/models/available` 的模型对象可包含：

```json
{
  "modelId": "deepseek-v4-flash-YoudaoInner",
  "supportsThinking": true,
  "runtimeProfile": null,
  "thinkingConfig": {
    "options": [
      { "level": "off", "openclawLevel": "off" },
      { "level": "high", "openclawLevel": "high" },
      { "level": "max", "openclawLevel": "xhigh" }
    ],
    "defaultLevel": "high"
  },
  "requestCapabilities": ["lobsterai-options-v1"]
}
```

字段语义：

- `options[].level` 是 UI、SQLite、内部请求和 server 共用的产品等级。
- `options[].openclawLevel` 是该产品等级在 OpenClaw 控制面中的等级。
- `defaultLevel` 必须引用一个 `options[].level`。

产品等级允许 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；OpenClaw 等级不包含 `max`。同一配置中两侧等级都必须唯一，且产品 `off` 与 OpenClaw `off` 必须双向对应。

空选项、重复映射、未知枚举、无效默认值和仅包含 `off` 的配置均视为非法。客户端 fail closed：不显示入口，也不发送新协议参数。

### 3.3 能力协商

客户端在模型列表和代理请求中声明：

```http
X-LobsterAI-Client-Capabilities: kimi-k3-agentic-v1,thinking-level-control-v1
```

客户端只有同时满足以下条件时才发送思考选项：

1. 当前模型存在合法 `thinkingConfig`；
2. 当前模型的 `requestCapabilities` 包含 `lobsterai-options-v1`。

Capability 只表示协议能力，不是鉴权凭据，也不替代模型可访问性检查。

### 3.4 请求参数

`POST /api/proxy/v1/chat/completions` 可包含：

```json
{
  "lobsterai_options": {
    "version": 1,
    "thinking": {
      "level": "off"
    }
  }
}
```

`lobsterai_options` 是 LobsterAI 与 server 之间的内部协议，不属于上游 OpenAI 请求。server 的处理约定为：

1. 先从待转发请求中移除整个字段。
2. 校验版本、结构、客户端 capability、模型配置和等级 allowlist。
3. 将产品等级转换为当前上游兼容字段。
4. 仅转发剥离内部字段后的请求体。

思考参数优先级为：

```text
lobsterai_options.thinking.level
  > OpenClaw 生成的 thinking/reasoning_effort
  > 旧客户端兼容规则
```

显式 `off` 会关闭 thinking，并移除顶层和历史消息中的 reasoning 字段；其他允许等级会开启 thinking 并覆盖对应 effort。参数存在但版本、结构或等级非法时返回参数错误，不回落到默认值。

### 3.5 旧客户端兼容

- 未声明 `thinking-level-control-v1` 或未发送 v1 参数时，server 使用旧规则。
- `deepseek-v4-pro` 在原生 DeepSeek 和 `YoudaoInner` 路由上继续强制 `max`。
- `deepseek-v4-pro-thinking` 在原生 DeepSeek 路由上继续映射到 Pro 并强制 `max`，不作为新可配置模型暴露。
- 同名第三方路由保持原请求不变。
- `deepseek-v4-flash` 对旧客户端维持原请求体。
- 员工模型使用完整 Provider/model 元数据匹配，不删除 `YoudaoInner` 后缀。

新客户端连接旧 server 时不会获得 `lobsterai-options-v1`，因此不会发送内部字段。

## 4. 客户端与 OpenClaw 方案

### 4.1 数据流

```text
server 下发 thinkingConfig + requestCapabilities
  → LobsterAI 校验并缓存模型元数据
  → Renderer 动态展示产品等级
  → 产品等级持久化到 Agent/Session
  → sessions.patch 前映射为 openclawLevel
  → OpenClaw 执行当前 turn
  → lobsterai-model-compat 反向还原产品等级
  → 注入 lobsterai_options
  → server 消费、剥离并转换上游参数
```

### 4.2 元数据解析

`src/shared/providers/modelThinking.ts` 是等级、配置解析和双向映射的唯一数据源。Main、preload、renderer 和本地扩展共享协议常量，不复制可比较的字符串。

模型目录经过 startup warmup、main cache、preload 和 renderer store 时必须保留 `thinkingConfig` 与 `requestCapabilities`。配置变化纳入 OpenClaw 配置指纹；相同配置不产生重复同步。

### 4.3 UI 与访问控制

`ModelSelector` 根据合法配置动态展示入口，模型详情显示当前有效等级或默认等级。二级菜单兼容悬浮与点击；鼠标从模型项移动到菜单时不能提前关闭。

未登录、不可访问或未满足套餐条件时，控件不仅视觉禁用，还必须阻断 pointer 和 keyboard 更新，继续沿用原登录/订阅引导。

### 4.4 状态持久化

`cowork_sessions` 和 `agents` 使用 `thinking_level` 保存产品等级，不保存 `openclawLevel`。模型 ID 与思考等级复用同一套 Agent/会话更新路径：

- 当前会话保存自己的选择；
- Agent 保存新会话的默认选择；
- 新会话继承当前模型下仍有效的 Agent 等级；
- 历史空值或失效值在运行时解析为模型当前 `defaultLevel`。

### 4.5 OpenClaw 等级映射

配置同步根据 `options[].openclawLevel` 生成模型目录的 `thinkingLevelMap` 和 `supportedReasoningEfforts`，并把双向映射写入本地扩展的 `thinkingProfiles`。

以 `max → xhigh` 为例：

```text
SQLite: max
  → sessions.patch: xhigh
  → OpenClaw runtime: xhigh
  → local extension: max
  → lobsterai_options.thinking.level: max
```

该方案让 OpenClaw 只接触其支持的等级，同时保证 server 收到稳定的产品语义。映射来自模型元数据，不硬编码具体模型。

### 4.6 本地兼容扩展边界

`lobsterai-model-compat` 使用完整 `provider/modelId` 精确匹配 `thinkingProfiles`，只负责等级反向映射和 v1 参数注入。它不负责鉴权、额度、Provider 路由、模型 ID 归一化或任意请求字段透传；未匹配模型保持 passthrough。

该链路不依赖全局插件 registry、`activation.onStartup` 或 OpenClaw 源码 patch。

## 5. 边界、发布与回滚

### 5.1 边界情况

| 场景 | 处理方式 |
|---|---|
| `thinkingConfig` 缺失或非法 | 不显示入口，不发送 v1 参数 |
| 已保存等级不再允许 | 使用最新 `defaultLevel` |
| 未登录或模型不可访问 | 详情可见，控件禁用 |
| 新客户端连接旧 server | capability 不成立，走旧协议 |
| 旧客户端连接新 server | 忽略附加字段，server 走旧规则 |
| v1 参数非法 | server 返回参数错误，不静默降级 |
| OpenClaw 不接受产品 `max` | 使用配置的 `xhigh` 别名 |
| 员工模型带后缀 | 使用完整身份，不做名称归一化 |
| 模型配置批量变化 | 合并同步，避免连续 Gateway 重启 |

### 5.2 发布约束

1. server 必须先支持并消费 v1 参数，再发布 LobsterAI。
2. 客户端发布前必须完成所有 server 实例升级并排空旧实例，避免先从新实例获取 capability、再请求旧实例。
3. server 准备好模型配置后，先用内部账号验证 `off`、`high`、`max` 和 `max → xhigh → max`。
4. 客户端按小流量灰度，观察参数错误率和 Gateway 重启次数后扩大发布。

### 5.3 回滚

1. 优先由 server 停止下发 `thinkingConfig` 或 `lobsterai-options-v1`，关闭入口和新协议。
2. 等待客户端刷新模型目录；必要时要求重启，避免缓存 capability。
3. 新 server 兼容旧客户端，因此客户端可独立回滚。
4. 客户端发布后不能直接回滚到不认识内部字段的旧 server；必须先关闭 capability 并确认无新协议请求。

## 6. 关键涉及文件

| 模块 | 关键入口 |
|---|---|
| 共享协议 | `src/shared/providers/modelThinking.ts`、`lobsterAIRequestOptions.ts`、`modelRuntimeProfiles.ts` |
| 模型元数据 | `src/main/libs/claudeSettings.ts`、`startupCacheWarmup.ts`、`openclawConfigSync.ts` |
| 会话与持久化 | `src/main/coworkStore.ts`、`sqliteStore.ts`、`openclawRuntimeAdapter.ts` |
| Renderer | `src/renderer/components/ModelSelector.tsx`、`modelSelector/ModelThinkingMenu.tsx`、`cowork/agentModelSelection.ts` |
| 本地扩展 | `openclaw-extensions/lobsterai-model-compat/` |

## 7. 验收标准

1. 合法 `thinkingConfig` 可以稳定解析并双向映射，非法配置 fail closed。
2. 客户端只在双向 capability 成立时发送 v1 参数。
3. 未登录和不可访问模型无法修改思考强度。
4. 悬浮与点击均可稳定操作二级菜单。
5. 会话和 Agent 重载后保留有效产品等级。
6. `off` 明确关闭思考，后续 `high` 可以重新开启。
7. `max` 在 OpenClaw 中使用 `xhigh`，server 最终仍接收 `max`。
8. 公开与员工 DeepSeek V4 Flash/Pro 使用同一配置协议。
9. Pro/Pro Thinking 对旧客户端保持既有强制思考行为。
10. 新客户端连接旧 server 时不发送内部参数。
11. `lobsterai_options` 永远不转发给上游 Provider。
12. 非目标模型和无 profile 模型保持 passthrough。
13. 模型元数据变化触发一次必要同步，相同配置不重复同步。
14. 目标 Vitest、changed-file ESLint、Electron 编译和生产构建通过。
15. 测试服覆盖公开及员工模型的 `off`、`high`、`max` 真实请求。
