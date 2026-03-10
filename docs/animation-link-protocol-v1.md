# AIRI × Lobster 动画联动协议 v1

## 1. 目标与范围

- 目标：让 AIRI 根据 Lobster 执行状态与任务语义展示稳定、可解释、可回退的动画反馈。
- 范围：仅覆盖桌面核心链路与 OpenAI 兼容接入，不包含手机 IM 新功能。
- 版本：v1（最小可用闭环）。

## 2. 设计原则

1. 事件驱动：动画由结构化事件驱动，不依赖文案正则猜测。
2. 可降级：模型不支持某动作时必须有回退表情。
3. 去抖动：短时间高频事件合并，避免表情抖动。
4. 可观测：每次状态切换可记录并追踪。

## 3. 状态机定义

### 3.1 核心状态

- `idle`：待机
- `think`：思考/推理中
- `tool_use`：调用工具中
- `ask_user`：等待用户确认/输入
- `success`：任务完成
- `error`：任务失败

### 3.2 状态转换（简化）

1. `idle -> think`：收到用户新请求
2. `think -> tool_use`：触发工具调用
3. `tool_use -> think`：工具结束并继续推理
4. `think -> ask_user`：需要权限确认/补充信息
5. `ask_user -> think`：用户响应后继续
6. `think/tool_use -> success`：输出完成
7. `think/tool_use/ask_user -> error`：异常结束
8. `success/error -> idle`：展示结束后回到待机

## 4. 事件协议

### 4.1 事件名

- `agent.state.changed`

### 4.2 事件载荷

```json
{
  "version": "1.0",
  "sessionId": "string",
  "turnId": "string",
  "timestamp": 0,
  "state": "idle|think|tool_use|ask_user|success|error",
  "emotion": "neutral|think|happy|question|sad|awkward|surprised|angry",
  "durationMs": 1200,
  "priority": 50,
  "source": "lobster-main",
  "taskType": "general|search|doc|code|schedule",
  "toolName": "optional",
  "reason": "optional",
  "fallbackEmotion": "neutral"
}
```

## 5. 状态到表情映射（默认）

| 状态 | 默认表情 | 说明 | 回退 |
|---|---|---|---|
| idle | neutral | 空闲待机 | neutral |
| think | think | 推理中 | neutral |
| tool_use | awkward | 执行中反馈 | think |
| ask_user | question | 等待用户输入/确认 | neutral |
| success | happy | 完成反馈 | neutral |
| error | sad | 失败反馈 | awkward |

## 6. 任务类型覆盖映射（v1）

| taskType | think | tool_use | success | error |
|---|---|---|---|---|
| general | think | awkward | happy | sad |
| search | think | question | happy | awkward |
| doc | think | neutral | happy | sad |
| code | think | awkward | surprised | sad |
| schedule | think | neutral | happy | awkward |

## 7. 去抖与节流策略

1. 同状态重复事件在 `400ms` 内忽略。
2. `success/error` 最短展示 `900ms`。
3. 高优先级状态覆盖低优先级状态（`error > ask_user > tool_use > think > idle`）。
4. `tool_use` 连续事件合并为同一动画段，最长 `6s` 后强制刷新。

## 8. 回退策略

1. 若当前模型无目标动作，使用 `fallbackEmotion`。
2. 若 `fallbackEmotion` 也不可用，统一回退 `neutral`。
3. 回退必须写日志，便于补齐动作映射。

## 9. 验收标准（DoD 关联）

1. 五态闭环（`think/tool_use/ask_user/success/error`）事件触发成功率 `>= 99%`。
2. 连续 100 轮对话无动画卡死、无状态乱跳。
3. 未支持动作全部按回退策略执行且有日志。
4. 性能：动画联动层额外开销 P95 `< 5ms/事件`。

## 10. 实施拆分

### 阶段 A：协议落地

- 定义事件结构与校验器。
- 在 Lobster 主流程中发出状态事件。

### 阶段 B：AIRI 消费与映射

- AIRI 侧接入事件消费者。
- 建立状态映射表和回退表。

### 阶段 C：观测与回归

- 增加事件成功率统计。
- 增加五态回归用例与录屏验收样例。
