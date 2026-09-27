# ¥0.01 体验活动：公开展示与注册 7 天内领取

## Change Summary

活动有效时，Server `visible` 对所有身份为 true；`eligible` 仅对注册后 7×24 小时内、从未订阅且未购买过本活动的个人账号为 true。注册时间取 `users.created_at`，不取最近登录时间。客户端弹窗同步开放给未登录、已订阅和团队身份用户，保留隐私同意与设备本地每周展示、关闭三次停止的规则。

## Endpoint Details

`GET /api/subscription-trial`：公开接口，无请求体。匿名请求不带认证，登录请求带现有 JWT；响应禁止缓存，仍为 `{ "code": 0, "message": "success", "data": { ... } }`。例如老用户：

```json
{"code":0,"message":"success","data":{"active":true,"visible":true,"eligible":false,"reason":"not_new_user","campaignCode":"standard_trial_2026_09"}}
```

历史订阅用户的 `reason` 仍为 `subscribed`，已购买用户为 `already_purchased`，团队身份为 `enterprise`，匿名为 `login_required`。`POST /api/subscription-trial/orders` 仍由 Portal 结算页调用，请求 `{ "campaignCode": "standard_trial_2026_09", "agreementAccepted": true }`；成功返回现有订单数据，资格不符返回 `SUBSCRIPTION_TRIAL_UNAVAILABLE`。付款时按渠道确认的付款时间再次检查注册窗口，超期进入 `payment_review`。

## Frontend Action Items

客户端用 `active && visible` 判断弹窗候选，不再依据订阅或团队身份隐藏，也不要求首次登录。点击仍跳转 Portal 并由其刷新资格；弹窗说明改为“注册后 7 天内且从未订阅”。本地展示频控与活动截止处理保持现有逻辑。

## Auth Requirements

GET 允许匿名；购买需登录并以个人身份进行。客户端不传用户 ID 或注册时间。

## Notes & Caveats

先执行 Server `sql/V101__user_last_login_at.sql`，再发布 Server，随后发布 Portal 与 Electron。`users.last_login_at` 从上线后成功登录或客户端换票开始记录，旧值保持 NULL；活动资格只看注册时间。活动开关和起止时间仍由原 Overmind 配置控制。
