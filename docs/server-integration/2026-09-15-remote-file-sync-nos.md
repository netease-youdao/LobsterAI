# 远程文件同步：输入附件与版本化产物

2026-09-22 同步设计更新（代码已实现，未部署）：[当前生效服务同步方案](../../specs/bugfixes/remote-sync-target/2026-09-22-effective-server-sync-design.md) §4.3 将文件任务、asset/upload/reply 引用和发布回执归到当前服务绑定。相同数据集多域名可恢复原任务；新数据集重新登记文件引用，不能复制旧服务 ID 或凭据。缓存仅在内容及访问权限核验后复用，GC 保护所有保留绑定的引用；域名／模式本身不构成文件同步禁令。

本次桌面实现基于服务端 `docs/api/mobile-remote-files-api.md`，文件持久存储由服务端 NOS 适配负责；桌面不接触 Bucket、对象地址或存储凭据。该文档记录代码接入，不代表环境已配置、开关已开放或已完成真实 NOS 联调。

## 能力与认证

先使用默认 v1 调用 `GET /api/remote/v1/capabilities`。只有支持 `file_sync_v1`、`artifact_versions_v1` 与 `projectionVersions: [1,2,3]` 才接入新文件同步，并申请 `projectionVersion:3` 的 WS ticket；hello 降级则停止新文件发布。无新能力继续既有文本/输入 v2 与本地产物占位。

所有请求使用原有 JWT 和 `X-Remote-Device-Credential`；产物变更与恢复额外携带当前 `X-Remote-Connection-Generation`，文件请求携带 `X-Remote-File-Policy-Version`。账号、空间、服务环境或 generation 变化后，旧请求不再推进本地发布状态。服务端重新校验授权，客户端检查不替代服务端权限。

`GET /file-policy?deviceId=<id>` 下发允许名单、数量与大小限制，每 45 秒刷新；FILE_POLICY_CHANGED 使本地策略失效。桌面再与本地安全上限取交集：文本/源码 5 MiB、图片 10 MiB、文档 30 MiB；仅显式输入允许音频 20 MiB、视频 50 MiB。未知类型、HTML/SVG、压缩包和可执行文件不新增上传。

## 输入附件

用户发送时只捕获显式选择的附件。主进程验证账号、会话和文件访问资格，在按账号/空间隔离的受控目录创建不可变快照，校验源文件和快照摘要。不从提示词、模型回复的本地路径推断上传。

原用户消息先同步到服务端。桌面随后按原消息 ID 申请 `POST /devices/{deviceId}/input-assets`，body 仍为：

```json
{"uploadRequestId":"<固定UUID>","source":"desktop_message","sessionId":"<会话ID>","messageId":"<用户消息ID>","fileName":"report.md","mimeType":"text/markdown","sizeBytes":"1024","sha256":"<完整摘要>"}
```

随后复用 `PUT /input-assets/{assetId}/parts/{partNo}` 和 `POST /input-assets/{assetId}/complete`。分片从 1 编号，携带 Content-Length/X-Content-SHA256。完成后将同一用户消息升级为 ready attachment，成功前继续保留本地占位。旧版本客户端遗留的可变文件路径不自动回填，无法取到原固定快照时记录 FILE_SOURCE_CHANGED。

## 输出产物

候选仅来自资料库与当前任务的 `created/modified` 关系，必须有真实 message/run 归属；`referenced`、匿名任务、未登记路径不会上传。文件 inode/birthtime 必须仍对应资料库已验证身份；原子替换需要资料库重新验证后才允许捕获。不会递归上传整个工作目录。

桌面每 2 秒检查已登记候选的变化标记；停止修改 2 秒或持续变化达到 10 秒时尝试阶段快照。捕获前后核对文件身份，并比较源文件和副本 SHA-256。每个产物只允许一个在途阶段上传；普通变化合并。任务终态边界另行捕获至多 3 份不可合并的终态快照，按 captureSequence 发布并固定消息引用，避免下一轮改写覆盖上一轮结果。

