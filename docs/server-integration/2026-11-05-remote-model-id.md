# 远程模型目录公开模型 ID（2026-11-05）

2026-11-13 文档补充：[手机选择列表倍率与订阅优先接入](../../../lobsterai-server/docs/integration/2026-11-13-mobile-model-multiplier.md)明确倍率数据源、虚拟预设能力、0／限免、订阅优先徽标及缓存规则。本轮仅核对源码和补文档，不改 App 或协议，未测试、未部署、未完成真机验收；下方旧验证记录保持原日期含义。

## 变更摘要

远程模型目录增加可选 `modelId`，供手机 App 以公开业务模型 ID 查找配置服务中的图标和展示倍率。`modelRef` 继续是桌面按账号、空间、设备及同步目标隔离的随机引用；模型选择和执行始终使用 `modelRef + version`。本次不修改手机 App 源码、Portal、Admin 或数据库。

桌面直接从自定义配置的 `model.id`、服务端模型元数据的 `model.modelId` 取值，保留渠道后缀和大小写。快速／旗舰分别发布 `yd-fast`／`yd-ultra`，不替换成底层实际执行模型。`modelId` 不是数据库数字主键、供应商配置、内部 `runtimeRef` 或执行授权。

## 接口与能力协商

### `GET /api/remote/v1/devices/{deviceId}/models`

