# Windows 启动失败修复设计（更新版）

## 背景

Windows 用户在应用启动时仍会偶发进入“初始化应用程序失败”页面。  
此前已有一轮排查与修复从其他分支迁移，但问题未彻底解决。

本次结论基于以下真实日志：

- `release/lobsterai-logs-20260426-021837/main-2026-04-28.log`
- `release/lobsterai-logs-20260426-021837/openclaw-2026-04-28.log`
- `release/lobsterai-logs-20260426-021837/install-timing.log`

---

## 本次真实失败点

这次样本中的直接失败并不是 skill 同步慢，而是：

- Renderer 在 `configService.init` 处触发硬超时并失败：
  - `initializeApp FAILED after 15019ms: configService.init timed out after 15000ms`

同一时间窗内，主进程启动负载较重：

- OpenClaw Gateway 首次 ready 约 **29.6s**
- McpBridge 启动多个 stdio MCP server（Tavily / Context7 / GitHub）
- 后续出现 `mcp-bridge config CHANGED`，触发 **HARD RESTART**

当前行为链路是：

1. 启动期主线程压力高，IPC 响应变慢  
2. `configService.init` 的 15s 超时被当作致命失败  
3. 应用进入错误页（即使系统稍后可能自行恢复）

---

## 关键时序证据（摘要）

来自 `main-2026-04-28.log`：

1. `21:57:02`：窗口创建完成，skill 同步在本次样本仅 ~95ms
2. `21:57:03`：OpenClaw Gateway 进程启动
3. `21:57:21`：Renderer 开始 `initializeApp`，进入 `configService.init`
4. `21:57:21`：`configService.init` 15s 超时，初始化失败
5. `21:57:32`：Gateway healthy（约 27.9s，startGateway 总计 ~29.6s）
6. `21:57:46`：mcp-bridge 配置变化触发 HARD RESTART
7. `21:57:54`：Gateway 重启后再次 ready

来自 `openclaw-2026-04-28.log`：

- 21:57 启动阶段中，mcp-bridge 先是配置不完整被跳过，后续重启后注册 33 tools
- 存在多条 stale plugin entry warning，增加启动期配置抖动和噪声

来自 `install-timing.log`：

- 冷安装解包约 34s，说明首次安装/升级场景天然更容易触发启动竞争问题

来自 `2026-05-01` 开发联调日志（`npm run electron:dev:openclaw`）：

1. `09:07:45`：`[OpenClawSyncQueue] ... reason=startup`，启动期 single-flight 队列生效  
2. `09:07:47`：`reason=token-refresh:proactive`，发生 secret 变化，但网关 `phase=starting`，日志显示 `RESTART NEEDED ... skipping`
3. `09:08:13`：`reason=ensureRunning:mcpBridge`，`mcpBridge config CHANGED` 且 `needsHardRestart=true`，同样因 `phase=starting` 被 skip
4. `09:08:17`：网关 ready 后仍出现 `mcp-bridge skipped registration because callbackUrl/secret/tools are incomplete`
5. 结论：即使 queue 合并生效，若“需要重启”发生在 `starting` 阶段，旧逻辑会留下“应重启未重启”缺口，导致 MCP 不可用

---

## 根因判断（按优先级）

## P0：初始化阶段“超时即失败”策略过于刚性

`configService.init` 超时后直接进入错误页。  
短暂的 IPC 延迟被放大为“启动失败”。

## P0：主进程启动期竞争严重

同一窗口内并行/串行叠加了：

- Gateway 启动
- McpBridge server 启动与 tools 发现
- 多次 `syncOpenClawConfig` 触发

这些会挤占主线程处理能力，影响 renderer 的关键 IPC（如 `store:get`）。

## P1：`store:set(app_config)` 仍是阻塞路径

`store:set` 在 `app_config` 写入时仍 `await syncOpenClawConfig`，  
把配置写入变成高成本 IPC，进一步放大启动期拥塞。

## P1：配置写入一致性风险仍未完全收敛

已有 commit 修复了部分 `...config` 整包回写，但并非所有路径都完全收敛。  
仍可能造成配置回滚/抖动，诱发额外 config sync。

## P2：鉴权网络请求缺少严格超时边界

