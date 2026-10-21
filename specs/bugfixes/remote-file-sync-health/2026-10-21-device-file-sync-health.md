# 设备管理文件同步状态误报修复

日期：2026-10-21

## 问题与证据边界

用户反馈所有任务显示“已同步”，设备管理仍显示“部分文件待同步”。任务记录的 ACK 与输入/产物文件二进制上传是独立通道，因此不能仅凭任务已同步断言附件上传成功。本次没有该设备的现场日志，修复以下代码中可确定复现的状态汇总缺陷，不将其认定为截图的唯一原因。

1. `RemoteFileSync` 将任何产物 `job.reason` 都算作文件同步降级。文件已发布、当前消息已有可下载引用后，`FINAL_SNAPSHOT_UNAVAILABLE` 仍会按设计保留，用来说明无法追溯固定任务结束瞬间的版本；设备状态却据此持续告警。
2. 按现有对话产物展示规则隐藏的代码/中间文件，在没有上传队列时仍可能用历史原因触发设备告警。
3. 快照缓存清理因引用预算或读取异常暂停时，也会触发文件同步降级，即使独立文件发布正常。

## 修复规则

统一复用当前消息的产物投影判断，不只检查文件名、任意旧消息引用或 job.latest：

| 状态 | 设备文件告警 |
|---|---|
| 无上传/重命名工作、无已知未捕获变更（dirtyAt），原因为 Final，当前 messageId 的投影为 ready | 不再告警；保留原原因和未固定版本状态 |
| 无上传/重命名工作，当前消息投影按既有规则明确隐藏（block=null） | 不再因该隐藏产物告警 |
| 仍有上传/重命名工作且存在原因 | 保留告警与原重试责任 |
| Final 但当前消息没有 ready 引用，或仅旧消息有 ready 引用；已发布旧版本后存在尚未捕获的本地修改 | 保留告警 |
| 可见文件类型、大小、来源、传输等失败 | 保留告警，不因有旧版本而忽略新版本失败 |
| 缓存清理暂停 | 保留清理诊断和安全边界，不把维护失败当成文件未同步 |

现有“部分文件待同步”中英文提示改为“部分文件未同步”/“Some files are not synced”，避免让类型、大小等长期限制看起来必然会继续上传。正常上传中及真实失败仍按原协议汇总。输入附件不采用生成产物的隐藏规则，用户主动附加的代码文件仍需上传并保留失败提示。

## 不变量与兼容性

- 不清空失败记录、不修改上传队列，不生成虚假的成功回执或终态 pin。
- 现有当前账号、scope、目标服务、设备、generation、会话授权和删除检查保持。
- 缓存引用未知时继续禁止删除；仅调整维护错误对设备提示的影响。
- 文件任务统计仍沿用原分页调度，上传完成后的待处理数最多保留到下一轮原有扫描；不宣称新增全量文件核对能力。
- 只涉及 LobsterAI 桌面客户端，无服务端接口、数据库或手机端协议变更。

## 验证

使用 Node.js 24.17.0 完成以下本地验证：

- `npm test -- src/main/remote/remoteArtifactProjection.test.ts src/main/remote/remoteFileSync.test.ts src/main/remote/remoteFileSync.inputs.test.ts src/main/remote/remoteFileSync.polling.test.ts src/main/remote/remoteBridge.test.ts src/renderer/components/settings/remoteControlState.test.ts --maxWorkers=2`：6 个测试文件、224 个用例通过。
- `npm run compile:electron`：通过。
- 5 个修改的 TypeScript 文件按 `eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0` 检查：通过。
- `git diff --check`：通过。

回归覆盖当前版本已发布但无终态 pin、仅旧消息引用、同消息 v1 发布后存在未捕获修改、隐藏产物、真实上传失败后恢复、不可同步文件、缓存清理预算保护、任务和文件状态独立性。未连接真实服务或修改用户任务数据；尚未打包发布，也未在截图对应设备进行升级后的实机验证。
