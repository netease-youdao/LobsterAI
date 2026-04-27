# 移除废弃 `yd_cowork` 引擎 — 实施计划（更新于 2026-04-15）

**前置文档：** [audit.md](./audit.md)（排查报告） | [spec.md](./spec.md)（验收规格）

**现状：** 大部分清理工作已在之前提交中完成（路由器简化、SDK 移除、类型缩窄、渲染进程清理）。剩余工作集中在记忆系统内联和文件删除。

---

## Step 1：内联 `isQuestionLikeMemoryText` 到 `coworkStore.ts`

> 这是唯一有行为风险的步骤，必须先做并验证。

**文件：** `src/main/coworkStore.ts`

**1a. 移除 import（第 9-14 行）：**
```diff
- import {
-   type CoworkMemoryGuardLevel,
-   extractTurnMemoryChanges,
-   isQuestionLikeMemoryText,
- } from './libs/coworkMemoryExtractor';
- import { judgeMemoryCandidate } from './libs/coworkMemoryJudge';
```

**1b. 添加本地定义（在现有 `MEMORY_ASSISTANT_STYLE_TEXT_RE` 常量后，约 line 43）：**
```typescript
export type CoworkMemoryGuardLevel = 'strict' | 'standard' | 'relaxed';

const CHINESE_QUESTION_PREFIX_RE = /^(?:请问|问下|问一下|是否|能否|可否|为什么|为何|怎么|如何|谁|什么|哪(?:里|儿|个)?|几|多少|要不要|会不会|是不是|能不能|可不可以|行不行|对不对|好不好)/u;
const ENGLISH_QUESTION_PREFIX_RE = /^(?:what|who|why|how|when|where|which|is|are|am|do|does|did|can|could|would|will|should)\b/i;
const QUESTION_INLINE_RE = /(是不是|能不能|可不可以|要不要|会不会|有没有|对不对|好不好)/i;
const QUESTION_SUFFIX_RE = /(吗|么|呢|嘛)\s*$/u;

// 注意：此函数有独立的规范化逻辑（追加去尾部标点），不能复用 normalizeMemoryText
function isQuestionLikeMemoryText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().replace(/[。！!]+$/g, '').trim();
  if (!normalized) return false;
  if (/[？?]\s*$/.test(normalized)) return true;
  if (CHINESE_QUESTION_PREFIX_RE.test(normalized)) return true;
  if (ENGLISH_QUESTION_PREFIX_RE.test(normalized)) return true;
  if (QUESTION_INLINE_RE.test(normalized)) return true;
  if (QUESTION_SUFFIX_RE.test(normalized)) return true;
  return false;
}
```

**1c. 删除已无调用方的代码：**
- `applyTurnMemoryUpdates()` 方法（唯一调用方 coworkRunner.ts 已删除）
- `ApplyTurnMemoryUpdatesOptions` 接口（第 474-483 行）
- `ApplyTurnMemoryUpdatesResult` 接口（第 485-493 行）

**验证：**
1. `npx tsc --noEmit` — 编译通过
2. `npm test` — 测试通过
3. `npm run electron:dev` → 启动后检查日志中 `[cowork-memory] Auto-deleted` 是否正常（可有可无，关键是无报错）

---

## Step 2：修复 `preload.ts` 类型

**文件：** `src/main/preload.ts:231`

```diff
- agentEngine?: 'openclaw' | 'yd_cowork';
+ agentEngine?: 'openclaw';
```

**验证：** `npx tsc --noEmit`

---

## Step 3：删除废弃文件

删除以下 5 个文件：

| 文件 | 说明 |
|------|------|
| `src/main/libs/coworkMemoryExtractor.ts` | 记忆提取（已内联所需函数） |
| `src/main/libs/coworkMemoryJudge.ts` | 记忆验证（无调用方） |
| `src/main/libs/coworkMemoryExtractor.test.ts` | 对应测试 |
| `src/main/libs/coworkMemoryJudge.test.ts` | 对应测试 |
| `tests/coworkMemoryJudge.test.mjs` | 对应测试 |

**验证：**
1. `npx tsc --noEmit` — 编译通过
2. `npm test` — 测试通过（已删除的测试除外）

---

## Step 4：删除 `getClaudeCodePath()`

**文件：** `src/main/libs/claudeSettings.ts`

删除 `getClaudeCodePath()` 函数（第 84-102 行）。已无调用方。

**验证：** `npx tsc --noEmit`

---

## Step 5：更新 `AGENTS.md`

- 移除 `yd_cowork` 引擎描述（line 145）
- 移除 `@anthropic-ai/claude-agent-sdk` 依赖（line 222）
- 从目录结构中移除已删除文件：`coworkRunner.ts`、`claudeSdk.ts`、`claudeRuntimeAdapter.ts`、`coworkMemoryExtractor.ts`、`coworkMemoryJudge.ts`

---

## 覆盖安装兼容性保障

| 用户场景 | 保障机制 | 状态 |
|----------|----------|------|
| SQLite 中存有 `agentEngine = 'yd_cowork'` | `normalizeCoworkAgentEngineValue()` 硬编码返回 `'openclaw'` | ✅ 已有 |
| 旧版 IPC 发送 `setConfig({ agentEngine: 'yd_cowork' })` | `main.ts:3318` 归一化只接受 `'openclaw'`，其他值设为 `undefined` | ✅ 已有 |
| `preload.ts` 类型兼容 | Step 2 修复后类型仅允许 `'openclaw'` | Step 2 修复 |

---

## 最终验证

1. `npx tsc --noEmit` — 类型检查通过
2. `npm test` — 测试通过
3. `npm run build` — 构建成功
4. `npm run lint` — 无新增告警
5. `npm run electron:dev` → 新建 cowork 会话 → 验证 OpenClaw 正常工作
6. 确认 `src` 目录中无 `yd_cowork` 字符串（`grep -r 'yd_cowork' src/`）
7. 确认 `src` 目录中无 `claude-agent-sdk` 引用（`grep -r 'claude-agent-sdk' src/`）
