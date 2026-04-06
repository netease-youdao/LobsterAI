# 任务清单：Airi × LobsterAI 会话化 Agent Bridge 重构

**Feature**: 002-airi-lobster-session-bridge  
**建议分支**: feature/spec-002-airi-lobster-session-bridge  
**生成时间**: 2026-03-27

---

## 当前核对结果（2026-04-05）

- 当前阶段从“继续堆功能”切换为“会话正确性收口 + 验证闭环”
- 最小止血已落地：显式 `sessionMode`、`bridgeState` 快照、`text-fast -> agent` 单向升级、历史文件 `stale` 标记
- 当前主风险已从“模式漂移”转为“请求语义完整性”和“验证证据不足”
- 当前任务状态统一采用：
  - `已实现`：代码主链已落地，且有基础验证
  - `部分实现`：功能可用，但架构目标或验证证据未收口
  - `待验证`：实现已存在，但缺少系统化联调证据
  - `未开始`：未进入主链

## 阶段总览

| 阶段 | 目标 | 当前状态 | 说明 |
| --- | --- | --- | --- |
| A | 协议与会话契约 | 部分实现 | 主链止血已完成，但 authoritative session contract 未建立 |
| B | Bridge 正确性 | 部分实现 | 请求语义、历史上下文、图片链路仍需收口 |
| C | 多模态与能力 | 部分实现 | 文件可用，图片/技能/过程态仍需逐项补证据 |
| D | UI/状态下沉 | 部分实现 | `ChatArea.vue` 仍承担较重编排职责 |
| E | 联调与证据 | 待验证 | 仍缺场景矩阵级别证据与统一口径 |

## 阶段 A：协议与会话契约

- [已实现] T001 `src/main/libs/agentBridgeSessionStore.ts` 已维护 `airiSessionId -> lobsterSessionId` 映射、会话代际、`sessionMode` 与文本 transcript
- [已实现] T002 `src/main/libs/agentApiServer.ts` 已具备 session bind/create/continue 协议骨架
- [已实现] T003 Bridge 事件已统一包含 `sessionId`、`turnId`、`seq`、`type`、`createdAt`
- [已实现] T004 `src/main/libs/coworkRunner.ts` 已暴露 Bridge 所需 session 能力
- [已实现] T005 `src/main/main.ts` 已完成 `AgentApiServer` 依赖注入
- [部分实现] T006 Airi 会话元数据已持久化 `bridgeState` 快照，但仍缺 authoritative session 查询接口
- [部分实现] T007 `session.bound` 与 bind 响应已带 `sessionMode`，但前后端契约仍有兼容层存在
- [未开始] T008 新增 authoritative `bridge session snapshot` 查询接口，作为重启后权威恢复来源

---

## 阶段 B：Bridge 正确性

- [已实现] T009 服务端已输出 `assistant.delta`、`assistant.final`、`tool.call`、`tool.result`、`done`、`error`
- [已实现] T010 `packages/stage-ui/src/services/lobster-bridge.ts` 已完成 Airi 侧 Bridge Client
- [已实现] T011 `packages/stage-ui/src/stores/chat.ts` 已接入 Lobster Bridge，事件回归统一聊天主链
- [部分实现] T012 `ChatArea.vue` 已不再承担原始 SSE 逐包解析，但仍承担较重的 Bridge 发送编排与恢复逻辑
- [已实现] T013 当前 Bridge payload 已显式承载当前轮用户输入、图片与模块上下文信息，不再只发送裸文本
- [部分实现] T014 `buildUserContent` 已接入主链，但“完整历史上下文”仍依赖服务端会话，尚未形成权威 session snapshot 拉取闭环
- [未开始] T015 为“同一会话刷新/重启后恢复”的主路径补 authoritative 对账逻辑

---

## 阶段 C：动作、多模态与能力

- [已实现] T016 `state.changed=think` 已映射到 Airi 等待态动作
- [已实现] T017 `assistant.delta` 首 token 已映射到说话态与口型驱动
- [已实现] T018 `tool.call/tool.result` 已映射到工具执行态动作
- [已实现] T019 `assistant.final/done` 已映射到完成态与 idle 恢复
- [已实现] T020 `Stage.vue` 已增加结构化状态到 emotion queue 的映射
- [部分实现] T021 技能列表、启停、配置、聊天区入口已存在，但“功能能力”和“状态抽象”尚未完全统一
- [部分实现] T022 文件上传、`fileId`、reattach、`stale` UI 已落地，但文件物理回收与生命周期仍未收口
- [已实现] T023 图片附件与普通文件已在同一 turn 通过 smoke 验证，覆盖“纯文本 -> 文件上传 -> 图片+文件同轮 -> reattach”主链
- [部分实现] T024 `reasoning.delta / reasoning.final` 已由服务端发出并接入聊天主链，当前剩余产品策略是默认展示方式与可见性收口

---

## 阶段 D：UI/状态下沉与技术债治理

- [部分实现] T025 `ChatArea.vue` 已比早期版本更轻，但仍承担 Bridge 发送、文件重附加、权限恢复与错误翻译
- [部分实现] T026 `lobster-bridge.ts` 已承担协议兼容与事件规范化，但请求样板仍可继续抽象
- [部分实现] T027 技能状态已有 composable/面板，但未完全沉到独立 store / adapter
- [未开始] T028 将 Bridge 发送编排从 `ChatArea.vue` 进一步下沉到 adapter/composable
- [部分实现] T029 文件状态已进入会话层，权限状态与技能选择已下沉到 `lobster-bridge-session` store，后续仍可继续抽象为统一 adapter

---

## 阶段 E：联调与验证证据

- [待验证] T030 文本单轮：等待态、流式文本、完成态全链路
- [待验证] T031 多轮会话：runtime session 复用与上下文保持
- [待验证] T032 文件：上传、引用、reattach、`stale` 转换、清理
- [待验证] T033 图片：视觉输入与展示
- [部分实现] T034 技能：已通过 `github-deep-research` 真实 smoke 验证 skillIds + 文件组合进入主链，仍待补配置编辑与更多技能回归证据
- [已实现] T035 权限请求：已通过真实 smoke 验证 `allow/deny` 双路径语义与 `permission.request` 回流
- [待验证] T036 回退模式：关闭 Bridge 后文本兼容模式仍可工作
- [待验证] T037 安全与脱敏：`tool.call` / `tool.result` / `permission.request` 无路径泄露
- [待验证] T038 性能与稳定性：`ttft`、首字延迟、长会话升级、多轮连续发送

---

## 说明

- 本任务清单已改为“按层级 + 按完成定义”组织，避免把功能项、架构项、验证项混在同一粒度。
- 当前优先级顺序为：会话正确性 > 多模态正确性 > 过程态与验证证据 > UI 下沉。
- 只有进入“已实现”或“待验证”的任务，才代表主链已接入；其余不建议对外宣称完成。