沿用现有认证与成功响应包装，新服务端在 `data` 顶层返回：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "deviceId": "pc_01",
    "catalogVersion": "3",
    "capabilities": ["model_display_id_v1"],
    "items": [{
      "modelRef": "556f725b-57f9-41e1-a014-6d1dad41ec2c",
      "version": "2",
      "source": "subscription",
      "modelId": "deepseek-flash-YoudaoInner",
      "displayName": "DeepSeek Flash",
      "providerLabel": "LobsterAI",
      "available": true,
      "unavailableReason": null,
      "inputCapabilities": {"text": true, "image": false, "toolCalling": true},
      "thinking": {"options": [], "default": null}
    }]
  }
}
```

例子只列本次相关响应字段；其他既有字段保持不变。能力通过本目录 GET 协商，不增加桌面注册能力，不改变 `input_schema_v2`。

### `POST /api/remote/v1/devices/{deviceId}/models/publish`

请求头沿用 JWT Bearer、远程设备凭据及账号／空间上下文。请求体仍为：

```json
{
  "publicationId": "ce98035e-5135-4591-87b3-f4f893d78a40",
  "expectedCatalogVersion": "3",
  "connectionGeneration": "12",
  "items": [{
    "modelRef": "556f725b-57f9-41e1-a014-6d1dad41ec2c",
    "version": "2",
    "source": "subscription",
    "modelId": "deepseek-flash-YoudaoInner",
    "displayName": "DeepSeek Flash",
    "providerLabel": "LobsterAI",
    "available": true,
    "unavailableReason": null,
    "inputCapabilities": {"text": true, "image": false, "toolCalling": true},
    "thinking": {"options": [], "default": null}
  }]
}
```

成功回执、错误码和 CAS 行为不变。缺少 `modelId` 的条目继续接受并保持字段缺失，不补 `null`；显式非法 `modelId` 按原非法输入错误拒绝。服务端对完整条目计算 hash，因此显示字段变化也需要递增单项 `version`。

## 桌面行动项与兼容性

1. 发布前使用现有目录 GET 检查 `capabilities`。仅明确含 `model_display_id_v1` 才带 `modelId`。旧服务端无能力字段时，保持旧条目形状。
2. 目录发布器持久化已协商能力。能力升级或回退改变公开条目时递增 `version`，保留 `modelRef`。重连立即重新检查；无变化时按既有五分钟周期复查，升级无需修改模型配置。
3. 未确认的发布请求保持原 `publicationId`、`expectedCatalogVersion` 和 `items` 不变。服务端升级时先完成旧 pending 发布，下一次发布补充 ID。服务端回退时先读取回执：已确认的 pending 正常认领；若服务端明确不支持新增字段且未确认的 pending 含 `modelId`，废弃该 pending，以新 `publicationId`、当前目录 CAS 版本及更高单项版本重新发布旧形状。不得修改同一发布 ID 的 payload。CAS 冲突继续重拉目录恢复。滚动混部期间若 GET 声称支持、POST 却精确返回 HTTP 400 / code=47019 / `Unknown request field`，且本次请求确实带 `modelId`，将该目录的展示 ID 暂停五分钟：退休已明确拒绝的发布 ID，下轮重新 GET 后以新发布 ID 和更高单项版本发送旧形状；窗口内不采信新节点的能力声明。超时、权限失败、CAS 冲突及其他非法输入错误不触发降级或丢弃 pending。
4. 不向 `session.inputModel`、`message.inputModel`、`resolvedInput.model` 展开新增字段。这些摘要仍走既有白名单；回复的实际执行模型与输入选择的预设模型可能不同，不能用当前目录重写历史消息图标。
5. 本地完整私有配置继续参与变更指纹；凭据、地址、权限或能力变化仍使旧选择失效。公开展示字段不参与授权，也不能代替 `modelRef` 发起选择。

## App 接入要点

- 倍率使用同服务环境、同账号及个人／企业上下文的 `GET /api/models/available`（正常 JWT，data 为数组，不要求远控设备凭据），只对 `source=subscription` 按完整 modelId 唯一精确匹配；不改大小写、剥渠道或按名称／modelRef 猜测。custom 不套同名平台价，缺 ID／重复匹配／请求失败／null 时隐藏未知倍率，不补 x1。图标仍可按公开 ID 映射，缺失用通用图标。
- costMultiplier 必须为有限非负数字，0 不是缺值；值 >0、存在 presetId 或 limitedFreeActive===true 时显示 x 两位小数，限免只认 limitedFreeActive。合法 0 不等于请求必然免费；倍率只用于当前选择列表，不回填历史成本或赋予选择权限。保留远控顺序、available 和 modelRef/version，实际计费以服务端为准。
- 快速／旗舰使用 yd-fast／yd-ultra 自身的 available 加权倍率，不用静态 displayCost 或具体模型代替。请求需 virtual-models-v1，精确候选池还受目标执行能力影响，例如 kimi-k3-agentic-v1；不能为查倍率盲目宣称能力或保证简化头部与任意桌面相同。公共 pricing-catalog 不完整覆盖员工／预设，不作默认补缺。
- 打开选择页刷新 available，缓存按环境、账号、scope、能力集合隔离，远控目录另按设备／版本隔离；上下文变化丢弃旧在途结果。完整请求示例、显示条件、目标能力匹配及验收见[11 月 13 日 App 指南](../../../lobsterai-server/docs/integration/2026-11-13-mobile-model-multiplier.md)。
- 订阅优先复用同一次 available 查询和 subscription 完整 modelId 唯一精确匹配；仅 subscriptionPriority===true 显示金色钻石＋「订阅优先」，提示「仅限有效订阅用户使用」。false／null／缺失／非法类型或匹配失败隐藏，custom 不套用；不从 Highspeed 名称、倍率、付费状态猜测，预设不继承候选标记。倍率 null／非法不影响 true 徽标，限免和订阅优先可同时显示；不重排、不解锁，保持原 remote.available 和准备／执行校验。无需向 remote 严格白名单新增字段，标签沿用同源同上下文缓存与开页刷新；见[指南 §2.1](../../../lobsterai-server/docs/integration/2026-11-13-mobile-model-multiplier.md#21-订阅优先徽标)。App 待接入，本轮未现场验证。
- 仍按设备隔离缓存目录并使用 `modelRef + version` 保存选择。旧桌面发布的目录不含 `modelId`，升级服务端无法反推该字段。
- 详细手机 API 与服务端接入约定见 `lobsterai-server/docs/api/mobile-remote-input-v2.md` 和 `lobsterai-server/docs/integration/2026-11-05-remote-model-id.md`。

## 安全和发布说明

允许 ID 为 1–200 个 ASCII 字符，匹配 `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$`，并拒绝 `://`、不区分大小写的 `localhost`、IPv4 片段或 `sk-[A-Za-z0-9]`。不 trim、截断、拆解或猜测原值。本地遇不安全 ID 只省略字段，不阻塞目录；服务端拒绝显式非法值且不记录原值。不得上传 API key、baseURL、token 或内部 runtimeRef。

优先上线兼容服务端，再升级桌面和消费字段的 App；新桌面连接旧服务端会自动省略字段。保留原 JWT、设备归属、空间隔离、连接代次、目录版本及输入版本校验；不新增数据库字段，兼容 MySQL 5.7。配置服务负责图标和倍率的展示映射，本次未变更其配置内容或实际计费规则。


## 验证记录

在仓库外暂存副本中使用 Node `v24.17.0`：

- 六个相关 Vitest suite 共 155 项通过：`remoteModelCatalog`、`remoteInputModels`、`sessionCommandService.input`、`remoteReplyModel`、`remotePresetInput`、`remoteInputProjection`。覆盖旧服务、能力升级／回退、混部拒绝后的有限降级、不可变 pending、版本变化、不安全 ID 省略、凭据变更及现有输入／回复摘要。
- `tsc --project electron-tsconfig.json` 通过，与 `npm run compile:electron` 使用同一编译配置。
- 五个变更 TypeScript 文件的 ESLint 通过，`--report-unused-disable-directives --max-warnings 0`。
- 未启动 Electron 做真机联调；未执行服务端测试。部署后需验证手机配置映射及图标／倍率兜底展示。
