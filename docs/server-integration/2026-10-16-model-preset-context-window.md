# 快速 / 旗舰会话上下文窗口

## 变更摘要

Server 为快速（`balanced`）和旗舰（`ultimate`）分别增加可空 `contextWindow` 配置，按 customer/employee 隔离。NULL 使用默认 400,000 tokens，Admin 填写后直接使用设置值，设置值不得低于 400,000（400k），由 Admin 输入校验和 Server 接口共同限制。数值单位为 tokens，400k = 400,000。Admin API 保留 NULL 表示未设置，客户端 available/resolve API 返回生效数值。普通模型目录和直接选模的窗口保持不变。

## 接口与认证

沿用登录态 JWT Bearer 和现有客户端能力请求头。

`GET /api/model-presets/available` 示例（仅展示相关字段）：

```json
{"code":0,"message":"success","data":[
  {"presetId":"balanced","contextWindow":800000,"accessible":true},
  {"presetId":"ultimate","contextWindow":400000,"accessible":true}
]}
```

`POST /api/model-presets/balanced/resolve` 请求不变：

```json
{"sessionId":"local-session-id","requiresImage":false}
```

响应仍为 `AvailableModelDTO`，例如 `data.modelId` 为选中的真实模型、`data.contextWindow` 为 800000；未设置返回 400000，设置后使用 Admin 的值，不再与原模型窗口取较小值。计费和代理继续使用真实模型 ID。`GET /api/models/available` 继续返回原模型窗口，不应用模式覆盖。

## 客户端接入

- 加载可用模型时同时获取模式窗口，单独缓存 `presetContextWindows`，不覆盖普通模型的 `contextWindow`。
- OpenClaw 模型配置声明原窗口（默认）以及快速、旗舰两个可选窗口；各模式使用 Admin 配置值，缺省为 400,000；原窗口仅作为直接选模的默认值。
- 模式会话在 `sessions.patch.contextWindow` 中选择 `model-preset:balanced` 或 `model-preset:ultimate`，首次发送、继续会话和重新选择模式均沿用现有 `modelPresetId`。直接选模时清除此选择。
- 本次已完成上述客户端接入，无需更改 SQLite 表或真实模型 ID。

## 发布与兼容

先执行 Server `sql/V123__model_preset_context_window.sql`，再发布 Server/Admin 和客户端。旧客户端不应用模式窗口。旧 Server 的 available 接口缺失时不生成模式窗口选项；模式读取暂时失败时保留已有模式元数据，不阻止普通模型目录加载。

必须重新构建 OpenClaw 运行时，纳入 `scripts/patches/v2026.8.1/openclaw-model-preset-context-windows.patch` 和 `scripts/patches/v2026.8.1/openclaw-model-preset-window-metadata.patch`。该补丁为内联模型配置增加原生会话窗口选项的类型与 schema 支持，并让 lobsterai-server 的快速/旗舰会话按选择的窗口执行预算、压缩和用量展示；其他模型和普通会话保留原行为。仅执行 renderer build / compile:electron 不会更新捆绑运行时。

配置刷新后，模式窗口对该模式会话的后续请求生效；候选模型仍保持会话内已选结果。直接使用 DeepSeek 的默认窗口保持原值。所有窗口设置都不能扩展上游模型的真实能力。

## 快速模式上下文选项不支持的修复

`contextWindow "model-preset:balanced" is not supported for lobsterai-server/MiniMax-M3.1-Flash-Preview` 出现在会话保存校验阶段。客户端已经正确写入 `contextWindows`，但 OpenClaw 的配置模型目录投影仅保留了标量 `contextWindow`，未传递选项和默认项；运行时配置覆盖与配置模型回退路径也存在同样遗漏。

`openclaw-model-preset-window-metadata.patch` 补齐目录生成、目录覆盖、配置模型运行时覆盖与回退的 `contextWindows` / `contextWindowDefault` 传递。保留原模型 ID 和原始窗口，直接选模继续走 `model-default`。这是独立增量补丁，已应用旧窗口补丁的源码可以继续应用，无需手动撤销旧补丁。

补丁附带 5 项回归用例，覆盖快速 400k、旗舰 Admin 自定义 2M、配置模型目录的会话校验、运行时两条解析路径及直接选模隔离。修复前隔离副本复现 4 项失败，修复后 5 项通过。

需要执行 `npm run openclaw:runtime:host` 构建包含新增补丁的运行时，再重启客户端。仅执行 `npm run build` 或 `npm run compile:electron` 不会更新正在使用的 OpenClaw 网关。本次未启动客户端或进行浏览器、视觉与交互校验。
