# Bridge 会话止血工作日志

## 背景

- 问题不是单点 UI 缺陷，而是 Airi 聊天会话与 LobsterAI Agent Runtime 会话模型不一致。
- 主要表现为：
  - 同一会话在 `text-fast` 与 `agent` 之间反复锁定
  - 文件上传 / re-attach 在重启后表现失真
  - Airi 仍记得历史文件，但 LobsterAI Bridge 已忘记内存 binding

## 本轮目标

- 先完成最小止血，不再继续做零散补丁
- 让 Bridge 会话具备：
  - 显式 `sessionMode`
  - 可持久化的 `bridgeState` 快照
  - `text-fast -> agent` 单向升级
  - 历史文件弱校验与 `stale` 标记

## 关键节点

### 节点 1：确认根因

- 确认 Airi 过去没有显式发送 `sessionMode`
- 确认 LobsterAI 过去会按每轮请求能力自动推导模式
- 确认 Airi 本地持久化了 `fileRefs`，LobsterAI 只在内存保存 binding
- 结论：这会导致同一 `airiSessionId` 在重启、多轮、多模态切换后出现系统性错位

### 节点 2：Airi 侧补 bridgeState 快照

- 扩展 `ChatSessionBridgeState`
- 新增字段：
  - `sessionMode`
  - `lobsterSessionId`
  - `bindingStatus`
  - `lastBoundAt`
- 扩展 `ChatSessionBridgeFileRef`
- 新增字段：
  - `bindingState`
  - `lobsterSessionId`
  - `clientTurnId`

### 节点 3：Airi 侧发送链路改为显式模式

- `chat.ts` 发送 Bridge 请求时会根据当前会话状态和文件/图片/技能输入显式传 `sessionMode`
- 一旦会话进入 `agent`，后续继续按 `agent` 发，不再交由后端重新猜测
- `session.bound` 事件会回填并持久化 `lobsterSessionId` 与 `sessionMode`

### 节点 4：LobsterAI 侧单向升级

- 服务端允许 `text-fast -> agent`
- 进入 `agent` 后不再反向 silent downgrade
- 文件上传与 `reattach` 不再先被 `bridge_mode_locked` 阻断，而是优先升级 binding
- 从 `text-fast` 升到 `agent` 时，会把纯文本 transcript 注入 agent 首轮 prompt

### 节点 5：文件弱校验与 UI 收口

- Airi 不再把历史文件一律视为可重新附加
- 当 binding 变化或服务端回报 `bridge_file_missing` 时，历史文件会标记为 `stale`
- UI 中 `stale` 文件显示为 `需重传`
- 只有 `active` 文件允许 `重新附加`

### 节点 6：协议补齐

- `session.bound` 事件补齐 `sessionMode`
- `bind` 响应补齐 `sessionMode`
- Airi SSE 规范化逻辑支持在服务端未回传 `sessionMode` 时，根据 `lobsterSessionId` 做兼容推断

## 变更文件

### Airi

- `packages/stage-ui/src/types/chat-session.ts`
- `packages/stage-ui/src/stores/chat/session-store.ts`
- `packages/stage-ui/src/types/lobster-bridge.ts`
- `packages/stage-ui/src/services/lobster-bridge.ts`
- `packages/stage-ui/src/stores/chat.ts`
- `packages/stage-layouts/src/components/Widgets/ChatArea.vue`

### LobsterAI

- `src/main/libs/agentBridgeSessionStore.ts`
- `src/main/libs/agentBridgeSessionStore.test.ts`
- `src/main/libs/agentApiServer.ts`

## 验证记录

### 代码检查

- LobsterAI 单测通过
  - `npm run test -- src/main/libs/agentBridgeSessionStore.test.ts`
- LobsterAI 编译通过
  - `npm run compile:electron`
- Airi 类型检查通过
  - `pnpm -F @proj-airi/stage-ui typecheck`
- Airi 相关测试通过
  - `pnpm -F @proj-airi/stage-ui exec vitest run src/stores/chat-bridge-mode.test.ts src/stores/llm.test.ts`

### 请求级验证

- 直接 HTTP 验证确认：
  - 同一 `airiSessionId` 先走 `text-fast`
  - 再走文件上传
  - 文件上传不再被 Bridge 上传接口先行 `bridge_mode_locked`

### 运行时说明

- 本地存在一个常驻 LobsterAI 运行实例，占用了现有开发端口与 Agent API 端口
- 因此直接命中的 19888 端口未必总是本轮新代码对应的最新主进程
- 为避免混淆，最终手测前必须完整重启现有 LobsterAI 与 Airi 进程

