# 7·17 决赛积分活动

## Change Summary

服务端在原积分重置活动上增加可叠加的重置权益，并为符合条件的非订阅用户提供一次500积分领取权益。桌面端需要同时展示旧0.01元活动、新500积分活动和动态重置次数。

## Endpoint Details

`GET /api/user/profile-summary` 中的 `creditsResetCampaign` 新增：

```json
{
  "availableResetCount": 2,
  "resetEntitlements": [
    { "campaignCode": "credits_reset_2026_07", "expiresAt": "2026-07-31T23:59:59" },
    { "campaignCode": "credits_final_reward_2026_07", "expiresAt": "2026-08-15T23:59:59" }
  ],
  "availableFreeCreditsRewardCount": 0,
  "freeCreditsReward": null,
  "freeCreditsRewards": []
}
```

非订阅用户会收到 `freeCreditsRewards[]`，每项包含 `campaignCode`、`credits`、`claimDeadline`、`validityDays` 和可选的 `presentation`。兼容字段 `freeCreditsReward` 始终返回最早截止的一项，旧客户端领取并刷新后会自动推进到下一项。

`presentation` 可包含 `titleZh/titleEn`、`actionTextZh/actionTextEn`、`posterUrl` 和 `iconUrl`。未配置远程海报时，当前7·17活动继续使用内置素材，后续活动使用动态通用卡片。

## Overmind 多活动配置

`credits-final-reward-campaign` 兼容原单对象格式，并支持后续仅通过活动列表增加第 N 次活动：

```json
{
  "enabled": true,
  "campaigns": [
    {
      "enabled": true,
      "campaignCode": "credits_final_reward_2026_07",
      "startAt": "2026-07-17T00:00:00",
      "endAt": "2026-08-15T23:59:59",
      "registeredBefore": "2026-07-17T00:00:00",
      "freeCredits": 500,
      "validityDays": 30,
      "rewardSource": "500积分决赛奖励",
      "presentation": {
        "titleZh": "你已获得500积分决赛奖励",
        "titleEn": "You received a 500-credit finals reward",
        "actionTextZh": "立即领取",
        "actionTextEn": "Claim now",
        "posterUrl": "https://static.example.com/campaign.png",
        "iconUrl": "https://static.example.com/campaign-icon.svg"
      }
    }
  ]
}
```

顶层 `enabled=false` 关闭全部新活动；每项 `enabled` 可单独上下线。`campaignCode` 必须永久唯一。

### `POST /api/credits-reset-campaign/free-credits/claim`

```json
{ "campaignCode": "credits_final_reward_2026_07" }
```

响应包含 `creditsGranted`、`claimedAt` 和 `expiresAt`。积分从实际领取时间起有效30天。

`POST /api/credits-reset-campaign/reset` 现在可选接收 `{ campaignCode }`；不传时使用最早到期权益。

## Frontend Action Items

- 账号菜单显示动态重置次数，并为最早截止的活动积分提供独立入口。
- 右侧提示按 `resetEntitlements.expiresAt` 顺序展示，跳转 Portal 时附带活动码。
- 活动积分通过主进程鉴权请求直接领取，成功后刷新 quota/profile 并推进下一项。
- 金额、双语文案、海报和入口图标由接口动态返回，以便后续活动无需客户端发版。

## Auth Requirements

桌面端通过现有 JWT Bearer 调用。用户必须在 `2026-07-17 00:00:00` 前首次登录；领取或使用时按当前订阅状态分流。

## Notes & Caveats

- 新活动中的500积分和新重置权益互斥，旧0.01元活动不受影响。
- `profile-summary.creditItems` 按“免费积分 → 活动奖励积分 → 限时赠送 → 套餐积分 → 邀请奖励 → 加油包”返回；服务端实际扣减遵循相同顺序。
- 新活动领取窗口和重置权益在 `2026-08-15 23:59:59` 结束；已领取500积分按各自领取时间再保留30天。
- 上线顺序：服务端先上线，随后发布 Portal 和桌面端。
