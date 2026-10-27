# 远控 metadata 有界投影、旧故障恢复与部分内容状态

日期：2026-10-27。状态：**客户端实现及 27 文件/564 项定向回归完成，安装包打包、安装和现场复测未执行**。扩展两文件有 8 项既有失败，已与修改前 HEAD 核对，详见验收记录。本文不表示截图对应客户端已经恢复。本次未重启应用、未修改真实用户数据库。

关联文档：[服务端对应修复 Spec](../../../../lobsterai-server/docs/specs/mobile-remote-control/bugfix-2026-10-27-remote-metadata-projection.md)、[服务端接入说明](../../../../lobsterai-server/docs/integration/2026-10-27-remote-metadata-projection.md)、[桌面 availability 集成说明](../../../docs/server-integration/2026-09-23-availability-first-sync.md)、[既有 v3 API](../../../../lobsterai-server/docs/api/remote-availability-v3.md)。

## 问题与范围

现场记录中的约 63 KiB 工具 metadata 在公开字段归一化之前触发旧 32 KiB 原始读取限制，产生对象级 `ENCODING_FAILED` 故障。设备心跳在线与消息展示发布是两条独立证据；该故障可使设备显示“在线 · 同步暂停”，但不证明任务执行失败或服务器连接中断。

旧 fault 还可能位于最近 64 个来源候选之外；仅换编码器不能保证旧对象获得重探机会。已存在 ACK 后的补充编码也可能留下 fault，不能因为请求队列为空便宣称恢复。故障只有经有效发布结果核验并持久确认后才能清除。

本轮业务实现仅在 LobsterAI 桌面。**服务端仅更新文档，无 HTTP 协议、认证、错误码、配置、MySQL DDL 或手机源码变更。** 桌面 sidecar 增加本地恢复证据表，与“无服务端 DDL 变更”分别陈述；已有能力协商、writer fence、账号/环境边界及旧客户端接口继续有效。

## 不变量

- 保留原始 content/metadata、会话、工具、run、source revision、历史 ACK、执行 journal 和删除事实；不为展示同步重新执行任务或工具。
- 展示 worker 和健康快照不授予发布、重试或执行权限。主进程仍核验当前 owner/scope、服务环境、设备、会话、writer、来源版本、停止/切号及删除状态。
- 已封存 publication 的 ID、body、hash 不可变。结果未知时核对原操作；普通 HTTP 200、编码完成、队列为空或点击重试都不是恢复证明。
- 仅移除本来不公开的内部字段。公开内容因预算而缺失时必须明确标注，不把截断后的结果当作完整同步。

## 编码层次与预算

KiB 为 1024 字节；字符串和规范 JSON 均按 UTF-8 字节计算。

| 层次 | 当前实现与边界 |
| --- | --- |
| 原始 metadata | 单源最多 **256 KiB**。SQL 先取字节长度，再用有界 `CASE` 读取；超限不把整块原文载入 worker。Tool 来源最多读取 16 条候选，实际读取的 metadata 还共用 256 KiB 总预算 |
| 归一化 metadata | 公开字段规范 JSON 最多 **32 KiB**；先筛字段、验证身份和类型，再计量。结构深度最多 32、节点最多 8192，不对超大/非法 JSON 截前缀后继续解析 |
| inline Message blocks | 完整候选 `blocks` 的规范 JSON 最多 **48 KiB**。超限或真实公开字段被省略时使用已有 `desktop_only` 表示 |
| 原始 content 读取 | 当前最多 128 KiB。超出后无法在预算内取得可信完整公开内容大小，保留固定失败原因，不伪造占位字节数 |
| live projection worker | 每次作业 **2 秒**截止，Node `--max-old-space-size=96`。这是约 **96 MiB V8 old-space 堆限制，不是进程 RSS 上限**；IPC 结果最多 128 KiB，父进程负责超时取消及退出确认 |

实际文件数据库通过独立、可终止的 live projection child 只读打开；不在主进程同步回退解析大 JSON。`:memory:` 路径仅供本地测试/内存调用使用。预算不改变现有 Message/Tool 和 live 请求的服务端限制。

归一化实现位于 [remoteLiveMetadata.ts](../../../src/main/remote/remoteLiveMetadata.ts)。筛除未被公共投影消费的 diff、patch、内部调试字段等；`toolInput`、公开工具结果、错误详情等若属于原协议允许公开的表示，仍按原规则纳入预算，不能为了过限把它们静默删除后声明 complete。必要身份、关键字段类型或真实状态无法确认，以及非法 JSON、超原始读取/结构预算等情况继续隔离对象；无关的未公开字段不被误当作必要字段。

