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
- Airi 已停止向 Bridge 透传角色卡 `systemPrompt`，当前普通聊天恢复为 LobsterAI 默认提示词链路，优先保证响应速度、发声稳定性与回复自然度
- 用户仍可继续在 Airi `settings/airi-card` 中维护角色卡配置，但当前 Bridge 普通聊天不再直接消费这份提示词

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
- 思考过程默认不再面向终端用户展示，前端仅保留调试开关
- Bridge 路径当前不再透传 Airi 角色卡 `systemPrompt`，普通聊天优先回到 LobsterAI 默认提示词链路
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
- 当前聊天发声链路依赖 `assistant.delta` 驱动 Stage token hooks；若重新回到单包 `assistant.final` 或首包过慢，聊天 TTS 很容易再次失效
- 当前语音体验为“文本流式 + 分段 TTS + 预取播放”，不是音频 chunk 级真流式

## 真流式语音开发计划

- Phase A：Airi 播放层流式化
  - 新增可持续消费音频帧的播放器能力，替代当前以完整 `AudioBuffer` 为单位的播放方式
  - 目标是支持边接收边播放，而不是每段完整生成后再播放
- Phase B：Speech provider 能力扩展
  - 为 speech provider 增加 stream output 能力声明
  - 在 Airi speech store 新增 streaming TTS 接口，并保留当前整段 TTS 作为 fallback
- Phase C：Speech pipeline 会话化
  - 将当前“文本分段 -> 每段一次 TTS 请求”升级为“单次会话持续喂文本 -> 持续产出音频”
  - 让文本 token、音频输出、打断/flush 语义统一到一个 streaming session
- Phase D：舞台联动与体验打磨
  - 将口型、说话状态、打断、恢复统一到 streaming 播放链路
  - 增加首帧时间、段间 gap、打断耗时等专项验证指标
- 当前阶段结论
  - 这项工作已正式纳入后续开发计划
  - 当前优先级高于继续扩展人格提示词接入

## 交接时需要特别注意的遗漏项

- 文档一致性
  - 旧记录里仍有“透传 Airi systemPrompt”的描述，交接时应以本文件和最新 `verification-checklist.md` 为准
- 系统化验证缺口
  - 多轮会话、图片前端附件、普通文件前端展示与回收、技能设置页生效、权限 allow/deny、Bridge 开关回退模式仍需继续补完整 UI 联调记录
- 安全与工程风险
  - 默认 API key 仍在
  - `Access-Control-Allow-Origin: *` 仍未收紧
  - pending permission 仍是内存态
  - temp 文件物理回收仍未完成
- 前端结构风险
  - `ChatArea.vue` 仍承载较多 Bridge、权限、技能状态协调逻辑，后续仍需继续拆分
- 语音能力边界
  - 当前体验已可接受，但仍不是真正音频流式；后续接手者不要把当前“分段 TTS 预取播放”误判为最终形态

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

- 将“真流式语音输出”按 Phase A-D 拆成独立 backlog，并先完成播放器与 provider 能力设计
- 技能设置页继续补技能市场与更细的风险报告展示
- 技能配置表单继续补字段 schema 映射与更友好的输入组件
- 技能共享状态继续补跨页刷新提示
- 权限确认 UI 继续补到服务端权威恢复与过期状态提示
- 服务端 pending permissions 继续补持久化，避免进程重启后丢失
- 将 `ChatArea.vue` 里的 Bridge 请求与权限状态逻辑继续抽离，避免状态协调继续堆积
- 工具结果继续补结构化折叠与复制成功反馈细节
- 收紧默认 key 与通配 CORS 风险
