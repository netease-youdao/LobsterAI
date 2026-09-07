# 模型生成视频分享接入说明

日期：2026-09-01

状态：服务端与 LobsterAI 客户端已接入，功能默认关闭，待迁移、环境联调和灰度启用。

## Change Summary

`lobsterai-server` 新增模型生成视频专用分享链路。客户端只能用当前账号拥有的成功视频任务 `taskId + outputIndex` 创建分享，不能通过通用 multipart 接口上传本地视频，也不能把文件路径、结果 URL 或 NOS URL作为来源凭证。

服务端会在新视频任务成功后异步把结果持久化到 NOS。历史任务首次分享时按需补存：先读取原结果地址，地址失效时重新查询原供应商任务；两种方式都失败则返回明确错误。分享创建、额度、订阅过期、访问方式、分享码、状态、统计和生命周期继续复用其他文件分享策略。

公共页面通过同源 `/s/{shareId}/content/video` 代理视频字节并支持单段 HTTP Range，不向客户端或浏览器暴露 NOS URL。

## Endpoint Details

所有业务接口继续使用统一响应结构：

```json
{
  "code": 0,
  "message": "success",
  "data": {}
}
```

### 查询任务输出及已有分享

```http
GET /api/html-shares/generated-videos/source?taskId=12345&outputIndex=0
Authorization: Bearer <access-token>
```

成功响应示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "state": "prepared",
    "taskId": 12345,
    "outputIndex": 0,
    "assetStatus": "persisted",
    "retryAfterMs": null,
    "failureReason": null,
    "share": null
  }
}
```

`state` 可能为：

- `checking`：还没有可用分享或持久化资产；
- `prepared`：资产已经持久化，可以提交创建请求；
- `ready`：`share` 中已经包含当前任务输出的分享。

服务端始终按当前 JWT 的个人/企业账号空间校验任务归属。不存在、非视频、非成功、输出越界以及不属于当前空间的任务统一按不可分享任务处理。

### 准备并创建视频分享

```http
POST /api/html-shares/generated-videos
Authorization: Bearer <access-token>
Content-Type: application/json
```

请求体：

```json
{
  "taskId": "12345",
  "outputIndex": 0,
  "sessionId": "client-session-id",
  "artifactId": "artifact-id",
  "title": "海边日落",
  "accessMode": "public"
}
```

禁止增加或回退使用以下字段：`filePath`、`remoteUrl`、`resultUrl`、`nosUrl`、`archive`、`content`、`duration`、客户端计算的内容哈希。

资产尚在准备时返回 HTTP `202 Accepted`：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "state": "preparing",
    "taskId": 12345,
    "outputIndex": 0,
    "assetStatus": "persisting",
    "retryAfterMs": 1500,
    "failureReason": null,
    "share": null
  }
}
```

客户端按照 `retryAfterMs` 轮询 source 接口，并在 `prepared` 后重试本接口。创建完成返回 HTTP `200 OK`：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "state": "ready",
    "taskId": 12345,
    "outputIndex": 0,
    "assetStatus": "persisted",
    "share": {
      "shareId": "abc123",
      "url": "https://example.com/s/abc123/",
      "accessMode": "public",
      "status": "live",
      "moderationStatus": "pending"
    }
  }
}
```

同一账号空间、同一 `taskId + outputIndex` 重复调用会返回已有分享，不创建重复资产或重复分享。

### 兼容旧会话来源

```http
POST /api/html-shares/generated-videos/resolve-legacy-source
Authorization: Bearer <access-token>
Content-Type: application/json
```

请求只包含客户端旧消息中结果 URL 的 SHA-256：

```json
{
  "resultUrlSha256": "64位小写十六进制SHA-256"
}
```

唯一匹配当前账号历史成功视频任务时返回：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "taskId": 12345,
    "outputIndex": 0
  }
}
```

客户端随后必须走标准 `taskId + outputIndex` 创建流程。无匹配或多匹配均失败，不能上传本地副本兜底。原结果 URL 只在 Electron 主进程内做哈希，不发送给服务端。

### 公共播放

```http
GET /s/{shareId}/
GET /s/{shareId}/content/video
HEAD /s/{shareId}/content/video
Range: bytes=<start>-<end>
```

