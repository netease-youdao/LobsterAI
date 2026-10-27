# 已停止任务无法删除的恢复与反馈

日期：2026-10-27

## 问题与目标

任务没有运行完成就被停止，桌面详情已不再显示运行中，但确认删除后仍留在侧边栏。任务是否完成不应成为删除前提：已经停止的任务应能删除；仍有执行或排队工作的任务，先确认停止，再提交删除。无法确认时保留记录并显示原因。

本次检查到本地会话为 `idle`，对应持久化 run 仍为 `reconciling`，且保存了有效的 core run / gateway run / session key 绑定。停止日志及应用重启记录与此状态一致。诊断只读取本地数据库与日志，没有删除真实会话。

## 原因

1. 本地 `stopSession()` 清理界面和内存状态，并不代表网关已确认全部执行停止，因此 run 可保留为 `reconciling`。
2. 重启后 `activeTurns` 和 `yieldedSessions` 中没有旧任务。原 `cancelSessionConfirmed()` 在两者均不存在时直接返回 `false`，没有使用持久化绑定向当前网关确认。
3. 删除服务正确地拒绝未确认停止的非终态任务，但这个分支无法自行恢复。侧边栏删除回调又只消费 boolean，确认框在请求结束前关闭，用户看不到具体失败原因。

## 实现

### 运行引擎确认

保留原有 active turn 与 yielded wait 停止路径。新增没有内存 turn 的恢复路径：

- 要求当前 core run、持久化 gateway run 绑定和解析出的精确 session key 一致。允许绑定来自旧 gateway boot；要求当前连接的 boot 已知。
- 使用已有本地 OpenClaw `sessions.abort({ key, clearQueued: true })`。不限定旧 runId，确保清理该会话的队列和子任务；接受停止请求本身不等于确认停止。
- 随后调用 `sessions.list({ search: key, limit: 50, archived: 'all' })`。必须唯一匹配完整 key，且 `hasActiveRun === false`、`hasActiveSubagentRun` 为 `false` 或缺省。缺行、重复行、未知字段、仍有活动执行或 RPC 异常均不能作为停止证据。
- 请求前、每次异步返回后以及本地清理前，复验账号及恢复 epoch、会话访问权限、删除 guard、core run、完整绑定、session key、gateway client/generation/boot/PID；新 active turn 或 yielded wait 出现也立即失效。
- 确认后执行本地停止清理并发出绑定 gateway run 的 `runTermination(cancelled)`，由既有状态观察与删除流程继续处理。

RPC 与响应验证放在 `openclawSessionStop.ts`，适配器只负责捕获并复验运行上下文。沿用已打包 OpenClaw 的现有 API，不修改 OpenClaw 源码或补丁。

### 删除事务与账号边界

`SessionDeletionService` 捕获全部删除目标的 guard、runId、owner 和账号 epoch，在每轮处理、每次停止等待返回后、最终提交前复验。复验通过后才允许更新 run；等待期间收到的真实终态不覆盖为 cancelled。主进程传入包含账号 generation 的 epoch，阻止同账号退出再登录的 ABA 结果继续删除。

批量删除仍在全部任务通过停止确认后统一提交；任一任务失败时没有部分删除。已确认停止的任务可以保留停止状态。沿用现有本地删除事务、持久化删除标记、清理重试与通知，不以服务端同步 ACK 作为本地删除前提。

### 确认框反馈

- 提交后显示“正在删除…”，禁用重复提交、取消、遮罩及 Escape 关闭。
- 本地删除成功才移除预览并关闭弹窗；失败保留弹窗，以 `role=alert` 展示主进程返回的具体原因，允许重试。
- 账号切换或组件卸载后丢弃旧请求完成结果；保留现有 boolean 删除 API 兼容其他调用方，侧边栏使用新增结构化结果方法。
- 新增文案提供中英文翻译。主进程为单条、批量删除失败记录有界日志，便于区分停止未确认与存储错误。

## 兼容与边界

仅修改 LobsterAI 桌面端的 runtime adapter、删除服务、IPC 错误日志及渲染层，无服务端、Portal、Admin、手机 App 或数据库结构变更。产物文件不属于本次会话删除范围。

网关不可用、绑定缺失或无法取得明确的停止证据时仍保留任务，并向用户显示可重试的失败原因。不会仅凭 `idle`、本地没有 active turn 或网关查不到记录推断可以安全删除。停止确认无需访问线上或测试业务服务，因此不受其同步 ACK 是否完成约束。

## 验证

- 运行时回归覆盖旧 boot + 本地 idle + 持久化 reconciling 的实际状态组合，以及绑定错误、账号 ABA、guard/run/client/boot/PID 变化、新 turn、新等待、子任务活动和 RPC 失败。
- 内存 SQLite 回归验证确认前保留任务、确认后删除、失败不写删除标记、自然终态保留、批量原子性及异步身份变化。
- 弹窗与服务回归验证请求等待、重复点击、错误展示、重试、账号切换与旧请求结果隔离；保留侧边栏删除缓存回归。
- 使用隔离 Electron 窗口挂载真实 React 组件、Modal 和项目 CSS，以真实鼠标与 Escape 输入验证等待、失败、重试和账号变更，检查浅色与深色布局。该烟测只替换数据与请求夹具，不启动产品主进程，不连接真实账号或删除真实会话。

验证结果：11 组定向测试共 237 项通过（其中运行时停止相关 60 项，其余 10 组 177 项）；本次改动 TypeScript 文件的严格 ESLint、Electron 编译、renderer 类型检查、生产构建与 `git diff --check` 通过。生产构建仍有既有的 Browserslist 数据、lottie-web eval、混合导入与大包体提示，没有构建错误。

本轮没有进行真实产品 IPC 与运行中的 OpenClaw 联调，也没有修改用户真实任务。真实用户会话需要在加载新版主进程后再次操作删除验收。
