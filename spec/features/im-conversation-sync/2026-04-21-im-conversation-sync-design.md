# IM 会话同步设计文档（2026-04-21 更新）

本文档描述 `reconcileWithHistory()` 的**尾部对齐算法**重构，解决长对话历史丢失和数据一致性问题。基于 2026-04-08 版本设计文档的增量更新。

---

## 1. 概述

### 1.1 问题

`reconcileWithHistory()` 通过 gateway `chat.history` 接口（限制 50 条）同步 IM 频道消息。旧实现存在两个缺陷：

1. **全量替换导致历史丢失**：每次同步删除本地所有 user/assistant 消息，再用 gateway 返回的最多 50 条重建。超过 50 条的历史被永久删除。
2. **保护逻辑失效**：`0715f03` 添加的 guard（`rawGatewayCount < localEntries.length / 2`）在长对话（>100 条本地消息）中永远触发跳过，导致新消息无法同步。

### 1.2 目标

- 本地永久保留 IM 长期数据
- 最新数据以 gateway 的 history 接口为准，确保与 OpenClaw dashboard 显示一致
- 当本地与 gateway 数据无重叠时，以 gateway 为准（dashboard 一致性 > 本地数据保留）

### 1.3 与前版设计的关系

| 方面 | 旧方案（0715f03） | 新方案（本次） |
|---|---|---|
| 替换范围 | 全量替换所有 user/assistant | 仅替换 gateway 窗口覆盖的尾部 |
| 保护逻辑 | `rawGatewayCount < localEntries.length / 2` | 基于用户消息锚点的内容对齐 |
| 本地数据上限 | 实际上限 50 条 | 无上限，窗口外的数据永久保留 |
| 文本比较 | auth 清洗、local 不清洗 | 双方统一清洗后比较 |

---

## 2. 变更一：统一文本清洗

### 2.1 问题

旧代码只对 `authoritativeEntries`（gateway 数据）做平台相关的文本清洗（`stripDiscordMentions`、`stripQQBotSystemPrompt`、`stripPopoSystemHeader`、`stripFeishuSystemHeader`），但构建 `localEntries` 时直接用 `msg.content.trim()`，不做清洗。

这导致对齐比较时同一条用户消息的文本不匹配：

```
authUser:  "你好"                         ← 已清洗
localUser: "[QQBot] to=xxx\n\n...你好"     ← 未清洗
→ 文本不同 → 对齐失败
```

### 2.2 方案

新增 `normalizeEntryText` 函数，封装所有平台清洗逻辑：

```typescript
interface PlatformFlags {
  isDiscord: boolean;
  isQQ: boolean;
  isPopo: boolean;
  isFeishu: boolean;
}

const normalizeEntryText = (
  role: 'user' | 'assistant',
  text: string,
  flags: PlatformFlags,
): string => {
  let result = text.trim();
  if (!result) return result;
  if (flags.isDiscord) result = stripDiscordMentions(result);
  if (flags.isQQ && role === 'user') result = stripQQBotSystemPrompt(result);
  if (flags.isPopo && role === 'user') result = stripPopoSystemHeader(result);
  if (flags.isFeishu && role === 'user') result = stripFeishuSystemHeader(result);
  return result;
};
```

构建 `authoritativeEntries` 和 `localEntries` 时统一调用此方法，同时 `localEntries` 也增加 `shouldSuppressHeartbeatText` 过滤。

---

## 3. 变更二：尾部对齐算法

### 3.1 核心思路

gateway 返回最近 N 条消息（上限 50），这些消息构成一个"窗口"。算法找到该窗口在本地的对应位置，只在窗口范围内用 gateway 数据覆盖，窗口之前的本地消息不动。

```
本地:  [── 长期保留（不动） ──|── 以 gateway 为准 ──]
                              ↑
                           对齐点
```

### 3.2 用户消息锚点

使用**用户消息**（而非全部消息）作为对齐锚点：

- **用户消息不可变**：IM 场景下用户发送的文本不会改变
- **assistant 消息可能不一致**：streaming 残留、thinking-only 回复等原因导致 assistant 文本差异
- **取最大重叠 k**：gateway 是权威数据源，重叠区越大纠正范围越广

### 3.3 `findTailAlignmentIndex` 算法

