# Apple 测试账号普通业务接入

日期：2026-11-17。服务端工作区实现，尚未部署；测试库 V142 已按用户授权执行并核验，生产未迁移，不要求手机 App 发版。

## Change Summary

测试账号仅 Apple 订阅使用 Sandbox；每日积分礼、邀请、兑换、赠送、充值和普通积分恢复原业务规则。暂停/到期不影响普通积分，但新任务不能消费 Sandbox 来源。原已开始任务、已验证支付与退款按原证据完成。Sandbox 会员不等于真实付款。

## Endpoint Details

原路径、参数、认证和字段类型保留，无新增必填：

- `GET /api/client-activities/slot`：沿用原平台、版本和 placement 参数。
- `GET /api/client-activities/{activityCode}/context?configRevision=12`：沿用原领取状态。
- `POST /api/client-activities/{activityCode}/actions/check_in`：`Content-Type: application/json`，请求示例为 `{"configRevision":12,"idempotencyKey":"6b62c52d-260d-44e8-8b26-2c03c6739de1","payload":{}}`。
- 原响应封装 `{"code":0,"message":"success","data":{...}}` 不变，动作返回原 `replayed/result/context`；奖励仍为 campaign，`claimedCredits` 是历史累计，不是当前余额。
- 原订阅、积分明细、余额及 Apple v1/v2 接口不变，不传测试身份、环境或内部资金策略版本。

完整请求/响应示例、后台接口和回滚约束见[服务端接入说明](../../../lobsterai-server/docs/integration/2026-11-17-apple-test-account-normal-business.md)。示例活动、修订及金额不是实际线上配置。

## Frontend Action Items

继续使用现有接口；领取后刷新原 context 和余额，同一请求重试保留幂等键。业务账号跨设备每日最多一份，切换 Apple ID 不重置领取历史。不要根据 Apple 测试身份主动隐藏普通积分、活动或支付；仍按服务器返回的业务资格和真实订阅冲突决定操作。当前提审 App 须真机验证，无需新增接口接入。

## Auth Requirements

手机/Electron 沿用 JWT Bearer；Portal 沿各既有接口的 Cookie/Session 认证。Admin 沿 IAM 和当前有效 ADMIN，普通账号不能配置自己为测试账号。账号封禁、活动风控、兑换/邀请限制与企业角色校验仍有效。

## Notes & Caveats

先核验并执行服务端 V142 新增 funding_policy_version，再部署支持 V1/V2 的所有服务/Worker；混版期间显式关闭 APPLE_TEST_ACCOUNT_NORMAL_BUSINESS_ENABLED（代码默认开启），升级完成后启用。数据库结构兼容不等于旧Worker能处理新策略；回滚需保留新任务和历史退款的兼容处理者。普通非Apple渠道按原配置实际付款，不因Sandbox标记变成模拟支付。

测试库 V142 已执行：8 条原记录均为 funding_policy_version=1，消费协议仍为 0，原列和索引未改变；生产未迁移。未运行服务端测试或部署。原接口兼容仍需原构建验收；旧open conflict不会自动删除，不能将此功能当作未知Apple归属放行。
