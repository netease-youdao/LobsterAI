# 远控故障隔离接入说明（2026-10-08）

适用：App 接口开发、Electron 接入与服务端发布。本任务不修改手机 App 源码。本轮服务端与 Electron 已实现下述隔离、恢复和有界调度改造；源码交付、测试库迁移、生产发布及手机接入分别核验。完整交付证据见[实施记录](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-10-08-optimization-implementation.md)。

协议与示例见[接口文档](../../../lobsterai-server/docs/api/remote-control-isolation-2026-10-08.md)，全面优化设计见[主 spec](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-10-08-remote-control-optimization-plan.md)。基础字段、状态及错误语义以[mobile-remote-api](../../../lobsterai-server/docs/api/mobile-remote-api.md)为准。

## 1. 变更摘要与状态

| 内容 | 状态 | 消费方影响 |
| --- | --- | --- |
| `independent_subscriptions_v1` / `isolateSessions` | 服务端已实现，是否部署须核验 | App可明确请求逐会话订阅结果；旧订阅保持原批量语义 |
| 旧snapshot局部展示修复争用沿用47014，专用partial read-view | 已实现契约 | 失败范围按会话处理；不能把partial解释为没有待办 |
| HTTP设备份额与原429信封 | 已实现 | 合并刷新并退避，保留草稿和原请求身份 |
| 有效控制索引、operation结果无损压缩 | 已实现并有readiness门禁 | 对外DTO不变；实际启用依赖真实部署证明 |
| 图片沙箱、本地Gateway核对、任务同步恢复、模型摘要版本修复 | 既有桌面修复，详见原实施记录 | 不要求手机同步升级；仍须发布相应桌面构建 |
| RC-01核心隔离、RC-02主线程、RC-05worker、RC-07缓存/容量准入 | **代码已实现，本地验证见实施记录** | 核心权威事实保留；全profile容量与代次退休未完成 |
| RC-03输入隔离、v2部分恢复 | **服务端及Electron已实现，按能力启用** | V112及全writer证明满足后公告；旧v1原子页保留 |
| RC-04激活与联合验收 | **保留既有门禁，真实部署待核验** | capability不能代替每任务active/controlReady |
| source generation/跨代退休 | **后续条件方案，不属首批协议** | 未定义新能力名/端点，不能自行发新字段或重置source版本 |

代码实现和运行验收分别记录；既有执行记录不能替代本轮RC项验收。普通功能开关默认开启；writers/readers-ready、归档证明、授权与执行证据不是普通功能开关，不因上述约定自动视为满足。

## 2. 已实现接口与认证

### 能力发现

```http
GET /api/remote/v1/capabilities
Authorization: Bearer <accessToken>
```

