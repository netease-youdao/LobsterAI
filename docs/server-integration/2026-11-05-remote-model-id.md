# 远程模型目录公开模型 ID（2026-11-05）

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

- 可用 `modelId` 原值在配置服务映射 icon 和展示倍率；保留公开 ID 的完整渠道后缀。缺字段、未知 ID 或图标加载失败使用默认图标，展示倍率缺失时隐藏或采用明确的默认展示，不能阻塞选择和发送。
- 展示倍率只是 UI 配置，不代表实际扣费。须结合 `source` 区分套餐与自定义模型；同名 `source=custom` 不能继承套餐倍率或套餐计费含义。实际计费、权益和用量以服务端权威结果为准。
- 快速／旗舰使用 `yd-fast`／`yd-ultra` 的图标。不要把模型显示名称或 `providerLabel` 当稳定 ID；不要把图标映射结果当作可执行模型。
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