## 当前交付状态

- 最小止血已完成
- 现在应具备的行为：
  - 同一会话可以从纯文本升级到多模态
  - 会话模式不再每轮漂移
  - 历史文件不会在 binding 失效后假装仍可用
  - `session.bound` 与本地 bridgeState 快照能够对齐

## 2026-04-05 进度快照

- 当前阶段定位：
  - 已从“主链不可用”进入“主链可用但需系统验证”
- 当前真正的 P0 不再是模式锁，而是：
  - Bridge 请求是否完整携带历史上下文
  - 图片链路是否真正进入主请求语义
  - `reasoning.*` 是否需要进入可见 UI
- 已完成的 P0 收口：
  - 当前轮用户输入已通过 Bridge helper 统一构造成主请求内容
  - 图片附件已进入 Bridge 主请求，而不再只参与模式推断
  - 模块上下文已作为“仅供参考”的文本前缀并入当前轮请求
- 当前任务颗粒度已统一为 4 类：
  - `Contract` 协议契约
  - `Correctness` 行为正确性
  - `UX/State` 交互与状态
  - `Verification` 联调与证据
- 当前建议执行顺序：
  - 先做会话正确性与请求语义
  - 再做多模态正确性与过程态
  - 最后继续拆 `ChatArea.vue` 与 adapter
- 已完成的 P1 起步：
  - 新增 `scripts/bridge-smoke-test.cjs` 的多模态 smoke 覆盖，纳入“纯文本 -> 文件上传 -> 图片+文件同轮 -> reattach”主链检查
  - 已补 `lobster-bridge.test.ts`，对当前轮文本、图片与上下文拼装做工程测试
  - 已补 `npm run bridge:smoke` 作为统一入口，便于后续真实运行态回归
  - 已在本地真实运行态完成一次 smoke 通过，确认图片+文件同轮与 reattach 主链可工作
  - 已用 `github-deep-research` 验证 `skillIds + file` 组合进入主链
  - 已补稳定可复现的权限 smoke 场景：先创建 `permission-smoke.txt`，再请求删除，能够收到 `permission.request`
  - 已在本地真实运行态完成 `permission.request` 的 `allow / deny` 双路径核对
  - 已将权限状态与技能选择下沉到 `lobster-bridge-session` store，并打通 `reasoning.*` 主链事件
  - 已修复 Airi -> Bridge 的 `systemPrompt` 透传，角色卡提示词重新在 text-fast 与 agent 模式生效
  - 已修复图片回复“LobsterAI 有答案但 Airi 不显示”的主链兜底，assistant.final 现会回填可见正文
  - 已修复 Cowork / Airi 侧 ACT 指令直出问题，当前会消费 ACT 驱动动作，并从可见文本中剥离控制 token
  - 已完成 Airi Web/Desktop 一致性第一阶段：共享启动装配、核心初始化、settings system 主体与首页主舞台主体开始共用
  - 已完成 Airi Web/Desktop 一致性第二阶段：channel-server / developer 菜单 / data settings / ChatArea 的平台分支继续迁移到 runtime capability
  - 已在 Airi 侧完成第二阶段后的 `stage-web` 与 `stage-tamagotchi` typecheck/build 通过，确认当前 Lobster Bridge 接入面未被一致性改造破坏
  - 已在 Airi 侧新增 `openclaw-agent` 独立 provider 入口，并完成 onboarding / settings / ChatArea / 技能条的桥接复用
  - 已将 Bridge 专用提示词下沉到角色卡 `extensions.airi.agents.openclaw.prompt`，Bridge 聊天现通过 `systemPrompt` 显式透传，避免继续转发 Airi 原生角色提示词
  - 已在 Airi 前端加入运行时保护：使用 `lobster-agent` / `openclaw-agent` 且未配置角色卡 OpenClaw 提示词时，聊天发送会被阻止并提示先到角色卡设置填写

## 待你手测的检查点

- 同一会话：
  - 先发纯文本
  - 再上传文件
  - 再提问
- 重启后：
  - 历史文件若失效，应显示 `需重传`
  - 不应继续表现为可直接 `重新附加`
- re-attach：
  - 只有 `active` 文件可以点击
  - `stale` 文件应被禁用

## 后续结构性重构入口

- 将 Bridge session 从“前端猜状态”升级为 authoritative session contract
- 将 LobsterAI BridgeSessionStore 从内存 Map 升级为持久化存储
- 暴露真实模型能力，而不是继续使用壳模型抽象
