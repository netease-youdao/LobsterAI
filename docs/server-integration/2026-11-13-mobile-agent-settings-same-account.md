# 手机 Agent 设置：同账号访问与桌面自动同步

日期：2026-11-13。适用项目：LobsterAI 桌面客户端、手机 App 接入方。本次不修改手机 App、Portal 或 Admin 源码，不执行数据库迁移或服务端测试，也不表示已部署或完成真机联调。

## 变更概述

同一账号的手机完成既有远控连接后，即可查看和管理当前电脑上本人可管理的 Agent。新版桌面移除“手机上的 Agent 设置”中的手机选择、Agent 选择、权限勾选和授权按钮，自动维护有效同账号访问。无需额外的逐手机/Agent 设置授权。

模型和多 Agent 协作继续直接保存；身份、记忆、关于你继续只读，并通过同目标会话修改，具体文本变更的会话审批保留。主助手 main 使用当前电脑共享配置，须如实展示共享语义；非 main 仍要求当前账号真实归属，匿名和他人 Agent 不开放。

内部 binding/version/accountEpoch、设备凭据、远控控制 grant、连接版本及设置操作许可继续用于身份隔离、防重放和断网恢复。正文只在实际请求时读取，不在登录或同步绑定时批量上传。

服务端仅扩展两个桌面只读列表的可选分页，解决手机与 Agent 组合超过单页上限时的漏同步、反复撤销和重建。设置操作与手机接口契约不变。完整契约见[服务端 API](../../../lobsterai-server/docs/api/mobile-agent-settings-v1.md)，手机页面接入见[服务端接入说明](../../../lobsterai-server/docs/integration/2026-11-05-mobile-agent-settings.md)。

## 接口与认证

基础路径 `/api/remote/v1`，继续使用以下头：

```http
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <callerDeviceId>.<deviceKey>
X-Remote-Data-Space-Id: <dataSpaceId>
X-Remote-Data-Generation: <dataGeneration>
```

owner/scope 从认证派生；手机使用手机凭据，桌面列表与 settings-access 必须使用目标电脑自身凭据。Cookie 不能代替 Bearer，不允许请求体伪造 userId、手机来源或归属。

| 调用者 | 接口 | 本次调整 |
| --- | --- | --- |
| 桌面 | `GET /devices/{d}/agent-settings-access-candidates?cursor=...` | 可选 cursor；每页最多返回 100 个候选，增加 nextCursor |
| 桌面 | `GET /devices/{d}/agent-settings-access?agentId=...&cursor=...` | 可选 cursor；每页最多 200 个 active 绑定，agentId 先过滤再分页，增加 nextCursor |
| 桌面 | `POST /devices/{d}/agents/{a}/settings-access` | 请求/响应不变，由桌面自动同步替代用户逐项确认 |
| 手机 | `GET /devices/{d}/agents/{a}/settings-capabilities` | 不变，继续返回绑定、分区能力与不可用原因 |
| 手机 | `POST /devices/{d}/agents/{a}/settings-operations` | 不变，继续提交 read 或 model/collaboration update |
| 手机 | `GET /agent-settings-operations/{operationId}` | 不变，只根据真实回执判断完成 |

