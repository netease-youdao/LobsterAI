# Doubao-Seedream-5.0-pro 图片模型

## Change Summary

lobsterai-server 新增 Doubao-Seedream-5.0-pro 图片模型配置，并新增媒体计费单位：

- `doubao-seedream-5-0-pro-260628`
- `billingUnit=per_image_io`
- 输入图首张免费，超出部分按 `0.02 元/张` 计费
- 输出图按像素分层计费：`≤236万像素 0.30 元/张`，`>236万像素 0.60 元/张`

## Endpoint Details

### 获取图片模型

```http
GET /api/media/images/models
Authorization: Bearer <accessToken>
```

返回值仍为 `MediaModelDTO[]`。新模型的 `pricing` 中会包含：

```json
{
  "billingUnit": "per_image_io",
  "inputCostYuan": 0.02,
  "freeInputImageCount": 1,
  "unitLabel": "张输出图",
  "tiers": [
    {"label": "输出图≤236万像素", "outputPixelsMax": 2360000, "outputCostYuan": 0.3},
    {"label": "输出图>236万像素", "outputPixelsMin": 2360001, "outputCostYuan": 0.6}
  ]
}
```

### 生成图片

```http
POST /api/media/images/generate
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "model": "doubao-seedream-5-0-pro-260628",
  "type": "i2i",
  "prompt": "保持人物和背景风格，对主体位置做轻微调整",
  "params": {
    "images": ["https://example.com/input.png"],
    "n": 1,
    "size": "2K",
    "watermark": false
  }
}
```

成功响应沿用现有同步图片生成 `MediaTaskResponse`，`resultUrls` 为图片 URL。

## Frontend Action Items

- 图片模型列表以 `GET /api/media/images/models` 为准，客户端不要硬编码模型枚举。
- 计费展示需要识别 `billingUnit=per_image_io`：展示输入图价格和输出图分层价格，而不是只展示单一按张价格。
- 参考图继续传 `params.images`、`params.referenceImages`、`params.imageUrls` 或 `params.image/imageUrl`；后端会按上游实际输入图张数抵扣首张免费后计费。
- 输出张数继续使用 `params.n` 或 `params.count`。
- 输出像素分层以后端扣费结果为准。后端会优先使用上游返回的实际 `data[].size`，没有实际尺寸时才用请求 `params.size` 预估。

## Auth Requirements

- 需要 Electron JWT Bearer token。
- 当前模型为公开可见图片模型，不额外要求 internal/OpenID。

## Notes & Caveats

- 后端按预估请求参数先扣费，同步生成成功后按上游返回的实际用量和 `data[].size` 重新计算并调账；输入图按首张免费抵扣。
- 当前计费公式为 `max(0, 输入图张数 - 1) * 2 credits + 输出图张数 * 输出图分层单价 credits`；`≤236万像素` 为 30 credits/张，`>236万像素` 为 60 credits/张。
- 如果客户端只依赖 `unitCredits`，默认 `size=2K` 表示 1 张输出图的 60 credits；完整费用仍应以后端扣费结果为准。
