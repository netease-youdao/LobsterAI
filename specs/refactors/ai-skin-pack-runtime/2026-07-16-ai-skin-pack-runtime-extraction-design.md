# AI 皮肤包主进程职责抽离设计文档

## 1. 概述

### 1.1 问题/动机

AI 皮肤包 MVP 同时涉及可信 Kit 校验、会话事务、媒体工具路由、资产注册、Electron 协议与 IPC。如果这些逻辑直接留在 `src/main/main.ts` 和通用 Kit handler 中，会继续放大两个历史大文件，也会让异步生图生命周期难以独立测试。

### 1.2 目标

- 只抽离 AI 皮肤包新增职责，不拆分或改名历史主流程。
- 将皮肤主进程实现统一维护在 `src/main/skins/`。
- 让 `main.ts` 只保留组合与委托代码。
- 使用纯模块测试锁定可信入口、软生成预算指令、严格串行、注册顺序及异步生命周期。
- 保持现有 Cowork、Kit、媒体生成、协议和 IPC 外部行为不变。

## 2. 现状分析

皮肤 MVP 的初始接入把会话状态 Map、Kit workflow 解析、工具参数校验、会员图片路由、协议和 IPC 注册直接放进 `main.ts`。其中 OpenClaw 原生 `image_generate` 是后台任务：runtime 的一次 `complete` 不表示整个皮肤流程完成，若沿用普通媒体会话的清理时机，后续 wake 将丢失 draft 和槽位进度。

通用 `kits/handlers.ts` 也曾直接包含内置皮肤 Kit 的离线目录、安装、卸载和 bundled Skill 管理，使该文件需要了解皮肤专属标记与同步策略。

## 3. 方案设计

### 3.1 模块边界

| 模块 | 单一职责 | 对外接口 |
|------|----------|----------|
| `skinRuntimeController.ts` | 组合皮肤 Store、Registry 和 Bridge | `prepareTurn`、`handleToolRequest`、`preflightLobsterImageGeneration`、会话生命周期方法 |
| `skinWorkflowRegistry.ts` | 可信 Kit 与会话流程状态 | Turn 准备、父会话解析、draft、完成或清理 |
| `skinMediaBridge.ts` | 本地工具桥策略 | 皮肤管理工具校验、会员生图前置校验 |
| `registerSkinElectron.ts` | Electron 边界 | 特权 scheme、协议/IPC 注册、变更广播 |
| `skinPackKitLifecycle.ts` | 内置 Kit 生命周期 | 目录合并、离线目录、安装和卸载委托 |
| `skinStore.ts` 等既有模块 | 受管资产与安全读取 | Store、图片验证、协议响应 |

`src/main/skins/index.ts` 只导出 `main.ts` 需要的门面和 Electron 接入，避免组合根依赖内部实现。

### 3.2 生命周期

1. Renderer 选择内置 `ai-skin-designer` Kit 并开始或继续 Turn。
2. Controller 同时校验稳定 Kit ID 和已安装记录中的 `skin_pack` 标记，随后建立新的内存事务。
3. 会员路线强制使用 LobsterAI 图片模式；非会员路线不启用 LobsterAI 媒体选择，由 OpenClaw 原生工具处理。
4. `runtime complete` 保留事务，以支持原生后台生图完成后的同会话 wake。
5. 成功 `apply`/`deactivate` 清理事务；显式不带 Kit 的新 Turn、runtime error、单个或批量会话删除也会清理。
6. MVP 不跨进程重启恢复未完成事务，半成品 draft 仍可留作诊断但不会自动应用。

### 3.3 不变项

- 不重构通用媒体生成请求、Cowork session IPC 或 Computer Use Kit。
- 不改变 SQLite schema。
- 不改变 Renderer 的 preload API 和 `lobster-skin://` URL 契约。
- 不让 manifest 控制布局、CSS、透明度或任意文件路径。

## 4. 实施步骤

1. 先为 Registry 与 Bridge 增加生命周期和顺序测试。
2. 抽出工作流 Registry、媒体 Bridge 与 Runtime Controller。
3. 抽出 Electron 协议/IPC 注册。
4. 抽出内置皮肤 Kit 生命周期，并让通用 handler 只委托。
5. 将 `main.ts` 替换为少量门面调用。
6. 运行皮肤测试、changed-file ESLint、Electron 编译、Renderer 构建与完整 Vitest。

## 5. 涉及文件

- `src/main/skins/index.ts`
- `src/main/skins/skinRuntimeController.ts`
- `src/main/skins/skinWorkflowRegistry.ts`
- `src/main/skins/skinMediaBridge.ts`
- `src/main/skins/registerSkinElectron.ts`
- `src/main/skins/skinPackKitLifecycle.ts`
- `src/main/main.ts`
- `src/main/ipcHandlers/kits/handlers.ts`

## 6. 验证计划

- Registry：可信 Kit、订阅/原生路由、父会话、`complete` 保留、error/delete 清理。
- Bridge：先建 draft、生成完成状态检查、skinId/槽位归属；软预算由指令引导，不在 Bridge 硬拒绝异常追加尝试。
- Kit 生命周期：目录去重、离线 fallback、安装启用、卸载保留 bundled Skill、watcher 异常恢复。
- 集成：皮肤相关 Vitest、完整 Vitest、changed-file ESLint、`compile:electron` 和 `build` 均通过。
- 差异审查：`main.ts` 不再包含皮肤状态机，通用 Kit 与媒体路径没有无关格式化或结构改动。