视频代理支持完整响应、单段 `206 Partial Content`、开放尾部、suffix Range 和 `416 Range Not Satisfiable`。分享状态、有效期、分享码、跨站子资源限制和 Admin 临时预览均沿用现有分享校验。

## Error Codes

| code | 含义 | 客户端处理 |
| ---: | --- | --- |
| `41317` | 找不到可分享的视频生成任务 | 提示来源无法确认，不开放上传兜底 |
| `41318` | 原地址失效且供应商无法重新获取 | 提示重新生成视频 |
| `41319` | 准备失败或功能尚未启用 | 提示稍后重试；旧服务端/功能关闭也不得回退上传 |
| `41320` | 兼容旧服务端的格式错误 | 新服务端不再因容器或编码拒绝分享 |
| `41301` | 视频超过服务端文件大小限制 | 展示服务端返回的 `limitBytes`，不使用时长替代限制 |

额度、身份、分享状态、分享码等其他错误继续复用现有 HTML 分享错误码和 UI。

## Frontend Action Items

LobsterAI 已按以下契约接入：

1. 视频生成成功消息和本地持久化资产保留 `taskId + outputIndex`；
2. 只有拥有明确生成来源或可安全反查的旧工具结果才显示分享入口；普通本地视频不可分享；
3. Electron 主进程负责认证请求和旧 URL 哈希，渲染进程不能直接调用服务端；
4. 资产准备期间显示等待状态并轮询，账号切换后旧请求不能写入新账号 UI；
5. 视频分享不显示“更新文件”操作，只复用访问方式、停止/恢复、复制链接和删除；
6. 视频分享记录会出现在“我的文件”的媒体分类中，列表和详情均不返回 NOS 地址；
7. 权益与额度继续走现有文件分享预检和服务端最终校验，客户端不硬编码订阅或普通用户规则。

`lobsterai-portal` 不需要改动，也不能增加视频分享入口。

## Auth Requirements

- 三个业务接口使用 Electron JWT Bearer 认证。
- 任务归属和分享归属完全来自签名 token 的 `userId + accountMode + enterpriseId`；请求不能提供可覆盖账号空间的字段。
- 个人订阅过期后，旧视频仍可按当前普通用户文件分享策略创建；已经创建的权益型分享继续使用现有权益失效宽限期。
- 资产准备不消耗分享名额；只有 NOS 持久化且创建分享记录成功后才计入文件分享额度。

## Migration and Rollout

1. 在服务端先执行 `lobsterai-server/sql/V84__generated_video_share.sql`。迁移兼容 MySQL 5.7，不使用外键、`CHECK`、窗口函数或 MySQL 8 专属 JSON 表函数。
2. 部署服务端。视频下载和 NOS 持久化不依赖 `ffprobe` 或 `ffmpeg`；启用视频内容审核时，审核环境仍需单独提供 `ffmpeg`。
3. 视频下载不需要配置供应商域名白名单；服务端只接受视频任务 `taskId + outputIndex`，并对供应商返回地址及每一跳重定向执行 HTTPS 和公网 IP 校验。
4. 部署 `lobsterai-admin`，再部署 LobsterAI 客户端。
5. 完成 NOS 持久化、供应商过期地址刷新、内容审核、分享码和 Range 联调后，将 `HTML_SHARE_GENERATED_VIDEO_ENABLED` 从默认 `false` 灰度开启。
6. 可选配置 `HTML_SHARE_GENERATED_VIDEO_AUTO_PERSIST_CREATED_AFTER=YYYY-MM-DDTHH:mm:ss`，只补偿指定时间之后的成功任务；上线前历史任务默认在分享时按需补存。

## Notes & Caveats

- 分享层没有 15 秒或其他实际时长上限，也不探测实际时长。
- 服务端将供应商返回的视频字节原样上传 NOS，不探测或限制容器和编码，不做转码；最大文件默认 100 MiB。
- 新任务成功不等待 NOS 上传；生成任务状态与资产持久化状态互相独立。
- 删除、禁用或过期分享不删除生成资产；相同任务输出只在 NOS 保留一份资产。
- 服务端和 Admin 接口不返回 NOS URL。Admin 通过现有临时预览令牌访问受控公共页面。
- 当前代码只完成离线编译、类型检查、Lint 和客户端定向测试；依赖 Redis、NOS、供应商、ASR，以及审核可选 `ffmpeg` 的链路需要在测试环境验证。
