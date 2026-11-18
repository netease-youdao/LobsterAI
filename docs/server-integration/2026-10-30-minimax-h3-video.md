# MiniMax-H3 视频生成模型接入

## 1. Change Summary

lobsterai-server 新增视频模型 `MiniMax-H3`（MiniMax V2 API，`/v2/video_generation`），沿用现有媒体生成接口，无新增接口、无字段变更：

- 模型列表：`GET /api/media/videos/models` 返回新增 `modelId = "MiniMax-H3"`
- 生成：`POST /api/media/videos/generate` 或 `POST /api/media/v2/tasks`（durable）
- 查询 / 取消：沿用 `/api/media/videos/tasks/{taskId}`、`/api/media/v2/tasks/{taskId}`

支持文生视频、首帧/尾帧/首尾帧图生视频、多模态参考生视频（参考图 ≤9、参考视频 ≤3、参考音频 ≤3）；分辨率 768P/2K，时长 4-15 秒。

新计费单位 `per_second_io`：

| 分辨率 | 输出视频 | 参考视频输入 | 输入图片 |
|---|---|---|---|
| 768P | 50 积分/秒 | 50 积分/秒 | 前 5 张免费，之后 20 积分/张 |
| 2K | 80 积分/秒 | 80 积分/秒 | 同上 |

参考音频免费。提交时按参数预扣（含参考视频但未给时长时按 15 秒预估），任务成功后按上游 `usage.output_seconds / input_seconds / input_image_count` 结算多退少补。

## 2. Endpoint Details

请求参数沿用客户端现有 `lobsterai_video_generate` 工具的字段：

```json
{
  "model": "MiniMax-H3",
  "prompt": "一只猫在雨中奔跑",
  "params": {
    "durationSeconds": 5,
    "resolution": "768P",
    "aspectRatio": "16:9",
    "watermark": false
  }
}
```

素材字段与 H3 `content[].role` 的映射：

| 客户端参数 | H3 role |
|---|---|
| `firstFrame` | `first_frame` |
| `lastFrame` | `last_frame` |
| `images` + `imageRoles` | 按 `imageRoles`；未指定角色时，有参考素材则为 `reference_image`，否则依次为首帧、尾帧 |
| `referenceImages` | `reference_image` |
| `videos` / `video` | `reference_video` |
| `media[]`（`{type:"audio_url", audio_url:{url}}` 等原生 content 项） | 原样角色；音频默认 `reference_audio` |

素材地址支持 HTTP(S)、`data:<mime>;base64,...`、`mm_file://`。

服务端预校验（预扣积分前返回 `INVALID_PARAMETER`）：

- prompt 非空且 ≤ 7000 字符
- 首尾帧与参考素材（图/视频/音频）不能混用
- 首帧、尾帧各 ≤1；参考图 ≤9；参考视频 ≤3；参考音频 ≤3
- 文生视频不能使用 `aspectRatio = "adaptive"`；未传时默认 `16:9`；有素材时未传则用上游默认 `adaptive`
- 分辨率仅 `768P` / `2K`（大小写不敏感）
- 所有素材字符串合计超过 ~63 MB（上游请求体上限 64 MB）时拒绝

## 3. Frontend Action Items

本次客户端改动（分支 `feat/minimax-h3-audio-reference`，基于 `release/2026.10.26`）：

- `src/main/main.ts`：本地文件转 data URL 的 `MEDIA_MIME` 新增 `.mp3 → audio/mpeg`、`.wav → audio/wav`。此前本地音频会被编码为 `application/octet-stream`，H3 要求 `data:audio/<format>`，会被上游拒绝。

无需其他改动：

- 模型选择器、参数说明来自 `/models` 返回的 `parameterSpec` / `capabilities`；图标已由 `/minimax/i` 匹配。
- `src/shared/media/videoCreditEstimate.ts` 已支持 `per_second_io`：纯文生视频估算为 `单价 × 时长`，有图片/视频输入时不给出总价估算，结算以服务端为准。

## 4. Auth Requirements

与现有媒体生成接口一致：Electron 使用 `Authorization: Bearer <accessToken>`（JWT）。

## 5. Notes & Caveats

- 向后兼容：旧版客户端无需升级即可使用 H3 文生视频、图生视频和参考视频；只有通过本地 mp3/wav 文件做参考音频时需要本次客户端改动（远程 URL 不受影响）。
- 客户端允许最大 50 MB 的本地视频，但 base64 后约 67 MB，会超过 H3 的 64 MB 上限，服务端会提示改用素材链接。
- 上游视频下载链接有时效，服务端成功后沿用现有生成视频转存流程。
- 未接入 H3-Highspeed / Lite / Max、H3-Context-IR 和视频再生成。
