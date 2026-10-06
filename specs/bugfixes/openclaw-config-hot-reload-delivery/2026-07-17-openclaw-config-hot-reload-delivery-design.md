# OpenClaw 配置热载交付可靠性修复设计文档

## 1. 概述

### 1.1 问题

账号切换（或升级重启后重新登录）后，服务端模型列表整体更新。模型选择器立即展示新列表，但用户切换到新模型时报错：

```text
模型切换失败，请稍后重试。
```

等待数分钟或重启应用后，同样的切换又能成功。网关侧的真实错误是：

```text
sessions.patch ... errorCode=INVALID_REQUEST errorMessage=model not allowed: lobsterai-server/deepseek-v4-pro
```

注意与 `specs/bugfixes/openclaw-model-allowlist-switch/2026-05-22` 区分：那次的根因是 **allowlist 生成不完整**（只写了带 `customParams` 的模型），已修复。本次 `openclaw.json` 中的 allowlist 是**完整且正确的**，问题出在**运行中的网关从未应用这次写入**。

### 1.2 根因

2026-07-17 日志（`main-2026-07-17.log` / `gateway-2026-07-17.log`）还原的完整时间线：

| 时刻 | 事件 |
|---|---|
| 14:15:48 | media-entitlement 变更触发网关硬重启（第一次） |
| 14:16:18 | 又一次 media-entitlement 变更，再次硬重启，旧网关 SIGTERM |
| 14:16:25 | 新网关进程 spawn，14:16:26 `loading configuration…`（此时读到的是**旧模型表**） |
| 14:16:19 | 账号切换后 `Auth:getModels` 拉到新账号的 19 个模型，判定 `metadataChanged=true missingFromConfig=true` |
| 14:16:28.75 | 新网关 ready |
| 14:16:29.28 | `server-models-updated` sync 把 19 个新模型写入 `openclaw.json`（`top-level changed keys: models,agents`），因 `restartImpact=none` 走 `NO RESTART, hot-reload only` 分支——**该分支只写文件、直接返回 success，没有任何通知网关的动作** |
| 14:16:29 之后 | 网关日志**再无任何** `config change detected`（当天 10:38～14:15:48 期间该 watcher 正常触发过 7+ 次），说明这次写入被网关的文件监听漏掉了 |
| 14:19:42–59 | 用户切换模型，`sessions.patch` 按网关**内存中的旧 allowlist** 校验，连续拒绝 `deepseek-v4-pro` / `MiniMax-M3`；`deepseek-v4-flash` 恰好在旧表里所以能成功 |

分层归因：

1. **直接原因**：配置写入落在网关刚完成启动的窗口内（ready 后约 0.5 秒），网关文件 watcher 漏检（baseline 快照晚于写入，或 watcher 挂载晚于 ready——具体机理在 vendor 内部，无法也无需从 LobsterAI 侧确认）。
2. **结构缺陷**：`syncOpenClawConfig` 的热载分支（`src/main/main.ts` `NO RESTART, hot-reload only`）是"祈祷式"交付——写完文件就报告 success，把生效完全押在网关 watcher 上，**没有确认、没有重试、没有升级路径**。
3. **触发面**：`restartImpact` 仅对 `mcp` 键升级为重启（`openclawConfigSync.ts:2781`），`models`/`agents` 变更全部依赖热载。而升级、换号、entitlement 变更这类事件天然聚集在启动窗口附近（本次 41 秒内两次硬重启加一次配置写入），碰撞不是小概率巧合，是启动编排的固有时序。

### 1.3 为什么值得修（而不是保持现状）

现状的辩护点：故障非破坏性（切换失败但会话仍可用旧模型）、可自愈（下次重启/下次被 watcher 捕捉的写入）、watcher 在稳态下工作正常。

但三个结构性理由压过它：

