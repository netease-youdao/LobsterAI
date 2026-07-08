# Cowork 右侧轨道长距离跳转卡顿修复 Spec

## 问题描述

用户反馈 LobsterAI 在超长 Cowork 对话中，从底部点击右侧轨道标题/刻度跳转到顶部时会出现卡顿。当前 macOS 环境未能稳定复现，但代码路径存在明确性能风险，Windows 或低性能设备更容易放大该问题。

### 现象

- 对话总内容很长时，从底部点击右侧轨道顶部项会短时间卡顿
- macOS 高性能设备可能无感
- 消息数量少但单条消息体很长时仍可能触发

---

## 根因分析

右侧轨道点击调用 `scrollIntoView({ behavior: 'smooth' })` 做长距离平滑滚动。超长对话中，这会在滚动途中持续触发：

1. `onScroll` 中的轨道索引计算和滚动状态更新
2. `LazyRenderTurn` 的 `IntersectionObserver` 可见性切换
3. 长消息进入视口后的 Markdown 渲染和 `ResizeObserver` 高度缓存更新
4. 未渲染目标消息从 placeholder 切换为真实内容时的布局重排

因此该问题不是单纯的滚动慢，而是长距离 smooth scroll 与懒渲染/长 Markdown 内容共同造成的主线程压力。

### 关键路径

| 文件 | 风险点 |
|------|--------|
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | `navigateToRailItem()` 使用长距离 `smooth` 跳转 |
| `src/renderer/components/cowork/LazyRenderTurn.tsx` | 滚动途中逐段触发真实内容渲染和高度缓存 |
| `src/renderer/components/MarkdownContent.tsx` | 长内容进入可见区域后触发 Markdown/代码块渲染 |

---

## 解决方案

本次修复只优化右侧轨道点击跳转路径，不改变消息加载、普通滚动、自动滚动到底部、懒渲染策略和 Markdown 渲染逻辑。

### 修复 1：轨道长距离跳转禁用 smooth

在 `navigateToRailItem()` 中根据目标距离选择滚动行为：

- 距离较近：保留 `smooth`，维持日常点击手感
- 距离超过若干屏：使用 `auto`，避免沿途逐段唤醒懒渲染内容
- 用户开启 `prefers-reduced-motion` 时始终使用 `auto`

示意：

```typescript
const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const distance = Math.abs(targetElement.offsetTop - container.scrollTop);
const isLongJump = distance > container.clientHeight * 2.5;
const behavior = prefersReducedMotion || isLongJump
  ? 'auto'
  : 'smooth';

targetElement.scrollIntoView({ behavior, block: 'start' });
```

选择像素距离而不是 turn 数量作为判断依据，是因为该问题可由“少量但超长消息体”触发；实际滚动距离比消息条数更接近性能压力来源。

### 修复 2：缓存轨道 items 计算

将轨道 items 的构建从 render 内联 IIFE 提取为 `useMemo`：

- 避免每次 hover/current index 更新都重新扫描全部 turns
- 避免对超长 assistant 内容反复执行 markdown strip 正则
- memo 依赖 `turns`，确保新消息、流式内容更新、历史消息加载后及时重算
- `railItemCountRef` 与 `turnToRailRangeRef` 通过 `useEffect` 从 memo 结果同步，避免 render 阶段写 ref 副作用

示意：

```typescript
const railItems = useMemo(() => buildRailItems(turns), [turns]);

useEffect(() => {
  railItemCountRef.current = railItems.length;
  turnToRailRangeRef.current = buildTurnToRailRange(railItems);
}, [railItems]);
```

`hoveredRailIndex`、`currentRailIndex`、tooltip 状态只影响显示高亮和浮层，不参与 `railItems` 计算依赖，避免 UI 交互导致长内容重复解析。

### 不变更范围

- 不修改 `LazyRenderTurn` 的可见性判断、`rootMargin` 和高度缓存策略
- 不修改 `handleMessagesScroll()` 的历史消息加载和轨道当前项计算
- 不修改流式输出时的自动滚动到底部逻辑
- 不修改 `handleScrollToBottom()` 按钮行为
- 不修改 Markdown 大内容预览和代码块渲染策略

### 诊断日志

仅在轨道导航发生长距离 instant scroll、遵循 reduced-motion 使用 instant scroll，或目标 turn 异常缺失时写 renderer debug 日志。短距离正常点击不写日志，避免高频交互污染日志。

---

## 涉及文件

| 文件 | 变更 |
|------|------|
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | 优化 `navigateToRailItem()` 滚动行为；抽取并缓存轨道 items 构建逻辑 |

---

## 验证方法

### 功能验证

1. 准备包含多轮长消息的 Cowork 会话
2. 滚动到底部，点击右侧轨道最顶部条目
3. 验证页面能快速跳到目标消息，且无明显长时间卡顿
4. 点击相邻轨道条目，验证短距离跳转仍保持平滑体验
5. 验证滚动到底部按钮、自动滚动、加载历史消息不受影响

### 回归验证

| 场景 | 预期 |
|------|------|
| 短对话点击轨道 | 行为无明显变化 |
| 相邻轨道项跳转 | 继续使用平滑滚动 |
| 超长对话底部跳顶部 | 避免长时间 smooth scroll 卡顿 |
| 顶部跳底部 | 能正常跳转并更新当前轨道高亮 |
| 流式输出中轨道 items | 新增内容后轨道数量、长度和 tooltip 及时更新 |
| 加载更早历史消息后轨道 items | 轨道项和 turn 映射及时更新 |
| Windows 环境 | 长距离跳转主线程压力降低 |
| macOS 环境 | 日常短距离轨道点击手感保留 |

---

## 已知边界

1. 该方案不改变消息渲染模型，只规避长距离 smooth scroll 的性能放大路径。
2. 如果单条目标消息本身极长，首次渲染该消息仍可能产生短暂开销，但不再叠加沿途所有消息的渲染成本。
3. 当前问题在 macOS 上可能无法复现，验证重点应覆盖 Windows 或低性能设备。
4. 如果上游状态管理原地 mutation `messages` 而不产生新引用，`turns` 与 `railItems` 的 memo 都可能无法重算；这不应在当前 Redux 数据流中发生，若发现需优先修正状态更新方式。