## complete、desktop_only 和字节含义

`complete` 指原协议允许公开的完整表示；不意味着要把所有私有 metadata 上传。仅去除无用 diff/patch 不构成正文缺失。

真实公开表示超过归一化/inline 预算且必要事实、完整候选大小仍可确定时，Message 沿用 `contentState=desktop_only`、空 `blocks`、有界 preview 和固定不可用原因。`originalContentBytes` 是**完整候选 blocks 数组规范 JSON 的 UTF-8 字节数**，不是 raw metadata、原始 content、preview 或占位 `[]` 的长度；无法可靠求值时保留故障，不填 0 或估算值。

Tool 保持既有 DTO 与大小限制，不新增 `summaryTruncated`、Tool `contentState` 或 Tool `originalContentBytes`。模型名称、错误真值、工具身份和真实状态继续保留既有公开语义。worker 返回的 `encodingStats`、工具来源证据和本地编码版本不进入网络 payload。

## 旧故障重探与工具恢复

[remoteLiveRecovery.ts](../../../src/main/remote/remoteLiveRecovery.ts) 为旧 `message:`/`tool:` fault 提供独立扫描，不受最近 64 条正常来源窗口限制。fault 候选及工具 refresh 分别按稳定键分页，每页最多 4 条；每轮最多编码 4 个、发送 2 个，每会话至多发送 1 个。最近消息轮与恢复轮交替，最近消息轮不消费恢复页，避免恰好满 4 条旧故障时的分页错位；两类工作均获得处理机会。扫描游标有界保存在内存，**重探许可持久化**，不能把重启当作新许可。

本次 `RemoteLiveEncoderVersion=2`。`availability_encoding_probes` 按 scope、会话、对象及来源 fingerprint 记录编码版本；同一旧故障在新编码版本下可获得一次额外重探机会，且在派发 worker 前消费许可。重启、崩溃或 scheduler reset 不会重新获得同版本额外许可。原退避仍生效：第一次故障通常等待 5 分钟，同一 24 小时窗口内第二次后等待至窗口起点加 24 小时；版本升级机会不删除原 fault/attempts，也不替代常规到期重试。

手动重试只安排有权限的现存对象：每次最多 4 条，每对象 60 秒持久冷却。它不清 fault、不伪造 ACK、不重新生成 source revision。只有历史恢复故障而没有 message/tool fault 的会话仍展示异常，但不提供不支持的 live 重试。单会话操作走 availability 对象恢复；全局重连中的可选恢复数据库失败被固定诊断隔离，不阻止原重连流程。

大 metadata 曾可能遗漏工具派生索引。worker 返回有界的 `messageId/toolId/sourceRevision` 证据后，父进程重核当前上下文及来源版本，在本地事务中核对类型、未删除状态与工具身份后更新 `remote_live_tool_sources`，并在 `availability_tool_refresh` 排队工具重新投影；不修改权威工具版本。已有同来源远端表示需要更新时，在已协商能力下沿用 `representation=repair` 与 `expectedProjectionRevision` 做 CAS，不篡改原封存请求或云端版本。

新恢复请求以本地 `liveEncoderVersion` 标记开启严格回执核验；accepted/superseded 必须匹配 publication、会话、writer、对象、来源与合法展示版本，rejected 保留既有服务端缺省字段兼容。complete 被拒绝后产生的 desktop_only 后继请求继承本地标记，不降回宽松校验；旧封存请求仍兼容旧回执，但已提供的字段必须匹配。旧 rejected Tool 不作为已有成功表示，可按原来源进行有限恢复；工具 CAS 冲突按原 publication 核对后持久退避，保留原 ACK 与修复队列。

只有同一对象的有效 `accepted/superseded` 结果经核验并在 `completeObject()` 中持久保存后，才原子清除对应 fault、编码 probe 和工具 refresh；编码成功、HTTP 成功、请求 resolve 或本地标记检查完成均不能替代此条件。损坏原请求、错误 ACK、丢响应或 CAS 冲突保留原证据和明确重试边界。

## 健康统计与界面

