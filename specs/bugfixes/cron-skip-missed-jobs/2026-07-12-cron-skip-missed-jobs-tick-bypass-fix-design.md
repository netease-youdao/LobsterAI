# 「跳过未执行任务」失效导致启动后补跑定时任务修复 Spec

## 1. 概述

### 1.1 问题

用户在设置中开启「跳过未执行任务」(`skipMissedJobs`) 后，每次启动 LobsterAI，仍然会出现：

1. 所有在应用关闭期间「错过时间点」的定时任务，在 gateway 就绪后约 5 秒被**同一时刻全量补跑**；
2. 补跑的资讯类任务（如「科技早报」）调用 OpenClaw `browser` 工具搜索网页，拉起一个可见的 headful Chrome 窗口——用户直观感受是「应用一启动浏览器就自己弹出来」；
3. 补跑任务执行成功，但结果推送**全部丢失**（`lastDeliveryStatus: not-delivered`），用户在 IM 里看不到任何新消息；
4. 每次启动白白消耗模型 token（实测单个任务 prompt 约 4.5 万 token × 多轮 × 多个任务），零产出。

2026-07-12 实测证据链（macOS，打包版 2026.7.10，OpenClaw v2026.6.1）：

```
21:09:40  LobsterAI started
21:09:48  [gateway] http server listening
21:09:53  三个过期任务同一秒 action:started
          - 科技早报        原定 15:07（agentTurn，delivery→微信群）
          - 测试 popo       原定 15:36（agentTurn，delivery→POPO 群）
          - 变更监控任务      原定 12:03（systemEvent，每 2 小时）
21:10:00  科技早报连续调用 browser 工具
          [browser/chrome] openclaw browser started (chrome) profile "openclaw" ... pid 26262
21:10:03  [cron:6c87c835] skipping stale delivery scheduled at 15:36, started 334m late
          → 推送被 OpenClaw stale-delivery 保护丢弃，deliveryStatus=not-delivered
```

当时生成的 `openclaw.json` 中 `cron.skipMissedJobs: true` 确认已写出且 schema 校验通过；同一配置对象的 `maxConcurrentRuns: 3` 明显生效（恰好并发 3 个），排除配置未注入的可能。

### 1.2 现状链路

`skipMissedJobs` 是 LobsterAI 通过版本化 patch 给 OpenClaw 增加的能力，完整链路：

1. 渲染层设置 →`cowork_config.skipMissedJobs`（`src/main/coworkStore.ts`，默认 `true`）。
2. `src/main/libs/openclawConfigSync.ts:1922` 写出 `cron.skipMissedJobs` 到 `openclaw.json`。
3. `scripts/patches/v2026.6.1/openclaw-cron-skip-missed-jobs.patch` 修改 OpenClaw 三处：
   - `src/config/types.cron.ts` / `src/config/zod-schema.ts`：类型与 schema 接受该字段；
   - `src/cron/service/timer.ts` 的 `planStartupCatchup()`：配置为 `true` 时打日志并返回空计划
     （`return { candidates: [], deferredJobs: [] }`）。
4. OpenClaw cron service 的 `start()`（`src/cron/service/ops.ts`）调用 `runMissedJobs()` →
   `planStartupCatchup()`，即 patch 只拦截了「启动补跑专用通道」。

### 1.3 根因

三个机制叠加，patch 被 OpenClaw 常规调度循环整体绕过：

1. **patch 的 skip 分支只返回空计划，不推进过期任务的 `nextRunAtMs`。**
   跳过 catch-up 后，过期任务的 `nextRunAtMs` 原样留在 store 里（停在过去）。

2. **上游「反静默跳过」机制有意保留过期时间戳。**
   `recomputeNextRunsForMaintenance()`（`src/cron/service/jobs.ts`）对「slot 未执行」
   （`lastRunAtMs < nextRunAtMs`）的任务显式不推进，注释为
   *"Otherwise preserve the past-due value so the job can still run"*（上游 #13992、#16156）。
   因此 `start()` 尾部带 `recomputeExpired: true` 的维护性重算也不会解救。

3. **常规 tick 对「到期」没有迟到上限。**
   `onTimer()` → `collectRunnableJobs()` → `isRunnableJob()`（`src/cron/service/timer.ts`）
   判定 `nowMs >= nextRunAtMs` 即 runnable——迟到 6 小时和迟到 1 秒无区别。
   启动后第一次 tick 就把所有过期任务当作到期任务批量执行。

