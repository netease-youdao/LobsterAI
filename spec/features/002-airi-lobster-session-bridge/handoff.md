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
- 权限请求已补上一致性 capability token，`permission.request`、`permission/status`、`permission/list` 均会返回 token，`permission.respond` 必须同时校验 `airiSessionId + requestId + capabilityToken`
- Airi `ChatArea.vue` 已改走 `/api/agent/bridge/chat`，不再通过 `/v1/chat/completions` 直连文本流
- Airi 已可在聊天区恢复并展示待处理权限卡片，并使用 capability token 提交 `allow / deny`
- Airi 已支持 Lobster 技能列表、启停、配置读取与保存
- Airi 已支持技能安装入口与风险确认卡片
- Airi 设置页已新增独立技能管理页面，可查看技能列表、编辑配置、添加来源并确认安装风险
- Airi 聊天区技能条已补充技能数量摘要与“管理技能”入口
- Airi 已补上共享 Lobster skills 状态，技能总数 / 启用数 / 选中数现在走统一口径
- 已修复聊天区技能摘要显示异常，改为稳定的统计标签展示
- Airi 技能配置区已从 JSON 文本框升级为表单化键值编辑，并补上重复键校验、敏感字段遮罩与新增/删除配置项
- 技能安装成功后会在列表里高亮新技能，并自动打开配置区便于继续编辑
- 已修复聊天区底部按钮与技能条互相遮挡的问题，附件/语音控制改为正常文档流布局
- 已补上聊天容器 `min-h-0` 约束，消息区在输入区变高时可正常收缩与滚动
- 聊天区底部已拆出 `LobsterSkillsBar`、`LobsterPermissionList`、`ChatInputControls` 三个组件，便于后续继续拼装与调整
- 已修复聊天操作按钮压在右下角的问题，删除消息与背景切换按钮回到正常布局流
- Airi 聊天桥接已兼容 `assistant / reasoning / tool_use / tool_result` 等别名事件，并在初始化时立即拉取技能状态
- 技能条现在会同时展示“启用 / 未启用”状态，底部控制条也会显示启用数 / 总数 / 已选数
- 聊天区技能摘要已进一步收敛为“总技能 / 已启用”统计，不再在聊天区平铺完整技能列表
- LobsterAI 现在会在发现绑定的 session 已失效时自动重建 bridge 绑定，避免继续命中 `Session ... not found`
- Claude 路径已补 `onSessionDeleted` 清理，session 删除后不会再残留 runtime 内存态造成桥接续聊继续命中旧 session
- 工具参数与工具结果已可在聊天消息中显示
- 工具结果已支持长输出展开、复制与错误态高亮
- 技能安装已支持成功 / 取消 / 错误反馈提示
- Airi 当前激活角色卡中的 `systemPrompt + description + personality` 已会透传到 Lobster Bridge 的 `systemPrompt`，LobsterAI runtime 不再固定回落到默认 Claude 风格提示词
- 用户可继续直接在 Airi `settings/airi-card` 中编辑角色卡的人设、系统提示词与描述，无需再到 LobsterAI 侧单独维护一份人格配置

## 计划进度

- Phase 1：已完成主体能力
- Phase 2：已完成主体能力
- Phase 3：已完成主体能力
- Phase 4：已完成 `T017`、`T020`，并补上技能安装 / 风险确认入口；`T018` 进入可用首版，`T019/T021` 仍待收口
- Phase 5：`T022-T024` 已完成，`T025-T026` 处于可用但仍需系统化回收与专项验证
- Phase 6：`T027-T030` 已完成首版闭环，并补上按 chat session 恢复待处理权限确认视图
- Phase 6：已进一步补上服务端权威状态查询、pending 列表恢复与 expired/not_found 提示
- Phase 6：已补上权限一次性 capability 校验，当前权限回包必须命中所属 session 与有效 token
- Phase 7：`T031` 已完成，`T032-T034` 待完成
- Phase 8：已完成部分手工联调，自动化验证仍需继续补强

## 关键文件

- LobsterAI
  - `src/main/libs/agentApiServer.ts`
  - `src/main/libs/agentBridgeSessionStore.ts`
  - `scripts/bridge-smoke-test.cjs`
  - `scripts/skill-api-smoke-test.cjs`