1. **触发窗口叠在最高曝光时刻**。升级 → 重启 → 重新登录 → 切模型，是用户升级后的第一条操作路径；坏在这里对产品信任的伤害不成比例。
2. **同一条陈旧通道上还有一批"无报错"的隐性错配**：默认模型变更未生效（会话静默跑在旧模型上，成本/质量双重影响）、`contextWindow` 修正未生效（直接架空超窗压缩问题的根治方案，见 1.5）、`supportsImage`/显式缓存参数陈旧。这些今天没有任何可见症状。
3. **"过一会儿自己好了"是最昂贵的故障形态**：不可复现、用户无法理解、每次都要拉全套日志定位。

结论：修，且定位为修复**配置交付可靠性**这一通道级缺陷，而非只堵"切模型报错"这一个症状。

### 1.4 关键发现：网关存在事务式配置写入 RPC

阅读 pinned 运行时 dist（`vendor/openclaw-runtime/mac-arm64/dist/config-Czw8VbKe.js`）确认：

- `config.get`：返回**磁盘快照**（`readConfigFileSnapshot`）的脱敏视图及快照 hash。注意它**不反映网关内存态**，不能用作"是否已生效"的探针；但可提供乐观锁 `baseHash`。
- `config.set`：接收完整配置（`raw` 字符串）+ `baseHash` 乐观锁 → schema 校验 → secret refs 可解析性校验 → **网关自己落盘**（`commitGatewayConfigWrite` → `replaceConfigFile({ afterWrite: { mode: "auto" } })`）→ 按其内置 reload plan 处理后续。hash 不匹配时返回 `INVALID_REQUEST: config changed since last load`。
- `config.apply` / `config.patch`：额外带自主重启调度（`scheduleGatewaySigusr1Restart`），会与 LobsterAI 的 engineManager 进程监管相冲突，**不采用**。
- 网关内置 reload plan（`config-reload-plan-Dz0Yrapy.js`）中 `models`、`agents.defaults.models`、`agents.list` 均为 `kind: "hot"`——模型表变更本就是热载支持范围。

也就是说：**网关自己的写入管线不依赖文件 watcher，且带正向 ACK**。让运行中的网关通过 `config.set` 接收配置，watcher 盲区从机制上消失，无需任何轮询校验。

### 1.5 与超窗压缩问题的关系

同日定位的"LLM request failed（context_length_exceeded）+ 压缩卡 loading"问题，其根治方案是校准模型 `contextWindow` 配置——校准值正是通过本通道下发。通道不可靠时，校准"修了但没生效"且无任何报错。本修复是那个根治方案的前置依赖。

## 2. 用户场景

### 场景 1：账号切换后立即切换模型（本次事故）

**Given** 网关正在运行，用户从企业账号切换到个人账号，服务端模型列表整体翻新
**When** `Auth:getModels` 触发 `server-models-updated` sync，用户随即在会话底部切换到新列表中的模型
**Then** `sessions.patch` 应成功，不出现 `model not allowed`；网关不因此硬重启，活跃会话不中断

### 场景 2：聊天过程中服务端上新模型

**Given** 网关正在运行且有活跃会话在流式输出
**When** 常规 `getModels` 刷新发现模型列表变化并触发 sync
**Then** 配置在秒级生效（热载），活跃会话不被打断，不触发网关重启

### 场景 3：配置变更落在网关启动窗口

**Given** 网关处于 starting 阶段（已 spawn、尚未 ready）
**When** 一次 `changed=true` 的热载级 sync 到来
**Then** 交付层有界等待网关 ready 后通过 RPC 交付；等待超时则回退文件直写并调度延迟重启，最终必然收敛

### 场景 4：RPC 通道不可用时的降级

**Given** 网关 phase=running 但 RPC 调用失败（超时、hash 冲突重试仍失败、schema 校验失败）
**When** 交付层用尽 RPC 路径
**Then** 回退为文件直写 + `scheduleDeferredGatewayRestart`（带限频闸），行为不劣于现状，且日志明确记录降级原因

### 场景 5：不该受影响的路径保持不变

**Given** secret env vars / IM bindings / `mcp` 键发生变化，或调用方显式要求重启
**When** sync 执行
**Then** 仍走现有"文件写入 + 硬重启"路径，本修复不改变 `needsHardRestart=true` 分支的任何行为

