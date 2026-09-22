# 2026-09-16 加油包微信下单 500 修复

## 变更摘要

测试服 `lobsterai-server-test2` 在北京时间 18:07:51 的普通加油包下单中，将 `2026-09-16T18:37:51.552835861+08:00` 作为微信 `time_expire`。微信返回 HTTP 400 / `PARAM_ERROR`，服务端随后返回 HTTP 500。请求为 `boostPackId=6, paymentChannel=dual`，未携带优惠 token。

`WechatPayAdapter` 现在先将到期时间截到秒，再检查一分钟有效期下限，并按上海时区发送，例如 `2026-09-16T18:37:51+08:00`。标准加油包、自定义金额加油包及统一扫码路由共用此适配器。业务截止时间不延长；不传到期时间的旧调用保持兼容。

参考：[微信 Native 下单 time_expire 格式](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)。

## 接口、鉴权与响应

`POST /api/boost-packs/purchase`，`Content-Type: application/json`。Portal 使用原有 Cookie/Session；Electron 使用原有 JWT Bearer。仅允许为当前登录用户下单。

请求和响应字段均不变，例如双二维码请求：

```json
{"boostPackId":6,"paymentChannel":"dual"}
```

成功响应结构示例（地址仅为占位说明）：

```json
{"code":0,"message":"success","data":{"orderNo":"<订单号>","wechatQrUrl":"<微信二维码地址>","alipayQrUrl":"<支付宝二维码地址>","orderExpiresAtEpochMs":1789555071000,"serverTimeEpochMs":1789553271000,"paymentProcessing":false}}
```

## 前端接入与发布

- 无需修改前端调用、金额、优惠 token 或二维码切换逻辑。
- 部署服务端修复后，用户可通过“重新生成”或重新打开购买窗口发起下单；过期订单仍需重新下单。
- 不涉及数据库迁移、历史数据 UPDATE 或新增配置。
- 此说明不代表测试服已部署或真实渠道支付已验证。

## 回归范围

覆盖无小数秒、日志中的两组非零纳秒、上海时区及金额传递、未指定截止时间、临近过期拒绝下单。旧测试预先使用 `withNano(0)`，无法发现真实新订单带纳秒的格式问题；现在直接传入非零纳秒并检查发送给微信的参数。

## 本次验证结果

- `WechatPaymentDeadlineTest`：6 项通过，0 失败、0 跳过。
- `./gradlew build -x test`：通过。
- `./gradlew build`：编译及打包通过；既有 `DepartmentPermissionOvermindConfigTest.testPermission_ExactMatch` 因测试 MySQL `CommunicationsException / SocketTimeoutException` 失败，随后中止全量执行，不能视为全量 build 通过。
- 未部署服务、修改测试服数据或执行真实渠道付款。