- Airi
  - `packages/stage-ui/src/stores/modules/airi-card.ts`
  - `packages/stage-ui/src/stores/chat.ts`
  - `packages/stage-ui/src/types/lobster-bridge.ts`
  - `packages/stage-layouts/src/components/Widgets/ChatArea.vue`
  - `packages/stage-layouts/src/components/Widgets/ChatActionButtons.vue`
  - `packages/stage-layouts/src/components/Widgets/ChatContainer.vue`
  - `packages/stage-layouts/src/components/Widgets/ChatInputControls.vue`
  - `packages/stage-layouts/src/components/Widgets/LobsterSkillsBar.vue`
  - `packages/stage-layouts/src/components/Widgets/LobsterPermissionList.vue`
  - `packages/stage-layouts/src/components/Layouts/InteractiveArea.vue`
  - `packages/stage-pages/src/pages/settings/skills/index.vue`
  - `packages/stage-ui/src/composables/use-lobster-skills.ts`

## 当前已知策略

- Lobster Bridge 流超时已提升到 180 秒，避免大文件和工具任务误判超时
- Bridge 收尾已监听 Lobster `complete` 事件，减少“原生完成但 Airi 超时”的问题
- 工具调用参数来自 `message.metadata.toolInput`
- 工具结果默认走纯文本 / JSON 展示，不走 Markdown 富文本渲染，并优先根据 `isError` 做错误态高亮
- 思考过程复用 Airi 现有 `categorization.reasoning` 展示链路
- Bridge 路径当前会复用 Airi 会话中的首条 system message 作为 `systemPrompt` 透传，因此角色卡里配置的人设、描述与系统提示词会随会话一起生效
- 权限确认面板的待处理状态保存在 `ChatSessionMeta.bridgeState.pendingPermission`
- `/api/agent/bridge/permission/status` 可用于前端恢复时校验 requestId 仍然有效
- `/api/agent/bridge/permission/status` 与 `/api/agent/bridge/permission/list` 会在 pending 状态返回 capabilityToken，供刷新恢复后的确认卡片继续回包
- `permission.respond` 不再只依赖 requestId，必须校验一次性 capabilityToken
- Airi 当前通过 `ChatArea.vue` 直接消费 Bridge SSE，并在同一聊天区展示工具、思考与权限状态
- 技能正式管理入口当前位于 `settings/skills`，聊天区只保留轻量选择与跳转入口
- `settings/skills` 与 `ChatArea.vue` 现在共享同一份 skills 拉取、规范化与计数逻辑
- 技能配置编辑当前采用安全边界更清晰的键值表单，不再直接暴露 JSON 文本框
- 聊天区底部控制条已改成流式布局，不再压住技能统计与技能列表
- 聊天区底部区域当前已完成首轮组件拆分，`ChatArea.vue` 主要保留状态协调与事件处理
- 聊天桥接消费层现在会兼容部分旧事件别名，减少 Airi / LobsterAI 版本漂移导致的空白回复问题
- `ChatArea.vue` 聊天区当前只保留技能统计，不再直接展示完整技能 chip 列表
- Claude runtime 与 store 的 session 删除清理链路现在已对齐 OpenClaw，减少“store 已删但 runtime 仍引用旧 session”的情况

## 当前可运行测试节点

- Bridge 冒烟测试
  - `node scripts/bridge-smoke-test.cjs`
- 技能 API 冒烟测试
  - `node scripts/skill-api-smoke-test.cjs`
- 权限 capability store 单测
  - `npm run test -- src/main/libs/agentBridgeSessionStore.test.ts`
- Airi ChatArea 类型检查
  - `pnpm -F @proj-airi/stage-layouts typecheck`
- Airi Skills 设置页类型检查
  - `pnpm -F @proj-airi/stage-pages typecheck`
- Airi stage-ui 类型检查
  - `pnpm -F @proj-airi/stage-ui typecheck`

## 下一步建议

- 技能设置页继续补技能市场与更细的风险报告展示
- 技能配置表单继续补字段 schema 映射与更友好的输入组件
- 技能共享状态继续补跨页刷新提示
- 权限确认 UI 继续补到服务端权威恢复与过期状态提示
- 服务端 pending permissions 继续补持久化，避免进程重启后丢失
- 将 `ChatArea.vue` 里的 Bridge 请求与权限状态逻辑继续抽离，避免状态协调继续堆积
- 工具结果继续补结构化折叠与复制成功反馈细节
- 收紧默认 key 与通配 CORS 风险