## 3. 功能需求

### FR-1：运行中网关的配置变更必须有生效确认

`changed=true` 且网关 running 且 `needsHardRestart=false` 时，交付必须以下列之一收尾：

- `config.set` 返回 `ok: true`（正向 ACK），或
- 降级路径已落盘文件且已调度延迟重启。

不允许出现"写完文件即报告 success、生效与否听天由命"的第三种状态。

### FR-2：交付层按网关状态分流

| 网关状态 | 交付方式 |
|---|---|
| stopped / 不存在 | 文件直写（现状不变，启动时网关自行加载） |
| running | `config.get` 取 `baseHash` → `config.set(raw, baseHash)` |
| starting | 有界等待 ready（复用现有 `ensureGatewayClientReady` 语义，上限约 15s）后走 running 路径；超时走降级 |

### FR-3：配置内容来源不变，config.get 仅供 baseHash

发送给 `config.set` 的完整配置必须来自 LobsterAI 本地生成的 managedConfig 合并结果（现有 `openclawConfigSync` 逻辑），**严禁**把 `config.get` 返回的脱敏快照（含 `***` 占位）回写——那会破坏 `gateway.auth` 等真实秘密字段。

### FR-4：降级链路与防环闸

RPC 失败的处理顺序：

1. `baseHash` 冲突（并发写）：重新 `config.get` → `config.set`，最多重试 1 次；
2. 仍失败 / 超时 / 校验错误：文件直写（幂等，内容与 RPC 版相同）+ `scheduleDeferredGatewayRestart(reason='config-delivery-fallback')`；
3. 自动重启限频：同 reason 的自动升级重启 10 分钟内至多一次，防止校验类系统性错误导致重启循环；
4. schema / secret refs 校验失败要打 `console.error`——这说明 LobsterAI 生成了网关不认的配置，是需要独立跟进的生成层 bug 信号。

### FR-5：needsHardRestart 分支零改动

secret env 变化、bindingsChanged、`mcp` restartImpact、显式 `restartGatewayIfRunning` 的行为完全保持现状。本修复只替换 `NO RESTART, hot-reload only` 分支的交付方式。

### FR-6（可选增强，默认暂缓）：模型切换失败点击自愈

`patchSession` 收到 `model not allowed` 且该模型存在于 `getAllServerModelMetadata()` 时，触发一次 sync 并在有界等待（≤10s）后自动重试一次 `sessions.patch`。有 FR-1～FR-4 之后此层价值仅剩极小的残留竞态窗口，建议先不做，观察一个版本周期再定。

## 4. 实现方案

### 4.1 前置确认（P0，动手写代码前完成，约半天）

以下事实来自对 minified dist 的静读，需用运行中的网关做两组实验坐实：

1. **热载语义**：网关 running 且内存配置为 X 时，`config.set` 内容 Y（含新增 lobsterai-server 模型）→ 验证网关日志出现 hot reload 应用记录，且 `sessions.patch` 立即接受 Y 中的新模型、无需重启。
2. **幂等边界**：`config.set` 与磁盘内容完全相同的 Y → 验证无害 no-op（不报错、不重启）。这决定降级路径中"先 RPC 后文件写"与"先文件写后 RPC"的顺序约束——**若网关的 reload diff 以磁盘快照为基线，则 running 状态下绝不能先直写文件再 RPC**（diff 为空会吞掉本应触发的热载），交付顺序必须是 RPC 优先、文件直写仅作 stopped/降级路径。
3. **参数契约**：确认 `config.get` 响应中 hash 字段名与 `config.set` 的 `baseHash` 参数名（`resolveBaseHashParam` / `validateConfigSetParams`）、`raw` 的格式要求（JSON/JSON5）。
4. **格式往返**：网关 `replaceConfigFile` 落盘后的文件，再被 LobsterAI 下次 sync 读取时不产生伪 diff（现有 diff 是语义级 deep-diff，预期无影响，验证一轮即可）。

