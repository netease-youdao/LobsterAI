# 排查报告：`yd_cowork` 引擎残留代码（更新于 2026-04-15）

## 当前状态总结

大部分清理工作已在之前的提交中完成。以下已完成：

- ✅ `PermissionResult` 类型已在 `types.ts` 中本地定义，SDK import 已全部移除
- ✅ `CoworkAgentEngine` 类型已缩窄为 `'openclaw'`（types.ts / coworkStore.ts / renderer types）
- ✅ `CoworkEngineRouter` 已简化为单引擎路由
- ✅ `coworkRunner.ts`、`claudeSdk.ts`、`claudeRuntimeAdapter.ts` 已删除
- ✅ `@anthropic-ai/claude-agent-sdk` 已从 `package.json` 和 `electron-builder.json` 移除
- ✅ `patches/` 目录已删除
- ✅ `main.ts` 中无 `yd_cowork` 引用、无 `CoworkRunner`/`ClaudeRuntimeAdapter` 引用
- ✅ 渲染进程中无 `yd_cowork` 引用
- ✅ `scheduledTask/enginePrompt.ts` 和测试已清理
- ✅ `legacyEngineCleanup.test.ts` 已添加，验证 SDK 已移除

---

## 剩余残留项

### 1. `src/main/preload.ts:231` — 最后一处 `yd_cowork` 字符串

```typescript
agentEngine?: 'openclaw' | 'yd_cowork';  // ← 需改为 'openclaw'
```

### 2. `src/main/coworkStore.ts:13-14` — 仍然导入已废弃的记忆模块

```typescript
import {
  type CoworkMemoryGuardLevel,
  extractTurnMemoryChanges,
  isQuestionLikeMemoryText,
} from './libs/coworkMemoryExtractor';
import { judgeMemoryCandidate } from './libs/coworkMemoryJudge';
```

- `isQuestionLikeMemoryText` — **仍在用**，启动时 `autoDeleteNonPersonalMemories()` 调用
- `extractTurnMemoryChanges` — 仅在 `applyTurnMemoryUpdates()` 中调用，该方法**已无调用方**（coworkRunner 已删除）
- `judgeMemoryCandidate` — 同上，已无调用方
- `CoworkMemoryGuardLevel` — 配置管理使用

**活跃调用链：**
```
main.ts:848 getCoworkStore()
  → coworkStore.autoDeleteNonPersonalMemories()  (line 1557)
    → shouldAutoDeleteMemoryText()  (line 288)
      → normalizeMemoryText()  (line 65, coworkStore 本地函数)
      → MEMORY_ASSISTANT_STYLE_TEXT_RE  (line 42, 本地常量)
      → MEMORY_PROCEDURAL_TEXT_RE  (line 41, 本地常量)
      → isQuestionLikeMemoryText()  ← 从 coworkMemoryExtractor.ts 导入
```

**注意：** `isQuestionLikeMemoryText` 内部有独立的规范化逻辑（追加 `.replace(/[。！!]+$/g, '')` 去尾部标点），不能复用 coworkStore 已有的 `normalizeMemoryText`。

### 3. 待删除的文件

| 文件 | 说明 |
|------|------|
| `src/main/libs/coworkMemoryExtractor.ts` | 需先内联 `isQuestionLikeMemoryText` |
| `src/main/libs/coworkMemoryJudge.ts` | 无活跃调用方 |
| `src/main/libs/coworkMemoryExtractor.test.ts` | 对应测试 |
| `src/main/libs/coworkMemoryJudge.test.ts` | 对应测试 |
| `tests/coworkMemoryJudge.test.mjs` | 对应测试 |

### 4. `src/main/libs/claudeSettings.ts:84-102` — `getClaudeCodePath()` 函数

仍然引用 `@anthropic-ai/claude-agent-sdk/cli.js` 路径。该函数已无调用方（coworkRunner 已删除），但代码仍在。

### 5. `AGENTS.md` — 文档引用

- Line 145: 仍提到 `yd_cowork` 引擎
- Line 222: 仍列出 `@anthropic-ai/claude-agent-sdk` 作为依赖
- 目录结构中仍列出已删除的文件（coworkRunner, claudeSdk, claudeRuntimeAdapter, memory modules）

### 6. `docs/` 目录 — 历史文档引用（低优先级）

- `docs/architecture-openclaw-gui-cowork.md` — 架构图中仍有 yd_cowork
- `docs/analysis-im-stop-session-bug.md` — 分析文档中引用 yd_cowork
- `docs/superpowers/specs/` 和 `docs/superpowers/plans/` — 历史 spec/plan 中引用

---

## 覆盖安装兼容性分析

| 场景 | 风险 | 保障 |
|------|------|------|
| SQLite 中存有 `agentEngine = 'yd_cowork'` | `normalizeCoworkAgentEngineValue()` (line 347) 已硬编码返回 `'openclaw'`，忽略所有输入 | ✅ 安全 |
| 旧版渲染进程发送 `setConfig({ agentEngine: 'yd_cowork' })` | `main.ts:3318` 归一化只接受 `'openclaw'`，其他值设为 `undefined`（不写入 DB） | ✅ 安全 |
| `preload.ts` 类型中仍有 `'yd_cowork'` | 旧版渲染进程可编译，但发送的值会被主进程忽略 | ⚠️ 需修复（最后一处） |
