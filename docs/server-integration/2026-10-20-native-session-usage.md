# 原生定时任务 / IM 会话用量接入（2026-10-20）

## 变更概要

IM 和定时任务在模型调用前登记会话与轮次，沿用现有用量账本、会话标题接口和按轮次聚合逻辑。无需新增表或执行数据库迁移。

- 定时任务：`sessionId = cron:<jobId>`，同一任务的各次执行按不同 `turnId` 展开。按 jobId + agent 查询持久化定时会话标题，缺失时取任务名称；用户输入取任务定义的 `payload.message`，不包含 cron 标记、当前时间或执行提示。
- IM：`sessionId = im:<platform>:<sha256>`。散列只包含完整 OpenClaw session key，隔离渠道账号、agent 和会话线程；runtime transcript 重置不会拆分同一渠道会话。标题使用客户端列表同一 `buildChannelDisplayName` 规则得到的任务标识。原始输入在媒体理解、指令归一化和排队前捕获为独立的 `UsageUserMessage`；微信、云信、钉钉、POPO、企业微信、邮箱通过渠道补丁直接提供原始文本，其余渠道使用 `rawText` / `RawBody`，并贯穿排队、合并执行与重试。合并执行仅用换行连接原始消息。
- 用户输入沿用 200 个 Unicode 码点的展示摘要上限；不是完整聊天历史上传。没有文字的消息传空字符串，Server 不再回退到运行时 prompt。
- 媒体生成沿用 `usageContext`，保留相同会话与轮次。在原生 run 的生命周期开始时绑定账号和 generation，媒体用量上下文读取也核对 owner；账号切换后旧原生轮次元数据不能附加到新账号请求。

## 接口

### 模型请求

`POST /api/proxy/chat/completions` 或原有 `/api/proxy/v1/...` 路径，JWT Bearer 鉴权。请求体不变，增加已有的可选头：

```http
traceparent: 00-11111111111111111111111111111111-2222222222222222-01
X-Lobster-Session-Id: cron:56c87521-c9f2-494c-abcd-123456789012
X-Lobster-Turn-Id: 11111111111111111111111111111111
X-Lobster-User-Message: %E6%AF%8F1%E5%88%86%E9%92%9F%E6%8A%A5%E4%B8%80%E4%B8%8B%E5%BD%93%E5%89%8D%E6%97%B6%E9%97%B4
```

原始输入使用 URI 编码；`turnId` 必须等于 trace ID。元数据仅用于展示与归属，不参与授权或定价。

### 标题上报

`POST /api/usage/session-metadata`，JWT Bearer 鉴权，现有按账号隔离的持久化 outbox 负责重试。

```json
{"sessionId":"cron:56c87521-c9f2-494c-abcd-123456789012","title":"报数","revision":1792500000000}
```

响应：`{"code":0,"message":"success","data":null}`。revision 由客户端按当前毫秒时间递增产生。

### Portal 查询

`GET /api/user/usage-conversations`，沿用 Cookie/Session 鉴权与现有日期范围、快照、分页参数。响应 `data.sessions.items[]` 新增可选展示字段：

```json
{"sessionId":"im:weixin:<sha256>","sessionTitle":"group:chat-123","sessionSource":"im","imPlatform":"weixin","userMessage":"北京今天天气如何"}
```

定时任务返回 `sessionSource: "scheduled"`；普通会话的新字段为空。轮次与逐次调用接口保持不变。

## 接入事项

Portal 在 `imPlatform` 存在时使用对应渠道图标，后接 `sessionTitle`；定时任务使用时钟图标。原始输入直接展示 `userMessage`，不得再从模型请求体拼接或推测。图标和渠道名称包含中英文。

客户端需随包发布 `openclaw-native-usage-context.patch` 、`scripts/openclaw-plugin-patches/native-usage-input.cjs` 与更新后的 `lobster-model-routing` 插件。渠道补丁同时覆盖源码和预编译缓存，保留供模型使用的引用、附件和上下文，仅分离用量展示输入。注册发生在等待完成的 `before_prompt_build` hook，不能依赖异步 `model_call_started` 通知抢在网络请求前完成。打包时按已有 OpenClaw 构建流程重新构建 runtime；仅编译 renderer 不会更新已运行的 gateway。

## 上线与兼容

建议先 Server、Portal，再客户端（包含重建的 runtime）。旧客户端与普通桌面会话继续使用原协议。只对更新后新产生的调用生效；缺少会话、轮次及原始输入的历史未关联记录不会被猜测回填。标题同步失败时 outbox 重试，关联记录仍可按会话 ID 查询。

本次未进行浏览器、桌面应用或真实 IM/定时任务交互验证，也未发布、合并或推送。

## 2026-10-21 对抗审查

修复了以下边界：

1. IM 更换 runtime transcript ID 时，原来会把同一任务拆成多个 Portal 会话；现只使用稳定的渠道 key，仍隔离账号、agent 和线程。
2. 定时任务的 run key 无法直接命中持久化会话；改为按任务 ID 和 agent 查标题。cron 标识优先于继承的 webchat provider，不会误判为桌面续聊。
3. 部分渠道的 RawBody 已含引用、附件错误提示或自动生成指令；使用独立的渠道输入字段，避免将这些拼接内容上报为用户输入。媒体理解前冻结字段，队列重试保留它。
4. 首次调用前切换账号和媒体回调跨账号时，原始输入不得重新绑定到新账号；从 run 开始绑定 owner，并在媒体上下文读取时检查。

定向回归 69 项通过；全部 69 个 runtime 补丁在独立干净副本按打包顺序应用成功；6 个渠道的 13 份源码/缓存入口补丁通过语法与变量检查，重复应用不产生变更。未重建或运行真实 gateway。

归属需要可信的 run/job/channel 元数据；系统 heartbeat 和没有唯一任务上下文的旧 systemEvent 仍不从 prompt 推测归属。

## 2026-10-21 自动定时任务的模型与积分回填

本机日志确认，同一任务 11:53 的手动执行与 11:55 的自动执行具有不同 runId，却使用相同的模型请求 traceId。cron 定时器继承了重新设置定时器的请求的异步追踪上下文。客户端为防止跨轮次覆盖而拒绝重复 trace 登记，导致后一次消息缺失 `modelPresetId`、`llmTrace` 和 `turnUsage`，只显示底层模型名称；Server 请求也会沿用前一轮的归属元数据。

新增 `openclaw-cron-run-trace-isolation.patch`：在每次 cron agent 执行入口创建独立根 trace，覆盖准备、模型调用和完成阶段；同一轮内部的模型重试仍共享该 trace。保留客户端已有的重复 trace 和账号校验，不按实际模型名称推测“旗舰”，也不估算积分。会话仍按 `cron:<jobId>` 聚合，原始输入和标题规则不变。

此修复需要随客户端重新构建并发布 OpenClaw runtime；只运行 `npm run build` 或 `compile:electron` 不会替换正在运行的 gateway。历史缺失或错误归属记录不会自动回填。

验证：独立干净副本成功应用全部 70 个 runtime 补丁。新增 3 个追踪回归在移除修复时全部失败，修复后通过；连同 cron 运行/重试和客户端用量回填共 43 项定向测试通过。客户端 `build`、`compile:electron` 和本次修改文件 ESLint 通过；全量 lint 仍为既有 51 个排序错误、1 个警告。未重建或启动实际 gateway。
