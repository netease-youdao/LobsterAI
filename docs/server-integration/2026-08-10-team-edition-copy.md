# 团队版用户文案升级

## Change Summary

`lobsterai-server` 将桌面客户端可见的产品口径由“企业版 / Enterprise”统一为“团队版 / Team”。本次不修改认证、额度、媒体权益或企业账号上下文的协议，只调整终端展示值和会透传给用户的业务提示。

## Endpoint Details

接口路径和字段结构不变，客户端需要关注以下返回值变化：

1. `POST /api/auth/exchange`、Token 刷新及用户额度响应中的 `quota.planName` 由 `企业版` 变为 `团队版`。
2. `quota.subscriptionStatus`、`quota.accountMode` 仍为 `enterprise`，`enterpriseId` 等字段名不变。
3. `/api/proxy/**`、媒体生成和团队账号相关接口的业务错误消息改用“团队成员、团队积分池、团队积分批次、团队媒体服务”等展示口径；客户端继续使用错误码和 reason 判定分支。
4. 服务端未返回 `planName` 时，企业技术状态对应的客户端兜底展示名应为 `Team`。

示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "quota": {
      "planName": "团队版",
      "subscriptionStatus": "enterprise",
      "accountMode": "enterprise",
      "enterpriseId": 1001
    }
  }
}
```

## Frontend Action Items

桌面客户端已完成以下接入：

1. 账号菜单、身份切换、额度提示、积分包、媒体权益、分享/部署权益及成员移除提示统一为“团队 / Team”。
2. 主进程和 Renderer 的中英文用户文案同步更新。
3. `authQuota` 在服务端缺少 `planName` 时按企业技术状态显示 `Team`，同时继续识别 `subscriptionStatus=enterprise`。
4. Redux、IPC、缓存、目录、类型和诊断日志中的 `enterprise` 技术标识保持不变。

## Auth Requirements

认证方式不变。桌面客户端继续使用 JWT Bearer Token；账号上下文仍通过现有 Enterprise Account IPC 和 `X-LobsterAI-Enterprise-Id` 请求头传递。

## Notes & Caveats

- 新旧 Server 都可被当前客户端识别；旧 Server 仍可能返回 `企业版`，新 Server 返回 `团队版`。
- 不得根据中文或英文消息判断额度、成员身份或媒体权益，继续使用错误码、reason 和既有枚举。
- 建议先发布客户端兼容版本，再发布 Server 展示值，降低版本交叉期间旧品牌暴露的概率。
- `lobsterai-admin` 和服务端内部技术域仍使用 `enterprise`，不在本次品牌替换范围内。
