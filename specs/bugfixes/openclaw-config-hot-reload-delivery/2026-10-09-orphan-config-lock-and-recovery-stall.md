# 孤儿配置锁与配置恢复熔断

## 1. 问题

Windows 用户反馈：每次发起任务都会重启 gateway，随后卡在"AI 引擎启动中"页面，只能重启应用。
2026-10-08 的日志（版本 2026.9.23，17:56 起为带 `ensureRunning:config-confirm` 的构建）显示：

- gateway 日志 57 次 `config.apply/config.set ✗ … file lock timeout for …\openclaw\state\openclaw.json: code=file_lock_timeout`，每次 19.2～20.4 秒；
- main 日志的锁诊断里 `openclaw.json.lock` 始终是 `sizeBytes: 0`、`payloadReadable: false`、`modifiedAt: 2026-09-07T12:45:01.758Z`；
- 宿主只看到 `gateway request timeout for config.apply`，全天 66 次下发 fallback、24 次硬重启、24 次优雅关闭超时后强杀；
- 17:56 后每次启动都在 config-confirm 失败，之后约每 48 秒重试、每 10 分钟硬重启一次，永不收敛。

## 2. 根因

1. **孤儿空锁。** @openclaw/fs-safe 建 sidecar 锁分两步：`O_EXCL` 建空文件，再写 `{ pid, createdAt }`。
   写入者在两步之间被 TerminateProcess（或崩溃、断电）就留下 0 字节锁。OpenClaw v2026.8.1 的
   `shouldRemoveDeadOwnerOrExpiredLock` 对没有 pid 和 createdAt 的锁直接返回 false，永不回收；
   `.reclaim` 守卫目录遗留时同样会挡住所有获取者。宿主早已为 gateway 单实例锁处理过同一问题
   （`openclawGatewayLock.ts`），但没有覆盖 `openclaw.json.lock`。
2. **宿主看不到真实错误。** `CONFIG_APPLY_TIMEOUT_MS`（15 秒）短于 gateway 等锁的约 19.5 秒，
   `file_lock_timeout` 传不回宿主，原有锁诊断也从不触发。
3. **恢复没有终止状态。** 下发失败后目标一直 pending，30 秒重试、10 分钟重启无限循环；
   重启无法删除磁盘上的锁，每次强杀还可能再制造一个空锁。
4. **准入结果被当作引擎生命周期。** 待应用时任务准入返回伪造的 `phase: 'starting'`，渲染端据此显示
   没有任何按钮的全局启动遮罩，而遮罩只在"最新同步收敛"时撤下；持续失败时永远不收敛。

本地用 OpenClaw v2026.8.1 原版锁代码复现：无锁 320ms 获取；0 字节且一个月前的锁 19549ms 后
`file_lock_timeout`；死进程 pid 的锁 16ms 回收。

## 3. 修复

### 3.1 回收孤儿配置锁（`openclawConfigLock.ts`）

`cleanupStaleOpenClawConfigLock` 处理 `<realpath(配置目录)>/openclaw.json.lock` 及其 `.reclaim`：

| 锁的状态 | 处理 |
| --- | --- |
| 读得到 pid，进程已退出 | 删除（`removed-dead-owner`） |
| 读得到 pid，进程存活 | 保留，无论多旧（`kept-alive-owner`） |
| 读出来没有 pid（空/坏 JSON），mtime 超过 30 秒 | 删除（`removed-unreadable`） |
| 同上但不到 30 秒 | 保留：写入者可能还没写 payload |
| 读取失败 | 保留（`kept-unreadable`） |
| `.reclaim` 目录超过 30 秒 | 删除（`removed-reclaim-guard`） |

删除遵循 fs-safe 自己的协议：先建（或接管超龄的）`.reclaim` 守卫，使 fs-safe 获取者等待；
复核 ino/size/mtime 未变后再 unlink，最后释放守卫。30 秒与 OpenClaw 配置锁的 stale 窗口一致。

