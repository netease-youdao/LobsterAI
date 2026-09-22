# 0.01 元订阅体验活动：新用户资格与每周弹窗

## Change Summary

服务端将已有任何历史订阅记录的账号排除在活动之外。客户端每个活动在本机首次真正显示后，以当日为固定星期锚点，每个自然周最多再显示一次；手动关闭累计三次后永久停止本活动弹窗。匿名、登录和切换账号共用本机次数。

## Endpoint Details

`GET /api/subscription-trial` 允许匿名访问，仍返回 `{ "code": 0, "message": "success", "data": { ... } }`。历史订阅用户即使已过期，也返回 `visible: false, eligible: false, reason: "subscribed"`；匿名访客在活动有效时返回 `visible: true, eligible: false, reason: "login_required"`。`POST /api/subscription-trial/orders` 仍需个人账号登录，请求体为 `{ "campaignCode": "standard_trial_2026_09", "agreementAccepted": true }`，服务端再次检查历史订阅。

## Frontend Action Items

客户端打开及新建任务时刷新活动状态。首次安装完成引导和首次登录后再弹窗；已有匿名用户可以弹窗。以服务端时间计算北京时间，首次显示的星期几为后续每周最早可弹日；错过该日则在当周下次打开或新建任务时弹出。订阅成功或活动截止立即隐藏。只有关闭按钮、Esc 或遮罩关闭计入手动关闭次数；购买跳转或状态失效不计。

本地 key 沿用 `subscription_trial.client_popup.v1:<testMode>:<campaignCode>`，新版状态增加 `firstShownDay`、`dismissCount` 和 `cadenceVersion: 2`；旧版“次日可见”状态读出时转换为首次显示日的下一周，不使已展示用户次日再次弹出。次数只保存在设备本地，不由服务端跨设备同步。

## Auth Requirements

匿名状态查询使用公开接口；登录查询用 JWT。下单必须登录，团队账号不可参与。

## Notes & Caveats

仍需服务端活动配置和有效标准版 `planId`；先发布服务端，再发布客户端。客户端使用现有 `banner=penny&trialCheckout=1` 跳转网页购买。匿名接口若在线环境返回 401，弹窗不会展示，需先发布支持公开查询的服务端版本。
