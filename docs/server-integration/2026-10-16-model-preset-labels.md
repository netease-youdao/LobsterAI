# 模型预设名称与倍率展示

## 变更摘要

服务端将 `ultimate` 预设的 `name` 从“极致”改为“旗舰”，将 `balanced` 从“均衡”改为“快速”。预设 ID、倍率数值、模型选择和计费逻辑保持不变。

## 接口详情

- `GET /api/model-presets/available`，无请求体。
- Electron 使用 `Authorization: Bearer <accessToken>`；客户端能力继续通过 `X-LobsterAI-Client-Capabilities` 请求头传递。
- 响应示例（仅展示与本次变更相关的字段）：

```json
{
  "code": 0,
  "message": "success",
  "data": [
    { "presetId": "balanced", "name": "快速", "costMultiplier": 0.1 },
    { "presetId": "ultimate", "name": "旗舰", "costMultiplier": 1.05 }
  ]
}
```

管理端 `GET /api/admin/model-presets` 和 `PUT /api/admin/model-presets/{presetId}` 返回的预设名称同步更新，认证仍使用现有 Admin IAM 和模型管理权限。

## 客户端调整

- 主进程及渲染进程的中文名称使用“快速 / 旗舰”，英文使用“Fast / Flagship”。
- `balanced` 对应的模型入口和消息标签使用描边闪电图标，保留深浅色主题适配；描述同步为“快速响应，高效胜任日常工作”。
- 模型列表和提示卡片统一以前缀 `x` 展示倍率，固定保留两位小数，例如 `x0.10`、`x1.05`、`x1.00`。
- 继续使用 `balanced` / `ultimate` 识别预设，不使用显示名称作为标识。

## 认证与发布注意事项

客户端接口仍需已登录用户，无新增权限或请求字段。本次无数据库迁移、功能开关或强制发布顺序；客户端通过本地翻译展示名称，可独立更新。
