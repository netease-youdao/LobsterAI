# 桌面远控本地身份失败：原身份安全重试

日期：2026-10-26。状态：**已实现原身份保留与安全重试，未发布；真实 Windows 故障机验收待完成。**

共享契约：服务端仓库 `docs/specs/mobile-remote-control/bugfix-2026-10-26-desktop-remote-identity-recovery.md`。本文用于桌面仓库的实现与验收记录，服务端 API/DDL 和手机源码均不变。

## 1. 已确认问题

Windows 日志 `main-2026-10-26.log` 在北京时间 14:43:03–14:57:11 共 31 次记录 `remote:connections` / `remote:configure` 的 `safeStorage.decryptString` 异常，首条位于 40000 行。栈为 `loadRemoteIdentity → initializeRemoteBridge`，发生在 bridge 创建及本次远控请求前。页面却显示“远程服务暂不可用”，打开设备管理和重新连接持续重复同一异常。

日志能证明旧密文当前无法解密，不能证明是版本升级、文件损坏、Windows 用户密钥改变或用户目录复制中的某一个原因；版本切换只作背景。普通模型请求成功不等于全部远控接口健康。

## 2. 当前实施范围

用户已明确选择保留原身份方案；无可用密钥时保留数据并提示恢复原始材料，不实施新身份重建。

- 在初始化边界将身份/检查点读取失败转为可读的本地状态；安全日志沿用原恢复状态及完整校验，使用稳定的共享原因常量，不匹配原始异常文案作 UI 分支。
- 保留原 identity、checkpoint、安全日志、注册身份和数据库；不删文件、不换 key、不重置 installationId/databaseId。
- 只读状态与连接列表查询不再反复初始化。阻塞期间暂停无效连接轮询，恢复后再获取连接列表。
- 提供并发合并的原身份安全重试；手动至少间隔 1 秒。自动恢复只针对 `secure_storage_unavailable` / `local_storage_unavailable`，每 30 秒最多一次且要求登录、远控开启；其他原因只显式重试。所有路径通过同一验证流程并清理失败资源。
- 正确展示本地原因，重试不改变原远控开关或独立保持唤醒偏好；本地普通能力不因远控初始化异常整体中断。
- 原安全存储恢复后读取相同身份，完整验证 journal 与数据库证据，再回到现有网络状态机；WS hello/心跳前不能显示在线。

本次不实现无密钥时的全新身份重建；不能用重试按钮重新赋予未知历史远程权限。原材料恢复前可准确诊断，但不能承诺永久丢失密钥的机器一键恢复。

## 3. 关键代码边界

| 区域 | 当前路径 | 本次职责 |
| --- | --- | --- |
| 根身份/检查点 | `src/main/remote/installationIdentity.ts` | 区分不可用、读取、解密、格式失败；保留原材料与正常首次创建行为 |
| 初始化组合与 IPC | `src/main/main.ts` | 捕获可分类失败，避免半初始化实例；状态读取无副作用；重试与账号代次校验 |
| 安全门禁 | `src/main/remote/remoteSecurityCoordinator.ts`、`remoteSecurityJournal.ts` | 继续使用原完整校验，不为恢复放宽归属/执行证明 |
| 共享状态 | `src/shared/remote/constants.ts` | 可选本地初始化状态和稳定原因值，保持旧成功结构 |
| 状态映射 | `src/renderer/components/settings/remoteControlState.ts` | 本地原因不被通用 error 分支覆盖；原网络状态仍正常 |
| 设备管理 | `src/renderer/components/remote/RemoteDeviceSettings.tsx` 及相关服务 | 阻塞轮询、安全重试入口、进行中状态与恢复后的重新加载 |
| 文案 | `src/renderer/services/i18n.ts` | 中英本地错误、重试、无法恢复的准确提示 |

实际新增可选字段 `RemoteSettingsState.initializationFailure`，五种值为 `secure_storage_unavailable`、`identity_unreadable`、`identity_invalid`、`local_storage_unavailable`、`dependency_unavailable`。沿用既有 `remote:state` 与 `remote:configure({retry:true,expectedAccountEpoch})`，无新增网络接口。

## 4. 状态与交互

状态至少区分：本地安全存储暂不可用、身份文件读取失败、身份解密失败、身份格式异常、安全证据校验未完成、正在重试、本地就绪后的原连接状态。原 401/403/429/满额/设备退役属于网络或服务端状态，不能触发根身份重建。