**行为指纹佐证走的是 tick 而非 catch-up 通道**：若走 catch-up，agentTurn 任务会被延迟
2 分钟（`DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS = 2*60_000`）且日志会出现
"running missed jobs after restart" / "deferring missed agent jobs"；实际三个任务
（2 个 agentTurn + 1 个 systemEvent）同一秒起跑、无任何 catch-up 日志。

净效果比不打 patch 更糟：任务一个不少地补跑，还失去了 catch-up 通道原有的
「每次重启最多补 `maxMissedJobsPerRestart`(默认 5) 个 + agentTurn 延迟 2 分钟」保护。

### 1.4 关联现象（本次不修，需知悉）

- **补跑推送被丢弃**是 OpenClaw 内置的 stale-delivery 保护（迟到超过阈值的 announce 丢弃，
  日志 `skipping stale delivery ... started 334m late`）。它掩盖了补跑的存在感（用户只看到
  浏览器弹窗、看不到推送），但本身是合理防线——修复本 bug 后开着开关的用户不再触发它。
  关着开关希望「补跑 + 补推送」的用户仍会被该阈值丢推送，属于独立的产品语义问题，不在本次范围。
- 现有测试 `src/main/libs/openclawPatches/cronSkipMissedJobs.test.ts` 只断言 patch 文件
  **文本**包含关键字，无法发现此类行为级失效（见 FR-5）。

## 2. 用户场景

### 场景 A: 开启开关后启动应用不补跑

**Given** 「跳过未执行任务」开启，存在每天 15:07 执行的定时任务，应用整个下午处于关闭状态
**When** 用户 21:09 启动 LobsterAI
**Then** 该任务不执行（不弹浏览器、不消耗 token、无 IM 推送），其下次执行时间被推进到明天 15:07；日志记录跳过明细。

### 场景 B: 关闭开关时保持现有补跑行为

**Given** 「跳过未执行任务」关闭，存在多个错过的任务
**When** 用户启动 LobsterAI
**Then** 走 OpenClaw 原生 startup catch-up：最多立即补 `maxMissedJobsPerRestart` 个，agentTurn 任务延迟约 2 分钟，行为与修复前的关闭态完全一致。

### 场景 C: 运行中正常到点执行不受影响

**Given** 应用持续运行，任务 `0 */2 * * *` 到达整点
**When** timer tick 触发
**Then** 任务正常执行、正常推送，与开关状态无关。

### 场景 D: 运行中的「小迟到」不受影响

**Given** 应用持续运行，某长任务占用调度导致下一个任务晚了 1~2 分钟才被 tick 捞到
**When** tick 执行该任务
**Then** 照常执行。修复不得给常规 tick 引入迟到窗口判定。

### 场景 E: 错过的一次性任务（`at`）

**Given** 用户设置了「今天 15:00 提醒我一次」的一次性任务，15:00 时应用关闭
**When** 用户 21:09 启动应用
**Then** 该一次性任务不受本开关影响，仍按现有 catch-up 语义补跑——用户显式设定的单次提醒被静默吞掉伤害更大。（产品已确认，2026-07-12）

### 场景 F: 任务执行中途 gateway 重启

**Given** 某任务正在执行时 gateway 被重启（`state.runningAtMs` 残留）
**When** cron service `start()` 运行
**Then** 沿用现有 `markInterruptedStartupRun` 中断标记逻辑；skip 快进逻辑必须排除 `runningAtMs` 残留的任务，不得将其 `nextRunAtMs` 推走。

## 3. 功能需求

### FR-1: 开关开启时，启动时刻已过期的周期任务必须被真正跳过

`skipMissedJobs === true` 时，cron service `start()` 完成后：

1. 所有已启用、非运行中、`nextRunAtMs <= now` 的周期任务（`schedule.kind` 为 `cron` / `every`），其 `nextRunAtMs` 必须被推进到**从当前时刻起的下一个正常时点**（跨多个错过 slot 时直接跳到未来最近一个，不逐个补）；
2. 推进结果必须在首次常规 tick 之前完成并持久化（利用现有时序保证：`runMissedJobs()` 在 scheduler 开始服务常规 tick 之前执行，见 `ops.ts` 中 start 流程注释）；
3. 覆盖 `isRunnableJob` 的两种 missed 判定：`nextRunAtMs` 过期，以及 `allowCronMissedRunByLastRun` 语义下 `lastRunAtMs < previousRunAtMs` 的 missed slot。

