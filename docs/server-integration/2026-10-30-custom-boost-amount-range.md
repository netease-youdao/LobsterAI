# 自定义加油包金额调整为 10–5000 元

日期：2026-10-30

服务端分支：`feat/penny-first-renewal-discount`

## 变更

个人自定义加油包金额下限由 20 元降为 10 元，上限仍为 5000 元，包含上下限。报价、下单、换单共用 `PaymentSelection` 校验；服务端继续兼容最多两位小数。固定档位、团队版规则、积分换算及优惠计算保持原有行为。

## 接口

请求使用 `Content-Type: application/json`。Portal 沿用登录 Cookie/session，Electron 直连接口沿用 JWT Bearer；权限与订单归属校验不变。

| 方法 | 路径 | 自定义金额请求示例 |
| --- | --- | --- |
| POST | `/api/payment/quote` | `{"target":{"orderType":"boost_pack","amount":10}}` |
| POST | `/api/boost-packs/purchase` | `{"amount":10,"paymentChannel":"dual"}` |
| POST | `/api/payment/orders/{orderNo}/replace` | `{"requestId":"unique-request-id","target":{"orderType":"boost_pack","amount":10}}` |

`offerToken` 仍为可选；自定义金额不能同时传 `boostPackId`。响应结构保持 `{code,message,data}`，成功时 `code=0`、`message="success"`，`data` 沿用原接口字段。报价中的 `amount` 继续表示最终应付金额，`originalAmount` 表示原价。

非法金额直接下单的响应示例：

```json
{"code":4000,"message":"自定义金额须在 10~5000 元之间，最多两位小数","data":null}
```

## 前端衔接与发布

- Portal 的中英文范围提示、输入校验及购买校验均使用 10–5000；Portal 仍仅接受整数输入。
- Electron 如跳转 Portal 购买，无需修改接口；如有独立金额校验或提示，应同步下限 10 元。
- 先部署服务端，再发布开放 10–19 元输入的前端。旧服务端仍会拒绝低于 20 元的自定义金额。
- 本次为兼容性放宽，无数据库迁移、功能开关或新增配置。

## 验证与状态

JDK 17 下 `./gradlew build -x test` 通过，包括构建内置的 MyBatis 元数据检查。已更新已有边界用例的数据，未执行测试。尚未部署到测试或生产环境。
