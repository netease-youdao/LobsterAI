# 工程控制记录

## 本轮目标

- 完成按 session 拉取 pending permission 列表
- 完成前端权威恢复与过期提示
- 完成权限回包一次性 capability 校验
- 完成 Airi ChatArea 对 Bridge SSE 与权限 capability 回包的接入
- 对当前 Bridge 对接进行工程控制复查
- 准备本地 git 存档前的检查依据

## 已执行检查

- LobsterAI 编译
  - `npm run compile:electron`
- LobsterAI 权限 store 单元测试
  - `npm run test -- src/main/libs/agentBridgeSessionStore.test.ts`
- airi ChatArea 类型检查
  - `pnpm -F @proj-airi/stage-layouts typecheck`
- airi Skills 设置页类型检查
  - `pnpm -F @proj-airi/stage-pages typecheck`
- airi stage-ui 类型检查
  - `pnpm -F @proj-airi/stage-ui typecheck`
- airi 类型检查
  - `pnpm -r -F @proj-airi/stage-web run typecheck`
  - `pnpm -r -F @proj-airi/stage-ui run typecheck`
- 文件编码检查
  - 本轮关键改动文件均为 `UTF8-no-BOM`
- 代码诊断检查
  - 关键改动文件 VS Code diagnostics 全部为 0

## 本轮实现摘要

- 服务端新增 `/api/agent/bridge/permission/list`
- 服务端 permission binding 现在保留 `toolName`、`toolInput`
- 前端恢复 pending permission 时优先拉取服务端列表并以服务端为准
- 若服务端无 pending request，则清除本地卡片并提示 expired / not_found 语义
- 服务端为每个 pending permission 生成 capability token
- `permission.request`、`permission/status`、`permission/list` 现在都会返回 capability token
- `permission.respond` 现在必须命中 `airiSessionId + requestId + capabilityToken`
- Airi `ChatArea.vue` 已切到 `/api/agent/bridge/chat`，并消费 `assistant.*`、`reasoning.*`、`tool.*`、`permission.request`
- Airi 现在可恢复服务端 pending permission 列表，并在聊天区提交 capability token 版 `allow / deny`
- Airi 设置页已新增 `settings/skills`，可查看技能列表、启停技能、读取保存配置、添加来源并确认风险安装
- Airi 聊天区技能条已补充技能数量摘要与“管理技能”跳转入口
- Airi 已抽出共享 `use-lobster-skills` composable，统一 `/api/agent/skills` 拉取、字段规范化与技能计数口径
- 已修复技能总数 / 启用数显示不稳定与聊天区摘要显示异常问题
- Airi 技能配置区已改为表单化键值编辑，补上重复键校验、敏感字段遮罩与新增/删除配置项
- 技能安装成功后会高亮新技能并自动打开配置区，便于继续编辑
- Airi 聊天区底部附件 / 语音控制已改为正常文档流布局，不再覆盖技能统计与技能列表
- `InteractiveArea.vue` 与 `ChatContainer.vue` 已补上 `min-h-0` 约束，消息区在输入区变高时可正常收缩滚动
- Airi 聊天区底部已拆出 `LobsterSkillsBar`、`LobsterPermissionList`、`ChatInputControls` 三个组件，降低后续 UI 拼装成本
- Airi `ChatActionButtons` 已回到正常布局流，不再压在聊天卡片右下角
- Airi 聊天桥接消费已兼容 `assistant / reasoning / tool_use / tool_result` 等别名事件，并在初始化时立即拉取技能状态
- 技能条与底部控制条已补上启用状态展示，避免只看到总数看不到启用情况
- Airi 聊天区已收敛为仅展示技能统计，不再平铺完整技能列表，减少对消息区的视觉干扰
- LobsterAI 在 bridge 绑定命中失效 session 时会自动重建 runner session，避免继续报 `Session ... not found`
- Claude runtime 已补 `onSessionDeleted` 清理，session 删除后会同步停止旧 runtime session，减少残留引用
- Airi Bridge 请求现在会从当前会话首条 system message 提取 `systemPrompt` 并透传给 LobsterAI
- Airi 角色卡中的 `systemPrompt`、`description`、`personality` 现在会沿着会话 system message 一起进入 Lobster runtime，不再长期停留在默认 Claude 风格提示词
- 用户当前可直接通过 Airi `settings/airi-card` 页面维护提示词与性格，Bridge 路径会复用这份配置

## 合规结论

- 类型检查：通过
- 编译检查：通过
- 权限 capability 单元测试：通过
- Airi ChatArea 类型检查：通过
- Airi Skills 设置页类型检查：通过
- Airi stage-ui 类型检查：通过
- Airi stage-pages 类型检查：通过
- 文件编码：通过
- 基础协议一致性：通过
- 本地恢复行为：通过

## 仍需收口的风险

- P0
  - 默认 key 仍存在
  - `Access-Control-Allow-Origin: *` 仍开放
  - 技能配置接口仍会直接读写敏感 `.env`
- P1
  - 服务端 pending permissions 仍为内存态，进程重启后丢失
  - temp 上传文件仍缺物理回收
  - 历史会话仍以服务端 session 为准，客户端尚未具备 authoritative session snapshot 拉取与对账
  - `reasoning.delta / reasoning.final` 已进入主链，但默认展示策略仍待最终产品收口
