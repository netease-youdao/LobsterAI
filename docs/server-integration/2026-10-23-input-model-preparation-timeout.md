# 远程续聊输入准备：模型版本冲突收敛

日期：2026-10-23。服务端与当前桌面代码已实现，尚未部署或完成 iOS/设备联调。

## Change Summary

旧会话保存的模型版本可能落后于当前目录，桌面续聊解析当前版本后曾反复被拒绝，手机等待至准备超时。本次在新 preparation 创建时固定同一模型的当前已发布版本，并让明确模型拒绝变成可查询的 failed。

仅涉及 lobsterai-server 与 LobsterAI 桌面，不要求 Portal/Admin 更新。服务端无数据库迁移，兼容 MySQL 5.7。

## Endpoint Details

已有 POST `/api/remote/v1/input-preparations/{preparationId}/result`，请求不变。当前合法 claim 的 ready 被明确模型校验拒绝时，仍返回原 HTTP 409，例如：

```json
{
  "code": 47042,
  "message": "模型配置已变化或不可用，请刷新后重试",
  "data": {
    "reason": "MODEL_VERSION_CONFLICT",
    "validationStage": "catalog_resolution",
    "expectedModelRef": "<opaque modelRef>",
    "actualModelRef": "<opaque modelRef>",
    "expectedModelVersion": "2",
    "actualModelVersion": "3"
  }
}
```

以上诊断字段可选；原 code、reason 和认证语义保留。拒绝保存后，已有 GET `/api/remote/v1/input-preparations/{preparationId}` 返回 `data.status="failed"`、`data.reason="MODEL_VERSION_CONFLICT"`，并发送既有 input.preparation.updated 通知。

新建 send_message/keep_session 的 `targetSummary.context` 可增加 `sessionModel:{modelRef,source,modelVersion,thinkingLevel}`，由服务端生成并冻结，客户端不提交或修改。thinkingLevel 可为 null。旧准备没有此字段仍按旧协议处理。

## Frontend Action Items

1. 当前桌面已修复：只有 server_ready 阶段可信 HTTP409/code47042 且 reason 为 MODEL_VERSION_CONFLICT/MODEL_UNAVAILABLE，才通过原 claim proof 补发 failed，兼容旧服务端。
2. 新服务端已保存 failed 时，同 reason 的 failed 可幂等完成；遇到47043读取权威收据，确认同 preparationId/deviceId 的 failed 后结束，不盲目重复ready。
3. 网络、5xx、响应丢失、ready成功后本地提交失败继续原核对流程。账号、连接代次或租约失效不能继续发送旧状态。
4. iOS沿用既有failed/reason展示具体错误并保留草稿，刷新后由用户主动重发；无需延长120秒超时或增加新发送参数。本地没有iOS工程，尚待手机验收。
5. 不按模型显示名替换身份。准备后目录或会话配置再次改变仍可能失败；后台目录尚未发布完成时应等待同步、刷新并重新准备，不把冲突当成功执行。

## Auth Requirements

沿用个人 JWT、X-Remote-Device-Credential、连接代次、claimId/claimToken、expectedStatusVersion 和现有 grant 校验；不得从其他账号或旧连接提交结果。

## Notes & Caveats

建议先服务端后桌面发布。旧桌面也能通过新服务端 failed 收敛；新桌面对旧服务端补发 failed，但旧服务端仍可能拒绝历史快照版本。原准备不能自动改版本或换新ID重发。

本次只收敛两类明确模型拒绝，不代表所有409都可终结。服务端没有修改测试库数据，没有执行测试；生产源及测试源编译通过。桌面定向22项测试、变更文件lint、Electron编译通过。完整polling文件中的命令对账计数用例在独立HEAD基线也失败，未修改无关逻辑。

联调需覆盖：历史会话旧版本/目录新版本正常续聊；准备期间目录再变拒绝；网络结果未知；账号切换与取消；手机收到失败原因且草稿保留，无重复命令。服务端完整spec：`docs/specs/mobile-remote-control/bugfix-2026-10-23-input-model-preparation-timeout.md`。
