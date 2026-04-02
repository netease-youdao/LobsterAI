# Phase 8 验证与联调清单

**Feature**: 002-airi-lobster-session-bridge  
**验证日期**: 2026-04-02  
**前置条件**: 
- LobsterAI 服务已启动 (`http://127.0.0.1:19888`)
- Airi 已配置 `lobster-agent` provider (baseUrl: `http://127.0.0.1:19888`)
- 两个项目均已拉取最新代码

---

## T035 文本单轮：验证等待态、流式文本、完成态全链路

### 测试步骤
1. 打开 Airi，选择 `Lobster Agent` 作为 provider
2. 在聊天框输入：`你好，请简单介绍一下你自己`
3. 点击发送

### 验证点
- [ ] **等待态**：发送后，Airi 角色进入等待/思考状态（Think 表情/动作）
- [ ] **流式文本**：回复内容逐字显示，不是等待完成后一次性显示
- [ ] **口型驱动**：Airi 说话时口型与文本同步（如果启用了 TTS 或文本口型）
- [ ] **完成态**：回复完成后，Airi 恢复 idle 状态（呼吸动画）
- [ ] **消息持久化**：刷新页面后，聊天记录仍然存在

### 预期结果
```
用户发送 → Airi 进入 Think 态 → 流式输出文本 + 口型驱动 → 完成后恢复 idle
```

---

## T036 多轮会话：验证 runtime session 复用与上下文保持

### 测试步骤
1. 完成 T035 后，继续发送第二条消息：`你刚才说了什么？`
2. 继续发送第三条消息：`请用三个词总结我们的对话`

### 验证点
- [ ] **上下文保持**：第二条消息的回复引用了第一条消息的内容
- [ ] **session 复用**：LobsterAI 服务端使用同一个 `lobsterSessionId`（可在浏览器 DevTools Network 面板查看 `/api/agent/bridge/bind` 响应）
- [ ] **多轮连贯**：第三条消息的回复能总结前两轮对话

### 预期结果
```
第一问 → 第二问（引用第一问） → 第三问（总结前两轮）
session bind 只调用一次，后续复用
```

---

## T037 图片附件：验证图片识别与流式展示

### 测试步骤
1. 点击聊天框的附件按钮，选择一张图片
2. 输入：`这张图片里有什么？`
3. 点击发送

### 验证点
- [ ] **图片上传**：图片以 base64 data URL 形式内联到消息中（不走 fileId 上传）
- [ ] **图片识别**：LobsterAI 能正确识别图片内容
- [ ] **流式回复**：回复内容流式显示
- [ ] **消息展示**：用户消息中显示图片缩略图

### 预期结果
```
用户消息 = [{ type: 'text', text: '...' }, { type: 'image_url', image_url: { url: 'data:...' } }]
Airi 回复流式显示图片分析结果
```

---

## T038 普通文件：验证上传、引用、读取与清理

### 测试步骤
1. 准备一个文本文件（如 `test.txt`，内容随意）
2. 点击附件按钮上传该文件
3. 输入：`读取这个文件的内容`
4. 点击发送

### 验证点
- [ ] **文件上传**：文件通过 `/api/agent/files/upload` 上传，返回 `fileId`
- [ ] **fileId 引用**：请求中包含 `fileIds: ["xxx"]` 而非绝对路径
- [ ] **文件读取**：LobsterAI 能读取文件内容并回复
- [ ] **文件清理**：session 结束后文件被清理（需检查 LobsterAI 服务端日志）

### 预期结果
```
POST /api/agent/files/upload → { file: { id: "xxx", ... } }
POST /api/agent/bridge/chat → { fileIds: ["xxx"], ... }
```

---

## T039 技能：验证查看、启停、勾选、配置编辑和生效

### 测试步骤
1. 打开 Airi 设置 → 技能页面
2. 查看技能列表
3. 启用/禁用一个技能
4. 编辑一个技能的配置
5. 回到聊天界面，勾选一个技能
6. 发送消息触发该技能

### 验证点
- [ ] **技能列表**：能正确显示 LobsterAI 返回的技能列表
- [ ] **启停操作**：切换开关后，技能状态立即更新
- [ ] **配置编辑**：能读取和保存技能配置
- [ ] **勾选生效**：勾选的技能在 turn 级 `skillIds` 中传递
- [ ] **i18n**：所有文本使用翻译 key，无硬编码中文