- P2
  - `ChatArea.vue` 继续承载较多技能/权限 UI 逻辑
  - `ChatArea.vue` 当前仍同时承担 Bridge 协议解析与状态协调，后续仍需继续拆分
  - 技能配置表单当前仍基于键值对启发式渲染，尚未接入真实 schema 元数据
  - 技能共享状态目前仍未补安装完成后的跨页面提示与更细粒度刷新反馈
  - 聊天布局虽已止血，但底部区域仍有较多交互状态从 `ChatArea.vue` 下发，后续仍建议继续下沉
  - Airi / LobsterAI 事件命名仍可能继续漂移，后续最好补统一适配层和专项回归测试
  - bridge 绑定重建目前仍依赖运行时 session 探测，后续可继续补显式 reset/rebind 能力
  - 目前仍依赖删除事件驱动清理，后续可补更强的会话一致性自检
  - `lobster-bridge.ts` 请求样板仍可抽象
  - `hooks.ts` 与 bridge adapter 仍有进一步收口空间
  - 技能选择与待处理权限虽已下沉到 `lobster-bridge-session` store，但还未完全抽象成统一 adapter

## 代码质量判断

- 当前改动未发现明显无用函数或死分支新增
- 当前最大“屎山风险”不是单个坏函数，而是：
  - `ChatArea.vue` 逐渐堆积 bridge 管理逻辑
  - `agentApiServer.ts` endpoint 样板与 runner 生命周期逻辑重复
- 当前建议是“先止血再重构”，不建议本轮再做高风险大拆分

## 本地 git 存档建议

- 仅提交本轮 Bridge 相关文件
- 不纳入 `.trae/`、`airi.zip`、无关未追踪目录
- 提交前再次执行：
  - `git status --short`
  - `git diff --stat`

## 本地 git 存档结果

- LobsterAI 本地提交
  - `526ac7a feat: add agent bridge workflow`
- airi 本地提交
  - `105f68c6 feat: integrate lobster bridge into chat ui`
- 说明
  - 两个子仓库已完成本地提交
  - 各仓库仍存在与本轮 Bridge 工作无关的其他未提交改动，未纳入本次归档

## 下一步建议

- 将“真流式语音输出”拆成独立开发计划，优先完成 Airi 播放层流式化、speech provider streaming 能力声明与 pipeline 会话化设计
- 收紧默认 key 与 CORS
- 增加按 session 的服务端 pending permission 持久化
- 抽离 `ChatArea.vue` 的技能/权限逻辑
- 抽离 `ChatArea.vue` 的 Bridge SSE 解析与请求封装
- 推进技能配置 schema 映射，让表单摆脱启发式键值渲染
- 将底部子组件继续配套抽出 composable / adapter，减少 `ChatArea.vue` 状态协调压力
- 补一轮 Airi / LobsterAI 桥接事件兼容性的专项验证
- 为 bridge 会话增加显式 reset/rebind 能力，降低失效 binding 的恢复成本

## 2026-04-03 补充记录

- Airi 前端已继续完成聊天显示止血：
  - `lobster-bridge.ts` 已补 Bridge 扁平事件到 `payload` 的归一化兼容
  - `ChatArea.vue` 已收敛为仅传显式勾选的 `skillIds`，避免普通消息误走 Cowork 链路
  - `chat.ts` 已补 `assistant.final` 对账与助手消息持久化兜底
  - `history.vue` 已补标签读取回退，避免 i18n 运行时异常导致聊天区整体崩溃
- 已在浏览器中重新验证 `你是谁`：
  - 请求正常命中 `/api/agent/bridge/chat`
  - 最新前端页面已可正常显示回复
- 当前工程判断：
  - “消息发出但没有信息返回”的主要阻塞已收口
  - 下一优先级转为 Airi 发声/测试页无声问题

## 2026-04-03 二次补充记录

- 提示词链路调整
  - 已按当前联调决策停止 Airi 向 Bridge 透传角色卡 `systemPrompt`
  - Bridge 普通聊天已恢复使用 LobsterAI 默认提示词与默认会话链路，优先保证速度与稳定性
  - 服务端继续保留用户可见文本清洗，防止 `ACT / DELAY / 元提示草稿` 混入最终回复
- 流式与发声链路调整
  - 已禁用普通文本 direct bridge path，避免长时间只等单包 `assistant.final` 导致的 `Stream timeout`
  - 当前 Bridge 已重新回到 `assistant.delta -> assistant.final` 的逐步输出模式
  - Airi 聊天超时已放宽到 180 秒，用于覆盖首包较慢与工具前置等待场景
  - Stage TTS 已改为更小分段 + 小并发预取播放，目标是减少聊天播报的断续感
- 当前工程判断
  - 当前 Airi / LobsterAI 聊天框不支持真正的音频 chunk 级流式播放
  - 现阶段可落地的最优方案是“文本流式 + 分段 TTS + 预取播放”

## 2026-04-05 现状快照

- 当前工程状态已从“模式锁导致主链不可用”切换为“主链可用，但验证证据和请求语义完整性不足”
- 已完成：
  - `bridgeState` 快照持久化
  - 显式 `sessionMode`
  - `text-fast -> agent` 单向升级
  - 历史文件 `stale` 标记与弱校验
  - 当前轮用户输入、图片与模块上下文已进入 Bridge 主请求
  - 已补多模态 smoke 脚本，用于覆盖“纯文本 -> 文件上传 -> 图片+文件同轮 -> reattach”主链
  - `package.json` 已补 `npm run bridge:smoke`，便于后续真实运行态回归
  - 已在本地真实运行态跑通图片+文件同轮与 reattach smoke
  - 已在本地真实运行态验证 `skillIds + file` 组合可进入主链
  - 已补稳定可复现的删除文件权限 smoke，可收到 `permission.request`
- 当前最高优先级不再是继续加功能，而是：
  - 验证服务端 session 是否足以承担历史上下文的权威来源
  - 验证 `reasoning.*` 是否需要进入 UI
  - 核对 `permission.request` 在 `allow / deny` 后的最终语义，并继续完善手工测试矩阵