### FR-2: 不得修改常规 tick 判定路径

`onTimer()` / `collectRunnableJobs()` / `isRunnableJob()` / `recomputeNextRunsForMaintenance()` 的现有语义一律不动：

- 不引入「迟到窗口」；
- 不改变上游反静默跳过（#13992/#16156）的维护性重算行为。

修复只发生在 `planStartupCatchup()` 的 skip 分支内（含其调用的快进 helper）。

### FR-3: 开关关闭时行为零变化

`skipMissedJobs` 为 `false`/未设置时，`planStartupCatchup()` 走原逻辑，catch-up 限流、agentTurn 延迟、interrupted-run 处理全部不变。

### FR-4: 跳过行为必须可观测

skip 分支执行时以 info 级日志输出：跳过的 job 数量、每个 job 的 `id`/`name`、原 `nextRunAtMs`、推进后的 `nextRunAtMs`。cron event 流如可行则同步发出等价事件，便于 LobsterAI 端未来在任务运行历史中展示「已跳过 N 次」。

### FR-5: 行为级测试兜底

- patch 内为 OpenClaw `src/cron/service/timer.regression.test.ts`（或新建同级测试文件）增加行为用例：`skipMissedJobs=true` + 过期 job → `start()` + 首次 tick → 任务未执行且 `nextRunAtMs` 已推进到未来；`skipMissedJobs=false` → 原 catch-up 行为。
- LobsterAI 侧 `cronSkipMissedJobs.test.ts` 的文本断言同步更新，至少覆盖「skip 分支包含快进调用」的关键代码行，防止未来 rebase patch 时把快进逻辑丢掉。

### FR-6: 一次性任务不受本开关影响

`at` 任务（含 `deleteAfterRun`）不参与跳过：开关开启时，错过的一次性任务仍按现有 catch-up 语义补跑（理由见场景 E，产品已确认）。skip 分支只快进周期任务（`cron` / `every`），并将 missed 集合中的 `at` 任务保留为 catch-up candidates 放行。该语义需在 patch 注释中说明。

## 4. 实现方案

### 4.1 修订 patch：skip 分支快进过期任务

重写 `scripts/patches/v2026.6.1/openclaw-cron-skip-missed-jobs.patch` 中 `planStartupCatchup()` 的 skip 分支。当前实现在 `ensureLoaded()` **之前**就 return，store 尚未加载；修订后的分支需要：

```text
if (cronConfig.skipMissedJobs === true) {
  await ensureLoaded(state, { skipRecompute: true });   // 先加载 store
  const missed = collectRunnableJobs(state, now, {      // 复用现有 missed 判定
    skipJobIds: opts?.skipJobIds,                       // 排除 interrupted 任务
    skipAtIfAlreadyRan: true,
    allowCronMissedRunByLastRun: true,
  });
  const fastForwarded = <对 missed 中 schedule.kind !== 'at' 的任务>
    强制以 now 为基准重算 nextRunAtMs（越过过期 slot）;
  if (fastForwarded.length > 0) await persist(state);
  log.info({ count, jobs: [...] }, "cron: skipping missed jobs after restart");
  return { candidates: <missed 中的 at 任务，按原 catch-up 语义放行>, deferredJobs: [] };
}
```

关键点：

- **推进必须「强制从 now 重算」**，不能复用维护性重算（它会保留 past-due 值）。OpenClaw 已有
  `recomputeJobNextRunAtMs({ state, job, nowMs })` 一类 helper，需确认其对「slot 未执行」任务
  是否同样保留过期值；若是，则在 skip 分支内直接按 schedule 从 `now` 计算下一时点写回
  （`cron` 表达式含 `staggerMs` 的要保持 stagger 语义，`every` 类按 anchor 对齐）。
- 整个分支在现有 `locked(state, ...)` 内执行，天然与其他 store 操作互斥。
- `at` 任务不快进：从 `missed` 中拆出后作为 candidates 返回，按原 catch-up 语义放行（FR-6）。
  `collectRunnableJobs` 已带 `skipAtIfAlreadyRan: true`，只有从未执行或处于 error-retry 的
  一次性任务会进入 missed 集合，语义正好吻合。

### 4.2 不动的部分

- `src/main/libs/openclawConfigSync.ts`：配置写出已正确，无改动。
- `coworkStore` / 渲染层设置 UI / i18n：无改动。
- OpenClaw tick 路径与维护性重算：无改动（FR-2）。

