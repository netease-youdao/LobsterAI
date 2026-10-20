# 远程模型目录展示顺序修复

日期：2026-10-20

## 变更摘要

桌面和服务端曾分别按随机 `modelRef` 排序远程模型目录，导致手机/平板模型顺序与桌面不一致。桌面现在保留本地模型目录顺序，服务端保留上传的 `items` 数组顺序。

本次不新增接口或字段，不改变模型引用、权限、错误码或认证行为。没有 SQL 或数据库迁移，兼容 MySQL 5.7。Portal 和管理员后台无需改动。

## 接口与示例

路径均相对服务端域名：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/remote/v1/devices/{deviceId}/models/publish` | 桌面发布完整有序目录 |
| GET | `/api/remote/v1/devices/{deviceId}/models` | 按发布顺序返回 `data.items` |
| GET | `/api/remote/v1/devices/{deviceId}/input-capabilities` | `data.models` 使用同一目录顺序 |

沿用既有请求头：

```http
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
X-Remote-Projection-Version: 2
Content-Type: application/json
```

发布请求示例（先展示快速，再展示 DeepSeek；引用字符串不决定顺序）：

```json
{
  "publicationId": "ea68718d-1ec8-4431-82d9-7de6463dbdbc",
  "expectedCatalogVersion": "12",
  "connectionGeneration": "current-generation",
  "items": [
    {
      "modelRef": "ref_z",
      "version": "1",
      "source": "subscription",
      "displayName": "快速",
      "providerLabel": "LobsterAI",
      "available": true,
      "unavailableReason": null,
      "inputCapabilities": {"text": true, "image": false, "toolCalling": true},
      "thinking": {"options": [], "default": null}
    },
    {
      "modelRef": "ref_a",
      "version": "1",
      "source": "subscription",
      "displayName": "DeepSeek-V4.1-Flash",
      "providerLabel": "LobsterAI",
      "available": true,
      "unavailableReason": null,
      "inputCapabilities": {"text": true, "image": false, "toolCalling": true},
      "thinking": {"options": [], "default": null}
    }
  ]
}
```

发布响应示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "deviceId": "computer",
    "catalogVersion": "13",
    "publicationId": "ea68718d-1ec8-4431-82d9-7de6463dbdbc",
    "syncedAt": "2026-10-20T04:00:00Z"
  }
}
```

读取目录的 `data` 仍包含 `deviceId`、`catalogVersion`、`lastPublicationId`、`syncStatus`、`syncedAt`、`items`、`serverTime`；其中 `items` 与上述发布请求中的两个条目及其顺序一致。GET 请求无请求体。目录上限仍为 200 项/256 KiB。

## 客户端接入事项

1. 桌面 `RemoteModelCatalog.refresh()` 不再按 `modelRef` 重排。模型 API 数据更新后，主进程重建元数据 Map，远程发布使用更新后的顺序。
2. 目录顺序变化会触发新发布并递增 `catalogVersion`，发送 `catalog.changed(resource=models)`。仅顺序变化不会更换 `modelRef` 或递增单项 `version`，已有模型选择继续有效。
3. 手机/平板按 `source` 分组时保留组内数组顺序，不按随机引用或显示名重新排序。收到目录变化事件后重新拉取；“跟随 Agent 默认配置”等操作项独立展示。
4. 同一发布的重试必须保留原 `publicationId`、`expectedCatalogVersion` 和 `items`（包括顺序）。已有 pending 发布先完成，再用新 publication ID 发布当前顺序。

## 认证与权限

远控接口继续使用 JWT Bearer 和设备凭证，Cookie/session 不能替代。设备归属、空间、远控授权、`model_selection_v1` 能力及当前连接代次校验保持不变。目录可见不代表模型永久可用，选择时继续检查 `available` 和版本。

## 发布与兼容性

- 先完成所有服务端实例升级，再发布桌面版本；手机更新目录缓存后生效。服务端升级本身不会重排已持久化的旧目录。
- 旧桌面可继续调用新服务端，但旧桌面已打乱上传顺序，需要升级桌面后才能恢复。
- 新桌面仍可调用旧服务端，旧服务端会继续重排；慢速目录对账可能再次发布，因此顺序修复需双方升级。
- 服务端兼容旧版本按引用排序计算的发布收据，旧收据重试只返回原结果，不覆盖目录。新发布的幂等校验包含顺序，同 ID 修改顺序仍返回既有 `47006/IDEMPOTENCY_CONFLICT`。
- 不新增功能开关，不修改数据库结构或数据。本次未修改移动 App 源码，需真机确认移动端保留服务端顺序。

完整远控协议见服务端 `docs/api/mobile-remote-input-v2.md`，其中 §2.2 说明本次顺序契约。
