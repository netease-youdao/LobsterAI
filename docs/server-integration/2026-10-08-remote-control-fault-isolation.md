# 远控故障隔离修复接入说明（2026-10-08）

## 变更概览

服务端修复了部分读取同步依赖修复写入、legacy 坏显示数据关闭共享 WebSocket、历史恢复漏分类显示 413、历史终态候选挤占未决上限、维护坏前缀，以及共享 Redis/调度资源问题。Electron 同批修复本地核心初始化、坏问题证据范围、请求额度、重试分类、文件 worker 和删除/目标迁移扫描。

没有新增消费端必调 API，也没有变更原 URL、字段类型、认证或成功 ACK 含义。详细实施与限制见[服务端实施记录](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-10-08-remote-control-implementation.md)。旧协议示例仍见[9/30 接口指南](2026-09-30-remote-control-reliability.md)。

## 受影响接口与示例

### 部分视图（既有能力）

```http
GET /api/remote/v2/sessions/<sessionId>/read-view
Authorization: Bearer <accessToken>
X-Remote-Projection-Version: 5
```

设备凭据、已验证的数据空间/代次等既有认证头仍由统一远控客户端附加，不得省略或猜测。GET 无请求 body；翻页参数仍为 beforeCursor/toolsCursor/approvalsCursor/questionsCursor。

响应包不变：`{ "code": 0, "message": "success", "data": { ... } }`。例如 data 中的局部字段：

```json
{
  "displayState": "partial",
  "messages": { "items": [], "beforeCursor": null },
  "tools": { "items": [], "nextCursor": null }
}
```

该示例仅展示局部字段，完整响应仍包括 identity/session/control/decisions/readSeq/readerGeneration 等既有字段。变化是健康部分可以在后台修复暂不可写时返回，不会伪造新 revision 或 ACK。`session:null`/空页/partial 不能当成会话删除或 idle。decisions.state 不代替各 nextCursor 判断是否翻页完成。无 capability 或非 projectionVersion 5 继续旧回退行为。

### 旧 snapshot / WebSocket subscribe

可定位的持久显示错误现在返回既有 47015 resync，保护原有健康订阅。首次同帧多 session subscribe 仍是原子结果，不能将整批失败解释为部分订阅成功。手机端应先独立订阅 catalog，再按 session 逐个请求，保留各自游标/退避；仍遵守最多 5 个订阅和原请求预算。

### 控制基线、命令与 history recovery

原端点、请求及结果保持不变。已终态历史候选不再直接计入 256 个真实未决限制。超过单请求 4096 候选工作预算时返回原 47014 核对语义，不能当作 idle/拒绝终态或重新执行许可。

只有服务端明确标记的纯显示 validator 413 才能通过已协商 history recovery 返回 gap。原 batch 仍原子 ACK；代理/网关/输入/hash/fence/资源 413 不可自行跳过。publication/command/import/claim ID 和未知原请求必须保持，超时/404 不是“从未执行”。

## 消费方动作

- Electron 使用本批代码，不新增 capability 猜测。坏可选 retry hint 只忽略提示；恢复先查原结果，保留必需附件、原 actor、归属/删除/fence 和未决执行保护。
- 手机端根据已有 partial_read_view_v1 + projectionVersion 5 读取；只恢复异常 session，保留健康订阅、缓存与草稿。普通后台恢复不要求重新登录或清缓存。
- 用户已明确本次不修改手机 App。上述手机消费方式作为后续建议保留，不纳入本批客户端/服务端代码交付。
- Portal 无强制接入改动，原登录/用户接口继续使用 primary Redis 池。

## 认证和发布

沿用 JWT、设备凭据、owner/scope/目标校验。可用性降级不跳过认证、必需输入、审批、执行去重或目标隔离。

1. 测试库 V109__remote_read_scan_positions.sql 已于 2026-10-08 执行完成（MySQL 5.7、无外键），新表结构、应用结构探针及 4 条读取 EXPLAIN 核验通过，见[执行记录](../../../lobsterai-server/docs/operations/2026-10-08-test-v109.md)。生产迁移未执行；其他环境先核对现有 V103–V108 结构，再增量执行 V109。数据库迁移不代表服务部署或 writer readiness 已完成。
2. 升级服务端，再升级 Electron；旧客户端协议保留。V109 缺失时后台修复补扫不就绪，不影响旧 API；部分视图不依赖提示队列成功。
3. 普通功能开关继续默认开启，writer/cluster 兼容证明和 archive/delete 存储证明必须实际验证。尤其 commandIntegrityWritersReady=false 时，不会为了跳过坏命令而放行未知混部行为。
4. 回滚不得清除安装身份、账本 locator/fence、原请求/回执或新增表。已写新证据只能回兼容构建或向前修复。

本批未运行服务端测试；编译不代替 Redis/MySQL 5.7、对象存储、混部和真实手机验收。完整的物理磁盘总预算、有效控制索引和 committed checkpoint 覆盖 GC 的状态以实施记录为准。
