# 移除废弃 `yd_cowork` 引擎 — 验收规格（更新于 2026-04-15）

## Overview

清理 `yd_cowork` 引擎的最后残留：记忆系统模块、preload 类型声明、废弃函数、文档引用。

## 终态要求

### 代码层面

1. **`src/` 中不存在 `yd_cowork` 字符串**
   - `preload.ts` 中 `agentEngine` 类型仅为 `'openclaw'`

2. **以下文件已删除**
   - `src/main/libs/coworkMemoryExtractor.ts`
   - `src/main/libs/coworkMemoryJudge.ts`
   - `src/main/libs/coworkMemoryExtractor.test.ts`
   - `src/main/libs/coworkMemoryJudge.test.ts`
   - `tests/coworkMemoryJudge.test.mjs`

3. **`src/` 中不存在 `claude-agent-sdk` 引用**
   - `claudeSettings.ts` 中 `getClaudeCodePath()` 函数已删除

4. **`isQuestionLikeMemoryText` 已内联到 `coworkStore.ts`**
   - 函数体（含独立的尾部标点规范化）和 4 个正则从 `coworkMemoryExtractor.ts` 移入
   - `CoworkMemoryGuardLevel` 类型在 `coworkStore.ts` 中本地定义
   - `applyTurnMemoryUpdates()` 方法及其接口（`ApplyTurnMemoryUpdatesOptions`、`ApplyTurnMemoryUpdatesResult`）已删除（唯一调用方 coworkRunner 已不存在）

### 功能验证

| 验收项 | 验证方法 |
|--------|----------|
| OpenClaw 引擎正常运行 | `npm run electron:dev` → 新建 cowork 会话 → 发送消息 → 收到响应 |
| 启动时内存自动清理正常 | 应用启动后无报错；若有待清理的记忆条目，日志出现 `[cowork-memory] Auto-deleted` |
| 老配置兼容 | SQLite 中 `agentEngine = 'yd_cowork'` 的用户启动后自动归一化为 `'openclaw'`（已由 `normalizeCoworkAgentEngineValue` 保障） |

### 构建验证

| 验收项 | 命令 |
|--------|------|
| TypeScript 编译通过 | `npx tsc --noEmit` 无报错 |
| 测试通过 | `npm test` 通过（已删除的测试除外） |
| 生产构建成功 | `npm run build` 成功 |
| 无残留引用 | `grep -r 'yd_cowork' src/` 和 `grep -r 'claude-agent-sdk' src/` 无输出 |

### 文档层面

- `AGENTS.md` 已更新：移除 `yd_cowork` 引擎描述、`@anthropic-ai/claude-agent-sdk` 依赖、已删除文件的目录引用

## 不在范围内

- `docs/` 目录中历史文档对 `yd_cowork` 的引用（归档性质，不影响功能）
- `mergeStreamingMessageContent` 函数（已在之前清理中移除或已成死代码）
- `agentEngine` 字段从 config/DB schema 中完全移除（保留字段、值固定为 `'openclaw'`，避免 DB 迁移）