调用时机：

- `cleanupStaleGatewayLocksSafely` 的 pre-spawn / post-stop / pre-repair（一键修复也因此会清锁）；
- 下发超时或 `file_lock_timeout` 后，经 `recoverConfigLock` 就地回收一次，成功则立即重试，不重启。
  超时时也会记录 `Config lock diagnostics`。

### 3.2 恢复熔断（`openclawConfigRecovery.ts`、`main.ts`）

`OpenClawConfigRecovery.failedAfterRespawn` 只在恢复性重启之后计数持续性失败
（`isPersistentConfigDeliveryFailure`：超时、锁超时、其他 RPC 错误；不含限流、断线、hash 竞争、已接收未应用）。
重启后第二次仍失败即 stall：停止 30 秒重试和 10 分钟重启，清掉 fallback 类延迟重启，
目标保留 pending。stall 在任一次下发成功（`applied`）后解除；手动重启或一键修复后 gateway 就绪时的
`gateway-ready:config-confirm` 会再试一次，失败也不再自动循环。

stall 以 `phase: error` + `errorCode: config_apply_stalled` 广播，`EngineFailureOverlay` 显示专门的
标题和说明，主按钮为一键修复。任务准入在 stall 时直接返回该错误。

### 3.3 准入回复不再驱动全局遮罩

`buildConfigApplyPendingStatus` 增加 `configApplyPending: true`。渲染端 `notifyOpenClawStatus`
忽略这类回复（它只描述一次被拒绝的请求，gateway 进程仍在运行），改为 toast 说明
"正在应用最新设置"或"设置未能生效，请一键修复"。真实的重启仍由 manager 状态事件显示启动遮罩。

### 3.4 诊断

下发前的 read 诊断增加 `applicationGap`：只写失败的检查项（`invalid`、`revision`、`content:<路径>`），
最多 6 个配置路径、深度 3，不含任何值。

## 4. 未做与后续

- **冷启动确认免写入（暂缓）。** 在较完整的真实配置上，每次冷启动的 config-confirm 都会真的
  `config.apply` 一次（receipt hash 与写前 hash 相同，写的是同样的字节）。核实后排除了"字面量密钥被脱敏"
  的假设：这些字段是 `${...}` 引用，原版脱敏不改 raw，OpenClaw 读取快照也是 `valid: true`。
  config.get 的 `hash` 经 `configRevisionProjector` 用 state DB 里的密钥做 HMAC，宿主无法自行计算。
  真正原因待 `applicationGap` 诊断从真实配置上给出后再修。
- 上游 OpenClaw：sidecar 锁改为原子创建，或对无 payload 的锁按 mtime 判定过期。宿主修复落地后无需本地补丁。
- gateway 优雅关闭普遍超过 6 秒后被强杀，是产生孤儿锁的主要来源，可考虑在配置写入期间延长宽限。
- state 目录下其他 fs-safe 锁（auth-profiles、会话存储等）属同类问题，可复用同一回收逻辑。

## 5. 验证

- 单测：锁回收各分支与 OpenClaw 源码协议契约、恢复熔断、下发就地回收与失败分类、
  `applicationGap`、渲染端准入提示与失败弹窗。
- 端到端（开发版 + 临时 profile）：
  1. 放入 0 字节、mtime 为 2026-09-07 的 `openclaw.json.lock` 后启动：pre-spawn 记录
     `stale config lock reclaimed (removed-unreadable)`，config-confirm 2.8 秒 applied，无硬重启；
  2. gateway 运行中放入孤儿锁并切换记忆刷新设置：15 秒超时后就地回收，重试 applied（共 16 秒），无重启；
  3. 由另一进程用 OpenClaw 原版锁持有配置锁：各时机均 `kept-alive-owner` 不删；原有 fallback → 重启路径照常收敛，熔断未误触发。
