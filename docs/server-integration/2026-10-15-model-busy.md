# 模型繁忙不可用配置（2026-10-15）

## 变更摘要

新增独立的 `busy` 开关。`status=1, busy=1` 的文本模型仍在客户端列表显示，但不可选用；关闭开关后按原有订阅、免费和积分权限恢复。`status=0` 仍表示下架，不会因此重新显示。管理员手动控制状态，不自动根据连通性测试切换。

## 接口

### Admin 管理

- `GET /api/admin/models`：模型新增 `busy: 0 | 1`。
- `POST /api/admin/models`：创建参数支持 `busy`，默认 `0`；新模型仍默认禁用。
- `PUT /api/admin/models/{id}`：支持局部更新 `{ "busy": 1 }` 或 `{ "busy": 0 }`；省略字段保持原值，显式 `null` 或非 0/1 值返回业务错误 400。
- Header：`Authorization: Bearer <IAM access token>`，沿用模型管理权限及审计日志。
- 更新返回：`{ "code": 0, "message": "success", "data": { "id": 1, "busy": 1, "status": 1, "...": "原有模型字段" } }`。

### 客户端模型目录

`GET /api/models/available` 沿用 JWT Bearer / YID 会话 / OIDC 认证及企业账号上下文。繁忙优先于免费、限时免费和订阅权益，示例（其余原有字段省略）：

```json
{
  "code": 0,
  "message": "success",
  "data": [{
    "modelId": "example-model",
    "modelName": "Example Model",
    "provider": "LobsterAI",
    "busy": true,
    "accessible": false,
    "restrictionHint": "当前模型服务异常，暂不可用"
  }]
}
```

公开的 `GET /api/models/pricing`、`GET /api/models/pricing-catalog` 在 `textModels[]` 中新增布尔 `busy`，不需要登录。`GET /api/models/free` 不再包含繁忙模型。

### 请求与预设

OpenAI 和 Anthropic 代理入口在配额检查、路由及上游调用前拒绝繁忙模型，沿用现有 SSE 错误结构，错误码 `50304`，文案为“当前模型服务异常，暂不可用”。个人、员工、企业账号一致。已经开始的流式请求不受开关中途变更影响。

预设候选继续使用 `accessible` 筛选，自动避开繁忙模型；所有候选不可用时沿用原有预设不可用提示，不绕过模型开关。

## 部署与兼容

先执行 server 的 `sql/V105__model_busy.sql`，再发布 server，最后发布 Admin / 客户端。存量模型默认 `busy=0`；迁移无外键，不修改现有状态或价格。SQL 已提供，本次未对任何数据库执行迁移。

旧客户端虽不认识 `busy`，仍可由 `accessible=false` 禁选，服务端也会拦截；其提示可能仍是订阅提示，完整体验需更新客户端。新客户端遇到旧服务端未返回 `busy` 时按正常状态处理。

## 前端行动项

类型、公开目录、登录目录均透传 `busy`。客户端保留服务端模型顺序，不因繁忙或不可用状态重新排序。繁忙行保留原模型图标并置灰，模型名称置灰，继续展示原有“订阅优先”或“限时免费”权益标签，不再显示“繁忙不可用”行内标签；人物工作图标移入悬浮卡，客户端提示统一为“当前模型服务异常，暂不可用”。保留悬浮和键盘聚焦但禁止选用。繁忙提示使用独立弹窗，不能误导购买订阅。已有会话发送前读取最新列表的状态；服务端仍是最后拦截点。打开已登录用户的模型选择器时复用现有目录刷新。已完成本项目接入。