捕获终态采用有上限的本地同步复制/摘要验证，上传异步；本机每账号上传缓存最多 200 MiB，包括输入和产物快照。无法捕获时保留既有结果并记录 FINAL_SNAPSHOT_UNAVAILABLE，不把当前最新版本冒充本轮最终版本。真实终态边界保存持久 run 序号和准入记录；若 renderer 晚登记，仅当当前仍为同一终态 run、run 序号未变化、账号/环境/设备一致，文件修改/创建时间不晚于结束边界，且身份和双摘要稳定时补捕获。缺少当时准入记录的历史、发生过下一轮执行或终态后文件修改均不回填。

发布按以下原协议顺序执行：

1. `POST /devices/{deviceId}/artifacts` 登记 opaque localArtifactId 与已同步 message/run。
2. `GET /sessions/{sessionId}/artifacts/{artifactId}` 查询真实最新版本。
3. `POST /artifacts/{artifactId}/versions` 固定 publicationId、expectedLatestVersion、captureSequence、message/run 与完整摘要。
4. 分片上传、complete 后 `POST /artifacts/{artifactId}/versions/{version}/publish`。
5. 终态 `POST /artifacts/{artifactId}/references` 携带当前 run 快照摘要，成功后原消息投影固定为 pinned。

断线恢复先 GET 上传状态，再使用原 publicationId/hash 和新 generation 调用 resume；不得给旧快照改序号、增加 expectedLatestVersion 强行覆盖。最终摘要相同时复用已发布内容，但仍提交当前 run 的 terminal reference。新 run 的阶段内容相同时不提前 pin 新消息，以免阻止该消息后续发布最终版本。

离线超过未发布草稿保留期后，仅当服务器明确返回原 publication 已 deleted/expired 且未发布，再次 GET 产物清单确认 pending 已清空、latest 仍等于原 expectedLatestVersion、captureSequence 尚未被发布，才重新申请一个 publicationId。此操作保留原 captureSequence、message/run 和受控快照；快照缓存文件身份及 SHA-256 必须未变，账号/空间/环境/设备/会话与原消息 run 仍有效。网络未知、404、pending 未清、新版本已推进、快照被替换或原上下文丢失均保留失败待核对，不能通过重跑任务或读取当前源文件补出旧结果。

投影 3 仅携带 artifactId/artifactVersion/assetId/assetVersion、已验证元信息与 latest/pinned 引用，不暴露本地路径。手机按原 WS 会话事件和 artifact.changed 刷新，并调用有权限检查的 HTTP 固定版本下载接口。手机的真实预览 UI 需 App 项目自行接入。

## 发布与验证

服务端先完成新增 MySQL 5.7 迁移、私有 NOS 持久读写/删除契约及配置验证，再开放新文件写入。关闭写入不应阻断已发布历史读取。旧 TOS 资产迁移由服务端处理，桌面不直接改写旧存储地址。

本轮只进行模拟 HTTP、临时文件/SQLite 的本地测试和 TypeScript/ESLint 检查；未启动真实远控同步，未上传用户文件，未运行外部服务测试。真实 NOS 权限、四节点重连和 App 预览仍需环境联调。

## 2026-09-22 Markdown 交付文件预览修复

本节补充“输出产物”的候选发现规则。`.md` 类型支持不等于文件已发布；占位卡片不会自行获得下载权限。日志显示资料库重复登记主键冲突，以及 exec 生成文件仅按 referenced 登记，两者均会阻断文件卡片升级。

