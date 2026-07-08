# 定时任务启动状态适配设计文档

## 1. 概述

### 1.1 问题/动机

应用窗口早于 OpenClaw Gateway WebSocket 握手完成。定时任务 IPC 在 Gateway client
尚未可用时返回成功的空数组，Renderer 因而把“服务启动中”误显示为“暂无任务”；历史页在请求等待期间也直接显示空状态。

### 1.2 目标

- 区分服务启动中、数据加载中、加载成功但为空和加载失败。
- Gateway 握手成功后立即刷新，不额外等待 15 秒轮询周期。
- 不增加本地任务定义缓存，继续以 OpenClaw cron 数据为权威来源。

## 2. 方案设计

1. 定时任务列表与全局历史 IPC 在 Gateway 未连接时返回 `ready: false`。
2. Renderer 分别维护任务列表和全局历史的 `starting/loading/ready/error` 状态。
3. 定时任务页面内容区在启动期间展示“定时任务服务正在启动...”，首次成功查询后才允许展示真正的空状态。
4. Gateway `onHelloOk` 后通知 `CronJobService` 立即轮询并发送全量刷新事件。
5. 加载失败时在页面内容区显示重试操作；任务列表就绪前禁用“新建任务”。

## 3. 一次性任务生命周期记录

OpenClaw 对 `schedule.kind = at` 的任务默认设置 `deleteAfterRun = true`。成功执行后任务定义会被删除，任务列表不再展示，但运行历史继续保留；失败任务会按策略重试，重试耗尽后禁用并保留。本次修改维持该行为。

## 4. 涉及文件

- `src/main/ipcHandlers/scheduledTask/handlers.ts`
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
- `src/scheduledTask/cronJobService.ts`
- `src/renderer/services/scheduledTask.ts`
- `src/renderer/store/slices/scheduledTaskSlice.ts`
- `src/renderer/components/scheduledTasks/`
- `src/renderer/services/i18n.ts`

## 5. 验证计划

- 单元测试覆盖 Gateway 从未就绪转为就绪时的即时轮询。
- 单元测试覆盖任务与历史状态独立转换。
- 执行变更文件 ESLint、定向 Vitest 和 Electron main/preload 编译。
- 手工验证冷启动时两个 Tab 不显示错误空状态，Gateway 就绪后自动展示真实数据。