`fetchWithAuth` 及 refresh 请求仍需要明确超时，避免弱网下长时间挂起。

---

## 已落地改动（当前分支）

- 初始化错误页“重启应用”链路已迁移：
  - `app:relaunch`（main）
  - `relaunch` 暴露（preload / types）
  - 错误页按钮 + i18n 文案（renderer）
- i18n 配置覆盖问题已做部分修复（去除部分整包 spread 回写）

这些改动提升了“恢复能力”和“部分一致性”，但还不是根治。

---

## 建议修复方案

### 阶段 1（立即可做，低风险）

1. 保留重启按钮作为用户兜底（已完成）
2. 增加启动前 30s 的关键 IPC 延迟观测（尤其 `store:get`）
3. 把 `store:set(app_config)` 改为非阻塞：
   - 先持久化并立即返回
   - `syncOpenClawConfig` 后台异步执行并记录失败

### 阶段 2（核心可靠性）

1. 降低启动关键路径竞争：
   - **McpBridge 启动策略暂不调整**（避免「延后启动」导致主界面可用但 MCP 立即报错；本轮不做 MCP 侧优化）
   - 启动期避免多路并发 `syncOpenClawConfig`
2. 增加 config sync 合并机制：
   - 对启动阶段的高频 `syncOpenClawConfig` 做节流/合并

#### 2.1 启动期避免多路并发 config sync（详细说明）

目标是在应用启动前几十秒内，避免多个入口同时执行 `syncOpenClawConfig()`，减少主线程竞争和 IPC 拥塞。

当前风险是短时间内可能出现多路触发（例如 `startup`、`skills-changed`、`app-config-change`、`ensureRunning:mcpBridge`），导致：

- 多次重复读写配置与 diff 计算
- 主线程被连续占用，`store:get` 等关键 IPC 延迟增大
- renderer 初始化超时概率上升

建议策略：

1. **单飞执行（single-flight）**：同一时刻只允许一个 sync 执行
2. **后续请求排队或标脏**：已有 sync 在跑时，新请求先不并行执行
3. **启动窗口优先级**：启动前 30s 内对低优先级 reason 降频处理

#### 2.2 增加 config sync 合并机制（详细说明）

目标是把短时间内的多次 sync 触发“折叠”为最少执行次数，降低抖动。

可采用组合机制：

1. **防抖（debounce）**：在 100~300ms 窗口内合并多次触发为 1 次
2. **飞行中合并（in-flight coalescing）**：若已有 sync 正在执行，仅记录 `dirty`，待当前 sync 结束后最多补跑 1 次
3. **reason 合并记录**：将本轮触发原因聚合写日志，方便排查
4. **启动期强化合并**：前 30s 使用更强合并策略，之后恢复常规

示例（期望行为）：

- t0：`startup` 触发 sync#1
- t0+100ms：`skills-changed` 到达（不并行，标脏）
- t0+200ms：`app-config-change` 到达（继续合并）
- sync#1 完成后：只补跑 1 次 sync#2，覆盖后两次变更

即从 3 次重操作降低到 2 次（或在部分场景降到 1 次），达到“减少启动期配置抖动”的效果。

#### 2.2.1 基于 OpenClaw 文档/源码的约束补充（用于实现边界）

为避免把 Lobster 问题错误归因到 Gateway，本节明确 OpenClaw 侧已知行为：

1. **配置来源与启动快照**
   - Gateway 启动读取磁盘配置（`openclaw.json`）并校验，非法配置会拒绝启动
   - 这意味着「SQLite 已更新但未写入 openclaw.json」时，网关不会自动感知到最新值
2. **运行期 hot reload 存在，但不是万用免重启**
   - OpenClaw 支持配置文件监听与 `hybrid/hot/restart/off` reload 模式
   - 多数字段可 hot-apply，但 `gateway.*`/`discovery`/`plugins` 等仍可能需要重启
3. **Lobster 与 OpenClaw 是两层合并，不可替代**
   - OpenClaw 的 debounce/重载主要作用于“文件变化后”
   - Lobster 当前痛点是“写文件前多入口并发触发 sync”，需在主进程先做 single-flight + dirty 合并

据此，阶段 2 的落地边界调整为：

