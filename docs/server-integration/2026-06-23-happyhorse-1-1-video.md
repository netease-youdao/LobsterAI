# HappyHorse-1.1 Dynamic Video Model

## Change Summary

lobsterai-server adds one logical admin-configured video model, `HappyHorse-1.1`, backed by three Aliyun HappyHorse 1.1 upstream submodels. The server chooses the concrete upstream model dynamically from image input count:

- no input images -> `happyhorse-1.1-t2v`
- one input image -> `happyhorse-1.1-i2v`
- multiple input images -> `happyhorse-1.1-r2v`

The concrete upstream model and selection reason are returned in task responses so tool-call output can show what was used and why.

## Endpoint Details

### List Video Models

`GET /api/media/videos/models`

No auth required. The response includes a single `HappyHorse-1.1` model entry for admin/client presentation. Clients should not expose the three upstream submodel IDs as separate selectable models.

### Generate Video

`POST /api/media/videos/generate`

Auth: `Authorization: Bearer <accessToken>`

Text-to-video:

```json
{
  "model": "HappyHorse-1.1",
  "type": "video",
  "prompt": "A cinematic shot of a red train crossing snow mountains",
  "params": {
    "resolution": "1080P",
    "ratio": "16:9",
    "duration": 5,
    "watermark": false
  }
}
```

Image-to-video:

```json
{
  "model": "HappyHorse-1.1",
  "type": "video",
  "prompt": "The character turns and smiles",
  "params": {
    "firstFrame": "https://example.com/frame.png",
    "resolution": "1080P",
    "duration": 5,
    "watermark": false
  }
}
```

Reference-to-video:

```json
{
  "model": "HappyHorse-1.1",
  "type": "video",
  "prompt": "[Image 1] walks beside [Image 2]",
  "params": {
    "referenceImages": [
      "https://example.com/person-a.png",
      "https://example.com/person-b.png"
    ],
    "resolution": "1080P",
    "ratio": "16:9",
    "duration": 5,
    "watermark": false
  }
}
```

Response includes the existing task fields plus:

```json
{
  "model": "HappyHorse-1.1",
  "type": "r2v",
  "upstreamModel": "happyhorse-1.1-r2v",
  "modelSelectionReason": "检测到 2 张输入图片，使用参考生视频子模型 happyhorse-1.1-r2v"
}
```

### Poll Task

`GET /api/media/videos/tasks/{taskId}`

Auth: `Authorization: Bearer <accessToken>`

Polling responses include the same `upstreamModel` and `modelSelectionReason` fields when the task was created through `HappyHorse-1.1`.

## Frontend Action Items

- Send `model: "HappyHorse-1.1"` for all HappyHorse 1.1 video generations.
- Keep local tool-call output explicit: show `upstreamModel` and `modelSelectionReason` from generate and poll responses.
- Derive a local fallback selection reason from image count only when the server response is missing those fields.
- Do not send `happyhorse-1.1-t2v`, `happyhorse-1.1-i2v`, or `happyhorse-1.1-r2v` as selectable model IDs.

## Auth Requirements

Generation and polling require Electron JWT bearer auth. Model listing remains public.

## Notes & Caveats

- Admin only configures `HappyHorse-1.1`; upstream submodel IDs live in the server model pricing config.
- `duration` must be an integer from 3 to 15.
- Video and audio media inputs are ignored for dynamic HappyHorse 1.1 image counting.
