# Seedream 5.0 Pro 生图参数兼容修复

## Change Summary

服务端在火山图片请求组装时，对实际上游模型 `doubao-seedream-5-0-pro-260628` 固定省略 `sequential_image_generation`，无论客户端传入 `disabled` 还是 `auto`。该模型不支持此字段，传 `disabled` 也会返回 HTTP 400。修复同时兼容通过 `mediaPricingConfig.upstreamModelId` 映射到该模型的模型别名。

其他模型继续按原逻辑透传此字段。接口路径、请求和响应结构、认证、计费及原始请求参数均不变。

## Endpoint Details

涉及现有图片生成入口：

- `POST /api/media/images/generate`：沿用现有同步/任务响应。
- `POST /api/media/v2/tasks`：请求额外包含 `mediaType: "image"`，并继续提供必填的 `Idempotency-Key` 请求头。

现有客户端请求仍可直接发送：

```http
POST /api/media/images/generate
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "model": "doubao-seedream-5-0-pro-260628",
  "type": "t2i",
  "prompt": "画一只猫",
  "params": {"size": "2K", "sequential_image_generation": "disabled"}
}
```

服务端发给火山的请求会保留模型、提示词、尺寸等现有字段，但不包含 `sequential_image_generation`。成功响应仍为 `{"code":0,"message":"success","data":{...}}`；例如旧接口成功结果的相关字段如下：

```json
{"code":0,"message":"success","data":{"taskId":123,"status":"succeeded","resultUrls":["https://example.com/image.png"]}}
```

V2 继续使用字符串 `taskId` 和原有查询任务流程，本次没有响应字段变更。

## Frontend Action Items

- 旧版 Electron 无需同步升级，默认生图路径附带的该参数会由服务端忽略。
- 后续客户端可按模型能力省略不支持的参数，但这不是本次服务端修复的前置条件。
- 继续沿用现有模型选择、配额校验、结果保存和任务轮询逻辑。

## Auth Requirements

沿用 Electron JWT Bearer 认证和现有账户上下文、模型可见性、媒体权益及额度校验，没有新增权限。

## Notes & Caveats

- 本次仅修复 Seedream 5.0 Pro 的不支持参数错误，不处理其他模型的尺寸校验、限流或客户端图片下载失败。
- 无数据库迁移、功能开关或 Overmind 配置变更；发布服务端修复后生效。
- 本地编译、静态检查和 `VolcengineMediaAdapterTest` 的 12 项测试已通过，覆盖 Pro 的 `disabled`/`auto`、上游模型别名和普通 Seedream 参数透传。测试及生产环境验收按服务端发布流程进行。