- 不假设“网关会自动继承 SQLite 最新状态”
- 至少保证在网关首次稳定使用前完成一次权威配置写入
- 启动窗口内由 Lobster 主进程收敛多路 sync，减少重复写和重启判定抖动

#### 2.2.2 dirty 处理时机与执行流程（实现口径）

为避免“说合并但实际仍抖动”，统一采用以下主进程口径：

1. **状态定义（进程内）**
   - `inFlight: Promise | null`：当前是否已有 sync 在执行
   - `dirty: boolean`：飞行期间是否收到新增变更
   - `pendingReasons: Set<string>`：本轮待合并 reason
   - `startupWindow: boolean`：启动强化窗口（建议 `app ready` 后 30s）
2. **触发规则**
   - 任意入口（`startup`/`app-config-change`/`skills-changed`/`im-gateway-start-batch`/`ensureRunning:*`）不直接并行执行 sync
   - 只调用统一入口 `requestConfigSync(reason, options)`
3. **合并策略**
   - 若 `inFlight != null`：仅 `dirty = true`，并把 reason 加入 `pendingReasons`
   - 若 `inFlight == null`：
     - 启动窗口内：先经过短 debounce（100~300ms）收集 reason，再启动一次 sync
     - 非启动窗口：可立即启动（或使用更短 debounce）
4. **补跑策略（drain）**
   - 当前 sync 结束后：
     - 若 `dirty == false`：结束
     - 若 `dirty == true`：清空 dirty，取 `pendingReasons` 合并成下一轮 reason，**最多立即补跑 1 轮**
   - 若补跑期间又收到新增触发，继续按同样规则；保证任意时刻最多 1 个执行体

参考伪代码：

```ts
async function requestConfigSync(reason: string): Promise<void> {
  pendingReasons.add(reason);
  if (inFlight) {
    dirty = true;
    return;
  }
  scheduleOrRun(); // startupWindow 内 debounce，窗口外可直跑
}

async function runSyncLoop(): Promise<void> {
  if (inFlight) return;
  inFlight = (async () => {
    do {
      dirty = false;
      const { mergedReason, mergedOptions } = mergeReasonsAndOptions(pendingReasons);
      pendingReasons.clear();
      await syncOpenClawConfig({ reason: mergedReason, ...mergedOptions });
    } while (dirty); // 飞行中若再来请求，只补跑下一轮
  })().finally(() => {
    inFlight = null;
  });
  await inFlight;
}
```

参数合并原则（避免语义回退）：

- 调度层**不改写**现有调用方语义，只做串行与合并
- `restartGatewayIfRunning` 由来源请求透传；合并时采用“从严不放松”规则：
  - 任一来源要求 `restartGatewayIfRunning: true`，则合并后为 `true`
  - 仅当所有来源都为 `false` 时，合并后才为 `false`
- 这样可保证启动后 IM/模型等原本应触发重启的路径不被错误降级

日志要求（验收可观测）：

- 每轮打印 `mergedReason`、合并条数、是否 `startupWindow`
- 打印 `coalescedCount`（被折叠请求数）与 `drainRounds`（补跑轮次）
- 保持错误日志语义：sync 失败可见，但不阻塞 `store:set(app_config)` IPC 返回

#### 2.2.3 reason 分层与调度规则（防止一刀切）

为避免“全部 reason 同优先级”导致关键配置被延后，按以下分层执行：

1. **P0-关键（到达即纳入下一轮）**
   - `startup`
   - `ensureRunning:*`
   - `app-config-change`（阶段 2 首版默认全量纳入，避免漏同步）
2. **P1-重要（可在窗口内合并）**
   - `im-gateway-start-batch:*`
   - `skills-changed`
   - `server-models-updated`
3. **P2-后台（仅在非关键轮次或空闲时处理）**
   - 诊断/清理类 reason（不影响当前可用性的同步）

调度约束：

- 任意时刻最多 1 个执行体（single-flight）
- 若当前轮包含 P0，则下一轮不得被 P2 抢占
- 启动窗口内允许 P1 合并到紧随 P0 的补跑轮次
- 启动窗口结束后恢复常规策略（降低 debounce，减少配置生效延迟）

`app-config-change` 字段级优化说明（后续迭代）：