若实验 1 不成立（pinned 版本的 `config.set` 不触发热载），退回**方案 B**：保留文件直写，写后 3~5 秒用语义探针（如 `agents.list` 中的活动模型目录）校验生效，未生效则补写一次 `meta.lastTouchedAt` 制造 watcher 边沿，再未生效升级 `scheduleDeferredGatewayRestart`。方案 B 的收敛保证弱于方案 A（依赖探针的可得性），仅作兜底记录。

#### P0 结论（2026-07-20 实验追记）

用 pinned 运行时（2026.6.1）+ 隔离 state dir 起真实网关完成了全部四项确认：

1. **热载语义成立，且强于预期**：`config.set` 在**响应 `ok` 之前**就同步完成 reload 评估与热载应用（网关日志 `config change detected` → `config hot reload applied` → `res ✓ config.set`，全程 111ms）。`sessions.patch` 对新模型从 `model not allowed` 变为接受，全程同一进程、无重启。ACK 即生效。
2. **幂等边界安全**：相同内容重复 `config.set` 返回 ok、无害 no-op。更关键的发现：读 `server-reload-handlers` 源码确认 **reload diff 的基线是网关内存中上次应用的配置（`currentCompareConfig`），不是磁盘文件**。因此"先写文件、再 config.set 同内容"依然会正确触发热载（live 落后即有 diff）——4.2/4.3 原设计中"延后落盘"的约束不成立，实施采用了更简单的**先落盘、后 RPC 推送**方案（见 4.2 修订）。
3. **参数契约**：`config.get` 无参数，响应含 `hash`（string）、`exists`、`valid` 及脱敏后的 `config`/`raw`；`config.set` 参数 `{ raw: string, baseHash?: string }`（schema 层 optional，但文件存在时 `requireConfigBaseHash` 强制要求）；`raw` 走 JSON5 解析，纯 JSON 兼容。陈旧 hash 报 `INVALID_REQUEST: config changed since last load; re-run config.get and retry`。
4. **格式往返安全**：网关落盘文件中真实秘密（`gateway.auth.token`）完好，仅 RPC **响应**做脱敏（`__OPENCLAW_REDACTED__`）；语义级 deep-diff 不受键序/格式影响。

#### 4.2/4.3 实施修订（依据 P0 结论 2）

由于 reload diff 基线是内存活动配置，交付层无需接管落盘，最终实现比原设计更简：

- `openclawConfigSync.sync()` **零改动**——照旧生成并原子写盘；企业合并（`mergeEnterpriseOpenclawConfig`）照旧在 sync 后执行，交付内容取**合并后的最终磁盘文件**，企业模式自动被覆盖；
- 新模块 `deliverOpenClawConfigToGateway()`（`src/main/libs/openclawConfigDelivery.ts`）：phase ∈ {running, starting} 时读最终文件内容 → `config.get` 取 `baseHash` → `config.set`；hash 冲突自动重取重试 1 次；RPC 失败/客户端不可用/文件读取失败 → `scheduleDeferredGatewayRestart('config-delivery-fallback:<reason>')`，10 分钟限频闸防环；phase 其余状态 → skipped（文件在下次启动时被读取）；
- `_syncOpenClawConfigImpl` 的 `NO RESTART` 分支：`changed=true` 时调用交付层并记录 `mode=rpc|skipped|fallback`；`changed=false` 直接返回；
- 适配器新增公开方法 `ensureGatewayRpcClient()`（包装既有私有 `ensureGatewayClientReady`，失败返回 null 不抛错），复用其"确保引擎运行 + 创建/复用客户端 + 握手"的全部串行化逻辑，`starting` 状态的有界等待由它天然覆盖；
- watcher 正常抢先应用时，config.set 的 diff 为空 → 无害 no-op（P0 结论 2 实证）。

### 4.2 新模块：`src/main/libs/openclawConfigDelivery.ts`

职责单一：把"已生成的配置内容"可靠交付给网关。