```typescript
const findTailAlignmentIndex = (
  localEntries: Array<{ role; text }>,
  authEntries: Array<{ role; text }>,
): number => {
  // 1. 分别提取 user 类型的条目（保留原始索引）
  localUsers = local 中 role=user 的 [{idx, text}, ...]
  authUsers  = auth  中 role=user 的 [text, ...]

  // 2. 找最大 k: localUsers 尾部 k 条 == authUsers 头部 k 条
  for k = min(localUsers.length, authUsers.length) → 1:
    if localUsers[-k:].texts == authUsers[:k].texts:
      return localUsers[-k].originalIndex

  // 3. 无重叠
  return -1
}
```

**搜索范围**：k 从 `min(localUsers.length, authUsers.length)` 到 1 递减。范围受 auth 大小约束（最多 50），与本地数据量无关。

### 3.4 对齐后的操作

| 对齐结果 | 含义 | 操作 |
|---|---|---|
| `alignIdx = 0` | gateway 覆盖了本地全部数据 | 用 `auth` 全量替换 |
| `alignIdx > 0` | gateway 只覆盖尾部 | 检查尾部是否一致：一致则跳过；不一致则 `local[0:alignIdx] + auth` 替换 |
| `alignIdx = -1` | 无重叠（断档或 gateway 重启） | 用 `auth` 全量替换（保证 dashboard 一致性） |

### 3.5 示例

**尾部对齐（保留前缀）**：

```
local:       [u1, a1, u2, a2, u3, a3_partial, u4, a4]
auth:                [u2, a2_final,  u3, a3,   u4, a4, u5, a5]

localUsers:  [u1, u2, u3, u4]
authUsers:   [u2, u3, u4, u5]

k=3: localUsers 尾部 3 条 [u2,u3,u4] == authUsers 头部 3 条 [u2,u3,u4] ✓
→ 对齐点 = u2 在 local 中的索引 = 2
→ 保留 local[0:2] = [u1,a1]
→ 用 auth 替换后面部分
→ 结果: [u1,a1, u2,a2_final, u3,a3, u4,a4, u5,a5]
```

**相同用户文本**：

```
localUsers:  [u"你好", u"你好", u"你好"]
authUsers:   [u"你好", u"你好"]

k=2: localUsers 尾部 2 条 == authUsers 头部 2 条 ✓
→ 对齐点 = 第 2 个 u"你好"
→ 保留第 1 个 u"你好" + 其回复
```

### 3.6 删除旧 guard

彻底删除 `rawGatewayCount < localEntries.length / 2` 代码块。尾部对齐算法自然处理了 gateway 返回数据少于本地的场景，不再需要基于数量的启发式保护。

---

## 4. 边缘场景

### 4.1 已同步

**场景**：本地和 gateway 数据完全一致。

**影响**：无。

**处理**：快速路径检查，长度相同且逐条 role+text 一致时直接跳过。

### 4.2 assistant 消息内容不一致（streaming 残留）

**场景**：本地保留了 streaming partial 文本，gateway 有最终完整文本。

**影响**：用户看到不完整的回复。

**处理**：用户消息锚点不受 assistant 文本影响。对齐成功后，尾部替换自动修正 assistant 文本。

### 4.3 本地重复 assistant 消息

**场景**：同步 bug 导致本地存在重复的 assistant 消息。

**影响**：用户看到重复的回复。

**处理**：gateway 窗口覆盖该范围时（`alignIdx = 0`），全量替换清理重复。窗口外的旧重复无法通过 reconcile 清理。

### 4.4 新消息到达

**场景**：IM 频道有新消息，本地尚未同步。

**影响**：本地缺少最新对话。

**处理**：用户消息锚点定位到重叠起始位置，auth 中的新消息作为尾部追加。

### 4.5 长对话（本地 >>50 条）

**场景**：本地有 200 条消息，gateway 返回最近 50 条。

**影响**：旧算法会删掉 150 条或因 guard 完全不同步。

**处理**：对齐到尾部，保留前 150 条，仅替换/验证后 50 条。搜索范围最多 50 次比较。

### 4.6 gateway 返回空数据

**场景**：gateway 重启后历史为空。

**影响**：全量替换会清空本地。

