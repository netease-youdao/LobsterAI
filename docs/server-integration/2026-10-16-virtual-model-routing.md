# 快速 / 旗舰统一模型目录与会话路由

## 评估与变更

方案可行。原实现将模式与普通模型分成两个目录，并只在桌面聊天中保存实际模型，导致 Agent 和定时任务无法共用。现在统一目录和配置存储，保留运行前的服务端解析步骤：

- `yd-fast` 对应 `balanced`（快速），`yd-ultra` 对应 `ultimate`（旗舰）。
- `/api/models/available` 返回普通 `AvailableModelDTO` 结构，额外的 `presetId` 仅用于模式名称、图标和默认思考行为。
- Agent 的 `model`、定时任务的 `modelId` 正常保存 `lobsterai-server/yd-fast` 或 `lobsterai-server/yd-ultra`，不在保存时抽取实际模型。
- 开始执行时，服务端按现有账号分组、候选权重、权限、忙碌状态和图片能力选择模型；结果写入数据库。
- 唯一绑定范围为 `user_id + enterprise_id + session_id + preset_id`。个人账号的 `enterprise_id=0`。重试、服务重启、候选权重调整不会重新选择；并发首次请求以数据库唯一键的获胜记录为准。
- 已绑定模型停用、不可访问或不能处理新增图片时返回错误，不静默替换。切换另一模式使用该模式的独立绑定，切换回来复用原绑定。

运行前解析保留了真实模型的 API 格式、思考配置及运行时能力，支持 OpenAI 和 Anthropic 候选模型混用。虚拟模型不能直接作为上游模型 ID 使用；调用方必须先解析，然后按返回的 `apiFormat` 走原有代理接口。

## 接口

### `GET /api/models/available`

请求头：

```http
Authorization: Bearer <accessToken>
X-LobsterAI-Client-Capabilities: virtual-models-v1,thinking-level-control-v1,kimi-k3-agentic-v1
```

示例（其余普通模型紧随其后，保持服务端排序）：

```json
{
  "code": 0,
  "message": "success",
  "data": [
    {
      "modelId": "yd-fast",
      "modelName": "快速",
      "presetId": "balanced",
      "provider": "LobsterAI",
      "apiFormat": "openai",
      "supportsImage": true,
      "supportsThinking": true,
      "supportsToolCalling": true,
      "agenticReady": true,
      "contextWindow": 400000,
      "costMultiplier": 0.65,
      "accessible": true,
      "moreModel": false,
      "requestCapabilities": []
    }
  ]
}
```

`apiFormat` 在虚拟条目中只是目录占位；运行协议以解析结果为准。`supportsImage` 表示至少有一个可用图片候选，首次带图运行会筛选；绑定后不得因图片而改选模型。展示倍率不参与实际扣费。模式不提供思考强度选择器，使用实际模型默认配置。

未携带 `virtual-models-v1` 的旧客户端仍获取普通模型目录，避免与旧的独立预设列表重复。

### `POST /api/models/{modelId}/resolve`

`modelId` 为 `yd-fast` 或 `yd-ultra`。认证和能力请求头与模型目录相同；企业账号沿用现有企业上下文请求头。账号和人群由服务端认证上下文决定，客户端不能指定。

```json
{"sessionId":"b7f8e740-6079-4ca8-8d92-9b49eef4b6b4","requiresImage":false}
```

`sessionId` 必填，允许 1–128 个英文字母、数字、`_ . : -`。同一会话必须复用同一值，不可每个请求重新生成。

