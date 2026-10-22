# 登录与支付安全补齐（2026-10-22）

## Change Summary

- 客户端 Token 只在系统加密可用且加密成功时持久化；失败时仅保留当前进程内存，并删除旧持久化记录。旧明文记录读取后迁移为密文，无法加密时从存储移除。
- Server 为新登录签发的 access/refresh JWT 增加同一个 `sid`，刷新时保留。客户端退出撤销整组 Token，黑名单保留时间覆盖配置的最长 Token 有效期及所提交 Token 的剩余有效期；重复退出不缩短会话撤销期限。
- `/api/auth/callback` 只使用 account-filter 验证得到的 YID；旧请求可继续携带 `accountInfo`，其中的 YID、手机号不作为身份凭据。
- 支付宝支付通知在验签和成功状态判断后，增加 `app_id` 与商户归属校验。原订单金额、归属和幂等结算校验继续生效。

## Endpoint Details

### 客户端退出

```http
POST /api/auth/logout
Authorization: Bearer <accessToken>
Content-Type: application/json

{"refreshToken":"<refreshToken>","keyfrom":"<existing-keyfrom>"}
```

`refreshToken` 为可选字段；老客户端只提交 Bearer、无请求体或原有请求体仍支持。也支持只提交 refreshToken。两者都提交时，必须同一用户、同一会话。签名有效但已过期的 Token 仅可用于撤销自身会话，不能用于其他 API；重复退出成功。

```json
{"code":0,"message":"success","data":null}
```

无效签名、错误 Token 类型、混用两个会话返回 HTTP 401 和现有 `TOKEN_INVALID` 错误。携带 JWT 的退出请求不清理其他 Cookie 身份；不携带 JWT 的浏览器退出继续执行原 Cookie/Session 清理。

### 登录与刷新

`POST /api/auth/exchange`、`POST /api/auth/refresh` 的请求与返回字段不变；JWT 内部新增 `sid`，消费者继续把 Token 当作不透明字符串。旧无 PKCE 授权码、浏览器回跳和 loopback/deep-link 协议不变。

`POST /api/auth/callback` 请求字段不变。普通浏览器和旧客户端仍通过已有 Cookie 经 account-filter 验证。没有可信 YID 时返回原有 `code=-1`，不再使用请求体中的账号自报信息建立登录。

### 支付宝通知

`POST /api/payment/alipay/notify` 的通知格式不变。Overmind `alipay-config` 新增可选 `sellerId`，填写真实收款商户的支付宝 PID，不能填 `appId`。

- `app_id` 必须与既有 `appId` 一致；`seller_id`、商户订单号和支付宝交易号不能为空。
- 配置了 `sellerId`：必须与已验签通知的 `seller_id` 一致。
- 未配置 `sellerId`：用现有商户客户端凭据调用 `alipay.trade.query`，必须查到同一商户订单号、支付宝交易号、金额和成功状态，且 API 返回码为 `10000`。不从通知中的 seller_id 建立可信商户配置。
- 商户不匹配或查单暂时无法确认，通知返回失败，等待渠道重试，不发放权益。旧配置可继续使用；正确配置 `sellerId` 可避免每次通知增加查单依赖。

## Frontend Action Items

- Electron 主进程退出时可附带当前 refreshToken；保持先清理本地登录状态、同步关闭内置 Portal 的行为。
- Token 不向 Portal JavaScript 暴露，不加入 URL、日志或页面存储。普通浏览器继续使用 Cookie，不需要获得 JWT。
- Portal 无需修改登录或付款接口；继续以 Server 订单 paid 状态作为付款完成依据。

## Auth Requirements

业务 API 的有效 Bearer 身份优先；无效 Bearer 不能退回 Cookie。只有精确的 `POST /api/auth/logout` 路径由退出服务直接验证签名，以允许过期凭据撤销会话；该例外不赋予业务 API 权限。

## Notes & Caveats

1. **发布顺序：所有 Server 实例 → Portal → 客户端。** 滚动发布期间，旧 Server 不识别 sid 撤销，不能宣称整组 Token 撤销已在所有节点生效。客户端可兼容旧 Server，但完整服务端撤销能力依赖新 Server。
2. **历史 JWT 的边界：** 没有 sid 的旧 Token 无法精确判断属于哪台设备；只有用户显式执行 JWT 退出时，会撤销该用户的全部无 sid 历史 Token 及由其刷新得到的 Token。普通 Cookie 会话和新登录生成的独立 sid 不受影响。升级本身不会强制用户退出；旧客户端重新登录后也会获得独立 sid。
3. **系统加密不可用的边界：** 当前进程仍可登录及支付，但关闭应用后需重新登录。历史明文记录的逻辑删除不等于擦除旧磁盘页、WAL 或备份。
4. **网络边界：** 客户端离线退出仍会清理本地身份；服务端未收到或未成功处理退出时，不能保证远端 JWT 已撤销。
5. 本次不修改支付金额、商品、微信支付、订阅签约或收款入账流程，不需要数据库迁移。移除了支付宝配置内容片段的日志，避免记录私钥字段。
6. 自动检查覆盖 Token 加密回退、JWT 撤销与刷新竞争、历史协议、Cookie 退出和支付宝签名/商户校验；不等同于真实渠道付款或生产部署验证。