### 预期结果
```
技能面板显示：总技能 N | 已启用 M | 管理技能按钮
勾选技能后，请求中包含 skillIds: ["xxx"]
```

---

## T040 权限请求：验证 Airi 侧确认后 runtime 可继续推进

### 测试步骤
1. 发送一个需要权限的操作（如文件写入、命令执行）
2. 等待权限请求弹出
3. 点击 Allow 或 Deny
4. 观察后续行为

### 验证点
- [ ] **权限弹窗**：`LobsterPermissionList.vue` 显示权限请求
- [ ] **工具信息**：显示工具名称和输入参数
- [ ] **Allow 行为**：点击 Allow 后，LobsterAI 继续执行
- [ ] **Deny 行为**：点击 Deny 后，LobsterAI 跳过该工具或报错
- [ ] **状态映射**：权限请求时，Airi 进入 `ask_user` 等待态（Awkward 表情）

### 预期结果
```
tool.call → permission.request 事件 → UI 显示权限弹窗
用户点击 Allow → POST /api/agent/bridge/permission → runtime 继续
```

---

## T041 回退模式：验证关闭 Bridge 时文本兼容模式仍可工作

### 测试步骤
1. 打开 Airi 设置 → Provider 设置 → Lobster Agent
2. 关闭 `Use Bridge Protocol` 开关
3. 回到聊天界面，发送消息
4. 重新打开 Bridge，再次发送消息

### 验证点
- [ ] **降级模式**：关闭 Bridge 后，消息走 `/v1/chat/completions` 兼容路径
- [ ] **文本正常**：回复内容正常显示，无流式失真
- [ ] **功能降级**：技能深接入、文件 fileId、权限请求等高级能力不可用（符合预期）
- [ ] **恢复 Bridge**：重新打开 Bridge 后，所有功能恢复正常

### 预期结果
```
useBridge = false → performSend() 走 llmStore.stream() 路径
useBridge = true → performSend() 走 streamChat() 路径
```

---

## 快速验证命令

### 检查 LobsterAI Bridge 端点是否可用
```bash
curl -X POST http://127.0.0.1:19888/api/agent/bridge/bind \
  -H "Authorization: Bearer lobsterai-agent-default-key" \
  -H "Content-Type: application/json" \
  -d '{"airiSessionId": "test-session-001"}'
```

预期响应：
```json
{
  "session": {
    "airiSessionId": "test-session-001",
    "lobsterSessionId": "xxx"
  }
}
```

### 检查技能列表端点
```bash
curl http://127.0.0.1:19888/api/agent/skills \
  -H "Authorization: Bearer lobsterai-agent-default-key"
```

### 检查 Airi 类型编译
```bash
cd airi/airi
pnpm -F @proj-airi/stage-ui typecheck
pnpm -F @proj-airi/stage-layouts typecheck
```

---

## 本轮已执行验证（2026-04-02）

- Airi 类型检查
  - `pnpm -F @proj-airi/stage-ui typecheck`：通过
  - `pnpm -F @proj-airi/stage-pages typecheck`：通过
  - `pnpm -F @proj-airi/stage-layouts typecheck`：通过
  - `pnpm -F @proj-airi/stage-tamagotchi typecheck`：通过
  - `pnpm -F @proj-airi/stage-ui test:run -- src/stores/chat-bridge-mode.test.ts`：通过
- 配置恢复与启动排障
  - 已确认 `apiKey/baseUrl` 本身会持久化，问题根因是 Airi 把失败校验结果按相同配置永久缓存
  - 已修正 provider 失败校验缓存与自动重试逻辑；当 LobsterAI 启动较慢时，Airi 会在后台继续重试校验并自动恢复为已配置
  - 已确认 LobsterAI 启动失败的直接原因是旧的 `vite --port 5175` 进程占用端口，而非 RxJS 本身故障
- LobsterAI 静态验证
  - `npm test -- src/main/libs/agentBridgeSessionStore.test.ts`：通过
  - `npx tsc --noEmit --project electron-tsconfig.json`：通过
- LobsterAI 服务与端点探测
  - `npm run electron:dev`：已启动，本地 Agent API 可用
  - `/api/agent/bridge/bind`：通过，可返回 `airiSessionId -> lobsterSessionId`
  - `/api/agent/skills`：通过，当前返回 38 个技能
