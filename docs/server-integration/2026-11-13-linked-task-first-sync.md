# 已关联旧任务的首次同步与续聊接入修复

日期：2026-11-13。状态：**桌面修复已实现，通过本地回归与独立安全复核；未部署、未操作用户现场数据、未完成手机真机验收。** 服务端与手机 App 的 HTTP／WS 协议、认证、错误码和 MySQL 表结构均不变。本次不修改手机 App 源码。

详细证据与服务端兼容边界见[本次排查记录](../../../lobsterai-server/docs/integration/2026-11-13-linked-task-first-sync.md)、[关联 SPEC §12.9](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-11-agent-task-account-association.md#129-2026-11-13-已关联旧任务首次发布来源确认)及 [App API §16.4](../../../lobsterai-server/docs/api/mobile-remote-api.md#164-2026-11-13-旧任务首次同步与续聊兼容修复)。

## 1. 修复摘要

11 月 10 日“生视频：雪山日出”在桌面关联账号后，首次同步的 state 查询返回 `404 / 47038 / SYNC_STATE_NOT_FOUND`，随后桌面报 `Unverified legacy session has no original mapping`。该错误发生在首次导入之前：显式关联的首次发布来源与旧同步准入没有接通。单独关联任务不会关联整个 Agent，而服务端本来允许任务携带 anonymous Agent 摘要；目录中没有该 Agent 不是历史任务读取的前提。

另修复桌面续聊错误复用整个 Agent 的发布资格检查：已归属当前账号、获准同步且原 Agent 仍可访问的任务，可继续使用其原匿名 Agent。这个修复不开放匿名 Agent 的目录、远程新建或设置权限。

## 2. 新关联与旧记录恢复

新的显式关联在严格确认没有历史发布事实时，保存当时可信的规范服务路由及可选目标身份；离线可先保存路由。来源已知时保持原值。原同步调度随后按可信目标、账号／空间、设备、映射和导入基线处理，不要求用户再关联整个 Agent，也不额外自动打开手机连接。

对早期已关联、原路由与目标均为空的记录，不依据当前账号、URL、零水位或一次 404 自动猜测来源。任务详情仅在主进程返回 `canConfirmPublication=true` 时显示“确认同步到当前服务”。用户新确认只补同步目标，不改变任务或 Agent 归属。

恢复范围为指定任务所在的真实 subagent 父子树，排除普通 fork 和 Agent 下未列出的其他任务。全范围必须同 owner、来自 manual_claim、被同一原关联回执覆盖且关联时间一致、来源双空，并严格无历史远端发布事实；任一不满足整体拒绝。主进程必须取得已识别的当前服务目标，把 route、target、设备和身份／目标的 epoch 纳入计划校验。目标或范围变化需重新预览；已有映射、ACK、原导入、outbox 或其他权威发布记录不能清零覆盖。

来源未确认显示“任务已关联账号，但同步来源尚未确认，请核对同步目标”，与电脑连接状态分开。没有确认按钮的任务仍须核查原同步事实，不能靠反复重试、关联整个 Agent 或修改本地数据库绕过。

## 3. 本地 IPC 契约与界面处理

复用现有 `ownership:preview`／`ownership:commit`／`ownership:getResult`：

| 字段／调用 | 增量 |
| --- | --- |
| `OwnershipDetail.canConfirmPublication?` | 主进程计算的窄恢复资格，仅决定是否显示入口；每次预览／提交仍重验 |
| preview 请求 `{kind,id,action?}` | action 默认 `associate`；同步目标确认使用 `confirm_publication` |
| preview `action?`、`publicationTarget?: {route}` | 展示真实账号、空间、规范服务路由及实际任务范围；没有匹配 action／route 的 eligible 回包不得确认 |
| commit | 保持 `planId`、`planVersion`、`accountGeneration`、`requestId` 四字段；不接受 renderer 指定的 route、target 或设备 |
| commit／getResult 成功结果 `action?` | 用于区分关联成功与同步目标确认成功提示；不是同步完成证明 |

新目标确认使用新的 requestId。已有未决意图先按原 requestId 查询结果；原关联回执重放只返回原结果，不自动产生目标确认。提交结果未知时保留原意图，不能另建请求重复提交。账号／空间切换或旧请求返回较晚时，不得覆盖新面板、显示过期成功提示或触发同步。待恢复意图仍只持久化原标识与计划字段，不保存预览正文、账号凭据或服务地址。

确认成功提示“已确认同步目标，等待同步”，不能显示为手机已同步。普通“关联账号”入口、默认 action 与原本地归属确认流程不变。

## 4. 服务端接入与兼容

继续使用原 capabilities／设备注册及同步目标身份、`GET /sync/state`、原 import 创建／分片／commit／状态核验与 sessions／snapshot／commands／输入准备接口。请求体和响应字段不增加本节的本地 IPC 字段；原 JWT、设备凭据、账号／空间、权限及错误处理保持不变。

严格没有远端发布事实且来源已可信绑定的首次发布，可直接进入原 online import，不必查询一个尚不存在的原映射。若执行 state 查询，精确 `404 / 47038` 仅说明当前鉴权设备尚无映射，不能替代可信来源和目标准入；任意 404、鉴权失败或旧目标数据缺失都不是清理／重建许可。已有映射、未决请求或发布事实时，依旧按原流程核对相应状态／回执，以及原协议、epoch、基线和不可变请求；v2／v3 不降级，不重置已有 ACK，不重跑历史任务。

已支持这些既有协议的服务端不需要为本次单独升级或迁移 MySQL，兼容 MySQL 5.7；手机 App、Portal、Admin 无必需变更。不承诺不理解既有 admission 或 v3 fence 的任意古老桌面版本可安全降级复用当前本地数据。

## 5. 验证记录

最终代码使用 Node 24.22.2 统一执行 12 个定向 Vitest 文件，464 项全部通过；Electron 编译、renderer TypeScript 检查与变更文件 ESLint 通过。覆盖来源保存与窄确认、首次导入两条链路、匿名 Agent 已准入任务续聊、来源状态展示，以及 renderer 确认／原回执恢复。独立安全复核已完成，发现的问题已修正，无未解决项；账号／目标变化、既有发布事实、旧回执和原权限边界均保持保护。

按约未运行服务端测试。本次未部署、未操作用户现场数据或执行现场目标确认，未完成手机真机端到端验收。真实手机展示与续聊恢复仍需以实际同步结果验收，不能由本地归属或目标确认成功推断。

## 6. 11/02 现场复核

日志包 `1793604161425lobsterai-logs-20261102-152148` 中，本地任务 `69308ffe-0375-47cf-a447-22a5cb588758` 使用 `main` Agent，对应远端任务 `d6813685-42ad-476f-8602-ef1ec7b5ce5d`。截图标题“早起上班图生成”未出现在这些日志中，本次按时间与任务 ID 关联，不能写成日志直接确认了标题。

| 证据 | 观察 |
| --- | --- |
| `main-2026-10-30.log:93948、94368` | 任务 17:32:41 启动，17:34:59 收到结束事件；session key 指向 `main` |
| `main-2026-11-02.log:51574、52226` | 15:20:09.131 记录 `ownership-associated` 配置同步，随后确认配置应用成功 |
| `remote.log:5359、5361` | 15:20:09.662 查询 `/sync/state` 返回 `404 / 47038`，随后同一任务报 `Unverified legacy session has no original mapping`；source／ACK／server 水位均为 0 |

这与 11/10 记录属于同一首次同步阻断路径，未发现 main 专属生产缺陷；15:21:24 的另一任务记录不作为本任务重试证据。日志不能证明现场原路由、目标均为空或没有历史发布事实，零水位和 404 也不授予恢复资格。既有“确认同步到当前服务”入口仍须按实际本地状态满足全部条件，不能据日志自动补写来源或修改现场数据。

本轮仅补测试与文档，无新增生产逻辑。Node 24.22.2 下执行 `ownershipAssociation.test.ts`、`remoteBridge.environment.test.ts`、`remoteOwnershipContentSync.test.ts`，3 个文件 190 项全部通过；两处变更测试文件的 ESLint（含 `--report-unused-disable-directives --max-warnings 0`）通过。覆盖非 main 匿名 Agent 与 main 的单任务关联、无关同 Agent 任务不关联不上传、Agent 归属不变，以及历史 `404 / 47038` 失败进入隔离、确认目标、首次 import ACK 的完整路径，无任务重跑。独立安全复核通过；本记录不替代上节 464 项历史验证。

服务端和手机无需新增接口，按约未运行服务端测试，本轮未重跑编译。未部署、未执行现场目标确认或修改用户数据；现场仍须发布包含既有修复的新桌面，在满足条件时确认目标，再完成手机展示与续聊的真机验收，尚不能宣称手机已恢复同步。
