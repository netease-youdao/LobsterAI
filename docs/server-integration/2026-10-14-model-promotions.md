# 模型限时免费与订阅优先接入（2026-10-14）

## 变更摘要

文本模型新增可由 Admin 配置的两个独立开关：限时免费、订阅优先。限时免费生效期间覆盖模型基础、分层、路由、分时以及缓存积分计价，实际请求不扣积分；原始定价不被改写，到期自动恢复。两者同时启用时，仅有效订阅用户可访问，活动期间不扣积分。

## 接口

### Admin 模型配置

`POST /api/admin/models` / `PUT /api/admin/models/{id}`，沿用 IAM Bearer 与模型管理权限。新增字段：

```json
{
  "limitedFree": 1,
  "limitedFreeStartAt": "2026-10-14T10:00:00",
  "limitedFreeEndAt": "2026-10-21T10:00:00",
  "subscriptionPriority": 1
}
```

开关使用 0/1。时间为北京时间（Asia/Shanghai），按 `[开始, 结束)` 生效。开启限时免费时两个时间必填且结束必须晚于开始；后端也验证部分更新，不能清空已启用活动的时间。关闭不会改写正常积分价格。原有 `freeAccess` 仅表示免费用户能否访问，并不表示不扣积分。

### 公开定价与已登录可用模型

`GET /api/models/pricing-catalog`（公开）、`GET /api/models/pricing`（同结构）及 `GET /api/models/available`（沿用 JWT / Cookie 会话认证）的文本模型新增：

```json
{
  "modelId": "example-model",
  "limitedFree": true,
  "limitedFreeActive": true,
  "limitedFreeStartAt": "2026-10-14T10:00:00+08:00",
  "limitedFreeEndAt": "2026-10-21T10:00:00+08:00",
  "subscriptionPriority": true,
  "costMultiplier": 0
}
```

`limitedFree` 是配置开关，`limitedFreeActive` 是服务端当前状态；开始/结束时间携带明确时区。公开目录中的基础积分、分层与分时费率保留原价，展示端须在生效区间显示 0，结束后恢复原费率。`costMultiplier` 在生效时返回 0。

`/available` 另返回 `accessible` 和 `restrictionHint`。订阅优先模型仅允许订阅记录 `status=active` 且当前处于 `currentPeriodStart <= now < currentPeriodEnd` 的用户使用，不依据 `currentPlanId` 单独判断。取消自动续费但仍处于有效期的用户继续可用；到期、未开始、暂停、退款取消、只有加油包或奖励积分均不授予访问权限。员工及企业请求也不能绕过订阅优先限制。

`GET /api/models/free` 排除订阅优先模型，并包含当前生效的限时免费模型。

### 实际请求与预设

`POST /api/proxy/v1/messages`、`POST /api/proxy/v1/chat/completions`继续使用现有认证与请求体。后端在转发前强制权限校验，拒绝时沿用 SSE 错误 `40301`。个人用户的限时免费模型不要求剩余积分；账户封禁、风控与企业账户原有额度准入继续生效。

请求在服务端解析模型时固定计价时点，跨活动结束时间完成的请求沿用请求接入时价格。预设的候选过滤复用 `/available` 的访问结果，不能借助均衡/极致访问受限模型；预设按最终真实模型计费。

## 前端事项

- Admin：编辑弹窗提供两个开关和北京时间开始/结束输入，前后端均校验必填及时间顺序。
- Portal：桌面及移动端定价列表从接口字段显示两个标签，可同时显示；按活动区间展示零积分，不再按 MiniMax 型号硬编码活动标签。兼容旧服务端：字段缺失则不显示活动标签。
- Electron：透传接口字段、显示两个标签和 0 倍率；每次打开选择器刷新权限与活动状态，在活动边界刷新；受限订阅优先模型引导订阅，不展示加油包优惠。
- 不要依赖客户端时间或置灰来做最终授权，服务端会在每次真实请求前检查。

## 迁移及发布顺序

1. 先执行 Server `sql/V104__model_promotions.sql`，新增字段默认关闭，无外键；已同步 `sql/schema.sql`。
2. 发布 Server，再发布 Admin、Portal、Electron。
3. 在 Admin 为需要推广的模型明确配置开关及时间；旧有零积分模型不会自动被当作限时免费活动。

本次仅准备源码与迁移 SQL，未执行线上/测试库 DDL、未部署、未提交或推送。Portal 分支从本地 main 创建，upstream 配置为远端同名 `feat/model-presets`，远端分支尚未创建。
