# 2026-09-15 异常详情丢失排查与修复

## 基线与结论

- 修复分支：`fix/cowork-error-details`，基于 `release/2026.9.15` 的 `b17e82109`。
- 本次变更仅恢复异常详情从运行时到现有错误卡片的传递与保存。
- 两份日志均记录了从 LobsterAI 2026.9.4 / OpenClaw 2026.6.1 升级到
  LobsterAI 2026.9.14 / OpenClaw 2026.8.1。
- 第一张图是错误详情传递链路回归，现有渲染器能够展示详情。
- 第二张图是计划模式恢复竞态；最新 release 的 `508024e07` 已修复这一问题。

日志及隔离验证产物保留在排查工作区的 `artifacts/error-details-20260915/`，不纳入版本管理。

## 第一份日志：通用模型错误覆盖了诊断信息

`user1/openclaw-2026-09-14.log:681`，21:14:26，结构化日志包含：

```text
error: LLM request failed.
provider: lobsterai-server
model: deepseek-v4-pro
rawErrorPreview: Cannot read properties of undefined (reading 'trim')
providerRuntimeFailureKind: unclassified
```

相同异常在多次重试、切换模型后重复出现。21:14:29 的
`user1/main-2026-09-14.log:5653` 中，最终 `chat state=error` 只包含
`errorMessage: LLM request failed.`，没有任何错误详情。

LobsterAI 用当前模型补齐 provider / model / modelSource，因此截图中展开后只有三行。
主错误文案与 rawErrorMessage 相同时，`buildCoworkErrorDetail` 不重复保存文案；
这项去重不是底层原因。

### 三个缺口

1. `scripts/patches/v2026.8.1/openclaw-safe-error-metadata.patch` 在升级时改为显式字段白名单，
   遗漏旧版透传的 `rawErrorPreview`、`providerErrorMessagePreview`。
   上游对外部渠道的错误脱敏测试明确要求不向其回调暴露任意服务商文本。
2. 新版 `agent-lifecycle-terminal.ts` 把运行器的 `finishing` 事件归并为外层终态时，
   白名单只保留终止状态，丢掉 provider / model / HTTP 状态码及错误观察字段。
3. webchat 的 `chat-send-agent-dispatch.ts` / `broadcastChatError` 另行发送最终聊天错误，
   仅带文本。LobsterAI 的 `handleChatError` 原先只读该事件，没有使用此前同次运行的生命周期详情。

### 修复

- 增加版本补丁 `zz-openclaw-error-detail-preview.patch`，在已有 safe-error-metadata
  补丁之后应用。
- 仅为内部 webchat 通道提供上游观察函数生成的已脱敏、限长摘要；外部 IM 回调保持原有约束。
  摘要限制沿用上游 400 / 200 UTF-16 字符及省略号，不透传完整响应体或请求头。
- 在延迟生命周期终态与 gateway 聊天投影的白名单中保留这些字段。
- LobsterAI 在当前 turn 中保存生命周期错误。最终聊天错误的请求、运行和错误文本匹配时，
  合并已保存详情；最终事件明确提供的字段优先。兼容网关把内部运行 ID 映射回请求 ID。
- 新一轮 lifecycle start 清除旧详情；不同运行、不同错误不复用，turn 清理后自然释放。

### 底层 TypeError 的范围

详情修复不等于修复 `undefined.trim` 本身。这份日志提供了异常文本，没有抛错堆栈或会话消息体，
无法据此确认是哪个字段或调用位置。失败前有 325 条历史消息、18 个历史图片块，
该时间段没有出现模型 HTTP 请求开始记录，但这些迹象不能单独证明具体触发条件。
进一步定位需要受影响会话的脱敏导出或抛错位置的堆栈。

## 第二份日志的范围说明

`user2/main-2026-09-14.log:60165–60281` 显示计划模式拦截后，旧错误兜底定时器中止了恢复运行，
记录为 `aborted=true, timedOut=false`。该竞态已有基线提交 `508024e07` 修复。
本分支不改动计划模式恢复、定时器或中止策略，仅保留能够传递的异常详情。

## 验证与发布

- LobsterAI 回归：同运行的详情合并、最终字段优先、内部运行 ID 映射、重试清理、跨运行隔离、
  不同错误隔离；复用现有计划模式双终态 / 旧定时器测试。
- OpenClaw 回归：生命周期摘要、密钥脱敏、外部通道隔离、finishing 到终态、重试清理、
  gateway 广播与会话订阅的字段保留。
- 隔离网关：独立 state / 配置 / 端口，模型端点为本机模拟服务；不调用真实模型服务。
- 必须重新构建并打包 OpenClaw runtime。仅更新渲染器或 Electron 主进程不能补回运行时已经丢掉的字段。
- 已存入历史会话的缺失详情不会自动补齐；新错误在修复后写入现有 metadata.errorDetail 字段。
- 未修改 IPC 协议、数据库结构或模型配置。

### 实际验证结果

- LobsterAI：`openclawRuntimeAdapter.test.ts` 与 `errorDetail.test.ts` 共 287 项通过；
  `npm run compile:electron`、两个变更 TypeScript 文件的 CI 同等 ESLint 检查通过。
- OpenClaw：生命周期 55 项、错误观察 18 项、延迟终态 3 项、gateway 事件 164 项通过。
  六个补丁涉及的 TypeScript 文件通过直接 oxlint 和 oxfmt 检查。
- 版本补丁完整应用成功，新增补丁的反向移除、重新应用、反向检查均通过。
- 实际隔离网关启动、认证握手、模型请求、终态事件通过；本机服务返回模拟 400，
  `finishing`、外层 `error`、最终聊天事件均包含 `rawErrorPreview`，模拟 API Key 为 `***`。
  SDK 在该响应中只保留错误文本，因此独立 `httpCode` 和 `providerErrorMessagePreview` 不存在；
  不能为所有异常保证这些可选字段。验证结果见 `gateway-verdict.json`。
- 上游 runtime 编译完成。完整构建在 Control UI 阶段因隔离 worktree 缺少其独立依赖而失败；
  接入现有 `ui/node_modules` 后单独重跑 UI 构建通过。
- 上游 lint 包装脚本的插件边界扫描遇到 worktree 依赖链接 `ENOENT`，已用相同配置直接对变更文件
  执行 oxlint，通过。未声称完整上游包装检查通过。
- 未操作用户真实 Electron 会话，也未对真实服务商发起付费请求。