**处理**：在对齐算法之前，`history.messages` 为空时提前返回（原有逻辑，第 3246 行），cursor 置 0，本地数据不动。

### 4.7 无重叠（大量新消息涌入）

**场景**：本地有 [u1..u5]，gateway 返回 [u10..u15]，完全不重叠。

**影响**：无法确定窗口位置。

**处理**：`alignIdx = -1`，全量替换。dashboard 一致性优先于本地数据保留。

### 4.8 平台前缀未清洗的本地消息

**场景**：QQ/飞书等平台在用户消息前注入系统提示，本地存储了未清洗的原始文本。

**影响**：对齐比较时文本不匹配。

**处理**：`normalizeEntryText` 统一清洗 authoritativeEntries 和 localEntries，确保比较口径一致。

---

## 5. 完整同步流程（更新后）

```
reconcileWithHistory(sessionId, sessionKey)
│
├─ [Guard] isManagedSessionKey? → return（主窗口会话不走此路径）
│
├─ [Fetch] chat.history(sessionKey, limit=50)
│  └─ 空数据? → cursor=0, return
│
├─ [Sync] 系统消息同步（reminder 等）
│
├─ [Extract] gateway → authoritativeEntries (normalizeEntryText + heartbeat filter)
│  └─ 空? → cursor=0, return
│
├─ [Extract] local → localEntries (normalizeEntryText + heartbeat filter)  ← 新增清洗
│
├─ [Fast path] isInSync? → cursor=auth.length, return
│
├─ [Align] findTailAlignmentIndex(localEntries, authEntries)  ← 新算法
│  ├─ alignIdx > 0:
│  │  ├─ tail in sync? → cursor=auth.length, return
│  │  └─ tail differs → store(local[0:alignIdx] + auth)
│  └─ alignIdx = 0 or -1:
│     └─ store(auth)  (全量替换)
│
└─ [Notify] cowork:sessions:changed → renderer
```

---

## 6. 修改文件清单

| 文件路径 | 变更 |
|---|---|
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 新增 `normalizeEntryText`、`findTailAlignmentIndex`；重写 `reconcileWithHistory` 对齐逻辑；删除旧 guard |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts` | 修复 2 个失败测试；新增 5 个尾部对齐测试 |
| `tests/openclawReconcile.test.mjs` | 删除（内容已合并至 vitest .test.ts 文件） |
| `tests/openclawRuntimeAdapter.history.test.mjs` | 删除（内容已合并至 vitest .test.ts 文件） |

---

## 7. 验证方案

### 7.1 自动化测试

```bash
# vitest 测试（20 个测试用例）
npm test -- src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts
```

测试矩阵：

| 测试项 | 场景 | 预期结果 |
|---|---|---|
| already in sync | 本地与 gateway 一致 | replaceCount=0 |
| missing assistant | 本地缺少 assistant | replaceCount=1，全量替换 |
| duplicate messages | 本地有重复 assistant | replaceCount=1，清理重复 |
| content mismatch | assistant 文本不一致 | replaceCount=1，修正文本 |
| preserves tool messages | 本地有 tool_use/tool_result | replaceCount=0，tool 消息保留 |
| tail subset (in sync) | gateway 返回尾部子集且一致 | replaceCount=0，全部保留 |
| tail content mismatch | 尾部 assistant 不一致 | replaceCount=1，前缀保留 |
| long conversation | 200 条本地，50 条 gateway | replaceCount=1，150 条保留 |
| no overlap | 完全不重叠 | replaceCount=1，全量替换 |
| identical user messages | 用户连续发相同文本 | 对齐到最近匹配位置 |
| new messages arrived | gateway 有新消息 | replaceCount=1，旧数据保留 + 新消息追加 |

### 7.2 关键日志

```
# 尾部一致，无需替换
[Reconcile] tail in sync — sessionId: xxx preserved: 150 tail: 50

# 尾部不一致，替换尾部
[Reconcile] tail replace — sessionId: xxx preserved: 150 auth: 50 total: 200

# 全量替换（gateway 覆盖全部或无重叠）
[Reconcile] full replace — sessionId: xxx local: 4 → auth: 6 alignIdx: 0

# 已同步
[Reconcile] already in sync — sessionId: xxx entries: 100
```