- 本地 SQLite dirty 触发器改用显式 `ON CONFLICT(session_id) DO NOTHING`；初始化时事务替换旧触发器，保留归属隔离，避免远控标记导致本地产物登记失败。
- OpenClaw 主任务发送前，在远控/文件能力有效时，仅记录 cwd 与 Desktop 直属文件的元数据基线。最多两个目录、每目录 256 项、总预算 80ms；执行等待硬上限 100ms，异常继续本地任务。不递归扫描、不在准备阶段读取内容或访问网络。
- 仅同一账号 epoch/run/运行序号的成功任务，存在同轮成功写入工具或最终 exitCode=0 的 exec/bash，才识别最终回复明确交付且相对基线发生变化的文件。图片语法仅接受 PNG/JPG/JPEG/WEBP/GIF 本地文件；排除普通未变化引用、代码示例、转义图片语法、裸路径、远程链接和 data URL；不处理历史任务回放。
- 复用本地访问 lease、服务端白名单与大小限制，封存后再次核验身份；资料库在实际 upsert 前验证解析结果的路径、身份、大小和修改时间。异步解析期间被替换的文件不得变成可同步关系。
- 新快照是捕获时的当前版本，走 latest，不伪造任务结束瞬间的 pinned/terminal 历史。相同内容去重复用服务器已有版本时，仍给新消息建立 latest 引用。
- 基线最多 32 个任务，暂停/换账号/换运行后失效，发现失败最多退避重试到结束后 10 分钟。持久上传队列仍按原协议恢复；任何发现/上传失败不改变本地任务结果。

范围限制：仅合格基线目录的直属文件参与这条补充流程。超过目录/时间预算、未变化文件、历史未封存任务，不自动扩大上传范围。已有明确 created/modified 产物继续使用原流程。

服务端接口和 MySQL 无变更；本地触发器随桌面升级。App 代码本次未改，继续使用 artifact/asset/version 鉴权下载，不开放 file://。更新桌面后应真机验证新建、同名覆盖、相同内容再生成三种交付；已有失败任务可通过新一轮实际修改并交付验证，不能承诺自动恢复旧版本。完整故障证据见服务端 `docs/operations/2026-09-22-app-markdown-artifact-preview.md`，设计见文件同步 Spec §20。

## 2026-09-22 其他附件和产物类型补齐

本次只有桌面实现与设计文档变更，复用已有 input-assets/artifacts 的请求、响应和鉴权，服务端无需新增接口、功能开关或 MySQL 迁移。

- 普通选择的文件也在发送时封存，远控有效时所有输入共用最多 250ms 本地等待，不等待网络。模型仍使用用户原路径；远端副本表示发送时版本，不保证等于模型稍后读取或修改后的版本。普通文件迟到结果、源身份变化和软链捕获失败继续本地任务，不回读历史可变路径补传。不可变 IPC 图片字节可后台完成。
- 等待后复核账号/空间、会话、run 和删除屏障；迟到元数据失效后清理副本。新 desktopInputRun 携带 localSessionId，任务删除后的私有缓存回收支持该字段、旧 session 前缀及精确终态 runHistory 关联；仍遵守删除确认、宽限期、owner 与在途上传保护，不删除原件。
- 共享类型表补齐 json/yaml/yml/xml/js/ts/py/java/c/cpp/h/hpp/go/rs/sh/sql，复用只读 Code 展示；本地可登记类型覆盖远端现有 31 种输出扩展名。没有扩大服务端白名单或改变 MIME 内容校验，HTML/SVG/音频/视频输出继续不上传。
- 最终回复中的本地内联图片与文件链接共用本轮变化证明和权限检查。没有合格基线的旧图片、远程图片和普通未变化引用不会自动上传。

客户端验收：普通 Markdown/PDF/JSON 输入应保留发送时字节，JSON/YAML/代码和五种图片输出应形成 ready/version；覆盖同名修改、断网、捕获超时、账号切换和删除期间的结果丢弃。使用新版桌面进行真实 NOS 鉴权下载和 App 真机验收；iOS 本次未修改，其 QuickLook 对不同格式的原生预览能力需单独确认。