- 首版不做字段过滤，先保证正确性优先
- 后续若要做“仅 OpenClaw 相关字段触发 sync”，必须同时满足：
  1. 提供明确字段白名单（文档化）
  2. 增加回归用例覆盖（模型切换、IM 配置、代理/鉴权变更）
  3. 证明不会出现“配置已写库但网关未同步”的漏同步

#### 2.2.4 启动窗口参数建议（首版默认值）

作为首版实现建议，先使用固定参数，避免过度调参：

- `startupWindowDurationMs = 30_000`
- `startupDebounceMs = 200`（范围 100~300ms）
- `normalDebounceMs = 50`
- `maxContinuousDrainRounds = 6`（防止异常抖动导致长时间占用）

保护策略：

1. 若达到 `maxContinuousDrainRounds`，打印告警并进入短冷却（例如 300ms）后继续
2. 单轮 sync 超过阈值（例如 3s）时打印慢日志，附带 `mergedReason`
3. 若 60s 内 coalescedCount 持续过高，输出聚合告警，提示检查写放大来源

#### 2.2.5 实现期新增问题与修复补充（MCP 不可用）

在按本方案落地 single-flight 后，开发联调中发现一类时序缺口：

- `ensureRunning:mcpBridge` 在启动期触发配置变更（`callbackUrl/tools` 更新）
- `syncOpenClawConfig` 判定 `needsHardRestart=true`，但当时网关处于 `starting`
- 旧逻辑对 `phase !== running` 直接 skip，导致“应重启未重启”
- 网关后续虽然 ready，但仍加载启动快照，出现 mcp-bridge 插件未注册
- 结果表现为：主界面可用，但 MCP 工具不可用

根因结论：

1. 这是**重启时机缺口**，不是 sync 合并策略本身错误
2. 触发条件是“需要硬重启 + 网关尚未 running（尤其 `starting`）”
3. 需要补“启动后补重启（post-start restart）”机制

本轮代码修复点（已实施）：

1. 当 `needsHardRestart=true` 且 `phase=starting` 时，不再 skip
2. 将 reason 记录到 `pendingPostStartGatewayRestartReasons`
3. 监听状态流转，在网关进入 `running` 后执行一次合并重启
4. 若存在活跃工作负载，则复用 deferred restart 机制，避免强杀会话

修复目标：

- 保证启动期晚到的 mcpBridge 配置最终被网关采纳
- 不改变现有 `needsHardRestart` 判定语义，仅补全时机链路

回归日志关键字（必查）：

- `RESTART QUEUED after startup (phase=starting)`
- `post-start restart: gateway reached running, applying pending restart`
- 不再持续出现 `mcp-bridge skipped registration because callbackUrl/secret/tools are incomplete`

#### 2.2.6 启动体验补充：两阶段连续展示（阶段进度独立）

在补齐 post-start restart 后，功能正确性恢复，但出现体验问题：

- 第一阶段网关短暂进入 `running` 时，启动遮罩会先消失
- 随后进入第二阶段重启，遮罩再次出现
- 间隔虽短，但用户可能在这段窗口内触发界面操作，造成“可操作-又被打断”的观感

体验目标：

- 第一阶段与第二阶段各自保留独立进度（允许第二阶段从 0 重新开始）
- 但两阶段之间遮罩不闪断，避免用户在中间窗口误操作界面
- 保留后台真实状态流转，不改变网关实际重启逻辑

本轮实现策略（已落地）：

1. 增加“展示态门面”层（display status）
   - 只要存在 `pendingPostStartGatewayRestartReasons` 或 `postStartGatewayRestartInProgress`，前端展示态保持 `phase='starting'`，确保遮罩连续
2. 分阶段展示进度，而非“单阶段假进度”
   - 第一阶段（初次启动）使用原始进度；当第一阶段已到 `running` 且存在待执行重启时，展示为“第一阶段完成，准备第二阶段”
   - 第二阶段（post-start restart）使用第二阶段真实进度，允许从低百分比重新增长
3. 在 post-start restart 执行前后维护进行中标记
   - 重启前置 `postStartGatewayRestartInProgress=true`
   - 第二阶段完成并稳定 `running` 后置回 `false`，再退出遮罩