成功返回真实 `AvailableModelDTO`，例如：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "modelId": "deepseek-flash",
    "modelName": "DeepSeek Flash",
    "provider": "LobsterAI",
    "presetId": "balanced",
    "apiFormat": "openai",
    "contextWindow": 400000,
    "accessible": true
  }
}
```

上例为结构示例，不代表当前候选配置。未登录、无权限、模式停用或绑定模型不可用均沿用现有业务错误响应。旧的 `/api/model-presets/{presetId}/resolve` 保留，并复用同一数据库绑定。

## 客户端改动

1. 目录只从 `/api/models/available` 加载；Agent、定时任务和聊天选择器共用这些条目，保留服务端顺序及权限提示。
2. 配置保存普通 provider/model 引用；修改 Agent 模型时清除旧的独立模式偏好。
3. 桌面新对话继续在启动前解析，持久化 `modelPresetId + modelOverride`，续聊沿用实际模型。
4. 新增本地 OpenClaw 扩展 `lobster-model-routing`：在 `before_model_resolve` 中只处理 `lobsterai-server/yd-fast|yd-ultra`。原生定时任务、IM 和显式使用虚拟模型的子任务通过经过鉴权的 loopback token proxy 调用解析接口。会话身份来自 OpenClaw 的 `ctx.sessionId`，不使用全局“当前聊天”。普通模型的子任务保持原路由。
5. 扩展覆盖运行中的 provider/model 后，OpenClaw 按真实模型协议请求代理。服务端权限、供应商 fallback、用量和计费逻辑保持按真实模型执行。
6. 模型选择/配置展示“快速 / 旗舰”；消息底部展示如“快速（deepseek-flash）”，原生任务的模型元数据与用量显示实际模型。不得将 `yd-fast`、`yd-ultra` 当作执行结果展示。没有真实模型元数据时不伪造实际模型名称；消息标签会抑制虚拟 ID。

## 上线顺序与限制

1. 执行 Server `sql/V124__model_preset_session_bindings.sql`。新表使用 BIGINT 主键和数字模型关联，无外键、无过期时间，不进行跨表字符串比较。
2. 预设基础表及 `context_window` 必须已存在，相关旧迁移为 V102 模式表、V103 人群、V123 上下文窗口；模式用量字段沿用 V122。2026-10-16 只读检查发现生产环境没有 `model_presets`，不能只部署 V124。旧迁移的字符串/组合主键需按生产发布平台的主键规则另行整理上线，本次未改写已部署的历史迁移。
3. 部署 Server，再发布客户端。新客户端依赖新增解析接口。旧客户端模型目录由能力标识隔离。
4. 客户端打包必须包含新扩展；现有 `openclaw:extensions:local` / `openclaw:precompile` 流程会复制、编译它，配置同步会启用插件并加入 allowlist。仅更新 renderer 无法让旧 runtime 获得原生任务解析能力。
5. 本次只增加迁移文件，没有执行生产或共享测试数据库写入，没有提交、推送或部署。

## 验证边界

按项目约定执行构建和 lint，没有启动 dev server、浏览器或 Electron 交互验证。服务端回归覆盖目录兼容、会话复用、并发赢家回读、账号隔离、权限变化和生产 MyBatis factory 下的绑定读写；H2 覆盖不是生产 MySQL 实际执行证据。全量构建中的既有环境测试因 MySQL 连接失败而无法完成，编译与本次相关测试需独立记录结果。

最终验证记录：

- Server：JDK 17 下 `./gradlew test --tests '*ModelPreset*' --tests '*ModelControllerCapabilityTest' --tests '*ModelControllerEnterpriseTest' --tests '*ModelPromotionAccessTest' build` 通过，50 项测试、0 失败；`./gradlew build -x test` 通过。
- 未过滤的 `./gradlew build` 在既有 `DepartmentPermissionOvermindConfigTest`、`DepartmentUsageMapperTest`、`FreeCreditMapperTest` 中反复遇到 MySQL `CommunicationsException / EOFException`，已中止，不能标记全量测试通过。
- Client：Node 24.15.0，`npm run build`、`npm run compile:electron`、改动文件 ESLint 均通过；新增扩展已用现有 esbuild 配置编译到本地 runtime。
- 全量 `npm run lint` 未通过：53 个既有导入/导出排序错误和 1 个未使用变量警告，涉及 `src/main/im/imChatHandler.ts`、`src/main/im/qqMediaDownload.ts`、`src/scheduledTask/policies/types.ts` 等未修改文件。未进行全仓库自动修复。