## 兼容性复查与发布安排

本次复查补齐 Portal 退出完成时的状态与资料请求失效处理：退出 HTTP 请求期间启动的旧状态查询、旧资料查询，即使在退出后返回，也不能恢复登录或账号资料。普通浏览器资料查询继续携带 Cookie；内置 Portal 资料走主进程 JWT 代理。

验证环境为 JDK 17、Node 24.15.0：Server `gradlew build` 配合指定认证/支付测试执行，430 项通过；Portal 登录状态、账号资料和微信签约来源逻辑 19 项通过，lint/build 通过；客户端认证、嵌入登录和支付接口 110 项通过。客户端本轮未改代码，沿用前次同一代码的 build、Electron 编译及修改文件 lint 通过结果；全量 lint 的 51 个导入排序错误和 1 个未使用变量警告位于未修改文件。本轮未进行浏览器操作或真实渠道付款，自动测试不代表已完成生产验证。

扩大回归发现的两条活动赠送测试失败已修正：测试明确配置 10% 加油包赠送比例，避免依赖现已为 0 的默认值；未改变生产赠送规则。

按以下顺序发布：

1. 发布前核对支付宝现有 `appId`、公钥与实际收款应用相符；建议在配置中补齐真实 `sellerId`（商户 PID）。配置值不能从任意支付通知中自动获取或直接信任。未配置 sellerId 仍有商户查单兼容路径。
2. **先发布 Server，并完成所有实例更新。** 保持 JWT 签名密钥、有效期配置和 Redis 前缀一致。旧客户端的无 PKCE 授权码、无 sid JWT、原刷新请求和只有 accessToken 的退出请求仍受支持；Cookie 请求不因缺少 JWT 被拒绝。新旧 Server 混跑期间，旧实例不识别 sid 撤销，整组 Token 撤销能力尚不完整。
3. **再发布 Portal。** 确保新版入口 HTML 生效，同时保留旧静态资源以兼容已打开的网页。新版账号资料获取和退出并发保护先就绪，之后再向用户分发新客户端。
4. **最后发布客户端，先灰度再扩大。** 客户端需要同时获得 Server 的撤销能力和 Portal 的 JWT 资料接口适配。老客户端无需强制升级，继续走原有浏览器回跳、loopback/deep-link 和支付接口。

剩余兼容边界：

- 无 sid 的历史 JWT 没有设备级关联；用户主动执行 JWT 退出会撤销该用户全部历史 JWT 及其刷新后代。升级本身不强退，Cookie 与新登录的独立 sid 不受影响。
- 移除客户端自报 accountInfo 身份、拒绝无效 Bearer 回退 Cookie 是必要的安全边界。依赖这两种不可信兜底的请求需要重新完成真实 Cookie 登录或 Token 刷新，不能承诺继续接受。
- 旧支付宝配置没有 sellerId 时，支付通知会额外依赖一次商户查单；渠道接口异常会延迟通知确认和权益到账，不能把未确认交易当作成功。
- 无系统加密时只保留进程内 Token，重启需要重新登录；离线退出不能保证远端 Token 立即撤销。
- 回退 Server 会降低 JWT 会话撤销能力；回退 Portal 到本次适配之前可能使新客户端的资料请求不兼容。应先停止新客户端放量，保留与在用客户端兼容的 Portal/API，不应把服务端安全回退视为无影响操作。

## 客户端覆盖升级数据检查

- 修复旧 `config.json` 导入顺序：必须在 SQLite `kv` 写入内部迁移完成标记前导入。此前标记会使“已有数据则跳过导入”的检查误判，导致旧配置、账号资料和 Token 无法恢复。
- 已有 SQLite 数据仍优先于遗留配置文件；退出后再次启动不会从旧文件恢复已退出账号，也不会覆盖升级后修改的配置。导入保持事务执行，原配置文件保留。
- 登录支付功能没有改变 `LobsterAI` 用户目录、`lobsterai.sqlite` 文件名或应用标识；无需删除用户目录或卸载后重装。旧 Token 会在同一设备上迁移为系统加密存储，升级本身不撤销会话；过期/撤销、系统加密不可用或密文无法解密仍可能要求重新登录。
- 配置保留有一项既有产品行为例外：合入的 release 分支会首次把浏览器显示方式迁移为内置浏览器，其他设置保留；迁移后用户再次选择外部浏览器会保留该选择。本次未改变这个既有策略。
- 使用隔离临时 SQLite 文件验证旧配置导入、Token 加密迁移及多次重启/退出；连同历史会话、MCP/IM、OpenClaw 配置/工作目录迁移、备份和安装器回归共 389 项通过。加密接口和安装器进程使用测试替身，未操作用户真实数据或进行正式安装包的跨版本覆盖安装，不能代替 Windows/macOS 实机发布验收。
- 本轮修改文件 lint、`npm run build`、`npm run compile:electron` 均通过；全量 lint 仍有 49 个未修改文件中的 51 个导入排序错误和 1 个未使用变量警告，详情见 `build/reports/upgrade-data-lint.log`。
