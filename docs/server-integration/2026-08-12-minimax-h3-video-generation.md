# MiniMax-H3 视频生成接入

## Change Summary

`lobsterai-server` 新增 `MiniMax-H3` 视频模型配置，并通过 MiniMax V2 视频接口提交、查询和取消任务。支持文生视频、首帧/尾帧/首尾帧图生视频，以及参考图片、视频、音频的多模态参考生视频。

本次不接入 H3-Context-IR，也不调用 `/v2/h3_context_ir`。MiniMax-H3 直接调用 `/v2/video_generation`。

计费按 MiniMax 官方按量价格折算（1 元 = 100 积分）：

- 768P：50 积分/输出秒；2K：80 积分/输出秒。
- 参考视频输入时长按所选输出分辨率的同档秒价计费。
- 输入图片前 5 张免费，超过部分 20 积分/张。
- 输入音频免费。
- 提交时按请求参数预扣；任务成功后按 MiniMax 查询结果中的 `usage.output_seconds`、`usage.input_seconds` 和 `usage.input_image_count` 对账。

## Endpoint Details

### 获取视频模型

`GET /api/media/videos/models`

响应中的 `MiniMax-H3` 项会包含动态定价和参数约束：

```json
{
  "code": 0,
  "message": "success",
  "data": [
    {
      "modelId": "MiniMax-H3",
      "displayName": "MiniMax-H3",
      "mediaType": "video",
      "unitLabel": "秒",
      "pricing": {
        "billingUnit": "per_second_io",
        "freeInputImageCount": 5,
        "inputImageCostYuan": 0.2,
        "tiers": [
          { "resolution": "768p", "costYuan": 0.5 },
          { "resolution": "2k", "costYuan": 0.8 }
        ]
      }
    }
  ]
}
```

### 创建任务

`POST /api/media/videos/generate`

```json
{
  "model": "MiniMax-H3",
  "type": "r2v",
  "prompt": "保持人物外观，跟随参考视频完成动作",
  "params": {
    "resolution": "2K",
    "durationSeconds": 6,
    "aspectRatio": "16:9",
    "referenceImages": ["https://cdn.example.com/character.png"],
    "videos": ["https://cdn.example.com/motion.mp4"],
    "audios": ["https://cdn.example.com/voice.mp3"],
    "aigc_watermark": false
  }
}
```

成功响应仍为现有任务结构：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "taskId": 123,
    "upstreamTaskId": "424010985738629",
    "model": "MiniMax-H3",
    "type": "r2v",
    "status": "processing",
    "progress": 0
  }
}
```

参数要点：

- `durationSeconds`：4–15 的整数。
- `resolution`：`768P` 或 `2K`。
- 纯文生视频必须传具体 `aspectRatio`；可选 `21:9`、`16:9`、`4:3`、`1:1`、`3:4`、`9:16`。
- 首尾帧模式使用 `firstFrame` / `lastFrame`，比例由图片决定。
- 多模态参考模式使用 `referenceImages`、`videos`、`audios`；不能与首尾帧模式混用。
- 客户端也可通过现有 `images` + `imageRoles`、`media` 或 `providerOptions.media` 传递角色化素材。

### 查询和取消

- `GET /api/media/videos/tasks/{taskId}`：查询状态和结果；成功时 `resultUrls` 包含视频 URL。
- `POST /api/media/videos/tasks/{taskId}/cancel`：仅排队中的 MiniMax-H3 任务可由上游取消；运行中的任务不能取消。

## Frontend Action Items

- 模型列表必须动态读取 `/api/media/videos/models`，不要在客户端写死 H3 单价。
- 视频工具需允许 `2K`、4–15 秒和参考音频输入。
- 提交前的积分提示按服务端 `pricing.billingUnit = per_second_io` 计算；无法获得动态定价时，不展示旧的“100 积分/秒”作为 H3 价格。
- 保持现有任务轮询和结果下载流程，无需新增 H3 专用客户端端点。

## Auth Requirements

- `/api/media/videos/models` 可公开读取。
- 创建、查询、取消任务均使用客户端现有的 JWT Bearer 登录态：`Authorization: Bearer <accessToken>`。
- 用户只能操作自己的任务；额度预扣和成功后的实际对账均由服务端完成。

## Notes & Caveats

- 上线顺序：先部署包含数据库迁移的服务端，再发布客户端。
- MiniMax 返回的下载链接有时效性，客户端继续提示用户及时保存。
- H3-Context-IR 与视频再生成 API 均不在本次范围内。
- 单个请求的素材格式、大小、数量和总时长还必须符合 MiniMax 官方 V2 接口限制。
