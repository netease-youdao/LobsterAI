# 启动失败与新会话同步恢复接入说明

日期：2026-10-29。涉及 LobsterAI 桌面和 lobsterai-server；App 源码不在本次范围。完整证据及验证记录见[修复 Spec](../../../lobsterai-server/docs/specs/mobile-remote-control/bugfix-2026-10-29-session-start-and-sync-recovery.md)。

## 1. 变更摘要

- 桌面历史投影在持续更新的老任务与新任务之间公平轮转，使新会话有机会生成初次快照；保留所有归属、一致性及发布安全检查。
- 桌面仅对本次新建、未执行的本地预设启动拒绝会话保存用户输入和通用失败说明，停止用临时页面代替真实失败记录；不补造 Run，也不把失败返回为成功。
- 服务端 v2 输入恢复查询补齐 MyBatis actor 参数名，保留原用户/空间/设备过滤条件，修复参数绑定失败。

以上均不增加手机 API 字段或必需请求参数，无数据库变更。不能据此断言现场切换模型后的原始异常已定位；报障日志止于 20:19:33，录屏为 20:25–20:26。

## 2. 相关接口与认证

| 接口 | 本次影响 |
| --- | --- |
| `GET /api/remote/v2/devices/{deviceId}/input-preparations?limit=20` | 桌面输入恢复原查询正确绑定 actor；cursor/limit、分页和收据合同不变 |
| `GET /api/remote/v1/sessions` | 初次快照完成后按原条件进入列表；不直接公开无快照占位 |
| `GET /api/remote/v1/sessions/{sessionId}/snapshot` | 继续返回原完整摘要、消息和水位 |
| `GET /api/remote/v2/sessions/{sessionId}/read-view` | 仅按原能力和投影版本 5 协商，部分视图规则不变 |

以上 GET 无请求体。继续使用 `Authorization: Bearer <accessToken>`、`X-Remote-Device-Credential` 及已协商投影版本；桌面 v2 输入恢复继续携带 `X-Remote-Connection-Generation`，只在已有 `isolated_input_recovery_v1` 能力和 readiness 满足时调用。手机不能用该桌面恢复接口代替详情读取。账号/空间来自认证，设备、grant 和 generation 校验不变。

v2 输入恢复的成功响应示例（没有待恢复记录的完整空页）：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "items": [],
    "unresolvedItems": [],
    "nextCursor": null,
    "scanComplete": true,
    "serverTime": "2026-10-29T09:00:00.000Z"
  }
}
```

这仍仅表示本次有界扫描结束，不授权清空本地 inbox/执行账本，也不证明所有历史准备已核对。完整健康记录、unresolved 跨页处理与混部回退见[输入隔离合同](../../../lobsterai-server/docs/api/remote-control-isolation-2026-10-08.md#input-recovery-v2)。

初次历史尚未发布时，详情沿用 HTTP 409，以下为错误字段节选：

```json
{
  "code": 47014,
  "message": "会话历史同步中",
  "data": {
    "reason": "SYNC_IN_PROGRESS",
    "reasonDetail": "INITIAL_IMPORT",
    "retryAfterMs": 2000
  }
}
```

## 3. 客户端行动项

- **桌面发布新版**：恢复原会话投影与上传，保留原 sessionId、commandId、import receipt 和捕获快照。无需清数据库、重新关联全部 Agent 或重新执行已经完成的任务。
- **手机按原合同处理等待**：命令已受理、电脑已执行、历史已发布是不同阶段。INITIAL_IMPORT 显示同步等待并按 retryAfterMs 核对原命令/会话；不要把它渲染为空详情、虚构终态或重复发送任务。
- **区分其他 47014**：根据 reason/reasonDetail 处理控制不可用、数据损坏等情形，不能统一视为初始导入；不覆盖已可信缓存。
- **启动失败消息**：使用已有 user/system 文本和 localStatus 展示；有真实 Run 时仍以 Run 为准。仅完整摘要明确 `run:null` 才使用已有历史展示回退，不能制造控制版本或“已启动”事实。
- **历史空会话**：缺少原始失败输入时不按标题补写；此次只补齐新发生的受保护失败路径。手机源码本次未改，具体界面需 App 团队按此验证。

## 4. 发布与验收

先在测试环境发布服务端补丁和新版桌面，验证旧任务持续更新期间新任务仍能同步、手机命令结果能回到详情/历史，以及预设启动拒绝有真实失败正文。随后按各环境分支合入发布。两项目可先后发布，无强制同时切换；旧服务/旧客户端接口兼容保持。

服务端补丁适用于已有 v2 输入恢复模块的分支；检查时本地 main 尚无该 mapper，部署范围需按实际代码确认。不要通过把缺失新模块类复制到旧分支来替代正常合并和验收。

发布后重新连接原账号及环境，等待原同步队列恢复；被安全隔离、已删除或凭据失效的任务仍须按原恢复流程处理，不承诺所有旧失败记录自动解除。不得用手工 ready、ACK 或重发原任务绕过。