### 4.3 构建与分发

- `npm run openclaw:patch` 重新应用 patch 后，需重建各平台 runtime。注意本仓库已知坑：
  runtime keep-list 或 patch 内容变化后需 `OPENCLAW_FORCE_BUILD=1`，且构建要求 Node 24.15+
  （shell 默认低版本会造成半成品构建）。
- 打包版随 `Resources/cfmind` 分发，dev 版走 `vendor/openclaw-runtime/current`，两者均需验证。

### 4.4 上游化（后续独立事项）

向 openclaw 上游提交 issue/PR，提案原生 misfire policy（如 `cron.catchUpPolicy: "none" | "latest" | "all"`，对齐 Quartz misfire instructions 的业界惯例）。本次 bug 的本质是本地 patch 与上游反静默跳过机制打架；上游原生支持后可删除本 patch，消除每次升级的 rebase 漂移风险。

### 4.5 避免伪修复

不接受以下方案作为最终修复：

- **在 `isRunnableJob`/`onTimer` 加迟到窗口**：会误伤运行中长任务后的正常迟到执行（场景 D），且与上游语义冲突，rebase 成本高。
- **修改 `recomputeNextRunsForMaintenance` 使其推进未执行 slot**：直接破坏上游 #13992/#16156 修复的「任务被静默跳过」问题，影响面远超本开关。
- **LobsterAI 侧启动后经 cron API 批量禁用/启用或改写任务**：与 gateway 首次 tick 存在竞态（本次实测 tick 在 listening 后 ~5 秒就收割了任务），且把 OpenClaw 内部调度语义泄漏到产品层。
- **只把浏览器改成 headless 或在任务 prompt 里禁用 browser 工具**：掩盖症状，token 浪费与错误补跑依旧。
- **只加日志**：不改变行为。

## 5. 边界情况

| 场景 | 处理方式 |
|---|---|
| 停机横跨多个 slot（如每 2 小时任务错过 5 个） | 推进到未来最近一个时点，不逐个补跑 |
| `every` 类任务 | 同样快进，按 anchor 语义对齐下一时点 |
| `at` 一次性任务错过 | 不受开关影响，维持补跑（FR-6） |
| 任务带 `staggerMs` | 快进后的时点保持 stagger 抖动语义，避免多任务快进到同一毫秒 |
| `runningAtMs` 残留（执行中重启） | 由现有 `markInterruptedStartupRun` 处理；快进逻辑经 `skipJobIds` 排除，不碰这些任务 |
| 处于 error backoff 的任务（`nextRunAtMs` 为过期的重试时点） | 视为 missed 一并快进到下一正常 slot（跳过=放弃停机期间的一切执行）；在日志中标注原因为 backoff-retry-skipped |
| `nextRunAtMs` 缺失（新建/迁移后未计算） | 走现有 recompute 正常路径，不属于 missed |
| `deleteAfterRun` 任务 | 属 `at` 语义范畴，同样维持补跑（FR-6） |
| 配置变更触发的 gateway 软重启 | 同样经过 `start()` → skip 分支，行为一致；重启前后运行中的任务不受影响 |
| 开关在运行期间被切换 | 配置同步触发 gateway restart 后按新值生效；不要求运行中热生效 |
| cron store 已迁移（`state/cron/jobs.json` 仅剩 `.bak`/`.migrated`） | 快进通过内存 store + `persist(state)` 完成，与存储介质无关；验证时以 `cron.list` API/日志为准，不直接改文件 |
| 时区/DST 变化跨越停机期 | 复用 OpenClaw schedule 计算（带 `tz`），快进只依赖「从 now 起的下一时点」，无额外处理 |

## 6. 涉及文件

| 文件 | 预期改动 |
|---|---|
| `scripts/patches/v2026.6.1/openclaw-cron-skip-missed-jobs.patch` | 重写 skip 分支：加载 store → 收集 missed → 快进周期任务 `nextRunAtMs` → persist → 结构化日志；附上游行为测试用例 |
| `src/main/libs/openclawPatches/cronSkipMissedJobs.test.ts` | 文本断言更新，覆盖快进逻辑关键行 |
| OpenClaw（patch 内）`src/cron/service/timer.ts` | skip 分支实现主体 |
| OpenClaw（patch 内）`src/cron/service/timer.regression.test.ts` 或新建 | FR-5 行为用例 |
| `vendor/openclaw-runtime/*` | 重建产物（不手改） |

