# 核心功能执行清单（Week 1）

## 目标

- 交付动画联动最小闭环（Think / ToolUse / Success / Error / AskUser）。
- 保持 OpenAI 兼容主链路稳定。
- 不引入手机 IM 新需求。

## 已开始

1. 在 Agent API 增加状态事件模型（`agent.state.changed`）。
2. 在会话执行流程中发出状态事件（think/tool_use/success/error）。
3. 将状态事件转发到桌面渲染层通道（`agent:state:changed`）。
4. 在流式响应中注入 `<|ACT:...|>` special token，驱动 AIRI 现有表情队列。

## 待办（本周）

1. AIRI 端接入事件消费者并建立状态映射表。
2. 落地回退策略与去抖策略。
3. 补充五态联动回归用例与录屏样例。
4. 增加事件成功率统计与调试视图。

## 验收项

1. `npm run lint` 通过。
2. `npm run compile:electron` 通过。
3. 五态事件触发成功率 >= 99%。
4. 连续对话 100 轮无动画状态乱跳。
