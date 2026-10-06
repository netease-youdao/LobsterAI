# 企业额度阻断与申请接入说明

日期：2026-07-16

## Change Summary

企业账号上下文新增服务端计算的 `quotaStatus`。客户端在新任务页提前阻断不可用额度，在任务中保留结构化错误提示；普通成员可申请提高个人额度，或通知管理员购买企业积分包。输入框保持可编辑，但额度不可用时不能提交。

## Endpoint Details

### 获取当前额度状态

`GET /api/enterprise/context` 新增：

```json
{
  "memberId": 101,
  "quotaStatus": {
    "available": false,
    "reason": "enterprise_pool_exhausted",
    "errorCode": 41607
  }
}
```

服务端始终先判断企业积分池，再判断成员月度额度。`reason` 支持：

- `enterprise_pool_exhausted`
- `enterprise_credit_batches_expired`
- `member_monthly_quota_exhausted`

### 提交额度申请

`POST /api/enterprise/{enterpriseId}/quota-requests`

```json
{"requestType":"member_quota"}
```

普通成员可传 `member_quota` 或 `enterprise_pool`。重复申请返回既有待处理记录：

```json
{"requestId":123,"requestType":"member_quota","status":"pending","created":false}
```

## Frontend Action Items

- 新任务：只展示额度卡片；主页输入可编辑，提交按钮禁用。
- 任务中：先展示中断横线，再展示额度卡片；继续输入可编辑，提交按钮禁用。
- 企业积分池不可用优先于成员额度，超级管理员进入充值页，普通成员调用 `enterprise_pool` 申请。
- 成员额度不可用时，超级管理员进入用量与额度页，普通成员调用 `member_quota` 申请。
- 申请按钮提交中与提交成功后不可重复点击；服务端仍负责最终去重。

## Auth Requirements

以上接口使用 Electron JWT Bearer。token 中的 `accountMode` 与 `enterpriseId` 是可信租户上下文；路径和请求头不能切换企业。

## Notes & Caveats

- 个人账号继续使用既有个人积分提示。
- 管理员调整成员额度、企业充值到账后，服务端自动解决对应待处理申请。
- 发布顺序：服务端数据库与接口先上线，再发布客户端。