本地故障文案按类别区分安全存储、解密、校验、文件访问和模块依赖；操作为“重新检查”，并说明原有数据已保留、需恢复原凭据或联系支持。界面不得暴露原始路径、密文、账号或底层堆栈，不承诺点击后必然恢复。

重试顺序：核对当前账号 epoch/owner → 合并并发 → 读取并解密原 identity → 检查原 checkpoint/journal/数据库与归属证据 → 完整通过后建立可用 bridge → 根据原用户偏好执行原网络流程。任何阶段失败保留证据，清理这次创建的监听、定时器/socket，不保留假就绪实例。

页面读取和首载在失败状态下不能调用会重复初始化的连接查询；仍可订阅/读取本地状态。手动/自动重试共享状态机。旧账号、旧环境或旧代次回包不得覆盖新状态，重试成功不等于授予当前账号访问全部本地历史。

身份读取、bridge 构造、异步 journal 验证和 WS 连接是不同阶段。即使同步构造已成功，原 `security.available()` 尚未通过时仍保留并展示 `syncHealth.LocalRecovery` 等真实状态，不记录完整恢复成功，也不把 journal 拒绝映射为远程服务故障。

## 5. 原材料不可恢复时的限制

根身份同时绑定服务端设备凭据、安全日志 HMAC 与数据库身份。缺失系统解密材料时，账号登录和同一主机名不能推出原 key，删除 `identity.bin` 会破坏原安全证明的验证基础。因此该状态下本次只报告阻塞、保留文件并允许以后重试。

全新身份受控重建暂不实施。如果后续明确采用，需要单独设计原数据隔离、备份、执行副作用未知处理、可信归属重建及一次性持久新身份；不能自动重放旧命令、继承旧设备或迁移旧云会话。现有 v2 register 可创建新设备，但不会注销旧设备；新桌面仅能通过显式 connection/remove 暂停同 owner 旧连接，不能用现有 retire 退役另一桌面。在线/注册预算及 syncTarget 隔离仍适用。

## 6. 验收计划

完整验收要求如下。实际执行记录见第 7 节；未完成的 Windows/Electron 人工验收不能由模拟 cipher 测试代替。

| 场景 | 核心断言 |
| --- | --- |
| 已有 identity 解密抛错 | 本地状态正确；零 capabilities/register/list 请求；无重复 IPC 堆栈风暴 |
| 安全存储暂不可用后恢复 | 文件 hash、installationId/key/databaseId 不变；完整校验后才恢复 |
| 读取错误、坏密文、非法 JSON/字段 | 不覆盖/删除/补造身份；分类可诊断 |
| 身份可读但 checkpoint/journal 错误 | 不解除安全门禁，不领取/执行新命令 |
| 多窗口、打开关闭页面、连续状态轮询及30秒后再次查询 | 普通查询不重新初始化；失败时连接列表轮询暂停 |
| 手动连点与自动重试竞争，构造或start失败 | 1秒/30秒及登录/开关门禁有效；一次在途尝试；无残留 worker/timer/socket/listener |
| 重试期间退出/切换账号、空间、环境 | 旧状态不覆盖新状态，不发送旧账号或环境的请求 |
| 原开关关闭 | 重试不启用远控，不修改独立偏好 |
| 本地成功但服务端满额/限流/认证失败/退役 | 原文案与退避有效；不再次生成新身份 |
| 健康升级和正常首次安装 | 原身份保留或只生成一次；旧成功 IPC 结构兼容 |
| 尚无 WS hello | 不显示在线；真实 hello/心跳后才更新 |
| 根身份系统密钥永久不可恢复 | 明确保持阻塞，不声称恢复成功或自动执行重建 |
| 普通本地任务及保持唤醒 | 不被远控初始化失败整体阻断；原执行安全规则不变 |
| 真实 Windows 环境 | 覆盖故障、同身份恢复、升级与重启；模拟 cipher 不能代替此项 |
| 日志和 UI | 无明文 key/token/密文；中文英文文案和状态优先级一致 |

实施后按仓库要求记录目标 Vitest、受影响文件 lint、Electron 编译和真实 Windows 人工复验的命令及结果；共享服务端 spec 的 RI-01–RI-16 作为跨端边界验收清单。服务端本次没有源码变更，不执行服务端测试。

## 7. 实施与验证记录

实际实现文件：

