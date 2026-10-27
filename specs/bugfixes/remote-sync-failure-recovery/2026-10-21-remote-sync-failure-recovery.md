# 桌面到手机同步失败状态与单任务重试修复

日期：2026-10-21

2026-10-27 增量：频繁切换服务、旧协议删除及 control backoff 的修复已在客户端实现，详见[同步目标 Spec 第 8 节](../remote-sync-target/2026-09-22-effective-server-sync-design.md#frequent-service-switching)及第 8.14 节实现记录。状态为**客户端验证完成，真实跨服务联合验收待执行**。本篇下方的 199 项历史回归不计入该增量。

## 问题与证据边界

用户反馈桌面任务偶现无法同步到手机，任务浮层显示红色“同步失败”。当前没有故障发生时的日志，无法确定截图对应的请求错误、会话或服务端状态。本次基于代码和隔离回归测试修复两处确定性缺陷，不将其推断为所有同步失败的共同原因。

## 缺陷一：自动重试成功后仍保留旧失败状态

`RemoteAvailabilityPublisher.live()` 首次发布一个对象失败时，使用包含 scope、会话 ID、对象种类与对象 ID 的键记录退避状态。下一轮通过持久化待发送请求重放成功时，却只删除 publication UUID 对应的失败键。

首次失败留下的对象键没有被删除；同一源版本已有 ACK 后进入跳过分支，也不会再次发布并清理这个键。`sessionHealth()` 仍检测到会话下的旧错误，返回 `degraded=true`，最终 `RemoteBridge.associationSyncState()` 持续返回 `sync_failed`。因此手机实际已收到内容时，桌面仍可能显示失败。

另一个同类问题是任务级扫描异常留下的 task key 缺少成功恢复清理点。

### 修复约束

1. 首次发布和持久请求重放使用一致的对象级退避标识，并兼容清理旧的 operation UUID 退避记录。
2. 只有对应请求通过现有回执校验、完成本地结果落盘后，才能清除该对象的瞬时失败标记。
3. 任务级扫描成功恢复后清除旧的 task key；本轮后续新产生的存储异常必须继续保留。
4. 不因重试时间到期或某个对象成功而清空所有失败；其他对象、其他会话、未知/无效回执以及持久化故障不得被误标为成功。
5. 原始 publication ID、请求正文、持久化重放和账号/连接代次校验继续复用，不重新生成操作绕过失败。

2026-10-27 设计补充：旧协议删除完成后的 control 退避只有在当前精确绑定的删除证据验证并持久化，或经验证移交正确的 legacy 删除恢复路径后，才能清理其不再适用的键；不能只从候选列表过滤掉任务而保留旧错误。结束旧 routeEpoch 可清其瞬时调度状态，但不删除原目标持久未知操作。此规则与既有 live 重放修复并列，具体分类、认证晚回包和 A→B→A 要求见上述 Spec。

## 缺陷二：任务详情的重试入口只触发全局重连

`ownershipService.retrySync()` 原来始终调用 `remote.configure({retry:true})`。该操作恢复连接和 Agent 列表同步，不会把单任务调度器中已隔离的任务重新加入核对队列。已有 `retrySessionId` 协议才会调用 `RemoteTaskSyncState.manualRetry()`。

### 修复约束

1. 当前目标是任务，且状态接口返回该任务可重试的问题时，调用既有 `retrySessionId`，并携带刚读取的 `expectedAccountEpoch`。
2. 任务问题明确不可重试时，不退化为全局重连并宣称任务已安排重试；保留冷却、服务端等待时间、已删除任务等保护条件。
3. Agent、全局连接问题或没有任务级问题记录的独立发布失败，沿用全局重连入口。
4. 面板切换、请求乱序或账号变化时，不得把旧点击应用到新的任务或账号。主进程仍是权限、归属、重试次数与时间限制的最终校验方。

## 范围与兼容性

仅修改 LobsterAI 桌面客户端，涉及独立发布器、任务详情重试服务、相关测试；不可重试时复用已有等待提示。复用现有 IPC 参数和回执协议；无服务端接口、手机 App、Portal 或 Admin 变更，无数据库迁移，不改变 MySQL 5.7 兼容性。

不改变会话归属、源事件水位、消息时间、历史 ACK、发布权限或数据损坏隔离规则；不通过手工删除错误记录或用户数据完成恢复。

## 验收场景

- 首次网络失败后自动重放原始操作，收到有效回执后同步健康状态恢复。
- 同一会话仍有其他失败对象时，不能因为一个对象恢复而显示全部同步成功。
- 无效回执或请求仍失败时，保留失败状态与待处理请求。
- 任务扫描短暂异常恢复后清理旧 task key；后续新增存储错误仍保留。
- 可重试的隔离任务通过详情入口进入核对队列；全局重连本身不能误当成单任务重试完成。
- 不可重试任务不会绕过限制；Agent/全局连接重试仍然可用。
- 切换账号或任务时，旧请求不会触发错误目标的重试。

## 验证记录

### 旧实现重现

- 自动重放已有有效 ACK 后，旧实现仍返回 `pending=true, degraded=true`；新增用例失败。
- 任务扫描临时异常恢复并成功发布后，旧实现仍返回 `degraded=true`；新增用例失败。
- 用 `/tmp/ownership-retry-readonly.vitest.config.mjs` 的只读加载插件验证旧的详情重试入口，预期单任务请求、实际收到 `{retry:true}`，用例失败。主进程对照同时确认全局重连不会解除任务隔离，而 `retrySessionId` 会进入 `reconciling`。

### 修复后检查

1. `npm test -- src/main/remote/remoteAvailabilityPublisher.test.ts`：75 项通过。
2. `npm test -- src/main/remote/remoteAvailabilityStore.test.ts src/main/remote/remoteAvailabilitySessionBudget.test.ts src/main/remote/remoteBridge.ownershipSyncState.test.ts src/main/remote/remoteTaskSyncState.test.ts src/main/remote/configureRemoteSettings.test.ts src/renderer/services/ownership.test.ts src/renderer/components/ownership/useOwnershipDetail.test.ts`：124 项通过。
3. 5 个变更 TypeScript 文件按 CI 规则执行严格 ESLint：通过。
4. `npx tsc --noEmit`：通过。
5. `npm run compile:electron`：通过。首次因沙箱不能写客户端编译输出目录失败，授权写入后重跑成功。
6. `git diff --check`：通过。

自动化共覆盖 199 项；使用隔离 SQLite/模拟传输，不访问用户会话或外部业务服务。无服务端变更，按仓库约定不执行服务端测试。缺少现场日志及手机真机联调，不能确认截图所示实例已经恢复。

### 变更文件

- `src/main/remote/remoteAvailabilityPublisher.ts`
- `src/main/remote/remoteAvailabilityPublisher.test.ts`
- `src/main/remote/remoteBridge.ownershipSyncState.test.ts`
- `src/renderer/services/ownership.ts`
- `src/renderer/services/ownership.test.ts`

