# 当前对接交接

## 已完成能力

- Airi 与 LobsterAI 已通过会话化 Bridge 对接
- `airiSessionId -> lobsterSessionId` 映射已接入
- Bridge 已支持：
  - `session.bound`
  - `state.changed`
  - `reasoning.delta / reasoning.final`
  - `assistant.delta / assistant.final`
  - `tool.call / tool.result`
  - `permission.request`
  - `done / error`
- 文件上传已改为 `fileId` 引用，真实路径仅保留在 LobsterAI 内部映射
- Airi 已支持权限确认卡片与 `allow / deny` 回传
- 权限确认状态已按 chat session 持久化，可在切换回来或刷新后恢复当前会话的待处理请求视图
- 服务端已支持权限状态查询，前端会在恢复时校验 requestId 是否仍然 pending，并对 expired / not_found 给出提示
- Airi 已支持 Lobster 技能列表、启停、配置读取与保存
- Airi 已支持技能安装入口与风险确认卡片
- 工具参数与工具结果已可在聊天消息中显示
- 工具结果已支持长输出展开、复制与错误态高亮
- 技能安装已支持成功 / 取消 / 错误反馈提示

## 计划进度

- Phase 1：已完成主体能力
- Phase 2：已完成主体能力
- Phase 3：已完成主体能力
- Phase 4：已完成 `T017`、`T020`，并补上技能安装 / 风险确认入口；`T018` 进入可用首版，`T019/T021` 仍待收口
- Phase 5：`T022-T024` 已完成，`T025-T026` 处于可用但仍需系统化回收与专项验证
- Phase 6：`T027-T030` 已完成首版闭环，并补上按 chat session 恢复待处理权限确认视图
- Phase 6：已进一步补上服务端权威状态查询与 expired/not_found 提示，但仍未实现“服务端下发 pending 列表”的完整恢复
- Phase 7：`T031` 已完成，`T032-T034` 待完成
- Phase 8：已完成部分手工联调，自动化验证仍需继续补强

## 关键文件

- LobsterAI
  - `src/main/libs/agentApiServer.ts`
  - `src/main/libs/agentBridgeSessionStore.ts`
  - `scripts/bridge-smoke-test.cjs`
  - `scripts/skill-api-smoke-test.cjs`
- Airi
  - `packages/stage-ui/src/services/lobster-bridge.ts`
  - `packages/stage-ui/src/stores/chat.ts`
  - `packages/stage-ui/src/stores/chat/hooks.ts`
  - `packages/stage-ui/src/components/scenes/Stage.vue`
  - `packages/stage-layouts/src/components/Widgets/ChatArea.vue`
  - `packages/stage-ui/src/components/scenarios/chat/assistant-item.vue`
  - `packages/stage-ui/src/components/scenarios/chat/tool-call-block.vue`
  - `packages/stage-ui/src/components/scenarios/chat/tool-result-block.vue`

## 当前已知策略

- Lobster Bridge 流超时已提升到 180 秒，避免大文件和工具任务误判超时
- Bridge 收尾已监听 Lobster `complete` 事件，减少“原生完成但 Airi 超时”的问题
- 工具调用参数来自 `message.metadata.toolInput`
- 工具结果默认走纯文本 / JSON 展示，不走 Markdown 富文本渲染，并优先根据 `isError` 做错误态高亮
- 思考过程复用 Airi 现有 `categorization.reasoning` 展示链路
- 权限确认面板的待处理状态保存在 `ChatSessionMeta.bridgeState.pendingPermission`
- `/api/agent/bridge/permission/status` 可用于前端恢复时校验 requestId 仍然有效

## 当前可运行测试节点

- Bridge 冒烟测试
  - `node scripts/bridge-smoke-test.cjs`
- 技能 API 冒烟测试
  - `node scripts/skill-api-smoke-test.cjs`

## 下一步建议

- 技能安装 / 下载 / 风险确认继续细化到正式管理面板
- 权限确认 UI 继续补到服务端权威恢复与过期状态提示
- 服务端继续补“按 session 拉取 pending permission 列表”
- 工具结果继续补结构化折叠与复制成功反馈细节
- 收紧默认 key 与通配 CORS 风险