两个 GET 均无请求体。省略 cursor 保持原首屏行为；新增 nextCursor 为字符串或 null。示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "items": [
      {
        "mobileDeviceId": "mobile_01",
        "name": "我的手机",
        "grantId": "grant_01",
        "grantVersion": "3"
      }
    ],
    "nextCursor": "opaque-cursor",
    "serverTime": "2026-11-13T02:00:00.000Z"
  }
}
```

候选接口每页扫描最多 100 个 grant 后过滤失效手机/非控制资格；绑定接口每页扫描最多 200 个 active 绑定后跳过历史 dataSpaceId/dataGeneration 的记录。两者都可能返回少量或空 items 但仍有 nextCursor，游标按原始扫描页推进，以 nextCursor 是否为 null 判断结束。历史目标过滤仅用于列表发现，实际操作仍严格校验数据目标。游标是最长 4096 字符的不透明认证密文，原样 URL 编码后用于下一页，不解析或自行生成。它绑定账号/身份空间、调用设备、目标电脑、agentId 筛选、数据空间/代次和列表类型，不能跨条件复用。非法游标返回既有 HTTP 400 / code=47019 / `INVALID_REMOTE_REQUEST`。

绑定列表响应的 item 仍为：

```json
{
  "bindingId": "binding_01",
  "bindingVersion": "1",
  "mobileDeviceId": "mobile_01",
  "agentId": "main",
  "grantId": "grant_01",
  "grantVersion": "3",
  "accountEpoch": "8",
  "sections": {
    "model": {"read": true, "directUpdate": true, "conversationUpdate": false},
    "collaboration": {"read": true, "directUpdate": true, "conversationUpdate": false},
    "identity": {"read": true, "directUpdate": false, "conversationUpdate": true},
    "memory": {"read": true, "directUpdate": false, "conversationUpdate": true},
    "userProfile": {"read": true, "directUpdate": false, "conversationUpdate": true}
  },
  "status": "active"
}
```

所有版本号和 epoch 保持十进制字符串，bindings 不包含正文。会话工具未就绪时三类文本的 conversationUpdate 为 false。原生模板只读、Agent 忙、revision 冲突等执行限制继续保留。

自动发布复用现有 POST 请求，Agent 来自路径，数据目标来自请求头：

```json
{
  "requestId": "b59e4880-4daa-4e36-a4f2-4b1461275bdb",
  "connectionGeneration": "current-generation",
  "mobileDeviceId": "mobile_01",
  "grantId": "grant_01",
  "grantVersion": "3",
  "accountEpoch": "8",
  "sections": {
    "model": {"read": true, "directUpdate": true, "conversationUpdate": false},
    "collaboration": {"read": true, "directUpdate": true, "conversationUpdate": false},
    "identity": {"read": true, "directUpdate": false, "conversationUpdate": true},
    "memory": {"read": true, "directUpdate": false, "conversationUpdate": true},
    "userProfile": {"read": true, "directUpdate": false, "conversationUpdate": true}
  }
}
```

成功 data 为上述绑定对象。重复发送保留原 requestId 与完整请求；不同内容不可复用同一 ID。手机不得调用这个桌面内部接口。

## 桌面与 App 行动项

1. 桌面读取完整分页后，对照本地持久记录、当前 owner/scope、真实 Agent 归属和有效控制 grant 自动同步合法分区权限。每轮每个列表最多读 5 页、最多提交 5 次绑定变更，分页未读完时留待后续轮次，完整读完后才对账。未变化或普通 WS 重连复用有效绑定，不因轮询重建而使在途请求失效。云端出现未知绑定不等于本地可直接信任。
2. 退出、切账号/身份空间/环境、暂停远控和移除电脑继续先冻结访问并递增 epoch。切回账号只能建立当前身份的新绑定，不能恢复旧请求的执行资格；已产生副作用的未知操作继续原 settle 流程。
3. 手机仍先确认服务端和电脑的 `agent_settings_v1`，再按各分区能力决定按钮。没有新增必填字段；bindingId/version/accountEpoch 继续取 capabilities 响应，不允许自行合成。
4. `LOCAL_AUTHORIZATION_REQUIRED` 仍代表没有可用设置绑定。新版桌面下展示“正在连接电脑，请稍后刷新”，有界刷新能力；持续失败检查电脑连接或升级，不引导用户寻找已删除的授权按钮。旧桌面保留原手工授权兼容行为，未支持设置能力的旧版本提示升级。
5. 手机读取/保存与会话修改流程不变。模型/协作只有真实 applied 才显示成功；身份/记忆/关于你仍按具体修改展示会话审批。退后台、切身份/环境/设备或访问失效立即清理正文缓存。

## 兼容与发布

建议先发布服务端分页增量，再升级桌面。服务端新参数可选，响应只增加 nextCursor；旧客户端仍可取原首屏并沿用旧字段。旧桌面的手工授权流程、旧 grant permissions、旧设置操作类型/状态、错误码与认证行为均保留。

已支持 `agent_settings_v1` 但尚无分页的旧服务仍可处理原设置操作。新版桌面遇到缺 nextCursor 的列表将其视为不完整，不能将未出现在首屏的记录判为撤销；特别是满页不允许当完整快照。实际操作仍由服务端复验有效 grant/绑定/epoch。完全不支持设置能力的旧服务保持既有远控功能，提示升级后再使用 Agent 设置。

无新表、字段、索引、外键或数据回填，不重复执行 V132；分页使用兼容 MySQL 5.7 的普通查询。`remote-control.agent-settings.enabled` 默认 true，现有 schema/密钥/运行时准备条件继续校验，不因免手工授权而跳过。

发布验证应覆盖：首次同账号连接自动可用、多个手机/Agent、超过 100 候选与 200 绑定、过滤后的空页仍有下一页、旧服务无 nextCursor、账号切换/撤销后迟到请求、匿名/他人 Agent 拒绝、文本直接 update 拒绝，以及具体会话审批与回执恢复。本次文档不宣称上述真实跨端验收已经完成。