- `src/main/remote/installationIdentity.ts`、`installationIdentity.test.ts`：错误分类、有界读取、保留坏字节、禁止旧安装缺身份时重新生成、加解密回验与独占首建；检查点不凭数据库猜测或重置。
- `src/main/remote/remoteInitialization.ts`、`remoteInitialization.test.ts`、`src/main/main.ts`、`main.remoteInitialization.test.ts`：状态缓存、普通读取不触发恢复、30 秒自动/1 秒手动限制、登录/开关门禁、半初始化资源清理与脱敏日志。
- `src/shared/remote/constants.ts`、主进程/renderer i18n：可选本地失败字段和中英文文案。
- `remoteControlState`、`RemoteDeviceSettings`、`remoteDeviceConnections`、`ownership` 及其测试：灰色本机状态、原身份重新检查、停止无效轮询、账号切换及迟到响应保护；归属面板重试不再把本地初始化失败提示为已安排同步。

### 已执行验证

运行环境：macOS，Node 24.17.0；测试使用临时文件/隔离 SQLite/模拟 cipher，不访问用户真实身份、Redis 或共享 MySQL。

1. `npm test -- src/main/remote/remoteInitialization.test.ts src/main/remote/configureRemoteSettings.test.ts src/main/remote/remoteConnectionIpc.test.ts src/main/remote/installationIdentity.test.ts`：最终实现 4 个文件、59 项通过。
2. `npm test -- src/main/main.remoteInitialization.test.ts`：11 项通过。AST 抽取实际主进程声明及 IPC，使用真实恢复 helper、配置 controller、身份读写和临时 SQLite；覆盖身份失败时无 bridge/网络、数据库历史证据禁止重新首建、构造/start 失败资源清理、纯重试返回分类状态、恢复复用原身份，以及真实 `RemoteBridge.tick()` 在安全证据拒绝时仍阻断网络。
3. `npm test -- src/renderer/components/settings/remoteControlState.test.ts src/renderer/components/remote/RemoteDeviceSettings.test.ts src/renderer/components/remote/RemoteControlPopover.test.ts src/renderer/services/remoteDeviceConnections.test.ts src/renderer/services/ownership.test.ts src/renderer/services/remoteSettings.test.ts`：最终实现 6 个文件、150 项通过。
4. `npm test -- src/main/remote/remoteStore.test.ts src/main/remote/remoteRegistrationIdentity.test.ts src/main/remote/remoteSecurityJournal.test.ts src/main/remote/remoteSecurityCoordinator.test.ts src/main/remote/remoteBridge.environment.test.ts src/main/remote/remoteEnvironmentMigration.test.ts`：扩展回归 118 通过、1 失败。
5. 上述唯一失败是 `remoteBridge.environment.test.ts` 的 `retries deferred admission only after explicit reconnect and preserves its original ACK`：预期 admissionDeferred=false，实际 true。使用只读 HEAD 源码加载器执行 `npx vitest run --config /tmp/remote-identity-baseline.config.mjs -t 'retries deferred admission only after explicit reconnect and preserves its original ACK'`，未修改源码同样失败；此项为已有问题，本次未改动相应准入恢复实现，不将整组回归称为通过。该临时配置仅替换修改过的源码为 `git show HEAD:<path>` 内容，没有重置工作区。
6. `npm run compile:electron`、`npx tsc --noEmit` 通过。17 个新增/修改 TypeScript 文件的 `npx eslint <files> --max-warnings 0` 及客户端、服务端本次文档的 `git diff --check` 通过。

合计 220 项定向测试通过；扩展回归另有 118 项通过、1 项已在未修改源码复现的失败。所有测试均不等同于 Windows 故障机已经恢复。

### 尚未完成与恢复限制

- 未执行真实 Windows DPAPI/safeStorage 验收、原始故障机恢复或完整 Electron UI 人工联调。
- 原密钥丢失且没有可解密副本时，本次保留现场并报告阻塞；没有新增独立 DPAPI 备份，也没有新身份重建/旧任务重新授权功能。
- 若恢复原材料后 journal 仍不匹配，继续遵守原安全门禁。不得删除身份目录、journal 或数据库来让界面变绿。
- 服务端只有共享 spec 更新，无 HTTP/WS、认证、SQL、数据库格式或功能开关变化，兼容 MySQL 5.7；无需手机源码、Portal 或 Admin 改动，未运行服务端测试。
