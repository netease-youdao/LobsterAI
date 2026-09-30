# 服务端接入：手机远控隔离、异常命令和请求关联

日期：2026-09-29；数据库状态更新于 2026-09-30。服务端和 Electron 代码已修改并完成本地构建/定向验证；测试 MySQL 5.7 的 V106 已执行并复核通过，生产迁移、混版和手机真机尚未验收。

## 1. 变化摘要

本次保留 remote v1/v2/v3 路径、认证、原请求字段、响应字段类型、status 枚举及 source ACK 语义。增加服务端命令完整性旁表和逐记录容错，坏任务不再必然使目录/整批命令领取失败；展示历史降级不能替代真实执行证据。新诊断头可选，没有新增移动端强制参数或独立遥测接口。

Electron 已接入逐条安全扫描、持久 live 失败退避、公平控制轮次、远控可选存储与核心保存分离、受监督 HTTP/WS worker，以及安全结构化日志。token 刷新和核心执行许可仍由主进程负责，worker 不能访问核心任务库或调用工具。

## 2. 接口与示例

以下均为既有接口；健康 DTO 保持原契约，新增内部隔离状态不进入 command/run.status。

| 方法与路径 | 本次行为 |
| --- | --- |
| `GET /api/remote/v1/sessions` | 坏 summary/控制事实只省略对应任务；健康任务继续返回，游标按已扫描记录推进 |
| `GET /api/remote/v1/sessions/{id}/snapshot` | 控制事实不可信时沿用 47014；安全展示占位/读取基线沿用既有协议 |
| `POST /api/remote/v1/commands` | 相同 commandId 保持幂等；依赖未决坏启动命令的同会话仍 busy，不自动创建替代任务 |
| `GET /api/remote/v1/commands/{id}` | 无法安全返回原命令时使用既有 47024/409 错误结构，保留原 ID |
| `GET /api/remote/v1/devices/{id}/commands?state=unresolved&limit=50&cursor=...` | 按条校验；坏命令保持服务端未决证据，分页游标可以越过未返回的隔离行 |
| `POST /api/remote/v1/devices/{id}/commands/claim` | 有界候选、验证后签发 permit；坏命令不会导致健康命令重复领取 |
| `POST /api/remote/v1/commands/{id}/ack` | received 与新执行许可受完整性门禁；原 claim 的合法执行报告仍可结算 |
| `POST /api/remote/v1/commands/{id}/reconcile` | 查询/核对沿用原 ID；坏证据不能换 ID 重放副作用 |
| `POST /api/remote/v1/commands/{id}/claims/{claimId}/settlement` | 原有 never_started 证据规则不变；隔离不成为伪造未执行的理由 |
| 原 v1 control、v3 live/recovery 接口 | 协议不变；统一请求关联，旧 exact 与 resolved 水位继续分开 |

认证头（仍以原接口的 capabilities/register 例外为准）：

```http
Authorization: Bearer <access-token>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
X-Remote-Data-Space-Id: <confirmed-data-space-id>
X-Remote-Data-Generation: 1
X-Remote-Request-Id: 52465f0b-38f1-4f24-a8b9-3c7650c56777
Content-Type: application/json
```

`X-Remote-Request-Id` 是可选 UUID；服务端校验后回传，无效/缺省时生成新值，不改变权限或幂等依据。设备凭据、数据空间双头、JWT 代次与 grant 验证保持原样；Portal cookie 不能代替远控授权。

领取请求（原格式）：

```http
POST /api/remote/v1/devices/desktop_1/commands/claim
```

```json
{"connectionGeneration":"12","limit":10}
```

无可领取命令的原响应格式：

```json
{"code":0,"message":"success","data":{"items":[],"serverTime":"2026-09-29T10:00:00Z"}}
```

健康 items 继续包含 `command/request/requestHash/claimId/claimToken/claimUntil/statusVersion/serverTime`。空 items 只表示本轮没有可返回项，不能推断某个原命令“从未执行”或解除本地同会话门禁。

完整性未能核对的兼容错误示例：

```json
{"code":47024,"message":"命令记录正在核对，请保留原命令标识","data":{"reason":"COMMAND_STATE_CONFLICT","retryable":false,"retryAfterMs":null,"reasonDetail":"COMMAND_INTEGRITY_BLOCKED","requestId":"52465f0b-38f1-4f24-a8b9-3c7650c56777"}}
```

目录可能返回健康项的子集。扫描预算耗尽时可能出现 `items=[]` 且 `nextCursor` 非空；分页应按 nextCursor 结束。此极端路径必须由实际旧 App build 验收，不能靠 Electron mock 声称兼容。详情控制状态尚未核实时使用原 47014/SYNC_IN_PROGRESS/409，不伪造 idle 或 inputVersion=0。