## 7. 验收标准

1. 构造过期任务（每天 15:07、`nextRunAtMs` 停在过去），`skipMissedJobs=true`，重启 gateway：任务不执行、无模型请求、无 browser 拉起；日志出现 `cron: skipping missed jobs after restart` 及快进明细；`cron.list` 显示 `nextRunAtMs` 为明天 15:07。
2. 同一场景 `skipMissedJobs=false`：走原生 catch-up（≤5 个立即、agentTurn 延迟约 2 分钟），与修复前一致。
3. 应用保持运行，任务到点正常执行、正常推送（场景 C 回归）。
4. 长任务占用调度后的正常迟到执行不受影响（场景 D 回归）。
5. 开关开启时，错过的 `at` 一次性任务仍被补跑（FR-6），周期任务被跳过——两者在同一次启动中行为可同时验证。
6. 端到端复现用户原始场景：白天关闭应用错过多个任务，晚间启动 LobsterAI，浏览器不弹出、无 token 消耗、无 stale-delivery 丢弃日志。
7. OpenClaw 侧新增行为测试通过；LobsterAI `npm test` 通过；`npm run compile:electron` 通过（若触及主进程文件）。

## 8. 验证计划

### 单元/回归测试

```bash
# LobsterAI 侧 patch 文本断言
npm test -- cronSkipMissedJobs

# OpenClaw 侧（patch 应用后的源码树内）
# 运行 cron timer 回归测试，含新增 skipMissedJobs 行为用例
```

### 手动验证

1. dev 环境应用 patch 并重建 runtime（`OPENCLAW_FORCE_BUILD=1`，Node ≥ 24.15）。
2. 创建一个 1 分钟后执行、每日重复的测试任务；等它执行一次确认正常。
3. 退出应用，将系统等待跨过下一个执行时点（或直接等到次日时点已过）。
4. 启动应用，观察 main log：应出现 skip 日志与快进明细，不应出现该任务的 `action:started`、`openclaw browser started`、模型请求。
5. 在定时任务 UI 检查下次执行时间已指向未来。
6. 关闭「跳过未执行任务」重复步骤 3-4，确认补跑恢复（含 agentTurn ~2 分钟延迟指纹）。
7. 打包版本抽验一遍步骤 3-5（`Resources/cfmind` 产物路径）。

### 日志验证要点

- 正例指纹：`cron: skipping missed jobs after restart` + 每任务 `old nextRunAtMs → new nextRunAtMs`。
  ⚠️ 实测（2026-07-13）：该日志经 `getChildLogger({ module: "cron" })` 走 OpenClaw 子系统日志管道，
  **不进入 gateway stdout / LobsterAI main log**（上游自己的 catch-up 日志同样如此，属 logger 管道
  全局行为）。以任务状态为准做验收：任务列表的下次执行时间被推进到未来、`cron_run_logs` 无启动窗口
  内的新执行记录、`state_json.lastRunAtMs` 保持旧值。
- 反例指纹（修复前）：gateway listening 后数秒内多个 job 同一秒 `action:started`、`skipping stale delivery ... late`。

### 端到端实测记录（2026-07-13，隔离 gateway + 本次构建产物）

两次启动法：CLI 真实创建任务 → 停 gateway → SQLite 将 `next_run_at_ms`/`state_json` 回拨成
「错过」状态（cron 任务迟 13h、`at` 任务迟 2h）→ 二次启动（被测场景）→ CLI/SQLite 读回。

| 断言 | skipMissedJobs=true | skipMissedJobs=false |
|---|---|---|
| 过期 cron 任务在启动窗口执行 | 否（lastRunAtMs 保持旧值） | 是（catch-up 补跑，lastStatus ok） |
| 过期 cron 任务 nextRunAtMs | 推进到未来下一时点（精确匹配明日 slot） | 执行后重算到未来 |
| 过期 `at` 一次性任务 | 补跑（FR-6，`cron_run_logs` 恰 1 条） | 补跑 |
| `cron_run_logs` 启动窗口记录数 | 1（仅 `at` 任务） | 2（两个任务） |

附注：cron store 在 OpenClaw v2026.6.1 实际为 `state/openclaw.sqlite` 的 `cron_jobs` 表，
`cron.store` 指向的 `jobs.json` 仅作迁移源；cron 服务为懒加载 + gateway ready 后约 250ms 由
post-ready maintenance 启动。
