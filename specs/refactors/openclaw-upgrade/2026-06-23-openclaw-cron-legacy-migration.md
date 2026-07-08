# OpenClaw 定时任务 legacy 存储迁移设计文档

## 1. 概述

### 1.1 问题/动机

OpenClaw 升级到 `v2026.6.1` 后，cron 定时任务的权威存储从 legacy JSON 文件迁移到 OpenClaw shared SQLite state database。QA 升级后反馈定时任务列表为空，日志未发现 `cron.remove` 或任务删除行为，而是 OpenClaw 启动时直接读取到 `jobs=0`。

QA 导出的状态数据进一步确认：

- `openclaw/state/cron/jobs.json` 中仍有 legacy 定时任务。
- `openclaw/state/state/openclaw.sqlite` 中已有 cron 表，但当前 Windows store key 下没有对应任务。
- 日志中未出现 OpenClaw `doctor --fix` 的 legacy cron import 记录。

因此问题不是任务被删除，而是升级后 legacy cron JSON 没有按 OpenClaw 官方路径导入 SQLite。

### 1.2 目标

- 遵循 OpenClaw 官方迁移指引：升级时运行 `openclaw doctor --fix` 导入 legacy cron JSON、state 和 run logs。
- 只在检测到 legacy cron 文件时触发迁移，避免普通启动增加额外成本。
- 不在 LobsterAI 中复制 OpenClaw cron schema、normalize、SQLite projection 和 run-log import 规则。
- 迁移失败不阻断应用启动，避免修复路径引入启动失败。
- 确保后续启动依赖 OpenClaw `.migrated` 归档机制自然跳过，不额外引入 LobsterAI 迁移 marker。

## 2. 现状分析

OpenClaw 官方文档 `vendor/openclaw-runtime/current/docs/automation/cron-jobs.md` 说明：

- cron job definitions、runtime state、run history 已持久化到 shared SQLite state database。
- 升级时运行 `openclaw doctor --fix`，把 legacy `cron/jobs.json`、`jobs-state.json`、`runs/*.jsonl` 导入 SQLite，并将 legacy 文件归档为 `.migrated`。
- `cron.store` 仍作为 logical store key 和 legacy doctor import path。

OpenClaw cron doctor 逻辑并非简单 JSON 导入，包含：

- legacy `jobs.json` / `jobs-state.json` 读取和状态合并；
- 旧字段规范化，例如 `jobId`、`schedule.cron`、旧 payload/delivery 字段；
- 无效 job quarantine；
- SQLite 已有任务和 legacy-only 任务合并；
- legacy run logs 去重导入；
- 成功后归档 `.migrated`。

因此 LobsterAI 不应自行实现这套迁移细节。

## 3. 方案设计

### 3.1 显式写入 cron.store

OpenClaw config sync 生成：

```ts
cron: {
  enabled: true,
  store: path.join(stateDir, 'cron', 'jobs.json'),
  skipMissedJobs,
  maxConcurrentRuns: 3,
  sessionRetention: '7d',
}
```

这样 doctor import path 与 gateway runtime 使用的 logical store key 保持一致。

### 3.2 Gateway 启动前 legacy cron preflight

在 OpenClaw gateway fork 前执行轻量 preflight：

1. 检查是否存在：
   - `openclaw/state/cron/jobs.json`
   - `openclaw/state/cron/jobs-state.json`
   - `openclaw/state/cron/runs/*.jsonl`
2. 不存在则直接跳过。
3. 存在时写入一个临时最小 OpenClaw config：

```json
{
  "gateway": { "mode": "local" },
  "cron": {
    "enabled": true,
    "store": "<stateDir>/cron/jobs.json"
  }
}
```

4. 调用 bundled OpenClaw CLI：

```text
openclaw.mjs doctor --non-interactive --fix
```

运行环境与 gateway 保持一致：

- `OPENCLAW_HOME`
- `OPENCLAW_STATE_DIR`
- `OPENCLAW_CONFIG_PATH` 指向临时最小 config，而不是真实 `openclaw.json`
- `ELECTRON_RUN_AS_NODE=1`

使用临时 config 的原因是完整 doctor 可能修复非 cron 配置，例如 skills、plugins、gateway auth 等。cron 迁移只依赖 `cron.store` 和 state dir，因此临时 config 可以复用 OpenClaw 官方 cron migration 逻辑，同时避免改写 LobsterAI 生成的真实配置。

### 3.3 失败策略

doctor 退出非 0 或超时：

- 记录 warning 和有限长度输出尾部；
- 继续启动 gateway；
- 不删除、不移动 legacy 文件。

这样用户仍可打开应用，后续仍可人工或下一次升级修复。

## 4. 实施步骤

1. 新增 `src/main/libs/openclawCronLegacyMigration.ts`：
   - legacy 文件探测；
   - official doctor 命令执行；
   - 超时、失败和日志处理。
2. 在 `OpenClawEngineManager.startGateway()` 中，fork gateway 前调用 preflight。
3. 在 `openclawConfigSync` 生成的 `cron` 配置中写入 `store`。
4. 增加 Vitest 覆盖：
   - 无 legacy 文件时跳过；
   - `jobs.json` 存在时调用 doctor；
   - 仅有 `runs/*.jsonl` 时调用 doctor；
   - CLI 缺失时跳过；
   - doctor 非 0 时返回失败但不抛出。

## 5. 涉及文件

- `src/main/libs/openclawCronLegacyMigration.ts`
- `src/main/libs/openclawCronLegacyMigration.test.ts`
- `src/main/libs/openclawEngineManager.ts`
- `src/main/libs/openclawConfigSync.ts`
- `src/main/libs/openclawConfigSync.runtime.test.ts`

## 6. 验证计划

- 运行新增迁移模块单测。
- 运行 OpenClaw config sync 相关单测。
- 运行 touched TypeScript 文件 ESLint。
- 使用 QA 导出的 legacy cron 数据在临时目录验证：
  - doctor 前 legacy JSON 有任务；
  - doctor 后 SQLite 当前 store key 下可读到任务；
  - legacy JSON / run logs 被归档为 `.migrated`；
  - 第二次 preflight 不再触发 doctor。
