# AIRI × LobsterAI 联调工作记录（2026-03-05）

## 目标

- 通过 AIRI 的 OpenAI 兼容 API 接入本地 LobsterAI
- 修复白屏、404/401、短回复、会话堆积、日志噪音等问题
- 形成稳定可复现的本地联调链路

## 问题与修复清单

### 1) AIRI 白屏（模块导入错误）

- 现象：AIRI 页面空白，控制台报 `SSEParser` 导出不存在
- 根因：`@xsai-ext/providers/utils` 不提供 `SSEParser`，自定义流式包装实现不兼容
- 修复：移除错误导入和手写 SSE 包装，回归 `createOpenAI(...)` 标准 provider
- 文件：
  - `airi/airi/packages/stage-ui/src/libs/providers/providers/lobster-agent/index.ts`

### 2) OpenAI 兼容校验失败（404/401）

- 现象：`chat completions` 404，`model list` 401
- 根因：
  - 路由路径与 AIRI 校验路径不一致
  - 鉴权方式不兼容
- 修复：
  - 增加兼容路由：`/v1/models`、`/models`、`/v1/chat/completions`、`/chat/completions`，并保留 `/api/agent/*`
  - 增加兼容鉴权头：`Authorization` / `x-api-key` / `api-key`
  - `models` 返回兼容结构：`{ object: "list", data: [...] }`
- 文件：
  - `LobsterAI/src/main/libs/agentApiServer.ts`

### 3) API Key 绑定错误

- 现象：AIRI 配置正确仍出现 key 校验不稳定
- 根因：Agent API Key 与其他 key 逻辑耦合
- 修复：改为优先使用 `LOBSTER_AGENT_API_KEY`，默认 `lobsterai-agent-default-key`
- 文件：
  - `LobsterAI/src/main/main.ts`

### 4) 旧地址残留导致误校验（11434）

- 现象：控制台仍持续请求 `http://localhost:11434/...`
- 根因：配置/校验流程存在旧地址残留
- 修复：
  - 对 Lobster provider 增加 `baseUrl` 归一化（11434 → 19888）
  - 校验器阶段同样走归一化，避免仅运行时生效
- 文件：
  - `airi/airi/packages/stage-ui/src/libs/providers/providers/lobster-agent/index.ts`

### 5) 会话列表持续新增 `Agent API Session`

- 现象：每次请求都在任务记录新增会话并长期保留
- 根因：API 侧创建 session 后未清理
- 修复：请求完成后统一 `deleteSession(sessionId)` 清理
- 文件：
  - `LobsterAI/src/main/libs/agentApiServer.ts`

### 6) 回复被截断（经常只回 2~3 个字）

- 现象：AIRI 只显示“我是/你好”等短片段
- 根因：桥接层仅消费 `message`，未正确消费 `messageUpdate` 的持续增量
- 修复：
  - 新增 `messageUpdate` 监听
  - 仅对 assistant messageId 转发增量
  - 非流式模式也同步 `messageUpdate` 结果
- 文件：
  - `LobsterAI/src/main/libs/agentApiServer.ts`

### 7) i18n 缺失告警

- 现象：`settings.pages.providers.provider.lobster-agent.*` not found
- 修复：补齐 `en / zh-Hans / zh-Hant` 对应文案键
- 文件：
  - `airi/airi/packages/i18n/src/locales/en/settings.yaml`
  - `airi/airi/packages/i18n/src/locales/zh-Hans/settings.yaml`
  - `airi/airi/packages/i18n/src/locales/zh-Hant/settings.yaml`

### 8) 非主链路探测噪音（11996 / 4315 / 11434）

- 现象：控制台出现大量 `ERR_CONNECTION_REFUSED`
- 判定：属于未启用 provider 的自动探测噪音，不是主聊天阻断
- 修复：
  - 调整 Ollama 自动校验触发条件
  - 去除 IndexTTS / Player2 启动即联网探活校验
- 文件：
  - `airi/airi/packages/stage-ui/src/libs/providers/providers/ollama/index.ts`
  - `airi/airi/packages/stage-ui/src/stores/providers.ts`

## 关键运行结论

- `server-runtime` 的 `ws closed code=1001/1005` 属于重连/页面切换常见行为，不是本问题主因
- UnoCSS `DM Sans` 拉取失败为网络层告警，非主链路阻断
- 主链路已收敛到：
  - Lobster API：`http://127.0.0.1:19888`
  - OpenAI 兼容入口：`http://127.0.0.1:19888/v1`
  - AIRI runtime WS：`ws://localhost:6121/ws`

## 当前推荐配置

- AIRI（OpenAI 兼容 API）：
  - Base URL: `http://127.0.0.1:19888/v1`
  - API Key: `lobsterai-agent-default-key`（或 `LOBSTER_AGENT_API_KEY` 对应值）
  - Model: `claude-agent`

## 当前启动顺序

1. `LobsterAI`: `npm run electron:dev`
2. `AIRI server runtime`: `pnpm dev:server`
3. `AIRI stage web`: `pnpm dev`

## 已执行验证

- `LobsterAI`:
  - `npm run compile:electron` 通过
  - `npm run lint` 通过
- `AIRI`:
  - `pnpm -C packages/stage-ui typecheck` 通过
  - `pnpm lint` 存在仓库历史 lint 噪音（与本次核心修复无阻断关系）

## 下一步规划建议

- 在 AIRI 侧增加“仅校验已启用 provider”的统一开关，进一步降低控制台噪音
- 增加 Agent API 的端到端自动化回归（models/chat/stream 三类）
- 将本次联调配置沉淀到项目 README 的“本地联调章节”