```typescript
export type ConfigDeliveryResult =
  | { mode: 'rpc'; applied: true }
  | { mode: 'file'; applied: true }            // 网关未运行，启动时自然加载
  | { mode: 'fallback'; applied: false; restartScheduled: boolean; reason: string };

export async function deliverOpenClawConfig(input: {
  serializedConfig: string;          // openclawConfigSync 生成的完整配置
  gatewayPhase: OpenClawEnginePhase;
  getGatewayClient: () => GatewayClientLike | null;
  writeConfigFile: () => Promise<void>;   // 现有文件直写逻辑的注入
  scheduleDeferredRestart: (reason: string) => void;
}): Promise<ConfigDeliveryResult>;
```

内部实现要点：

- running：`config.get`（取 baseHash）→ `config.set`；hash 冲突重试 1 次；
- starting：`await ready`（上限 15s）后同上；
- stopped：`writeConfigFile()`；
- 任何 RPC 失败：`writeConfigFile()` + 限频调度重启，返回 `fallback`；
- 限频闸状态保存在模块级（同 reason 10 分钟窗口）；
- 全程结构化日志：`[ConfigDelivery] mode=rpc|file|fallback reason=... elapsedMs=...`，让未来任何一次交付异常都有据可查。

### 4.3 改造 `_syncOpenClawConfigImpl`（`src/main/main.ts`）

现状（约 2195 行起）：

```typescript
if (!needsHardRestart) {
  console.log(`${D()} ──── NO RESTART, hot-reload only. reason=${options.reason}`);
  return { success: true, changed: syncResult.changed };
}
```

改为：`syncResult.changed === true` 时调用 `deliverOpenClawConfig` 并把交付结果并入返回值与日志；`changed === false` 时维持直接返回（无变更无交付）。

配套调整 `openclawConfigSync.sync()` 的写文件时机：running 状态下生成但**不落盘**，由交付层决定落盘方（网关 RPC 自落盘 / LobsterAI 直写）。这是本次改动里侵入性最高的一处，需注意与 sync 内部"读取既有文件做 diff/保留 gateway 自有 section"逻辑的先后关系——diff 基线仍是磁盘现状，仅"写"这一步延后移交。

### 4.4 明确不做

- **models/agents 变更一律升级为硬重启**：`getModels` 在聊天后、配额刷新时高频触发，模型表有变就重启会打断活跃会话与 IM 通道。RPC 交付失败时的延迟重启是它的正确子集。
- **现在就 patch OpenClaw 的文件 watcher**：失效机理仍是推测，且本仓库 patch 政策要求优先使用 LobsterAI 侧挂点；`config.set` 就是那个挂点。交付层日志会把每次 watcher 失效变成有据可查的事件，若未来证明高频复现，再拿实证去做 version-scoped patch。
- **`config.apply`/`config.patch`**：其自主 SIGUSR1 重启会与 engineManager 的进程监管状态机冲突。重启决策权必须留在 LobsterAI 侧。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 网关 stopped | 文件直写，现状不变 |
| 网关 starting，15s 内 ready | 等待后 RPC 交付 |
| 网关 starting，等待超时 | 文件直写 + 限频延迟重启 |
| `baseHash` 冲突（网关或他方并发写文件） | 重取 hash 重试 1 次，再失败走降级 |
| `config.set` schema/secret 校验失败 | 降级 + `console.error`（生成层 bug 信号） |
| RPC 超时但网关实际已应用 | 降级路径文件内容相同（幂等）；延迟重启多一次，由限频闸约束 |
| 同 reason 降级重启被限频拦下 | 记 warn 日志；下次 sync 或手动重启收敛 |
| secret env / bindings / mcp 变更 | 不进交付层，`needsHardRestart` 路径现状不变 |
| sync 串行队列中有更新的 sync 排队 | 交付层跟随现有串行链（`startAfterPrevious`），天然不交叠 |
| 修复上线前已存在的 file-vs-live 分歧 | 首次真实配置变更经 RPC 交付即收敛；不做主动扫描 |
| 网关落盘格式与 LobsterAI 直写格式差异 | 语义级 deep-diff 不受键序/格式影响（P0-4 验证）；若有伪 diff，多一次幂等交付，无功能影响 |
| IM sync、设置保存等既有调用方 | 交付层封装在 `syncOpenClawConfig` 内部，调用方零改动 |

