# 客户端会话用量归属与标题同步（2026-10-15）

## 变更说明

Portal 需要明确的「客户端 sessionId + 用户输入轮次」才能把多次模型调用归入同一轮。旧客户端无须升级即可继续请求；缺少完整标识的账单保留原样，在 Portal 下方明细分页展示。

客户端会话标题直接来自本地持久化会话的 `title`，包含自动生成标题和用户重命名后的值。Server/Portal 不重新生成标题，也不将首条输入当作标题。

## 模型请求：沿用 JWT，新增可选 Header

现有 `/api/proxy/...` 模型请求加入：

```http
Authorization: Bearer <accessToken>
traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01
X-Lobster-Session-Id: <local-cowork-session-id>
X-Lobster-Turn-Id: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
X-Lobster-User-Message: <encodeURIComponent(user-input-excerpt)>
```

- sessionId 使用本地会话 ID，允许 `[a-zA-Z0-9_.:-]`，最多 128 字符，不使用 OpenClaw 的共享会话键或标题作为 ID。
- 同一次用户输入所有模型请求的 Turn ID 都等于该用户输入既有 `llmTrace.traceId`（32 位小写十六进制）；下次输入生成新 trace，继续/重试当前输入保留原 trace。
- turn Header 必须与 traceparent 的 trace-id 一致，session/turn 缺失或无效时 Server 忽略归组元信息，不影响模型请求。
- 摘要最多 200 个 Unicode code point，必须百分号编码，不能直接把中文放入 HTTP Header。
- 代理自动补的单请求 trace 不等于用户输入轮次，禁止作为 turn 上报。
- 已有 Body 中 session_id/user_message 不变，不能仅依赖旧 Body 推断新轮次。
- 用户 ID 来自认证；所有统计仍以实际服务端账单为准。不会根据这些 Header 修改扣费金额。

## POST /api/usage/session-metadata

认证：JWT Bearer（沿用客户端 `fetchWithAuth`），JSON 请求：

```json
{
  "sessionId":"client-session-uuid",
  "title":"黄奇帆复旦经济课第二章介绍",
  "revision":1792065000000
}
```

响应：`{"code":0,"message":"success","data":null}`。

- title 为本地实际会话标题，最长 512 code point，不能为空。按纯文本展示，不支持 HTML。
- revision 为本次上报时的客户端毫秒时间；通过本地持久化 revision 保证跨进程重启单调递增。Server 只接受更大的 revision，避免并发请求中旧标题晚到覆盖新标题；最多容忍快于服务端 5 分钟。
- 归属使用认证用户，不接收请求中的 userId；标题以 `(user_id, session_id)` 唯一保存。
- 在每轮开始、自动标题生成完成、手动重命名后上报。先写入本地 `usage_title_outbox_v1`，超时 10 秒；仅 HTTP 成功且业务 code=0 才确认移除。网络、HTTP、业务错误均保留，30 秒起退避重试，最长间隔 5 分钟；重启自动恢复，无须新对话。队列以服务地址和账号隔离，只上传当前账号的待同步标题。同会话只保留最新 revision，旧请求响应不得清除新改名。
- 无标题数据时 Portal 展示通用会话标题；历史日期范围也使用最新上报标题。

## 图片/视频请求归属

个人媒体生成接口 `/api/media/images/generate`、`/api/media/videos/generate` 的 JSON 可选增加：

```json
{
  "model":"image-model", "type":"image", "prompt":"图片生成提示词", "params":{},
  "usageContext":{
    "sessionId":"client-session-uuid",
    "turnId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "userMessage":"原始用户输入摘要"
  }
}
```

- `main.ts` 在异步工具工作开始前捕获用户消息及其 `llmTrace.traceId`，同一对象也用于记录返回的媒体 taskId；不能在异步完成时再取最新输入。
- 归属字段为可选，仅用于展示，身份/金额始终从认证与服务端结算取得；缺失或非法字段不阻断旧客户端，费用仍在下方未关联调用中。
- 服务端把合法上下文存入已有 `media_generation_tasks.request_params.usageContext`，同步生成、后台 worker、视频轮询结算均使用持久化上下文落账。
- 每个媒体任务只写一条账单，新增 `media_task_id` 唯一索引去重。媒体账单写 session/turn，但不写文本 `trace_id`，因为现有客户端 trace 查询已经通过 `mediaTaskIds` 加上媒体费用，避免重复相加。
- 当前 Server 分支提供以上接口及其异步 worker/轮询路径；客户端能力协商选择 durable 请求时同样将上下文存入请求意图。此分支没有 `/api/media/v2/tasks` 服务端实现，后续若启用该协议，必须同时沿用上下文持久化与结算落账契约，不能仅宣布支持协议。

## 客户端实现落点

- `llmUsageContext.ts` 维护 trace→session/turn/prompt 上下文，最多 512 个活跃/近期条目，避免全局“当前会话”造成并发会话串归属。
- `openclawRuntimeAdapter.ts` 在用户输入与 `/btw` 分支登记上下文；主运行在 gateway ready 后登记。
- `openclawTokenProxy.ts` 按每个请求 trace 添加归组 Header。没有登记的 trace 不带归组元信息，停止代理清理登记。
- `usageTitleSync.ts` 管理账号隔离的持久化重试队列；`main.ts` 初始化标题上报回调；复用本地 SessionTitleGenerator 写入标题与 RenameSession IPC 的完成点。
- 现有 `GET /api/usage/llm-traces/{traceId}` 和客户端本轮积分组件不变。

## 发布顺序和口径

服务端先执行 V106 数据库迁移，再发布 Server/Portal/客户端。旧 Server 忽略新增 Header，标题接口尚未上线时 404 不阻断会话。未提供完整归属的旧数据不回填。

Portal 默认最近 7 个北京时间自然日。筛选实际请求账本 created_at 后再按 session/turn 聚合，而不是按会话创建时间过滤。上下分页独立，但会话、轮次、调用和未关联区共享服务端 `snapshotId`；刷新/日期切换整体重建查询。可见积分每笔保留两位后累加；原始账单不变，Token 费用标为估算。

当前 Portal 为个人中心，展示个人账本；本次不增加团队账本聚合页面。自定义供应商、没有登记用户轮次的后台请求不强行关联。没有执行浏览器/Electron 交互校验或共享环境数据库变更。

## 本次验证

本地回归包含标题 HTTP/业务/网络/JSON 失败、断线后无新对话重试、重启恢复、账号隔离、旧响应不覆盖新改名，以及媒体消息归属的捕获和缺失字段兼容。没有执行浏览器/Electron 交互校验、共享环境迁移、部署或提交。

修复后验证记录：

- Portal：全量 oxlint、ESLint 和 `npm run build` 通过。
- Electron：涉及的 7 个 TS 文件 ESLint、`npm run build`、`npm run compile:electron` 通过；新增两组用例共 8 项通过。全量 `npm run lint` 仍有 53 个既有 import/export 排序错误、1 个警告，日志 `/tmp/usage-fix-client-lint-full.log`。
- Server：定向 `test ... build` 通过，11 组共 83 项用例无失败，日志 `/tmp/usage-fix-server-focused.log`。再次尝试默认 `./gradlew build`，既有 `DepartmentPermissionOvermindConfigTest` 因 MySQL 连接超时失败，随后停止；不能据此宣称默认全量构建通过，日志 `/tmp/usage-fix-server-build-full.log`。
- 只读核对了生产/测试 `api_call_logs`、`media_generation_tasks` 的相关列；三列新增账本字段在共享环境尚不存在。未做真实 MySQL 写入或线上运行验收。