## 3. Electron 接入动作

1. 所有 remote 请求携带可选关联 UUID；只记录白名单元数据，不记录 headers/body/自由异常文本。排障串联 commandId → prepared/dispatched/terminal → persisted → publication ACK。
2. claim/unresolved 按单命令处理；持久坏 inbox、原 permit 或未知 ACK 不删不重建。分页推进以可信服务端 cursor 为准，历史失败不改 transport 在线状态。
3. 已被 v3 接管的会话健康度使用 control/live/history 账本，不把旧 outbox 再算为当前失败。编码失败按对象版本持久退避，下一健康对象继续。
4. 新桌面连旧服务端继续沿用 capabilities 协商；不要因为没有新日志头或 V106 而拒绝旧服务端，也不向未公告目标发送 v3 请求。
5. 网络 worker 退出只重建远控网络；账号变化后旧响应不能回流，任何工具/审批动作仍由主进程重新核实身份、generation 和执行许可。

本次不需要 Portal/Admin 改接口或添加页面。手机 App 源码不在已提供仓库，分页/pending/停止按钮等真机行为仍需独立确认。

## 4. 发布、灰度和回滚

- V106 `remote_command_integrity` 使用 MySQL 5.7 InnoDB、无外键；9/30 已在指定测试 writer 执行，11 列、2 个索引及应用 schema readiness 复核通过。记录见服务端 `docs/operations/2026-09-30-test-v106.md`；生产 DDL 未执行。
- `REMOTE_COMMAND_INTEGRITY_ENABLED=true` 为功能默认值；`REMOTE_COMMAND_INTEGRITY_WRITERS_READY=false` 为独立部署证明。全部 command/ACK/reconcile/retention writer 兼容、迁移与结构验证完成后才能显式确认 readiness。
- schema 存在后，已隔离状态必须被所有路径理解；暂停新增隔离不解除已有屏障。恢复需要原 hash/执行证据，不因 TTL 或重启直接放行。
- 回滚保留旁表、原请求、claim 和 ACK，使用理解隔离语义的兼容构建；不回退到忽略旁表的旧 writer。Electron 的 availability_requests 新增可空 object_id/object_kind/request_hash 列；客户端降级必须使用兼容该 ledger 列的补丁版，不能回退到无列名 INSERT VALUES 的旧写法，也不能删 ledger 绕过未知回执。
- 服务端只编译和跳过测试打包；没有运行依赖 Redis/MySQL 的测试。测试库 DDL 状态以 9/30 执行记录为准；业务联调、生产迁移、混版/真机、安装包与性能目标均不能据此视为已通过。

详细实施/验证记录见服务端 `docs/operations/2026-09-29-remote-isolation-implementation.md`；完整方案见 `docs/specs/mobile-remote-control/feature-2026-09-29-remote-isolation-resilience-observability.md`。

两项核心安全边界仍保持原行为，未应用被自动审批拒绝的改动：坏核心 run 的全局恢复屏障，以及账号切换全局停止屏障与逐任务清理的先后顺序。具体提案与验收见服务端 docs/operations/2026-09-29-remote-safety-boundary-approval.md。


## 5. 9/30 在线设备的任务同步异常修复

本次截图故障定位于客户端：鉴权请求包装隐藏传输原因，旧调度器将临时网络错误记为永久任务隔离；HTTP 退避条件还会取消本地投影。此次不改服务端接口、认证或 MySQL schema。

- 本地网络并发满延后 500ms，快照上下文变化延后 1 秒；保留原身份、原快照与回执检查。真实网络故障仍自动退避。
- 本地投影仅检查独立的隔离/关闭调度条件，原 owner、target、device、admission、发布上下文校验保持不变；HTTP 退避不会取消正在生成的投影。
- SQLite 调度表新增 `recovery_probe_version`，旧版三个已知隔离原因可在当前 owner/target/device 下获得一次原操作核对机会。进入 `reconciling` 后先检查原 import receipt 与 stream，核对成功不构造 ACK，不重跑模型或工具。
- 新日志提供白名单 `authStatus/authFailureKind/transportFailure/transportErrorType/transportSystemCode`。原始异常正文、URL、token 不写入诊断。
- 重启新客户端主进程后生效，不直接清理用户运行数据库。已有端点配置修改保留；手机真机状态需在新客户端加载后检查。

详细证据与验证见服务端 `docs/operations/2026-09-30-remote-sync-transient-failures.md`。