4. 完成后主动推送一次状态
   - 确保遮罩平滑退出，而不是依赖下一次自然状态事件

关键约束：

- 仅影响前端展示态，不改变 `needsHardRestart` 判定与重启执行语义
- 不影响 MCP/IM/模型配置最终一致性

回归验收（新增）：

1. 出现 `RESTART QUEUED after startup (phase=starting)` + `post-start restart...` 时
2. 启动遮罩在两阶段之间不闪断（不出现“消失后再出现”）
3. 第二阶段完成后遮罩一次性退出，且 MCP 工具调用成功

#### 2.2.7 实现期补充：启动前准备态可见性与错误条抑制（本轮新增）

在 2.2.6 落地后，联调中又发现两类体验问题：

1. 网关启动遮罩出现偏晚
   - 日志显示 `main-auto-ensure-running-dispatch` 已触发，但在 `startMcpBridge + syncOpenClawConfig` 的“启动前准备窗口”内，底层状态仍为 `phase=ready`
   - 旧前端逻辑仅在 `phase=starting` 显示遮罩，导致视觉上“主界面先出现，稍后才出现遮罩”
2. 主界面顶部失败条短暂误显
   - 启动早期存在短暂 `error`/状态抖动时，会先出现“网关失败 + 重启按钮”，随后又被启动遮罩覆盖，观感不稳定

本轮实现策略（已落地）：

1. 启动前准备态映射为展示层 `starting`
   - 在主进程增加 `preStartGatewayPrepInProgressCount` 计数
   - 当计数 > 0 且底层状态为 `ready` 时，`getDisplayedOpenClawStatus()` 返回展示态 `phase='starting'`
   - 文案为 `Starting AI engine: preparing startup...`，确保遮罩在预同步阶段也可见
2. 展示状态统一出口
   - `openclaw:engine:getStatus` 返回值改为 `getDisplayedOpenClawStatus(manager.getStatus())`
   - `did-finish-load` 的首次 `openclaw:engine:onProgress` 推送同样走 display-status 映射
   - 避免首帧收到“原始 ready”导致遮罩晚出现
3. 顶部错误条仅在稳定失败时展示
   - `CoworkView` 顶部状态条改为仅 `phase='error'` 才可显示
   - 增加 `1200ms` 延迟门槛：短暂抖动不展示失败条，减少误报闪现
4. 启动阶段浮层挂载前移
   - `EngineStartupOverlay` 不再依赖 Cowork 配置初始化完成后才订阅状态
   - 在 `App` 的 `!isInitialized` 与 `initError` 页面也挂载遮罩组件，保证启动早期可见

边界与语义约束：

- 仅优化“状态展示时机与稳定性”，不改变网关实际启动、重启、配置同步的业务语义
- 不改变模型/provider 选择与 `needsHardRestart` 判定规则
- 通过 `preStartGatewayPrepInProgressCount` 引用计数，避免并发 ensureRunning 下提前退出准备态

回归验收（新增）：

1. 启动日志中 `main-auto-ensure-running-dispatch` 之后，预同步阶段即可看到启动遮罩（不再必须等待 `startGateway` 才出现）
2. 启动过程中不再出现“顶部失败条先出现，随后被遮罩覆盖”的闪现
3. 在真实稳定失败场景（持续 `phase=error`）下，顶部失败条仍可正常出现，重启按钮可用
4. 多入口并发触发 ensureRunning 时，准备态遮罩不提前消失（计数归零后才退出）

#### 2.3 初始化失败策略（不使用「超时降级进壳」）

产品约束：**超时后仍进入主界面但大量功能不可用**的体验不可接受，因此不把「超时即忽略错误继续启动」作为首选方案。

推荐方向（与上述 P0/P1 一致）：

1. **消除阻塞源**：`store:set(app_config)` 非阻塞 + 启动期 sync 单飞/合并，降低 `store:get` 被拖慢的概率（治本）
2. **收紧竞态**：`configService.updateConfig` 全路径避免整包 `...config` 回写（例如 `i18n.setLanguage` 等残留点），减少无意义 `app_config` 写入与连锁 sync
3. **网络边界**：`fetchWithAuth` / refresh 加超时，避免弱网无限 pending 间接拖垮启动链路
4. **阈值与重试（可选）**：在阻塞明显缓解后，再评估是否仅对 `configService.init` 单独放宽超时或增加有限次自动重试（仍失败则保留错误页 + 重启按钮）