以下为响应中的相关字段节选，不代表完整响应或当前部署必定返回这些能力：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "capabilities": ["independent_subscriptions_v1", "partial_read_view_v1"]
  }
}
```

继续使用原JWT Bearer、owner/scope、设备/grant和连接代次校验。需要设备身份的接口继续传 `X-Remote-Device-Credential: <deviceId>.<deviceKey>`；WS通过原ticket建立，不增加认证旁路。`independent_subscriptions_v1` 是服务端WS能力，不要求与桌面能力取交集。

能力缺失、404或47017时按原协议降级；混部时能力查询与WS可能落到不同节点，不能把一次发现当成全节点支持。能力支持也不等于设备在线或某会话控制已active。

### 按会话独立订阅

沿用原ticket/WS链路。`isolateSessions`是可选布尔字段，只有显式true才使用部分结果；省略或false保留原批量原子准备语义。示例ID仅用于格式说明，实际使用持久会话身份：

```json
{
  "type": "subscribe",
  "requestId": "sub1",
  "catalog": false,
  "isolateSessions": true,
  "sessions": [
    {"sessionId": "session_a", "afterSeq": "12"},
    {"sessionId": "session_b", "afterSeq": "8"}
  ]
}
```

```json
{
  "type": "subscribed",
  "requestId": "sub1",
  "catalog": false,
  "sessions": [
    {"sessionId": "session_b", "afterSeq": "8", "replayThroughSeq": "11"}
  ],
  "failedSessions": [{
    "sessionId": "session_a",
    "code": 47014,
    "reason": "SYNC_IN_PROGRESS",
    "details": {
      "reasonDetail": "DISPLAY_REPAIR_DEFERRED",
      "retryable": true,
      "retryAfterMs": 2000
    }
  }]
}
```

成功仅代表订阅准备成功，事件应用仍需检查seq连续性。`failedSessions`始终为数组；可归属失败不取消成功任务，重复订阅失败也不自动清除其旧订阅/游标。单请求及连接会话订阅数仍不超过5。共享鉴权/DB故障不伪装为部分成功。目录建议独立订阅；`catalog=false`不会取消已有目录订阅。

### 部分读取与原命令

```http
GET /api/remote/v2/sessions/{sessionId}/read-view
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
X-Remote-Projection-Version: 5
```

仅在已有 `partial_read_view_v1` 支持下使用。响应结构与例子见[可靠性扩展](../../../lobsterai-server/docs/api/remote-control-reliability-v1.md)；不要给旧snapshot加header后假定其行为已变为partial。原设备、grant、scope校验保留。

已active、控制事实可信的会话可不依赖完整历史继续原commands API；正常legacy仍按原基线准入。未active且fenced/import进行中/无快照的既有会话，续聊、取消、审批和问题回答仍可能返回原47014；本次没有新增停止旁路。新建另一任务不依赖旧会话历史门禁，但仍需设备、权限及命令准入。

任何partial/resync/429/超时都不授权更换原commandId、publicationId或body/hash，也不证明旧动作未执行。保留原请求和草稿，先查原操作结果；未知执行不显示成确定成功/失败，不因缺少审批展示默认同意。

## 3. App开发者行动项（仅接入文档，不修改源码）

- 目录单独订阅；支持新能力时逐项消费成功/失败结果。旧节点拒绝新字段时去掉字段，按任务分开发旧格式subscribe。只重试受影响会话，遵守连接总订阅数上限。
- requestId关联订阅请求；sessionId关联展示状态。A的resync/47014仅更新A，保留B的订阅、游标、已加载消息与草稿。共享鉴权失效仍按原账户流程处理。
- 成功项检查seq连续性，失败项不得推进ACK。47008/47015重新取目标会话基线；47010按原删除语义；47014按retryAfterMs重试。`decisions.state=partial`不能解释为没有待办。
- 429合并轮询/目录刷新并加抖动退避，沿用原 `47011/RATE_LIMITED`、`details.limitKind="http"`；503按共享依赖退避，不重新登录或批量清空会话。
- 必需图片准备失败沿用既有 `failed / PREPARATION_FAILED`，不能删去图片后当文本命令执行。内部INPUT_UNSUPPORTED不是新增App错误reason。
- 后续UX可区别“历史不完整但控制可用”“该任务执行待核对”“设备远控暂不可用”；只能使用现有可信状态推导，不为本方案自行新增接口字段。未经手机真机验证不记录rendered成功。

手机验收范围待其项目安排：五任务中一个坏历史、初次批量及已建立订阅、读修复锁冲突、共享DB/鉴权失败、断线重连、未知命令结果、旧服务端未知字段回退。本任务不声称手机已完成这些动作。

## 4. Electron已有修复与待实施方案

### 既有修复继续保留

Electron无需消费手机专用订阅能力。继续原capability协商、同ID/hash重放、控制核对与target fencing。图片输入使用独立沙箱renderer；必需输入不满足资源条件时按原失败语义处理。账号fence持续低频恢复；切账号的旧代回调不能释放新账号凭据。局部GC和问题证据恢复不清除原执行账本。

模型目录展示版本变化由桌面推进输入版本，服务端兼容目录刷新与迟到历史且保留严格命令版本校验；已受影响任务的恢复不能换请求身份。详见[模型摘要同步接口及接入说明](../../../lobsterai-server/docs/integration/2026-10-08-remote-input-summary-sync.md)。这些是既有修复事实，并不表示已在所有用户设备发布。

### RC项实施边界

| 工作项 | 实现及后续范围 | 不能采用的捷径 |
| --- | --- | --- |
| RC-01 本地安全核心 | 本地owner/dispatch/删除/决定接口独立于可选远控；optional迁移延后；提交后观察与补扫 | 不捕获坏run/owner/delete后默认放行；不把所有remote_*数据当缓存 |
| RC-02 主线程 | 旁库回填分页、持久cursor；单SQL成本受限；live候选先限量再聚合；避免嵌套core第二写连接 | LIMIT最终结果不代表扫描有界；异步函数包住同步SQL不等于隔离 |
| RC-04 能力激活 | 可观察的协商/基线/核对/active/历史追赶；按会话事实呈现状态 | capability不等于active；ready=false不授权已迁移会话回落旧writer |
| RC-05 worker | 代次、确切child身份、有限前台等待、后台reaper、已确认未发请求释放slot | 超时不等于退出，不能直接busy=false后不断spawn |
| RC-07 本地容量 | 完整计量DB/WAL/索引/缓存/receipt；为已准入请求预留终态空间；最小证据退休 | 不按年龄删除未知operation；已ACK不等于可以删除source revision |

core-only只允许在本地安全核心健康时关闭可选远控；归属未知、已派发结果未知或删除已开始的任务仍需核对。若持有当前boot可信run binding，当前输出可按原run保存；不推导其他坏任务也可自由新建run。

第一批不直接删除revision/tombstone触发器，不重置source/object版本。要移动这些已对外承诺的事实，必须后续设计generation退休与旧writer fence协议，先服务端兼容再客户端启用。当前没有新增generation端点或能力名。

图片/网络退出未知时前台请求应有限时返回组件不可用，后台继续有界观测；没有精确退出证明不能启动第二个同类writer。没有退出证明时允许保持明确受限，不能承诺任意OS挂起均自动恢复。

### RC-03 输入准备与恢复（已实现，按能力启用）

服务端新增 preparation 完整性证明、坏对象隔离和持久公平 claim。旧 `GET /api/remote/v1/devices/{id}/input-preparations` 保留原子页语义，失败不能当空清单；claim.items仅代表实际领取工作，不证明历史核对完成。

发现 `isolated_input_recovery_v1` 后，Electron独立恢复lane调用 `GET /api/remote/v2/devices/{id}/input-preparations`，沿用Bearer、设备凭据并提供当前 `X-Remote-Connection-Generation`。响应为健康 `items`、可信归属 `unresolvedItems`、不透明 `nextCursor` 和 `scanComplete`；完整例子见[API §7.4](../../../lobsterai-server/docs/api/remote-control-isolation-2026-10-08.md#input-recovery-v2)。输入schema v2与恢复接口版本不同，不改变App发送入口。

恢复每轮20项，服务端游标有效期900秒；47008过期或47019游标失效时保留本地未决并重新扫描。能力缺失或明确404/47017不支持时走旧v1恢复；共享鉴权/500/超时仅退避，不按版本问题重发。协议版本/连接/账号/target变化时重新开始对应读取游标，不废弃准备、命令或资产证据。恢复失败不阻断独立健康claim及正式commands。

`scanComplete`和页末只结束扫描，不清inbox、执行账本、草稿或历史未决。Electron将诊断按target/owner/device/preparation持久保存，最多200项，满额只暂停该恢复lane新增诊断。已有ready仅在原manifest、request/resolved hash、归属、target、device、bound关系与期限可核对后确认；terminal或缺manifest保守保留，不从枚举重建输入或获得新执行许可。服务端不会自动修复坏字节或解除blocked，TTL、缺项、重启均不是修复证明。


## 5. 发布、兼容与回滚

原路径、字段类型/语义、错误码、JWT/设备凭据、owner/scope、grant与连接代次均保持。新增协议必须能力协商或新增版本，旧Portal/App/Electron继续原接口。首批RC-01/02/05/07内部优化不要求手机升级或新数据库迁移；后续退休协议另行增量设计。

既有存储发布顺序：先核对实际schema，再增量迁移；部署所有兼容reader/writer/reconciler/GC；真实证明满足后才公告相关能力或压缩/退休。V110/V111兼容MySQL5.7、无外键。不得直接重复执行已存在列/索引的ALTER，不把测试环境验证当生产部署完成。

部署证明：

- `REMOTE_INPUT_INTEGRITY_WRITERS_READY`：V112及全部claim/result/bind/reconciler/GC理解隔离证明；普通`REMOTE_INPUT_INTEGRITY_ENABLED`默认true，writer证明默认false。
- `REMOTE_AVAILABILITY_WRITERS_READY`：现有独立控制所需writer/fence部署证明；未满足不伪装控制已active。
- `REMOTE_OPERATION_RECEIPT_COMPRESSION_READERS_READY`：所有reader/reconciler/GC支持压缩存储；关闭只暂停新压缩，已有压缩仍能读取。
- `REMOTE_CONTROL_COVERAGE_READERS_READY`：所有读取、核对、GC及历史分片核验节点理解已覆盖committed行退休；旧checkpoint writer证明不能代替。

这些证明默认false且由实际清单决定。普通功能开关默认true；观察/暂停须显式覆盖。已经写入新事实后只能回滚到理解它的构建；关闭功能不停止原operation查询、核对、完成/abort，不恢复已删除正文，也不允许旧writer重新获得授权。

新旧组合验收：旧桌面+新服务端保持原ACK/重放；新桌面+旧服务端不发送未协商字段；新服务端+旧App保留原snapshot/命令/WS；混部不同节点返回能力不一致时按原兼容分支处理。健康历史缺失不影响控制的结论只适用于原准入已满足的会话。

## 6. 验收与交付记录

RC项的完整故障注入矩阵、性能目标与关闭证据见[主spec](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-10-08-remote-control-optimization-plan.md)。至少覆盖optional DDL失败、核心安全事实损坏、新旧库迁移中断、A坏历史且B/C健康、worker退出未知/迟到、长期receipt增长、配额临界保存终态、已激活后ready关闭及迟到写重放。关闭需要代码评审、适用验证记录、混部/恢复证据与文档同步，不能仅凭编译通过。

历史执行记录继续有效：V109的历史测试执行不覆盖V110/V111；[测试库V110/V111执行与复核](../../../lobsterai-server/docs/operations/2026-10-08-test-v110-v111.md)已独立记录，生产未执行。既有服务端交付以编译/Mapper校验/打包记录为准，未执行服务端测试。它们不替代本方案的规模、真实故障与手机真机验收。

**本轮已修改服务端和桌面代码，没有修改手机源码。** 测试库V112/V113已执行并复核，生产未部署。客户端定向回归、编译/静态检查、服务端编译/Mapper/打包结果与剩余容量/真机/混部验收见[本轮实施记录](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-10-08-optimization-implementation.md)；服务端测试未执行。
