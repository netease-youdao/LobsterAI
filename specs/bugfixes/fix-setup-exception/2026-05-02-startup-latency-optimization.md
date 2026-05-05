# 启动耗时优化（跨平台）

## 目标

在 **macOS + Windows** 双平台降低启动耗时，并保持现有业务语义不变：

- 不影响 OpenClaw / MCP / IM 可用性
- 不改变模型 / provider 同步语义
- 不修改数据库结构与迁移行为

## 问题定义

当前应用启动到 OpenClaw 网关可用仍有较长窗口。  
macOS 通常比 Windows 更快，但两端共享同一启动链路，瓶颈类型一致。

现阶段启动耗时主要分为两段：

1. `startGateway()` 前的准备窗口
2. OpenClaw 网关自身启动阶段（`pluginBootstrap`、`postAttachRuntime`）

其中第一段是当前 LobsterAI 代码侧最可控、收益最确定的优化空间。

## 现象证据（摘要）

近期日志共同特征：

- `main-auto-ensure-running-dispatch` 很早触发
- `ensure-running-start-gateway` 被较长 pre-start 阶段延后
- pre-start 阶段存在重复/叠加工作：
  - 等待 `pendingTokenRefresh`
  - `startMcpBridge()`
  - 多个 reason 触发的 `syncOpenClawConfig()`

## 非目标

- 不做 OpenClaw 架构级重构
- 不改变 MCP 产品行为（不禁用 bridge 启动）
- 不放松正确性约束（例如硬重启判定语义）

## 可优化项（按优先级）

### P0：`ensureOpenClawRunningForCowork` 全链路 single-flight

范围：

- 同一时刻仅允许一个完整 ensure-running 流程执行
- 并发调用复用同一个 in-flight promise（如 `ensure-running-for-cowork`、`channel-sync-ensure-ready`）

预期收益：

- 消除 pre-start 阶段重复工作
- 降低 macOS / Windows 两端 pre-start 抖动

风险：

- 必须保持现有错误传播与重试语义

### P1：`pendingTokenRefresh` 等待上限

范围：

- 将无上限等待改为有限等待（例如 800~1500ms）
- 超时后 refresh 后台继续，不阻塞网关启动主链路

预期收益：

- 避免网络波动拖慢启动关键路径

风险：

- 需防止引入“使用旧 token 启动”的行为回退

实施与验证结论（已完成）：

- 已实现有界等待：`PENDING_TOKEN_REFRESH_WAIT_TIMEOUT_MS = 3000`
- 已验证链路：`awaiting pending token refresh` → `timeout continue` → `token refresh succeeded` → `token-refresh:* sync`
- 结论：超时后网关会继续启动；refresh 在后台完成后会触发补偿同步，不阻塞主启动链路
- 验证期间使用的调试开关代码已全部清理，不进入正式逻辑

### P1：启动窗口内 sync reason 分层调度

范围：

- 关键 reason 立即执行（`startup`、`ensureRunning:*`）
- 非关键 reason 延后到网关 running 后处理

预期收益：

- 缩短首次 `startGateway` 前的队列排空时间

风险：

- 必须保证延后任务不丢失

### P2：MCP bridge 启动成本分析（本阶段仅分析不改行为）

范围：

- 量化 `npx` 启动与 tools discovery 的耗时占比
- 评估 callback/端口变化导致的 config churn 成本

预期收益：

- 为后续优化提供数据依据

风险：

- 若直接改行为风险中高；当前阶段仅做分析

## 实施顺序

1. P0：ensure-running 全链路 single-flight
2. P1：token refresh 有界等待
3. P1：启动窗口 sync reason 分层
4. P2：MCP bridge 成本深挖

## 验证方案

每个步骤完成后执行：

1. 双平台冷启动：
   - macOS：10 次
   - Windows：20~30 次（波动更大，作为主验收基线）
2. 记录关键时间点：
   - `main-auto-ensure-running-dispatch` → `ensure-running-start-gateway`
   - `startGateway` → running
   - `main-auto-ensure-running-complete` 总耗时
3. 回归验证：
   - MCP 工具可调用
   - IM 通道可正常连接
   - 模型 / provider 切换后配置仍可正确收敛
   - 无持续重启抖动

## 退出标准

- 双平台 pre-start 中位耗时均明显下降（目标：至少 20~30%）
- Windows 启动稳定性不低于当前基线
- MCP / IM / 模型链路无功能回归
- 启动日志无新增持续错误与重启震荡

## 基线样本（已记录）

### 样本 S1（来自启动日志 `monnx1qs-ly3znj`）

关键时间点（OpenClawStartupTrace）：

- `main-auto-ensure-running-dispatch`：`+763ms`
- `ensure-running-start-gateway`（首次）：`+14965ms`
- `main-auto-ensure-running-complete`：`+30254ms`
- `startGateway: gateway is running, total startup time`：`15287ms`

分段耗时：

1. **Pre-start 窗口**（dispatch → first start-gateway）
   - `14965 - 763 = 14202ms`
2. **Gateway 启动窗口**（first start-gateway → ensure-running-complete）
   - `30254 - 14965 = 15289ms`
3. **Ensure-running 总时长**（dispatch → ensure-running-complete）
   - `30254 - 763 = 29491ms`

初步结论：

- pre-start 与 gateway 启动两段耗时规模接近（各约 15s）
- 代码侧优先优化 pre-start（更可控、回归风险更低）
- 当前波动主因仍是 MCP bridge 启动阶段（约 11~20s 区间），后续优先做 P1/P2 的启动窗调度与成本拆分

## 日志采样模板（后续每轮都用）

每次优化后按同一模板记录 1 行（建议至少 10 次）：

| 样本ID | traceId | dispatch(ms) | firstStartGateway(ms) | ensureComplete(ms) | gatewayRunning(ms) | preStart(ms) | gatewayBoot(ms) | totalEnsure(ms) | 备注 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| Sx | `...` |  |  |  |  |  |  |  |  |

计算口径（必须固定）：

- `preStart = firstStartGateway - dispatch`
- `gatewayBoot = ensureComplete - firstStartGateway`
- `totalEnsure = ensureComplete - dispatch`

日志关键字（必采）：

- `main-auto-ensure-running-dispatch`
- `ensure-running-mcp-bridge-ready`
- `ensure-running-sync-complete`
- `ensure-running-start-gateway`
- `main-auto-ensure-running-complete`
- `startGateway: gateway is running`

