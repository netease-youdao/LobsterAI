# 任务清单：Airi × LobsterAI 会话化 Agent Bridge 重构

**Feature**: 002-airi-lobster-session-bridge  
**建议分支**: feature/spec-002-airi-lobster-session-bridge  
**生成时间**: 2026-03-27

---

## Phase 1：协议与会话基础设施

- [ ] T001 新增 `src/main/libs/agentBridgeSessionStore.ts`，维护 `airiSessionId -> lobsterSessionId` 映射、turn 游标与会话代际
- [ ] T002 在 `src/main/libs/agentApiServer.ts` 增加 session bind/create/continue 协议骨架
- [ ] T003 在 `src/main/libs/agentApiServer.ts` 定义统一 Bridge 事件信封结构（sessionId、turnId、seq、type、createdAt）
- [ ] T004 在 `src/main/libs/coworkRunner.ts` 暴露 Bridge 所需的 session 继续、历史读取与结束能力
- [ ] T005 在 `src/main/main.ts` 将 `AgentApiServer` 与 session store、runner、状态广播源完成注入

---

## Phase 2：流式事件桥接

- [ ] T006 在 `src/main/libs/agentApiServer.ts` 将现有文本兼容 SSE 升级为结构化事件流
- [ ] T007 在 `src/main/libs/agentApiServer.ts` 输出 `assistant.delta`、`assistant.final`、`tool.call`、`tool.result`、`done`、`error`
- [ ] T008 新建 `packages/stage-ui/src/services/lobster-bridge.ts`，实现 Airi 侧 Bridge Client
- [ ] T009 在 `packages/stage-ui/src/types/chat.ts` 扩展 Bridge 事件类型定义
- [ ] T010 在 `packages/stage-ui/src/stores/chat.ts` 接入 Lobster Bridge，使事件回归统一聊天主链
- [ ] T011 删除或下沉 `packages/stage-layouts/src/components/Widgets/ChatArea.vue` 中的 Lobster 直连 SSE 解析逻辑

---

## Phase 3：动作与等待态恢复

- [ ] T012 将 `state.changed=think` 映射到 Airi 等待态动作
- [ ] T013 将 `assistant.delta` 首 token 映射到说话态与口型驱动
- [ ] T014 将 `tool.call/tool.result` 映射到工具执行态动作
- [ ] T015 将 `assistant.final/done` 映射到完成态与 idle 恢复
- [ ] T016 在 `packages/stage-ui/src/components/scenes/Stage.vue` 中增加结构化状态到 emotion queue 的映射

---

## Phase 4：技能完整接入

- [ ] T017 在 `src/main/libs/agentApiServer.ts` 新增技能详情、配置读取、配置保存接口
- [ ] T018 在 `src/main/libs/agentApiServer.ts` 新增技能安装/下载与风险确认接口封装
- [ ] T019 新建 Airi 侧 Lobster 技能 store，拉取技能列表、启停状态与配置结构
- [ ] T020 在 Airi 中新增技能面板，支持查看、启停、勾选与配置编辑
- [ ] T021 将 turn 级 `skillIds` 与 session 级技能配置分离处理

---

## Phase 5：文件与图片会话化

- [ ] T022 在 `src/main/libs/agentApiServer.ts` 将上传接口从返回物理路径改为返回 `fileId`
- [ ] T023 新增文件元数据 registry，绑定 sessionId、turnId、ttl、mimeType、size
- [ ] T024 修改 Airi 侧上传逻辑，统一发送 `fileId` 而不是绝对路径
- [ ] T025 在 Lobster runtime 内实现 `fileId -> 真实文件` 解析与回收
- [ ] T026 验证图片附件走视觉输入、普通文件走 `fileId` 引用，二者均可参与同一 turn

---

## Phase 6：权限请求闭环

- [ ] T027 在 `src/main/libs/agentApiServer.ts` 增加 `permission.request` 事件与 `permission.respond` 接口
- [ ] T028 为权限请求引入一次性 capability / session 归属校验
- [ ] T029 在 Airi 侧新增权限确认 UI 或复用现有确认组件
- [ ] T030 让 Airi 可对工具执行请求返回 allow/deny，并推动 runtime 继续执行

---

## Phase 7：对账与回退

- [ ] T031 在 Airi 侧实现流式预览与 `assistant.final` 最终消息对账
- [ ] T032 在 session 恢复时实现历史快照同步，避免页面刷新后丢失状态
- [ ] T033 保留 `/v1/chat/completions` 文本兼容降级模式，并增加显式 feature flag
- [ ] T034 增加 Bridge 故障回退策略：Bridge 不可用时退回文本模式，并关闭高阶能力入口

---

## Phase 8：验证与联调

- [ ] T035 文本单轮：验证等待态、流式文本、完成态全链路
- [ ] T036 多轮会话：验证 runtime session 复用与上下文保持
- [ ] T037 图片附件：验证图片识别与流式展示
- [ ] T038 普通文件：验证上传、引用、读取与清理
- [ ] T039 技能：验证查看、启停、勾选、配置编辑和生效
- [ ] T040 权限请求：验证 Airi 侧确认后 runtime 可继续推进
- [ ] T041 回退模式：验证关闭 Bridge 时文本兼容模式仍可工作

---

## 说明

- 本任务清单默认采用“先协议、后 UI；先会话、后功能”的顺序。
- 在 Phase 2 完成前，不建议继续扩展 `ChatArea.vue` 的 Lobster 直连特判逻辑。