### 阶段 3（完整性收口）

1. `fetchWithAuth` 与 refresh 请求加超时（建议 10s）
2. 全量审计 `configService.updateConfig` 调用，清理整包回写模式
3. 清理 OpenClaw stale plugin entries，减少启动期配置噪声

---

## 验收标准

1. Windows 冷启动 30 次，不再出现初始化失败页
2. 即使 Gateway 启动偏慢，也能稳定出现 `initializeApp: shell ready`
3. `store:set(app_config)` 的 IPC 不再等待 config sync 完成
4. 在不改动 McpBridge 启动时机的前提下，`configService.init` 15s 超时失败率显著下降或归零（依赖 1～2 与阻塞消除）
5. 弱网场景下 auth 初始化不再无限挂起
6. 启动窗口内多路 sync 触发被收敛（可通过 reason 聚合日志证明 single-flight + dirty 生效）

---

## 后续核验清单（代码侧，与文档对齐）

| 项 | 当前风险 | 建议动作 |
|----|----------|----------|
| `store:set(app_config)` | 仍 `await syncOpenClawConfig` | 阶段 1：非阻塞 + 后台 sync + 错误日志 |
| `fetchWithAuth` | `net.fetch` 无超时 | 阶段 3：主请求与 refresh 均加 `AbortSignal.timeout` |
| `initializeApp` | `enterprise` / `auth` / `privacy` 无超时包装 | 视策略：先消阻塞再评估；若加超时须配合明确 UI/重试而非静默进壳 |
| `i18n.setLanguage` | 仍 `updateConfig({ ...config, language })` | 阶段 3：与其它路径一致，改为局部字段写入 |

---

## 验证方案

1. **冷启动回归（核心）**
   - Windows 冷启动 30 次，记录成功/失败与平均启动时长
   - 对比改造前后 `initializeApp FAILED` 发生率
2. **多路触发压测（验证 single-flight + dirty）**
   - 启动窗口内并发触发 `startup` + `app-config-change` + `skills-changed`
   - 期望：无并行执行；日志显示合并与补跑轮次符合预期
3. **弱网场景**
   - 限速/丢包下验证 auth 与 refresh 不无限挂起
   - 期望：失败可见、可恢复，不出现静默卡死
4. **可用性验证（不改 MCP 启动时机）**
   - 保持现有 MCP 启动行为，验证主界面可用与工具可用性
   - 期望：不因“延后 MCP”引入新的功能不可用窗口
5. **回归边界**
   - IM 启停、模型切换、技能启停后配置仍可最终收敛到最新状态
   - 期望：无长期配置漂移，无持续重启震荡
6. **MCP 启动期时序回归（本轮新增）**
   - 复现 `ensureRunning:mcpBridge` 在网关 `starting` 阶段触发配置更新
   - 期望：出现“queued after startup”与“post-start restart”日志，最终 MCP 工具可调用
7. **启动遮罩体验回归（本轮新增）**
   - 在触发 post-start restart 的场景下观察启动遮罩与文案
   - 期望：遮罩持续显示到第二阶段完成，不出现“先消失再出现”
   - 期望：第一/第二阶段文案可区分，第二阶段进度可从低百分比重新开始且不被误判为回退抖动
8. **启动前准备态可见性回归（本轮新增）**
   - 在 `main-auto-ensure-running-dispatch` 后、`startGateway` 前的准备窗口观察 UI
   - 期望：可见 `preparing startup` 文案遮罩，且首帧状态与后续推送一致
9. **错误条抑制回归（本轮新增）**
   - 启动过程注入短暂状态抖动（ready/error/starting 窗口）
   - 期望：短暂抖动不出现顶部失败条；稳定 error > 1.2s 后失败条出现

---

## 非本次范围

- **McpBridge 启动时机 / server 延后等 MCP 侧行为优化**（本轮明确不做）
- skill 同步逻辑的全面异步化重构
- OpenClaw 生命周期的大规模架构改造
- 与启动问题无直接关系的插件行为重构