## 6. 涉及文件

核心代码：

- `src/main/libs/openclawConfigDelivery.ts`（新增）：RPC 交付、降级链、限频闸
- `src/main/main.ts`：`_syncOpenClawConfigImpl` 热载分支接入交付层
- `src/main/libs/openclawConfigSync.ts`：running 状态下延后落盘（生成逻辑不变）
- `src/main/libs/openclawEngineManager.ts`：phase 查询 / gateway client 获取（预期只读复用）

测试：

- `src/main/libs/openclawConfigDelivery.test.ts`（新增）
- `src/main/libs/openclawConfigSync.runtime.test.ts`（回归）

相关历史文档：

- `specs/bugfixes/openclaw-model-allowlist-switch/2026-05-22-openclaw-model-allowlist-switch-fix-design.md`（同症状、不同根因：allowlist 生成不完整）
- `specs/bugfixes/settings-openclaw-config-impact/2026-05-20-settings-openclaw-config-impact-classification-design.md`（none/sync/restart 影响分级；本文修复 `sync` 级的交付可靠性）
- `specs/bugfixes/gateway-restart-on-agent-model-switch/2026-05-19-gateway-restart-on-agent-model-switch-design.md`

## 7. 测试计划

### 单元测试（`openclawConfigDelivery.test.ts`，mock gateway client）

1. running + RPC ok → `mode=rpc`，不写文件、不调度重启；
2. running + 首次 hash 冲突、重试成功 → `mode=rpc`，恰好两次 `config.get`；
3. running + RPC 连续失败 → `mode=fallback`，文件已写、重启已调度；
4. 10 分钟内第二次同 reason 降级 → 重启不再调度（限频闸），warn 日志存在；
5. starting 超时 → 降级路径；stopped → `mode=file`；
6. `config.set` 载荷为本地生成配置原文，未混入 `config.get` 的脱敏字段（防秘密破坏的回归锚点）。

### 集成/手工验证

1. **P0 实验 1/2**（见 4.1）在 `npm run electron:dev:openclaw` 环境完成并记录结论；
2. 复现事故时序：登录账号 A → 触发一次网关硬重启后 3 秒内切换账号 B → 立即在已有会话切换 B 独有的模型 → 预期成功且网关日志无 `model not allowed`；
3. 聊天进行中触发 `getModels` 变更 → 活跃会话不中断，新模型秒级可切；
4. 手动 kill 网关进程模拟 RPC 不可用 → 观察降级日志与延迟重启收敛；
5. 修改 provider API key（secret env 路径）→ 确认仍硬重启，行为与修复前一致。

## 8. 验收标准

1. 事故复现时序下，配置写入后 5 秒内 `sessions.patch` 接受新模型，全程无网关重启；
2. `changed=true` 的热载 sync 之后，系统必然处于"RPC ACK 已收到"或"降级已落盘且重启已调度/已限频记录"两种状态之一，不存在无确认的第三态；
3. secret env / bindings / mcp / 显式重启路径行为与修复前逐一致；
4. RPC 通道整体不可用时，行为不劣于现状（文件写入 + 最迟一次延迟重启内收敛），且无重启循环；
5. 每次交付在主日志留下单行可检索记录（mode/reason/耗时），"过一会儿自己好了"类工单可凭日志直接归因；
6. 新增单测全绿，`openclawRuntimeAdapter` / `openclawConfigSync` 既有测试无回归，改动文件通过 CI 同款 eslint。

## 9. 工作量与风险

- P0 前置确认：约半天（两组实验 + 参数契约核对）；
- 交付层实现 + 单测：约一天；
- 主要风险：`openclawConfigSync.sync()` 延后落盘涉及既有 diff/section-保留逻辑的时序，需小步改造并靠既有 runtime test 护栏；若 P0 实验推翻 `config.set` 热载假设，切换到 4.1 的方案 B，交付层接口不变、仅内部实现替换。