- Bridge 真实联调
  - 单轮文本：通过，`session.bound -> state.changed -> assistant.final -> done` 链路可工作
  - 会话复用：通过，同一 `airiSessionId` 连续两轮命中同一个 `lobsterSessionId`
  - 提示词透传：通过，传入 `systemPrompt = Reply with exactly PASS_PROMPT...` 后，最终回复为 `PASS_PROMPT`
  - 文件链路：通过，上传 `package.json` 得到 `fileId` 后，bridge chat 可读取并返回 `name = lobsterai`
  - 图片链路：通过，上传 `image/png` 后，bridge chat 可读取图片并返回图像描述
  - 权限链路：通过，危险删除请求会发出 `permission.request`，`permission/list` 可读到 capability token，`deny` 后请求被消费并返回拒绝结果
  - 技能基础接口：通过，技能列表与 `get-config` 接口可访问
- 本轮补充确认
  - Bridge 提示词透传已接通：Airi 会从会话首条 system message 提取 `systemPrompt` 并传给 LobsterAI runtime
  - 当前角色卡中的 `systemPrompt + description + personality` 会随会话进入 Lobster runtime
  - 已修正 Airi Onboarding 的 provider 可见性：`lobster-agent` 已进入 popularProviders，浏览器中已可在引导步骤里看到 `Lobster Agent`
  - 浏览器中已完成 `lobster-agent -> API Key -> Claude Agent` 的首次引导配置，首页与意识设置页都能看到 `Lobster Agent / Claude Agent`
  - 已为桌面聊天区补充显式发送按钮，首页自动化现可稳定触发发送
  - Airi 首页已完成一次真实文本单轮：浏览器触发 `/api/agent/bridge/chat`，用户消息与助手回复均已渲染到聊天区
  - Airi 前端可见品牌文案已统一替换为 `Xclaw`，并显式保留 `lobster-agent`、deep link、导出类型等协议标识不变
  - 已修正 `useBridge=false` 时未必回退的问题；当前 feature flag 会直接落到 OpenAI-compatible `/chat/completions`，并有单测保护
  - 已修正“重启后像是要重新配置”的问题；当保存的 Lobster 配置在启动早期因服务未就绪校验失败时，Airi 现会自动重试并恢复配置状态
  - 当前动作与口型尚未做单独观察记录，因此展示链路已验证，表现层联动仍建议后续补记

---

## 已知限制

1. **权限请求测试**：需要 LobsterAI 端配置了需要权限的工具才能触发
2. **文件清理测试**：需要检查 LobsterAI 服务端日志确认文件回收
3. **多轮会话测试**：需要 LobsterAI 端正确维护 session 上下文
4. **表现层待补记**：动作、口型与等待态切换尚未单独留存观察记录
5. **当前仍阻塞项**：权限请求与回退模式的服务端/逻辑链路已通过，但 Airi 浏览器自动化页面当前未稳定显示 DOM，界面层仍待补手测；图片前端附件操作也仍待手测

---

## 验证结果记录

| 测试项 | 状态 | 备注 |
|---|---|---|
| T035 文本单轮 | ✅ 通过 | 服务端 Bridge SSE、Airi 首页发送、`/api/agent/bridge/chat` 请求与消息展示均已验证；动作/口型未单独留档 |
| T036 多轮会话 | ⏳ 部分通过 | 同一 `airiSessionId` 成功复用同一 `lobsterSessionId`，上下文记忆验证通过；Airi 前端侧仍待联调 |
| T037 图片附件 | ⏳ 部分通过 | `image/png -> fileId -> /api/agent/bridge/chat` 已返回图片描述；前端附件操作仍待手测 |
| T038 普通文件 | ⏳ 部分通过 | `fileId` 上传、引用、读取已通过；文件清理与 Airi 前端展示仍待验证 |
| T039 技能 | ⏳ 部分通过 | 技能列表与配置读取接口通过；Airi 设置页启停、勾选、生效仍待 UI 联调 |
| T040 权限请求 | ⏳ 部分通过 | 已触发 `permission.request`，验证 `permission/list -> deny -> 消费完成`；Airi 权限卡界面仍待手测 |
| T041 回退模式 | ⏳ 部分通过 | 已修正 `useBridge=false` 的回退判定并补单测，且 `POST /chat/completions` 可返回 `FALLBACK_OK`；Airi 设置页开关与界面层仍待手测 |
| T042 配置恢复 | ✅ 通过 | 已修正同配置失败结果被永久缓存的问题；LobsterAI 启动较慢时，Airi 会自动重试校验并恢复已保存配置 |
