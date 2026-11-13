# 定时任务回复的独立模型标签接入

日期：2026-11-13。状态：**桌面与服务端源码实现完成，通过本地编译、桌面定向回归和独立 AI 安全复核；App 待接入，未部署、未完成手机真机验收、未修改用户现场数据。** 本轮不修改手机 App 源码。

权威字段契约见[服务端输入 API §7.1.2](../../../lobsterai-server/docs/api/mobile-remote-input-v2.md#712-独立回复模型标签2026-11-13-扩展)，实现边界见[本次 Spec](../../../lobsterai-server/docs/specs/mobile-remote-control/bugfix-2026-11-13-scheduled-reply-model-label.md)，App 行动项见[服务端接入指南](../../../lobsterai-server/docs/integration/2026-11-13-scheduled-reply-model-label.md)。

## 1. 修复范围

旧 remoteStore／live 投影只有本轮冻结 inputModel 存在时，才通过 replyInputModel 输出消息模型摘要；定时任务消息可能有实际模型元数据却没有冻结输入摘要，因此缺少标签传输路径。源码已确认此缺口，但截图不包含同步 payload，不能据此断言该次手机显示的全部原因已验证。

新增 assistant 消息可选 `modelLabel`，让回复标签独立于输入选择摘要。现有 inputModel 仍保持模型引用、版本、来源等原语义；不为补标签创建假的 modelRef/version，不把当前会话／目录选择冒充当轮选择。

## 2. 能力与发布

通过既有 `GET /api/remote/v1/capabilities` 读取 `data.capabilities`。只有当前服务明确包含 `reply_model_label_v1` 时才发送新字段。服务端公告依赖远控与原回复内容功能开启，不新增独立开关；旧服务端缺能力或协商未完成时，继续发送原消息形状。

消息片段（其余必填字段沿用原 Message DTO）：

```json
{"role":"assistant","modelLabel":"deepseek-flash"}
```

该消息可不含 inputModel。有可信预设与实际模型证据时，也可发送 `快速（deepseek-flash）`。必须有本条安全的具体 model 或 resolvedModelId；只有快速／旗舰档位不生成独立标签。本条或本轮冻结预设优先；使用同会话 user 预设还需要同 runId，或同一 cron transcript 与同轮 entry 的关联证明。无证明时只显示该条实际模型名，不从当前模型配置或路由猜测。

modelLabel 仅允许 assistant；显式值须非 null、非 blank、可合法 UTF-8 往返，最多 120 个 UTF-16 字符且 UTF-8 不超过 480 字节。禁止 ISO 控制／格式字符、://、localhost／IPv4 片段、Bearer／凭据标记和 sk- 形式，精确模式见 API；不发送服务地址、API key、内部 runtimeRef 或完整配置。不安全或缺少证据时桌面省略字段；服务端拒绝显式非法值，不 trim 或改写原值，保持原非法输入错误及认证顺序。

## 3. 消息更新与既有修复机制

- 旧 batch、首次／恢复快照和新版 live 投影使用相同规则；有合法冻结 inputModel 时仍保留原摘要和标签，继续兼容旧消费者。
- 实际模型晚到时通过完整消息更新发布；不修改同 ID、同 revision 内容，不通过正文 delta 更新模型标签。
- 本地 SQLite 增加派生索引／触发器：同轮 user 预设或 run 关联元数据晚到时，推进受影响 assistant 的派生展示 revision。升级不改写现有业务消息或运行记录，不伪造缺失 inputModel，旧客户端仍使用原字段。
- 已确认最近消息使用原有界 live repair/CAS：最近 64 个候选、每轮最多 4 次编码与 2 个请求，并继续要求原请求核对／封闭能力。能力未确认、上下文改变或缺少实际模型证据时不发起新标签修复。
- 新本地 replyModelLabelChecked 标记独立于旧 inputModel 的显示版本；不把旧 displayVersion 当作新标签已检查，也不发送此标记。无新能力时不消耗标记，之后能力可用仍可在原窗口内检查。
- 未确认的请求保留原 publicationId、body 和 hash，先核对原请求；不因能力变化、HTTP 400 或旧节点拒绝便原地删字段重发。CAS 冲突沿原规则核对／封闭，不无限重传同一来源版本。
- 不扫描或承诺补齐全部旧历史，不改原 ACK、消息运行关系、执行状态或任务归属，不重跑定时任务。

## 4. 手机消费与兼容

reader projection v2+ 的 HTTP 快照、消息分页／单条、read-view 和完整 WSS message.upsert 保留已验证 modelLabel；v1 递归剥离。message.ref 引用事件仍按原流程补取完整消息后取得标签，不把引用帧缺字段当作模型缺失；message.delta 只合并原正文／状态字段，不因缺少 modelLabel／inputModel 就清除缓存中的标签。内容安全降级只保留经过验证的标签。无需新 HTTP 接口或 reader 版本号。

手机回复底部依次使用本条 modelLabel、本条 inputModel.displayName、原无信息展示。禁止通过 session.inputModel、当前目录或 preset 路由重算历史模型。新字段是纯展示文本，不是图标／倍率 modelId，也不参与计费、模型选择、输入准备、权限或执行。

旧手机忽略新可选字段时仍按原摘要展示；定时任务没有原摘要时，旧手机可能继续无标签，需要 App 按上述优先级接入并发布，本轮没有修改 App 源码。旧桌面可连接新服务，新桌面连接不公告该能力的旧服务时保持旧格式。旧 10 月 20 日 inputModel.displayName 路径保持兼容，11 月 5 日 modelId 仍仅属于模型目录。

## 5. 认证、发布与验收

保留原 JWT Bearer、设备凭据、账号／空间／目标隔离、连接代次和读取授权；模型标签不扩大权限。能力公告不新增设备注册或写权限门禁，关闭公告不使原已持久标签或封存请求失效。无服务端 MySQL SQL／DDL 迁移，继续复用现有 JSON 存储，兼容 MySQL 5.7；桌面本地派生索引／触发器按客户端升级。Portal、Admin 无必需变更。

先升级全部服务端读写节点，再升级桌面，最后完成 App 接入与真机验收。一次能力响应不证明混部全部节点支持。推荐回滚保留字段兼容代码；能力回退时，live 未知原请求走原 resolve，缺能力则保留等待；包含新字段的已封存 legacy 事件暂缓，不改 body；pending import 沿原状态核验／允许的 abort／重建流程收敛，不丢弃未知结果或复用请求 ID 改内容。

最终桌面验证使用 Node 24.22.2 统一运行 7 个定向 Vitest 文件，289 项全部通过；npm run compile:electron 和改动 TypeScript 文件 ESLint 通过。服务端 compileJava、compileTestJava -x test --offline 通过；新增 8 个测试方法与能力断言更新只完成源码编译，按项目约定未执行服务端测试。独立 AI 安全复核通过，发现的问题已修改。

本轮未部署、未修改用户现场数据、未迁移服务端 MySQL。App 仍待接入，未完成手机真机验收；需要核对真实消息 payload、字段优先级、message.ref 补取、delta 缓存合并与同消息显示更新，不能把本地回归通过视为该用户现场已恢复。

## 6. 设备声明与服务端公告的区别（11/13 增补）

状态：桌面源码修复完成，本增量定向回归、编译、严格 lint 和独立安全复核通过；上节保留此前模型标签功能的历史验证。本机 `remote.log` 在 18:04:08 后出现设备 settings GET 200、PATCH 400（`47019 / INVALID_REMOTE_REQUEST`），`write_settings` 反复失败且 `connectionGeneration` 为空。本轮 `RemoteBridge.advertisedCapabilities` 错把 `reply_model_label_v1` 放入设备声明，服务端设备能力白名单拒收；注册也受相同白名单约束。

修复只从设备 register／settings PATCH 的 capabilities 中移除 `reply_model_label_v1`。服务端 `GET /capabilities` 公告仍由 `refreshCapabilities` 消费，继续设置 `replyModelLabelSupported` 并协商新消息字段；两份能力列表不能直接互相复制。旧服务端未公告该项时省略 modelLabel，保持注册／连接和旧消息格式。

保留本地 pending 队列、ACK、原消息 body／ID／hash。修正设备声明后通过原连接／设置重试恢复；原账号／目标／设备上下文和准入通过后继续队列及回执核验，不清存量、不重跑任务，也不放宽未知结果恢复门禁。

本增量无需服务端业务、API、认证、错误码或 MySQL 变更，不改 App 源码。Node 24.22.2 下，注册／设置与 environment 两文件 92 项、回复模型标签与投影两文件 73 项，合计 4 文件、165 项全部通过；Electron 编译和 3 个变更 TypeScript 文件严格 ESLint（`--report-unused-disable-directives --max-warnings 0`）通过。独立安全复核无未解决项，其余 24 项设备声明均符合服务端白名单，原鉴权、执行、reader v1 剥离及不可变请求保护不变。

本机日志及 SQLite 队列仅作只读排查，未修改用户数据库，按约未运行服务端测试；未部署、未完成手机真机验收，不宣称现场已经恢复。详见[本次 Spec 第 6 节](../../../lobsterai-server/docs/specs/mobile-remote-control/bugfix-2026-11-13-scheduled-reply-model-label.md#6-设备能力声明误用导致连接不可用1113-增补)。