| 事实 | 展示 |
| --- | --- |
| 真实 availability fault | 合入现有失败会话数与任务明细，按会话去重；对象故障使用“部分内容同步异常，其他内容可继续同步”，不承诺无限自动修复，不把健康连接统称为同步暂停 |
| 来源版本尚未 ACK | 保留 pending/同步中；旧版本 ACK 不代表当前版本完成 |
| 当前非删除来源已 ACK `desktop_only` | 中性色“部分内容需在电脑查看”；不作为红色失败，也不宣称全文已同步 |
| 合法 `local_only` 跳过 | 保持中性，不计 desktop-only ACK，不伪造上传成功 |
| 未识别表示、采样错误、超预算或过期快照 | 保留 unknown/degraded/统计暂不可用及计数未知；不补零假成功 |

`RemoteSyncHealth` 兼容增加可选 `desktopOnlySessions`，任务明细兼容增加可选 `source=live`。旧 task/projection 集合与 availability 集合互斥，汇总不重复计算；明细最多 20 条，计数不完整时保留下界/截断标志。重试按钮的展示资格不替代主进程权限与冷却检查。

归属详情新增 `OwnershipSyncState.Partial`。只有来源 ready、无 pending、无 degraded 时，desktop-only 内容才返回 Partial；故障、等待服务和真实待同步保留优先级。组结果仅在所有成员均 Synced/Partial 且至少一个 Partial 时返回 Partial。完整详情展示“部分内容需在电脑查看”，不添加会话 hover 行或改变原简洁布局。

## 诊断与验收

诊断仅输出固定原因、编码版本、有界 raw/normalized 字节计数、对象/作业关联标识和阶段耗时。不要记录原 metadata、正文、diff/patch、工具输入输出、token、设备密钥、请求 header/body 或任意异常 message；`encodingStats` 仅作本地诊断。

最终验证使用 Node.js 24.17.0，未访问真实用户数据库、Redis/MySQL 或其他外部服务：

- **27 个直接相关 Vitest 文件，564/564 项通过**。包含编码预算精确边界（256/32/48 KiB 各恰好上限及 +1）、真实 child/父事件循环、旧故障恢复、严格回执、工具 CAS、持久重试、状态和归属显示；未重复累计中间测试。
- **31 个改动 TS/TSX 文件严格 ESLint 通过**；`npm run compile:electron`、renderer `tsc --noEmit`、`git diff --check` 通过。
- 恢复负例包含：64 窗口外旧 fault、恰好 4 个旧 fault 与持续新消息、strict rejected→fallback 后不完整 ACK、同源 rejected Tool、ACK 提交前注入失败、重启 probe 与 CAS 冲突退避。失败时原 fault/封存请求保留，不产生假 ACK。
- 扩展 `remoteBridge.settings.test.ts` 和 `remoteBridge.environment.test.ts` 共 74 项中 66 通过、8 失败；在隔离的修改前 HEAD `4670f7fb2174fc069d4169f6ee13889f5a3da06f` 中同样出现这 8 项，属于既有缓存快照/分段准入时序问题。本轮未修改这两份测试或相关旧行为，**不宣称整个扩展集全绿**。
- 一次中间并发执行的既有 100 ms worker 时序测试曾超时，独立复验和最终串行定向集通过；未修改断言或生产 2 秒预算。服务端仅文档变更，未执行服务端测试。

可复现命令：`npm test -- --maxWorkers=1 --no-file-parallelism <27个文件> --reporter=json --outputFile=/tmp/lobsterai-metadata-targeted-results.json`。完整参数记录在 `/tmp/lobsterai-metadata-targeted-test-command.json`，最终结果在 `/tmp/lobsterai-metadata-targeted-results.json`，输出在 `/tmp/lobsterai-metadata-targeted-tests.log`。扩展与基线日志分别为 `/tmp/lobsterai-metadata-final-tests.log`、`/tmp/lobsterai-metadata-baseline-tests.log`，基线完整命令和原因见 `/tmp/lobsterai-metadata-baseline-reproduction.md`；静态检查及编译日志为 `/tmp/lobsterai-metadata-final-{lint,electron,renderer}.log`。

现场验收仍须安装包含完整修复的构建，确认原对象获得有限重探、正确表示到达、有效 ACK 持久保存后 fault 消失，且控制/其他对象仍正常。需覆盖版本重启预算、最近窗口外旧 fault、工具派生索引、迟到结果、丢响应、CAS 冲突、错误 ACK 和持久化失败。没有执行或宣称本机/线上恢复，不通过清库、删除身份或重放任务让提示消失。


后续展示入口调整见[任务内容同步提示 Spec](../task-sync-status-placement/2026-10-27-task-content-sync-status.md)：内容错误在任务详情处理，设备管理保留低强调摘要；不改变本篇字节预算、恢复协议或服务端接口。
