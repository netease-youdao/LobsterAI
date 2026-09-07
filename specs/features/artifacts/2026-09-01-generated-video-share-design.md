# 模型生成视频分享设计文档

> 版本：V1.0<br>
> 日期：2026-09-01<br>
> 状态：已实现，待环境联调与灰度启用<br>
> 涉及系统：`LobsterAI`、`lobsterai-server`、`lobsterai-admin`<br>
> 不涉及系统：`lobsterai-portal`<br>
> 分享能力基线：[Artifact 图片与 SVG 分享设计](./2026-06-10-image-svg-share-design.md)<br>
> 媒体生成基线：[LobsterAI 生图生视频托管工具设计](../media-generation/2026-05-13-media-generation-design.md)<br>
> 发布权益基线：[`lobsterai-server/docs/specs/html-share/feature-2026-08-20-unified-publishing-quota-expiration.md`](../../../../lobsterai-server/docs/specs/html-share/feature-2026-08-20-unified-publishing-quota-expiration.md)

## 0. 决策摘要

1. 视频分享入口只存在于 LobsterAI Electron 客户端的 Artifact 预览区域，不在 Portal 增加入口。
2. 首期只允许分享 `lobsterai-server` 视频模型任务生成的结果，不允许用户把本地视频导入会话后分享。
3. 客户端 UI、访问模式、订阅/普通用户额度、状态管理、分享码、访问统计和管理员治理复用其他文件分享能力。
4. 视频不能加入现有通用文件分享白名单，也不能通过现有 multipart 压缩包接口上传；否则本地视频会绕过生成来源校验。
5. 标准视频分享请求只提交 `taskId + outputIndex` 和展示字段。服务端不接受客户端视频文件、本地路径、远端视频 URL、NOS URL、时长或内容哈希作为分享依据。
6. 服务端以“当前账号拥有成功的视频生成任务”为可信根：

   ```text
   shareable source = 当前账号拥有任务
                    AND task_type = video
                    AND status = succeeded
                    AND outputIndex 对应真实输出
   ```

7. 新生成视频在任务成功后由服务端立即异步下载并上传 NOS；媒体任务成功与资产持久化使用两个独立状态，NOS 暂时失败不能把已经成功的生成任务改成失败。
8. 历史视频不做强制全量下载迁移。用户点击分享时，如果尚未持久化，服务端先尝试原 `result_urls`，地址失效时再用原供应商任务信息获取新地址。
9. 历史地址和供应商任务都不可用时，分享失败，提示用户重新生成；客户端保存的本地副本不能作为补传来源。
10. 生成资产使用独立的 `media_generation_assets` 表持久化，分享通过 `html_share_generated_videos` 引用资产；同一生成视频只在 NOS 保存一份。
11. 删除、禁用或过期分享只改变分享关系，不删除生成资产；订阅失效也不删除已经生成的视频。
12. 视频分享作为文件分享计入现有 `PublishingPolicyService.ResourceKind.FILE`，不新增视频专属订阅规则。
13. 个人订阅过期后仍可按普通用户文件分享策略分享旧视频；当前默认是个人历史总量 10 个、链接固定有效 2 小时。客户端不能硬编码这些值。
14. 订阅期间已经创建的权益型视频分享沿用现有 7 天权益失效宽限期；不为视频增加特殊延期。
15. 分享层不设置业务时长上限，也不为了分享准入探测实际时长；模型生成参数本身的时长范围不等同于分享限制。
16. 服务端不探测或限制容器、视频编码和音频编码，也不做转码；当前供应商返回的视频字节原样持久化到 NOS。
17. 视频内容通过同源服务端代理播放，必须支持 HTTP Range。公共页面和客户端响应都不能暴露 NOS URL。
18. 视频内容审核复用现有异步审核状态和管理员操作，但不能把视频标记为“unsupported/skipped”后直接视为安全；至少审核生成提示词、抽帧，并在有音轨时审核转写文本。
19. 同一任务输出是不可变内容。视频分享只允许修改访问方式、启停状态等元数据，不允许用另一段视频“更新”原链接。
20. Portal 现有媒体任务接口和 `resultUrls` 保持向后兼容；Portal 不展示视频分享按钮，也不参与 NOS 上传。

---

## 1. 背景与当前问题

### 1.1 当前客户端只做了本地保存

客户端已经能够预览视频 Artifact，并在视频任务成功后把供应商结果下载到会话工作目录。该保存属于用户设备本地文件：

- 只能保证当前设备在文件没有被移动或删除时继续预览；
- 其他访问者和其他设备不能依赖该路径；
- 本地文件可以被用户替换，不能证明内容仍是模型生成结果；
- 当前下载实现会把完整视频读入内存，不适合作为服务端分享上传链路。

因此，本地保存可以继续作为客户端体验，但不能作为视频分享的数据来源。

### 1.2 当前服务端只保存供应商结果 URL

`media_generation_tasks.result_urls` 当前保存供应商返回的 JSON URL 列表。视频任务成功路径只写入这些 URL，没有调用 `NosUploadService`。

现有三类供应商适配器均直接返回上游下载地址：

| 供应商 | 当前结果来源 | 地址性质 |
| --- | --- | --- |
| 火山 Ark | 任务结果中的 `content.video_url` | 供应商托管地址，不应视为永久地址 |
| 阿里云百炼 | `output.video_url` / `watermark_video_url` | 临时结果地址 |
| MiniMax | `file_id` 再换取 `download_url` | 临时下载地址 |

供应商官方资料表明这些地址必须按临时地址处理：

| 供应商/模型 | 官方说明 | 本方案处理 |
| --- | --- | --- |
| MiniMax 视频 | 官方发布资料说明文件下载 URL 有效 9 小时 | 任务成功后立即持久化；历史任务可再次用 `file_id`/任务查询换地址 |
| 阿里云万相/HappyHorse | 相关视频结果 URL 通常有效 24 小时 | 立即持久化；过期后重新查询任务结果 |
| 阿里云 Kling V3 | 结果 URL 文档标注有效 30 天，但任务查询本身有更短保留边界 | 不能等到用户未来分享时才首次保存 |
| 火山 Ark 视频任务 | 官方任务文档说明任务 ID 保留 7 天，当前公开文档没有承诺 `video_url` 永久有效 | 一律视为临时地址并立即持久化 |

官方参考：

- [MiniMax Video Generation API release](https://www.minimax.io/news/video-generation-api)
- [阿里云 HappyHorse 文生视频 API](https://help.aliyun.com/zh/model-studio/happyhorse-text-to-video-api-reference)
- [阿里云 Kling 视频生成 API](https://help.aliyun.com/zh/model-studio/kling-video-generation-api-reference/)
- [阿里云文生视频指南](https://help.aliyun.com/zh/model-studio/text-to-video-guide)
- [火山 Ark Contents Generations Tasks API](https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01)

链接有效期可能由供应商调整。工程上不得把任何上游结果 URL 当作持久存储。

### 1.3 直接复用通用文件分享存在来源绕过

当前图片、SVG、文档、Markdown 等 Artifact 分享由客户端读取文件或内容，打包 zip，再调用：

```http
POST /api/html-shares
Content-Type: multipart/form-data
```

如果只把 `video` 加入 `artifactFileSharePolicy` 和服务端 sourceType 白名单，那么以下本地视频也会获得分享能力：

- 用户在会话输入框导入的视频；
- 用户从 Library 选择的本地视频；
- 任意工具写入本地磁盘后被解析成 Artifact 的视频；
- 用户替换了模型生成视频本地文件之后的内容。

`artifact.source = 'tool'`、文件名、文件路径、远端 URL 和客户端计算的哈希都不能证明视频来自平台视频模型。因此视频必须使用服务端任务溯源专用链路。

### 1.4 当前部分历史消息缺少任务溯源

同步生成和显式状态查询路径已经在 `toolResultDetails.taskId` 中返回服务端任务 ID，但后台轮询完成后写入“Saved generated video”消息的路径没有把 `taskId` 写入结果 metadata。

当前 `parseToolResultMediaArtifacts()` 也只读取 `assets`，没有保留 `taskId` 和输出序号。这意味着部分旧会话只有：

- 本地 `filePath`；
- 原始供应商 `remoteUrl`；
- `source = 'tool'`。

本方案需要兼容这批历史消息，但不能因此放开本地上传。兼容方式见第 9.4 节。

---

## 2. 目标、非目标与项目范围

### 2.1 目标

1. 用户可以在模型生成的视频 Artifact 上获得与其他文件一致的分享入口和管理体验。
2. 服务端可以证明分享内容对应当前账号拥有的视频生成任务。
3. 新生成视频尽快持久化到 NOS，避免供应商地址过期。
4. 历史任务在用户首次分享时按需补存，并尽力刷新过期地址。
5. 服务端探测并记录实际时长，同时校验文件大小、容器和编码；实际时长不作为分享准入条件。
6. 视频分享复用现有文件分享权益、额度、访问方式、状态、统计和管理员治理。
7. 分享访问不暴露 NOS URL，支持浏览器拖动和分段播放。
8. 个人、企业账号严格按任务原归属空间分享，不能跨空间使用任务 ID。

### 2.2 非目标

1. 不支持分享用户导入、拖入、附件上传或 Library 选择的本地视频。
2. 不支持客户端上传视频作为历史任务修复手段。
3. 不在 Portal 增加分享入口或分享管理 UI。
4. 不把所有历史视频任务一次性批量下载到 NOS；历史任务采用按需补存。
5. 不覆盖或删除 `media_generation_tasks.result_urls`，保留其作为上游原始结果和问题排查信息。
6. 不在首期支持任意容器、任意编码、转码、清晰度切换或 HLS/DASH。
7. 不允许用户用新的本地内容更新已经创建的视频分享。
8. 不为订阅过期设计视频专属规则。
9. 不因为分享删除而删除用户生成资产；账号注销等数据删除需求另走统一隐私清理流程。

### 2.3 项目范围

| 项目 | 首期范围 |
| --- | --- |
| `LobsterAI` | 唯一用户入口、任务溯源 metadata、分享 IPC/API 调用、准备状态和错误展示 |
| `lobsterai-server` | 资产持久化、历史恢复、NOS、数据库、专用分享 API、Range 播放、审核、权益和生命周期 |
| `lobsterai-admin` | 视频类型筛选、详情、预览、审核、禁用、恢复、删除和统计 |
| `lobsterai-portal` | 不改；保持现有接口兼容 |

---

## 3. 核心术语与不变量

| 术语 | 含义 |
| --- | --- |
| 媒体任务 | `media_generation_tasks` 中的视频生成任务 |
| 上游结果 URL | 供应商返回并保存在 `result_urls` 中的临时地址 |
| 生成资产 | 服务端从任务输出下载、校验并持久化到 NOS 的不可变视频 |
| 分享记录 | `html_shares` 中受额度、访问方式、状态和审核控制的逻辑资源 |
| 输出序号 | `result_urls` 中从 0 开始的稳定输出索引，例如原视频和水印视频 |
| 资产准备 | 从上游获取视频、探测媒体信息并上传 NOS 的过程 |

服务端必须维护以下不变量：

```text
1. 一个生成资产只能来自一个服务端媒体任务输出。
2. 一个视频分享必须绑定一个 persisted 的生成资产。
3. 分享账号上下文必须与媒体任务账号上下文完全一致。
4. 客户端文件、路径、URL 和哈希不能改变分享绑定的生成资产。
5. 分享状态变化不能改变生成资产内容。
6. NOS URL 永远不是用户 API 或公共页面的访问凭证。
```

账号上下文一致定义为：

```text
personal:
  task.user_id = current.user_id
  AND task.account_mode = personal
  AND task.tob_enterprise_id IS NULL

enterprise:
  task.user_id = current.user_id
  AND task.account_mode = enterprise
  AND task.tob_enterprise_id = current.enterprise_id
```

不能只校验 `user_id`，否则同一用户可能把个人空间任务分享到企业空间，或反向跨空间使用团队生成资产。

---

## 4. 总体架构

### 4.1 新任务主链路

```text
视频供应商
   │ 返回临时 result URL
   ▼
media_generation_tasks.status = succeeded
   │ 事务提交后发布完成事件
   ▼
MediaGenerationAssetPersistenceService
   │ 服务端流式下载到临时文件
   │ 校验文件大小、magic、容器和编码，探测并记录实际时长
   ▼
NOS 上传
   │
   ▼
media_generation_assets.status = persisted
   │
   ├── 客户端仍可保留现有本地保存体验
   └── 用户点击分享时直接引用持久化资产
```

任务成功响应不等待 NOS 上传完成。资产准备失败通过独立状态重试，不能回滚媒体生成计费或把任务改成 `failed`。

### 4.2 历史任务分享链路

```text
客户端提交 taskId + outputIndex
   ▼
服务端校验任务归属、video、succeeded、输出存在
   ▼
查询 media_generation_assets
   ├── persisted：进入分享创建
   ├── pending/persisting：返回 preparing
   ├── 不存在：创建 pending 并触发准备
   └── terminal failure：返回明确失败

准备任务：
   原 result URL 下载
      ├── 成功：校验并上传 NOS
      └── 失效：调用原供应商适配器重新查询
                    ├── 获得新 URL：下载并上传 NOS
                    └── 失败：source_unavailable
```

### 4.3 分享访问链路

```text
访问 /s/{shareId}/
   ▼
现有分享状态、有效期、分享码和管理员预览校验
   ▼
服务端返回同源 <video> 播放页
   ▼
浏览器请求 /s/{shareId}/content/video
   ▼
服务端再次校验访问权限并代理 Range 到 NOS
   ▼
返回 200 / 206，不重定向，不暴露 NOS URL
```

---

## 5. 数据模型

### 5.1 为什么不直接把 NOS URL 写回 `result_urls`

不覆盖 `media_generation_tasks.result_urls`，原因如下：

1. 原始结果是供应商故障排查和地址刷新依据；
2. 任务成功与资产持久化是两个不同事实；
3. Portal 和现有客户端已经消费 `resultUrls`，直接替换语义会带来兼容风险；
4. 一个任务可能有多个输出，每个输出需要独立状态、哈希、时长和失败原因；
5. 后续图片等媒体也可复用独立资产表。

### 5.2 `media_generation_assets`

已新增迁移 `V84__generated_video_share.sql`：

```sql
CREATE TABLE `media_generation_assets` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `task_id` BIGINT NOT NULL COMMENT 'media_generation_tasks.id',
  `output_index` INT NOT NULL COMMENT 'result_urls中的0基输出序号',
  `user_id` BIGINT NOT NULL,
  `account_mode` VARCHAR(16) NOT NULL DEFAULT 'personal',
  `tob_enterprise_id` BIGINT DEFAULT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending'
      COMMENT 'pending/persisting/persisted/retryable_failed/source_unavailable/invalid',
  `source_url_sha256` CHAR(64) DEFAULT NULL,
  `nos_url` VARCHAR(2048) DEFAULT NULL COMMENT '服务端内部NOS地址，不对外返回',
  `nos_object_key` VARCHAR(512) DEFAULT NULL,
  `content_type` VARCHAR(128) DEFAULT NULL,
  `container_format` VARCHAR(64) DEFAULT NULL,
  `video_codec` VARCHAR(64) DEFAULT NULL,
  `audio_codec` VARCHAR(64) DEFAULT NULL,
  `width` INT DEFAULT NULL,
  `height` INT DEFAULT NULL,
  `duration_ms` BIGINT DEFAULT NULL,
  `size_bytes` BIGINT DEFAULT NULL,
  `sha256` CHAR(64) DEFAULT NULL,
  `original_filename` VARCHAR(255) DEFAULT NULL,
  `failure_reason` VARCHAR(64) DEFAULT NULL,
  `attempt_count` INT NOT NULL DEFAULT 0,
  `next_retry_at` DATETIME DEFAULT NULL,
  `lease_until` DATETIME DEFAULT NULL,
  `persisted_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_media_generation_asset_output` (`task_id`, `output_index`),
  KEY `idx_media_generation_asset_retry` (`status`, `next_retry_at`),
  KEY `idx_media_generation_asset_owner` (`user_id`, `account_mode`, `tob_enterprise_id`, `created_at`),
  KEY `idx_media_generation_asset_source_hash` (`source_url_sha256`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='媒体生成任务持久化资产';
```

约束说明：

- 不增加外键，符合生产迁移限制；关联完整性由服务事务维护。
- 状态使用 `VARCHAR` 和服务端常量，不依赖 MySQL `CHECK`。
- 唯一键保证重复完成事件、重复分享点击和多个服务实例不会创建重复资产。
- `nos_url`、大小和哈希只有 `status = persisted` 时才可作为可用资产。
- `container_format`、`video_codec`、`audio_codec`、宽高和 `duration_ms` 为兼容既有表结构保留的可空字段；视频分享持久化链路不再主动填充，也不使用客户端或生成请求声称的值。
- `user_id + account_mode + tob_enterprise_id` 固化资产所有者空间，分享时仍会重新校验原任务归属。

### 5.3 `html_share_generated_videos`

分享与生成资产使用独立绑定表：

```sql
CREATE TABLE `html_share_generated_videos` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `share_id` VARCHAR(64) NOT NULL COMMENT 'html_shares.share_id',
  `asset_id` BIGINT NOT NULL COMMENT 'media_generation_assets.id',
  `task_id` BIGINT NOT NULL COMMENT '冗余任务ID，便于审计和排查',
  `output_index` INT NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_html_share_generated_video_share` (`share_id`),
  KEY `idx_html_share_generated_video_asset` (`asset_id`),
  KEY `idx_html_share_generated_video_output` (`task_id`, `output_index`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='视频分享与模型生成资产绑定';
```

不直接把生成资产作为普通 `html_share_files` 的存储所有权对象：

- 普通分享文件由分享拥有，永久删除分享时可以进入 NOS 清理；
- 生成资产由媒体任务拥有，分享只是引用；
- 如果复用 `html_share_files.nos_url` 而没有所有权区分，后续清理逻辑可能误删用户生成资产。

管理员“文件信息”接口可以把绑定资产投影成虚拟文件信息，但不复制或转移 NOS 所有权。

### 5.4 `html_shares` 写入规则

视频分享继续写入现有主表：

| 字段 | 值 |
| --- | --- |
| `source_type` | `generated_video_file` |
| `client_source_key` | 服务端根据账号上下文、`taskId`、`outputIndex` 生成，客户端不能指定 |
| `entry_file` | `video.mp4` |
| `source_sha256` | `media_generation_assets.sha256` |
| `total_files` | `1` |
| `total_bytes` | 资产实际字节数 |
| `access_expires_at` | 完全复用当前发布策略计算 |
| `moderation_status` | 复用当前审核初始状态 |

服务端稳定来源 key 实现为：

```text
generated_video:{taskId}:{outputIndex}
```

查询同时带上分享记录的 `user_id + account_mode + tob_enterprise_id`，因此不同账号空间可以安全复用相同 key。该 key 只用于幂等查找，不承担鉴权；鉴权始终重新读取任务和账号上下文。

---

## 6. 生成资产持久化

### 6.1 任务成功触发点

当前视频任务可能通过多条路径进入成功状态：

1. 供应商同步提交直接返回成功；
2. 用户查询任务时 `pollAndUpdate()` 发现成功；
3. 后台 `MediaTaskPollingJob` / worker 发现成功；
4. 企业任务结算流程完成成功落库。

不能只在某一 Controller 或某一轮询路径调用 NOS。建议在“媒体任务成功事务提交后”发布统一领域事件：

```text
MediaGenerationTaskSucceededEvent(taskId)
```

事务提交后的监听器执行：

1. 重新读取任务，确认 `task_type = video`、`status = succeeded`；
2. 解析 `result_urls`；
3. 对每个输出按 `(taskId, outputIndex)` 幂等插入 `pending` 资产；
4. 提交到持久化执行器；
5. 即使事件丢失，定时补偿任务也能扫描成功任务中缺失的资产记录。

补偿扫描只负责新任务和遗漏事件，不要求启动时全量下载全部历史数据。建议以功能上线时间或可配置时间水位作为“新任务”边界。

### 6.2 任务状态与资产状态分离

```text
media_generation_tasks.status = succeeded
    表示供应商已经成功生成内容并完成原业务计费

media_generation_assets.status = persisted
    表示对应输出已经通过服务端校验并保存到 NOS
```

禁止以下做法：

- NOS 上传失败后把媒体任务改为 `failed`；
- 因资产准备重试而重复结算或退款；
- 把 `result_urls` 替换成 NOS URL 来隐式表示持久化成功；
- 等用户点击分享后才开始保存所有新生成视频。

### 6.3 持久化状态机

```text
pending
  │ 获取租约
  ▼
persisting
  ├── 成功 ───────────────► persisted
  ├── 网络/NOS临时失败 ──► retryable_failed ──► pending
  ├── 上游不可恢复 ──────► source_unavailable
  └── 文件不是合法视频 ─► invalid
```

状态语义：

| 状态 | 是否可分享 | 是否自动重试 |
| --- | --- | --- |
| `pending` | 否 | 是 |
| `persisting` | 否 | 等待当前执行器 |
| `persisted` | 需继续检查分享格式、额度等策略 | 否 |
| `retryable_failed` | 否 | 到 `next_retry_at` 后重试 |
| `source_unavailable` | 否 | 否；用户再次分享只返回明确失败 |
| `invalid` | 否 | 否 |

多实例并发使用数据库 CAS 和租约：

```sql
UPDATE media_generation_assets
SET status = 'persisting',
    lease_until = ?,
    next_retry_at = NULL,
    attempt_count = attempt_count + 1
WHERE id = ?
  AND (
    (status IN ('pending', 'retryable_failed')
     AND (next_retry_at IS NULL OR next_retry_at <= ?))
    OR (status = 'persisting' AND (lease_until IS NULL OR lease_until <= ?))
  );
```

只有更新到 1 行的实例可以执行下载。进程退出后，过期租约可被其他实例回收。

下载和 NOS 上传全部在数据库事务外执行，不能持有行锁或发布额度锁等待网络 I/O。事务只用于领取租约、写入最终状态和创建分享关系。

### 6.4 重试策略

建议默认自动重试间隔：

```text
第 1 次失败：1 分钟
第 2 次失败：5 分钟
第 3 次失败：20 分钟
第 4 次失败：60 分钟
第 5 次失败：停止自动重试
```

分类原则：

| 失败 | 分类 |
| --- | --- |
| 连接超时、DNS 临时失败、供应商 5xx、NOS 5xx | `retryable_failed` |
| 上游 401/403/404/410 且刷新也失败 | `source_unavailable` |
| 供应商明确返回任务不存在或已清理 | `source_unavailable` |
| 上游响应为空 | `retryable_failed` |
| 视频超过持久化技术大小上限 | `invalid` |

MiniMax 官方下载地址只有约 9 小时，自动任务必须在成功后立即执行，不能把首次重试安排到数小时以后。

### 6.5 下载与 NOS 上传

服务端使用临时文件流式处理：

1. 在受控临时目录创建随机文件；
2. 使用服务端保存的上游 URL 发起 GET；
3. 一边读取一边写磁盘、累计字节并计算 SHA-256；
4. 超过最大字节数立即中止；
5. 使用 `FileSystemResource` 调用 `NosUploadService.upload(filename, resource)`；
6. NOS 返回成功后写入地址、大小、哈希等资产信息；
7. 无论成功失败都清理临时文件。

不得在服务端使用 `byte[]`、`readAllBytes()` 或完整 `arrayBuffer` 承载视频。现有 `NosUploadService` 已支持 `Resource`，实现时需要验证底层 multipart 请求不会把完整资源再次缓冲进内存。

当前供应商返回 MP4，NOS 使用服务端生成的固定扩展名：

```text
generated-video-{taskId}-{outputIndex}-{sha256前12位}.mp4
```

文件名不得包含 prompt、用户标识或供应商签名参数。

### 6.6 上游地址安全

虽然结果 URL 来自服务端数据库或供应商刷新响应，下载器仍需防御异常重定向：

- 初始 URL 必须来自 `media_generation_tasks.result_urls` 或已注册供应商适配器；
- 客户端不能给下载器传 URL；
- 最多跟随 3 次重定向，每一跳都重新执行协议和 IP 校验；
- 仅允许 `https`；URL 来源由服务端视频任务溯源保证，不接受客户端传入 URL；
- 默认拒绝环回、链路本地、私网和云元数据地址；
- 不配置供应商域名白名单；供应商可以使用或调整其公网对象存储与 CDN 域名；
- 连接、首字节、整体下载均配置超时；
- 日志不记录完整签名 URL，只记录 host、taskId、outputIndex 和 URL 哈希前缀。

### 6.7 持久化和分享限制

持久化技术约束和分享业务约束必须分开：

| 层级 | 项目 | 限制 |
| --- | --- | --- |
| 持久化 | 文件大小 | `<= 100 MiB` |
| 持久化 | 内容来源 | 必须来自当前账号拥有且已成功的视频生成任务 |
| 持久化 | 内容 | 上游响应必须非空；不做容器或编码探测 |
| 分享 | 时长/容器/编码 | 不作为分享准入条件 |
| 分享 | 文件数量 | 1 |

实际时长、分辨率和编码信息不是分享必需数据。服务端不接受客户端视频内容或媒体元数据，因而无需使用 `ffprobe` 重新证明内容来源；可信性来自任务所有权、任务类型、成功状态和输出序号校验。当前模型即使只支持生成不超过 15 秒的视频，也只是生成能力边界，分享层不增加另一套时长限制。

持久化链路只负责把供应商返回的非空视频字节上传 NOS，并记录大小、SHA-256 和 NOS 地址。超过文件大小上限进入 `invalid`；下载、刷新或 NOS 临时失败进入既有重试流程。浏览器能否直接播放由供应商输出格式决定，服务端不转码，也不因格式或编码拒绝创建分享。

内容审核如需抽帧或音频处理，可以独立使用 `ffmpeg`；该审核依赖不属于视频下载和 NOS 持久化的前置条件。

---

## 7. 历史任务恢复

### 7.1 标准历史任务

客户端 Artifact 已包含 `taskId` 时，流程与新任务完全相同：

1. 分享接口验证当前账号拥有任务；
2. 根据 `outputIndex` 找资产；
3. 没有资产时创建 `pending`；
4. 尝试原 `result_urls[outputIndex]`；
5. 原地址失效时刷新供应商结果；
6. 成功后上传 NOS；
7. 客户端再次提交创建分享。

### 7.2 如何判断原地址失效

不依赖客户端判断。服务端流式 GET 时：

- `401/403/404/410`、供应商明确签名过期响应：尝试刷新地址；
- `429/5xx`：优先作为可重试失败，不立即认定源已永久丢失；
- 连接成功但内容为空或不是视频：记录为无效源，并在供应商支持时再刷新一次；
- 某些下载服务不支持 HEAD，因此 HEAD 只能作为优化，不能作为唯一有效性判断。

### 7.3 供应商刷新接口

在媒体适配层增加只读能力，而不是把供应商分支写进分享服务：

```java
interface UpstreamMediaAssetResolver {
    List<ResolvedMediaAsset> resolveSucceededAssets(
        MediaGenerationTask task,
        ModelPricing model,
        ModelRoute route);
}
```

`ResolvedMediaAsset` 至少包含：

```text
outputIndex
outputRole
downloadUrl
upstreamAssetId?
contentTypeHint?
```

实现原则：

| 供应商 | 刷新方式 |
| --- | --- |
| MiniMax | 优先使用历史 `result_metadata` 中已保存的 `file_id`；缺失时用 `upstream_task_id` 查询成功任务取得 `file_id`，再调用 files retrieve 获取新 `download_url` |
| 阿里云 | 用原任务 ID 查询任务结果，按 primary/watermark 角色稳定映射输出 |
| 火山 Ark | 用原任务 ID 查询 Contents Generations task 并重新读取 `video_url` |

刷新调用只解析资产，不重新结算媒体任务、不重复记录用量、不修改任务成功状态。原始 `result_urls` 不覆盖；新地址只用于当前下载尝试。

如果供应商返回的输出数量或角色不能与历史 `outputIndex` 唯一对应，必须失败，不能把另一输出静默分享给用户。

### 7.4 旧客户端消息缺少 `taskId`

严格禁止用以下方式恢复：

- 从本地文件内容上传；
- 从消息可见文本正则解析 Task ID；
- 仅凭 `source = 'tool'` 判定是模型视频；
- 把客户端传入 URL 直接作为下载源。

兼容路径只用于确认服务端已有任务身份：

1. 客户端仅对“已知由 LobsterAI 托管视频生成工具产生”的旧 tool result 启用恢复；
2. 客户端取旧 Artifact 保存的原始 `remoteUrl`，本地计算完整字符串的 SHA-256；
3. 调用兼容解析接口，只发送 `resultUrlSha256`，不发送文件和 URL；
4. 服务端只扫描当前账号上下文中 `task_type = video AND status = succeeded` 的任务；
5. 服务端对自己保存的每个 `result_urls` 元素计算 SHA-256；
6. 只有唯一精确匹配时返回 `taskId + outputIndex`；
7. 客户端随后走标准任务分享接口；兼容解析接口本身不能创建分享或下载客户端内容。

建议接口：

```http
POST /api/html-shares/generated-videos/resolve-legacy-source
Content-Type: application/json

{
  "resultUrlSha256": "64位十六进制SHA-256"
}
```

该接口需要限流，服务端分页扫描并设置最大任务扫描数，避免被用作高成本查询。没有唯一匹配时统一返回“无法确认模型生成来源”。

当前保存到本地的视频资产通常同时保留 `remoteUrl`，因此大部分旧消息可以通过哈希匹配恢复。只有本地路径、没有原 URL 的旧资产无法安全恢复，必须分享失败。

这条兼容路径仍保证最终分享内容来自服务端任务：即使用户构造了一个相同 URL 哈希，服务端分享的也是匹配任务对应的 NOS 资产，而不是客户端本地文件。

---

## 8. 视频分享 API

### 8.1 Source type

新增：

```text
generated_video_file
```

服务端必须区分：

- `KNOWN_SOURCE_TYPES`：查询、列表、状态、统计和后台可识别的全部类型；
- `MULTIPART_UPLOAD_SOURCE_TYPES`：通用 zip 上传允许的类型。

`generated_video_file` 只加入前者，不能加入后者。

以下请求必须被拒绝：

```http
POST /api/html-shares
Content-Type: multipart/form-data
sourceType=generated_video_file
```

### 8.2 查询资产和已有分享

```http
GET /api/html-shares/generated-videos/source?taskId=123&outputIndex=0
Authorization: Bearer <accessToken>
```

响应：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "taskId": 123,
    "outputIndex": 0,
    "assetStatus": "persisted",
    "retryAfterMs": null,
    "failureReason": null,
    "share": {
      "shareId": "shr_xxx",
      "url": "https://example.com/s/shr_xxx/",
      "accessMode": "code",
      "shareCode": "123456",
      "status": "live",
      "moderationStatus": "pending",
      "accessExpiresAt": null
    }
  }
}
```

规则：

- GET 不启动持久化，不产生分享额度；
- 找不到资产时返回 `assetStatus = not_started`；
- 返回已有 live/disabled 分享时复用现有分享响应字段；
- 不返回 `nosUrl`、供应商 URL、用户 prompt 或内部错误堆栈；
- 任务不存在和任务不属于当前账号使用相同错误，避免任务枚举。

### 8.3 创建分享或触发准备

```http
POST /api/html-shares/generated-videos
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "taskId": "123",
  "outputIndex": 0,
  "sessionId": "cowork-session-id",
  "artifactId": "artifact-media-message-0",
  "title": "海边龙虾短片",
  "accessMode": "code"
}
```

字段规则：

| 字段 | 规则 |
| --- | --- |
| `taskId` | 必填，十进制服务端任务 ID；客户端内部使用字符串避免精度和 metadata 类型漂移 |
| `outputIndex` | 必填，0 基非负整数 |
| `sessionId` | 可选，只作追踪，最大 128 字符 |
| `artifactId` | 可选，只作追踪，最大 128 字符 |
| `title` | 必填，沿用分享标题限制 |
| `accessMode` | `code` 或 `public`，默认与其他 Artifact 分享一致 |

请求中不存在以下字段：

```text
file
archive
filePath
localPath
remoteUrl
nosUrl
sourceSha256
duration
contentType
```

服务处理顺序：

1. 解析当前 `PublishingAccountContext`；
2. 按账号上下文查询任务；
3. 校验 `task_type = video`、`status = succeeded`；
4. 校验输出存在；
5. 查询同一任务输出已有非 deleted 分享，有则幂等返回；
6. 执行文件分享额度预检；
7. 资产没有准备时，幂等创建/唤醒持久化并返回 `preparing`；
8. 资产已持久化时确认 NOS 地址、大小和 SHA-256 完整，并校验文件大小；
9. 在现有发布 quota owner lock 下重新查询同源分享，并执行最终额度校验；
10. 同一事务创建 `html_shares` 和绑定记录；
11. 提交后触发视频审核；
12. 返回现有分享响应。

准备中的响应建议使用 HTTP 202：

```json
{
  "code": 0,
  "message": "视频正在准备",
  "data": {
    "state": "preparing",
    "taskId": 123,
    "outputIndex": 0,
    "assetStatus": "persisting",
    "retryAfterMs": 1500
  }
}
```

准备完成后，客户端再次调用同一个 POST。第二次调用在事务内创建或返回已有分享。这样无需增加“半创建”的 `html_shares`，普通用户固定有效期也从分享真正创建成功时开始计算。

客户端收到 202 后，按 `retryAfterMs` 轮询第 8.2 节的 GET 接口：

- `pending/persisting/retryable_failed`：继续等待，使用服务端返回的下一次建议间隔；
- `persisted`：停止轮询并再次调用 POST 完成分享创建；
- `source_unavailable/invalid`：停止轮询并展示对应失败；
- 已经出现 `share`：直接进入现有分享管理状态，不再创建。

初始额度检查只是避免明显无额度时产生不必要工作；最终创建必须再次校验，不能信任预检。如果等待期间额度被其他请求占用，最终返回现有额度错误。已经持久化的生成资产保留，不因为分享额度竞争删除。

MySQL 5.7 没有适合表达“同一资产仅允许一个非 deleted 分享”的部分唯一索引，因此同源幂等由现有 owner quota lock 串行化：拿锁后必须再次查询绑定资产对应的非 deleted 分享，再决定返回已有记录还是创建新记录。

### 8.4 复用现有管理 API

分享创建后复用：

```text
GET    /api/html-shares/{shareId}
PUT    /api/html-shares/{shareId}/access-mode
PATCH  /api/html-shares/{shareId}/status
DELETE /api/html-shares/{shareId}
DELETE /api/html-shares/{shareId}/permanent
GET    /api/html-shares/{shareId}/analytics
```

不复用通用内容更新接口：

```text
PUT /api/html-shares/{shareId} + multipart archive
```

当目标 `source_type = generated_video_file` 时，该接口必须拒绝内容更新。访问方式和启停状态仍可通过专用元数据接口修改。

### 8.5 错误码

建议在现有 413xx 分享错误段增加：

| 错误码 | 常量 | 用户语义 |
| ---: | --- | --- |
| 41317 | `HTML_SHARE_VIDEO_TASK_NOT_FOUND` | 找不到可分享的视频生成任务 |
| 41318 | `HTML_SHARE_VIDEO_SOURCE_UNAVAILABLE` | 原视频地址已失效且供应商无法重新获取，请重新生成 |
| 41319 | `HTML_SHARE_VIDEO_PREPARE_FAILED` | 视频准备暂时失败，请稍后重试 |
| 41320 | `HTML_SHARE_VIDEO_UNSUPPORTED` | 兼容旧服务端保留；新持久化链路不因格式或编码拒绝分享 |

文件超过 100 MiB 继续使用 `HTML_SHARE_TOO_LARGE`，并在错误 data 中返回 `limitBytes/actualBytes`。订阅、普通用户额度和企业权限错误继续使用现有错误码。

服务端内部失败原因需要比用户错误更细：

```text
ORIGINAL_URL_EXPIRED
PROVIDER_REFRESH_UNAVAILABLE
PROVIDER_TASK_EXPIRED
DOWNLOAD_TIMEOUT
DOWNLOAD_TOO_LARGE
VIDEO_STREAM_MISSING
NOS_UPLOAD_FAILED
PERSISTENCE_RETRY_EXHAUSTED
```

`UNSUPPORTED_VIDEO_CODEC` 和 `UNSUPPORTED_AUDIO_CODEC` 属于分享准入失败，不属于资产持久化失败。

---

## 9. LobsterAI 客户端设计

### 9.1 Artifact 可信来源模型

扩展 Artifact 类型：

```ts
export const ArtifactMediaOriginKind = {
  ModelGeneration: 'model_generation',
} as const;

export interface ArtifactModelGenerationOrigin {
  kind: typeof ArtifactMediaOriginKind.ModelGeneration;
  taskId: string;
  outputIndex: number;
}

export interface Artifact {
  // existing fields...
  mediaOrigin?: ArtifactModelGenerationOrigin;
}
```

不要把 `source: 'tool'` 扩展成“模型生成”的语义。`source` 继续表示 Artifact 的解析来源，`mediaOrigin` 单独表示服务端可验证的业务溯源。

### 9.2 生成消息写入

所有视频任务成功路径写入一致 metadata：

```ts
{
  toolResultDetails: {
    taskId: String(task.taskId),
    status: 'succeeded',
    mediaType: 'video',
    assets: resultAssets.map(asset => ({
      ...asset,
      outputIndex: asset.outputIndex,
    })),
  },
}
```

需要覆盖：

- 同步直接成功；
- 显式 status 查询成功；
- 主进程后台轮询成功；
- 下载本地文件成功和本地保存失败两种结果。

本地保存失败不能丢掉 `taskId` 和远端输出身份；用户仍可能等待服务端 NOS 准备后分享。

`outputIndex` 必须在构造原始 `resultUrls` asset 列表时写入，并由本地保存结果原样保留。不能对“保存成功的子集”重新 `map()` 编号，否则前一个输出本地下载失败时，后续输出会错误绑定到另一个服务端结果。

### 9.3 Artifact 解析

`parseToolResultMediaArtifacts()`：

1. 读取 `toolResultDetails.taskId`；
2. 读取每个 asset 的显式 `outputIndex`，旧数据缺失时使用数组索引；
3. 只对 `mediaType/video` 且 taskId 合法的资产写入 `mediaOrigin`；
4. `filePath` 仅用于本地预览，不能进入分享请求；
5. `remoteUrl` 可用于旧消息身份恢复，但不能进入标准分享 API。

当前解析器会丢弃没有 `filePath` 的视频。实现本方案后，已确认 `mediaOrigin` 的模型视频不能因为客户端本地下载失败而被丢弃：可以在供应商 URL 仍有效时用远端地址预览，或者显示“视频已生成，正在准备云端资产”的占位 Artifact。分享资格取决于任务身份和服务端资产状态，不取决于本地保存是否成功。

### 9.4 历史 Artifact 恢复

对于已知 LobsterAI 视频生成 tool result、缺少 `taskId` 但仍有 `remoteUrl` 的旧 Artifact：

1. UI 可显示分享入口，但标记为“需要确认来源”；
2. 用户点击后由主进程计算 URL SHA-256；
3. 调用第 7.4 节兼容解析接口；
4. 唯一匹配后在当前内存请求中补齐 `mediaOrigin`；
5. 再执行标准分享流程。

以下视频不显示分享入口：

| 视频来源 | 是否显示 |
| --- | --- |
| 当前 LobsterAI 视频任务，含有效 `mediaOrigin` | 是 |
| 旧 LobsterAI 视频任务，可通过 URL 哈希恢复 | 是，点击后先恢复 |
| 会话附件导入的本地视频 | 否 |
| Library 本地视频 | 否 |
| 任意本地 `.mp4` 文件 Artifact | 否 |
| 其他工具生成但无 LobsterAI 媒体任务的文件 | 否 |
| 只有本地路径且无法恢复任务的旧视频 | 否或点击后明确失败 |

即使 Renderer 误显示按钮，主进程和服务端仍必须分别校验，不能只依赖 UI 隐藏。

### 9.5 分享策略与请求联合类型

不要直接在 `ARTIFACT_FILE_SHARE_SOURCE_TYPES` 中增加 Video。新增专用请求分支：

```ts
export const ArtifactShareRequestSource = {
  HtmlFile: 'htmlFile',
  ArtifactFile: 'artifactFile',
  GeneratedVideo: 'generatedVideo',
} as const;

interface GeneratedVideoShareRequest {
  source: 'generatedVideo';
  sourceType: 'generated_video_file';
  sessionId: string;
  artifactId: string;
  lookupKey: string;
  title: string;
  accessMode: HtmlShareAccessMode;
  taskId: string;
  outputIndex: number;
}
```

`GeneratedVideoShareRequest` 类型中不能出现 `filePath`、`content` 或 `remoteUrl`。`lookupKey` 使用任务身份，不使用本地路径：

```text
generated_video_file:{accountScope}:{taskId}:{outputIndex}
```

### 9.6 IPC 与主进程

共享常量建议新增：

```ts
export const HtmlShareIpc = {
  // existing channels...
  CreateFromGeneratedVideo: 'htmlShare:createFromGeneratedVideo',
  GetGeneratedVideoSource: 'htmlShare:getGeneratedVideoSource',
  ResolveLegacyGeneratedVideo: 'htmlShare:resolveLegacyGeneratedVideo',
} as const;

export const HtmlShareSourceType = {
  // existing source types...
  GeneratedVideoFile: 'generated_video_file',
} as const;
```

主进程职责：

- 使用现有 `fetchWithAuth` 和当前个人/企业账号上下文；
- 调用专用 JSON API；
- 处理 HTTP 202 和轮询；
- 不读取视频文件；
- 不创建 zip；
- 不上传 Blob/FormData；
- 不把 URL、路径或 NOS 地址放入请求；
- 账号切换后中止旧账号的准备轮询，避免跨账号回显结果。

### 9.7 UI 交互

复用 `ArtifactFileShareController` 的现有体验：

- 登录检查；
- 普通/订阅/企业额度展示；
- 公开或分享码访问方式；
- 创建、复制链接、打开链接；
- 停止/开启分享；
- 额度错误和订阅引导；
- 访问统计入口（如果当前文件分享已展示）。

视频特有阶段：

```text
checking_source
preparing_video
creating_share
ready
failed
```

建议文案：

| 状态 | 文案 |
| --- | --- |
| 首次准备 | 正在准备视频分享，完成后会自动生成链接… |
| 历史地址刷新 | 原视频地址已失效，正在尝试重新获取… |
| 可重试失败 | 视频准备暂时失败，请稍后重试 |
| 永久不可恢复 | 原视频已失效，且无法从视频供应商重新获取，请重新生成后再分享 |

准备轮询建议从服务端 `retryAfterMs` 取值，并设置客户端最长等待时间。超过前台等待时间只停止 UI 轮询，不取消服务端资产持久化；用户稍后再次点击可以继续查询。

视频内容不可更新，因此分享弹窗不展示“更新文件/更新内容”。访问方式、状态和复制操作保持一致。

---

## 10. 发布权益、额度和账号状态

### 10.1 完全复用文件分享策略

视频分享属于：

```text
PublishingPolicyService.ResourceKind.FILE
```

因此：

- 普通个人用户按普通文件历史总量策略；
- 有效个人订阅按当前套餐文件活跃量策略；
- 企业用户按企业成员所在企业空间的文件活跃量策略；
- 视频和 HTML、图片、文档等共同占用文件分享额度；
- 停止视频分享是否释放额度，按当前身份的 `countMode` 处理；
- 客户端只消费服务端 quota 响应，不硬编码数量。

### 10.2 订阅过期后的旧视频

“视频生成权益”和“文件分享权益”分开：

- 订阅过期后不能创建新的视频生成任务；
- 已生成视频仍属于用户，生成资产不删除；
- 用户可以按当前普通用户文件分享政策创建旧视频分享；
- 当前默认普通用户文件历史总量为 10，分享固定有效 2 小时；
- 普通用户额度已用完时，旧视频不能新建分享；
- 订阅期间创建的权益型链接沿用现有 7 天失效宽限期。

宽限期内旧链接是否可访问、拥有者是否可以修改访问方式或重新开启，完全沿用现有文件分享写入限制：可以继续复制和访问尚未关闭的链接，但订阅/团队权益失效时不能借视频入口绕过已有的更新与恢复限制。

视频创建接口必须调用现有 `PublishingPolicyService`，不能单独检查 `subscription.status = active`。

### 10.3 准备过程与额度

资产持久化和分享额度是不同生命周期：

- 新任务成功后的自动持久化不检查分享额度；
- 历史任务由分享请求触发时先做额度预检；
- `html_shares` 只有资产准备成功、最终额度校验通过后才创建；
- 准备失败不消耗普通用户历史分享总量；
- HTTP 202 不开始普通用户 2 小时有效期；
- 同一任务输出已有分享时返回原逻辑资源，不重复计数。

### 10.4 企业空间

企业任务必须在原企业空间分享：

- 当前个人模式不能分享企业任务；
- 当前企业 A 不能分享企业 B 的任务；
- 用户已退出企业或企业不可用时，沿用现有企业分享权限错误；
- 不允许回退到个人普通用户额度创建企业任务分享。

---

## 11. 公共播放与 HTTP Range

### 11.1 分享页面

`HtmlShareStaticController` 识别 `generated_video_file` 后返回专用页面：

```html
<video
  controls
  playsinline
  preload="metadata"
  src="/s/{shareId}/content/video">
</video>
```

要求：

- 不自动播放；
- 复用现有 LobsterAI 分享页标题、Logo、访问方式和下载入口；
- 标题和文件名严格 HTML 转义；
- CSP 增加 `media-src 'self'`，不加入 NOS 域名；
- 分享码验证成功前不返回视频内容；
- 管理员预览继续使用短期 preview token/cookie；
- 分享 shell 成功访问计数 1 次，视频分片请求不计访问次数。

Header 与文档、文本等支持下载的文件分享页保持同一信息架构：

| 区域 | 内容 | 规则 |
| --- | --- | --- |
| 左侧 | LobsterAI Logo 和品牌名 | 沿用现有分享页品牌链接 |
| 中间 | 视频文件名、文件大小 | 文件名单行省略并保留完整 `title`；不依赖 `ffprobe` 展示实际时长 |
| 右侧 | 下载当前视频图标、分隔线、“下载 LobsterAI” | 当前视频下载是主内容操作，客户端下载安装是产品操作 |

下载当前视频使用现有源文件下载图标，按钮尺寸、hover、focus 和无障碍标签复用文档/文本分享页；播放器下方不再重复显示文件信息和“下载视频”按钮。这样下载动作在不同文件分享页的位置一致，也能为播放器保留更多纵向空间。

响应式规则：

- 窄屏隐藏 Header 中间的文件信息，但保留下载当前视频图标；
- 超窄屏可以隐藏“下载 LobsterAI”次级按钮，但不能隐藏视频下载图标；
- 分享码验证前、分享关闭或过期时，不显示视频文件信息和视频下载图标；
- 管理员预览标识继续复用现有 Header 的居中展示规则，不挤占下载操作区。

### 11.2 为什么不能使用现有 `byte[]` 文件读取

当前 `HtmlShareService.getPublicFile()` 会把 NOS 内容完整读入 `byte[]`，`HtmlShareStaticController` 再一次性返回。对视频会导致：

- 服务端堆内存随视频并发线性增长；
- 浏览器不能可靠拖动进度；
- Range 请求无法正确返回 206；
- HEAD 也可能触发无意义的完整读取。

视频必须使用独立的流式内容路径，不能复用完整 `byte[]` 返回值。建议用更具体的 Controller mapping 返回 `StreamingResponseBody`；不要在现有返回 `ResponseEntity<byte[]>` 的 wildcard 方法里增加视频分支。

### 11.3 Range 协议

内容端点支持：

```http
GET  /s/{shareId}/content/video
HEAD /s/{shareId}/content/video
```

行为：

| 请求 | 响应 |
| --- | --- |
| 无 Range 的 GET | `200`，流式返回完整内容 |
| `Range: bytes=0-999` | `206`，返回指定范围 |
| `Range: bytes=1000-` | `206`，返回从 1000 到末尾 |
| `Range: bytes=-1000` | `206`，返回最后 1000 字节 |
| 越界或非法单范围 | `416`，带 `Content-Range: bytes */{size}` |
| 多范围请求 | 首期返回 `416`，不实现 multipart/byteranges |
| HEAD | 不返回 body，返回与 GET 一致的长度、类型和 Range 能力头 |

必要响应头：

```text
Accept-Ranges: bytes
Content-Type: video/mp4
Content-Length: 当前响应字节数
Content-Range: bytes start-end/total  # 仅206/416相应形式
Cache-Control: private, no-store
Vary: Cookie, Sec-Fetch-Site
X-Content-Type-Options: nosniff
```

### 11.4 NOS 代理

服务端根据绑定表读取内部 NOS URL，并把客户端 Range 传给 NOS。要求：

- 不返回 302 到 NOS；
- 不在 HTML、JSON、日志或错误页中输出 NOS URL；
- NOS 必须在上线前验证支持稳定的单 Range 和 HEAD；
- 上游返回长度、Content-Range 与数据库元数据不一致时拒绝或报警；
- 客户端断开时立即停止上游读取；
- 设置连接池、每请求超时和并发保护；
- 管理员预览也走同一代理，不获得永久 NOS 地址。

如果当前 NOS 下载端不支持 Range，这是上线阻断项，不能退化为每次读取完整视频到内存。

### 11.5 下载

分享页在 Header 保留“下载当前视频”操作，仍使用同一受保护内容端点：

```text
/s/{shareId}/content/video?download=1
```

服务端增加安全的 `Content-Disposition: attachment`，权限、分享码、失效、审核和管理员预览规则与播放完全一致。

该入口不新增 API，也不直接链接 NOS；页面只使用同源 URL。文件名由服务端通过 UTF-8 `Content-Disposition` 返回，Header 链接同时提供清晰的 `title` 和 `aria-label`。

---

## 12. 内容审核

### 12.1 审核原则

视频分享复用：

- `html_shares.moderation_status`；
- `html_share_moderation_items`；
- 异步审核重试；
- 管理员人工通过/拒绝；
- 拒绝后关闭分享；
- 访问量阈值复核。

但不能让现有文件循环把 `.mp4` 记录为 `skipped("unsupported moderation file type")` 后结束。视频需要专用审核分支。

### 12.2 审核输入

1. 分享标题：沿用现有 title 文本审核；
2. 生成提示词：从服务端任务 `request_params.prompt` 提取，不信任客户端回传；
3. 视频画面：使用持久化资产的临时本地文件均匀抽帧；
4. 音频：存在音轨时覆盖完整音轨，按照 ASR 单次处理上限切片后调用现有 ASR/文本审核链路；不得只截取开头片段，也不得仅因视频较长跳过审核或拒绝分享；
5. 不把供应商 URL、NOS URL、完整请求 JSON 或用户身份信息发送给审核模型。

抽帧建议：

```text
frameCount = min(15, max(3, ceil(durationSeconds)))
```

在视频时间轴均匀采样，避免只审核首帧。每帧单独计算哈希，并把时间点写入 `relative_path` 或审核 item metadata，例如：

```text
__video_frame__/00002500ms.jpg
```

首期不长期保存抽帧图片或音频文件；审核完成后删除临时文件，数据库保存哈希、时间点和审核结论。

### 12.3 审核 item 类型

建议新增：

```text
generation_prompt
video_frame
video_transcript
```

画面或转写审核拒绝时，沿用现有 moderation disable 流程。抽帧、解码或 ASR 发生无法确认的错误时进入 `review`/`error`，不能当作 `skipped` 或自动 `passed`。

审核是否在 `pending/review` 阶段限制公共访问，首期沿用现有文件分享统一策略，不为视频私自改变全局审核语义；如果产品未来要求“先审后播”，应作为分享系统统一策略另行变更。

### 12.4 审核资源边界

- 审核使用的 `ffmpeg` 设置超时和并发池；
- 抽帧最大 15 张；
- 视频最大 100 MiB；抽帧在完整时间轴上均匀采样，音频按审核服务容量分片，分别限制单任务处理超时和并发；
- 音频转写用于安全审核，不消耗用户 ASR 配额；
- 审核失败重试次数复用现有配置；
- 管理员预览可在审核异常时查看原视频，但仍不暴露 NOS URL。

---

## 13. 管理后台

### 13.1 列表

`lobsterai-admin` 分享管理新增来源筛选：

```text
generated_video_file -> 模型生成视频
```

现有状态、访问方式、审核状态、账号模式、访问量、创建时间筛选保持不变。

### 13.2 详情

服务端管理员详情增加只读视频信息：

```json
{
  "generatedVideo": {
    "taskId": 123,
    "outputIndex": 0,
    "modelId": "doubao-seedance-2-0-260128",
    "provider": "volcengine",
    "persistStatus": "persisted",
    "durationMs": 5000,
    "width": 1920,
    "height": 1080,
    "container": "mp4",
    "videoCodec": "h264",
    "audioCodec": "aac",
    "sizeBytes": 12345678,
    "sha256": "..."
  }
}
```

不得返回 `nosUrl` 和仍有效的供应商签名 URL。

### 13.3 预览与审核

- 详情页通过现有管理员 preview token 打开公共视频播放器；
- 审核明细展示生成提示词、抽帧时间点、画面结果和音频转写结果；
- 复用现有人工通过、拒绝、禁用、恢复和 review-action；
- 永久删除分享不删除 `media_generation_assets`；
- 管理员如果需要删除生成资产，必须走未来独立的媒体资产/隐私删除能力，不能复用分享删除按钮。

---

## 14. 生命周期与清理

### 14.1 生成资产生命周期

首期规则：

- 任务成功后持久化的资产不因订阅过期删除；
- 不因没有分享而删除；
- 不因分享被禁用、审核拒绝、固定期限到期或永久删除而删除；
- 不因用户切换个人/企业上下文改变归属；
- 账号注销、企业数据删除、法务删除按统一数据清理流程删除资产和 NOS 文件；
- 在正式定义生成资产保留期前，不新增自动过期任务。

### 14.2 分享生命周期

视频分享沿用现有：

```text
live
disabled
failed
deleted tombstone
```

分享记录和绑定关系可以保留为审计数据。永久删除后再次分享同一任务输出是否创建新逻辑资源，沿用其他文件的稳定来源和额度规则；任何新记录仍引用原生成资产，不重新上传 NOS。

### 14.3 NOS 清理防误删

现有 `HtmlSharePermanentDeletionService`、NOS 删除记录、分享更新清理逻辑必须识别 `generated_video_file`：

- 删除分享时不把生成资产 `nos_url` 写入 `html_share_nos_delete_files`；
- 不因为删除绑定关系调用 `NosUploadService` 对应删除能力；
- 生成资产删除只能由媒体资产所有者生命周期服务发起；
- 清理任务在执行前再次检查该 URL 是否属于生成资产，防止历史错误队列误删。

---

## 15. 安全设计与威胁模型

| 威胁 | 防护 |
| --- | --- |
| 本地视频冒充模型视频 | 分享 API 只接受任务身份；服务端校验任务归属、类型和成功状态 |
| Renderer 绕过隐藏按钮 | 主进程无文件上传 IPC；服务端专用 API 再校验 |
| 修改本地模型视频文件 | 分享内容来自服务端 NOS 资产，不读取本地文件 |
| 构造其他用户 taskId | 账号上下文 owner 查询；不存在与无权使用同一错误 |
| 个人/企业空间串用 | 同时校验 `account_mode` 和 `tob_enterprise_id` |
| 客户端传恶意 URL SSRF | 标准 API 没有 URL 字段；服务端只使用任务记录/供应商解析结果，并校验 HTTPS 与公网 IP，不配置供应商域名白名单 |
| 供应商 URL 重定向到内网 | 每跳重新校验协议、host 和解析 IP |
| 绕过分享码直连 NOS | 公共响应不返回 NOS URL，所有播放请求经同源鉴权代理 |
| Range 放大或内存耗尽 | 单 Range、流式转发、大小限制、并发池、超时和断连取消 |
| 伪造时长 | 客户端时长和 metadata 不参与分享准入，也不写入服务端资产事实字段 |
| 不支持的视频跳过审核 | 视频专用提示词/抽帧/音频审核，失败进入 review/error |
| 日志泄露签名 URL | 只记录 host 和 URL 哈希前缀，不记录完整 URL |
| 重复点击重复上传 | `(task_id, output_index)` 唯一键和数据库租约 |

服务端不能把“客户端没有提供上传字段”作为唯一安全条件；最终安全性来自任务所有权校验和服务端资产绑定。

---

## 16. Portal 与兼容性

### 16.1 Portal 不改

Portal 当前个人和企业媒体任务列表继续展示现有任务结果，不增加：

- 分享按钮；
- 视频分享弹窗；
- 资产准备轮询；
- NOS 上传；
- 分享管理入口。

### 16.2 服务端接口兼容

- `MediaTaskResponse.resultUrls` 保持原字段和原语义；
- 不把 NOS URL 替换进 `resultUrls`；
- 新增资产状态只通过视频分享专用 API 返回；
- 如未来在媒体任务响应增加可选 `assetStatus`，必须保证旧 Portal 忽略后仍正常工作；
- 现有图片、SVG、文档、Markdown、Mermaid 和 HTML multipart 分享行为不变；
- 现有分享 URL、分享码和管理 API 不改路径。

---

## 17. 配置与可观测性

### 17.1 建议配置

```properties
html-share.generated-video.enabled=${HTML_SHARE_GENERATED_VIDEO_ENABLED:false}
html-share.generated-video.max-file-bytes=104857600
html-share.generated-video.connect-timeout-ms=5000
html-share.generated-video.read-timeout-ms=120000
html-share.generated-video.download-timeout-ms=180000
html-share.generated-video.max-redirects=3
html-share.generated-video.max-attempts=5
html-share.generated-video.lease-seconds=300
html-share.moderation.generated-video.ffmpeg-path=ffmpeg
html-share.moderation.generated-video.max-frame-count=8
```

要求：

- 配置由启动期校验保证为正数和安全范围；
- 视频下载不依赖供应商域名配置，可信来源由服务端任务溯源保证；
- 客户端不硬编码字节限制和服务端重试次数；
- 视频持久化不探测时长、容器或编码，客户端也不得据此增加分享门槛；
- 所有实例使用同一配置；
- 只有启用视频内容审核时才要求审核环境提供可用的 `ffmpeg`，它不阻塞下载和 NOS 持久化。

### 17.2 日志

建议日志标签：

```text
[GeneratedVideoAsset]
[GeneratedVideoShare]
[GeneratedVideoPlayback]
```

记录：

- taskId、outputIndex、provider、assetId、shareId；
- 状态迁移、尝试次数、耗时、字节数；
- 地址刷新是否触发及结果；
- Range 起止和 HTTP 状态，但不记录 Cookie、分享码；
- 错误码和异常类型。

不记录：

- 完整供应商 URL；
- NOS URL；
- access token、供应商 API key；
- 完整 prompt；
- 分享码明文。

### 17.3 指标

建议至少增加：

```text
generated_video_asset_persist_started_total{provider,trigger}
generated_video_asset_persist_succeeded_total{provider}
generated_video_asset_persist_failed_total{provider,error_code,retryable}
generated_video_asset_persist_duration_seconds{provider}
generated_video_source_refresh_total{provider,result}
generated_video_share_create_total{account_mode,identity_type,result}
generated_video_share_prepare_seconds{historical}
generated_video_playback_requests_total{status,range}
generated_video_playback_bytes_total
generated_video_moderation_total{result}
```

需要为 `source_unavailable` 和任务成功后长时间未 `persisted` 设置告警。

---

## 18. 实施位置

### 18.1 LobsterAI

重点文件/模块：

```text
src/renderer/types/artifact.ts
src/renderer/services/artifactParser.ts
src/renderer/components/artifacts/artifactFileSharePolicy.ts
src/renderer/components/artifacts/ArtifactFileShareController.tsx
src/renderer/components/artifacts/ArtifactPanel.tsx
src/shared/htmlShare/constants.ts
src/main/preload.ts
src/main/main.ts
src/main/libs/htmlShare/htmlShareClient.ts
src/renderer/services/i18n.ts
src/renderer/types/electron.d.ts
```

建议把新增的 JSON API 调用和状态解析放到独立模块，例如：

```text
src/main/libs/htmlShare/generatedVideoShareClient.ts
```

不要继续向通用 zip packager 增加视频分支。

### 18.2 lobsterai-server

建议新增职责边界：

```text
GeneratedVideoAssetPersistenceService
GeneratedVideoAssetDownloadClient
GeneratedVideoMediaInspector
GeneratedVideoShareService
GeneratedVideoPlaybackService
GeneratedVideoModerationService（或现有审核服务的视频分支）
MediaGenerationAssetMapper
HtmlShareGeneratedVideoMapper
GeneratedVideoShareController（也可挂在 HtmlShareController 下）
```

需要修改：

- 所有媒体任务成功收口点；
- 供应商适配器的成功资产重新解析能力；
- 分享 source type 集合和额度统计；
- `HtmlShareStaticController` 视频 shell/内容路由；
- 分享访问统计入口；
- 管理员分享详情和虚拟文件信息；
- 内容审核和永久删除逻辑；
- Library 共享文件类型映射；
- `sql/schema.sql` 和新的 MySQL 5.7 迁移。

### 18.3 lobsterai-admin

重点文件/模块：

```text
src/api/htmlShares.ts
src/views/HtmlShareListView.vue
```

增加 source type 类型、筛选和中文标签；详情显示生成任务与技术 metadata；预览使用管理员 preview URL，不直接加载 NOS。

### 18.4 lobsterai-portal

无改动。

---

## 19. 发布顺序与迁移

### 19.1 发布顺序

1. 准备并验证 NOS 上传、NOS Range 能力；启用视频内容审核时另外验证 `ffmpeg`；
2. 上线 MySQL 5.7 兼容迁移；
3. 上线服务端资产持久化、历史刷新、专用分享 API 和播放代理；
4. 确认服务端开始为新成功任务自动创建资产；
5. 上线管理后台视频识别、预览和审核；
6. 上线 LobsterAI 客户端入口；
7. 灰度开启 `html-share.generated-video.enabled`；
8. 观察持久化成功率、源地址刷新失败和 Range 播放指标后全量。

服务端必须先于客户端发布。旧服务端收到新客户端请求时，客户端应把 404/功能关闭映射为“当前版本暂不支持视频分享”，不能回退到本地文件上传。

### 19.2 历史数据

上线迁移只建表，不全量下载历史视频：

- 新成功任务：自动持久化；
- 上线前历史任务：用户分享时创建资产并按需持久化；
- 可选运维脚本只能预建资产索引或统计可恢复数量，不得改变分享额度；
- 已过期且供应商不可恢复的任务保持无资产状态；
- 不从客户端收集本地副本做回填。

### 19.3 回滚

- 客户端入口可通过服务端功能开关关闭；
- 已持久化生成资产保留，不因功能关闭删除；
- 已创建视频分享在回滚前应先确认旧服务端是否能识别 source type，避免旧版本把视频当未知文件；
- 因此服务端回滚必须保持读取 `generated_video_file` 和安全禁用页面能力，或在回滚前统一禁用视频分享；
- 数据库新增表可保留，不做破坏性回滚。

---

## 20. 测试方案

### 20.1 服务端单元/集成测试

任务来源：

- 当前个人账号成功视频任务可以准备；
- 非当前用户 taskId 返回统一 not found；
- 个人/企业空间不一致被拒绝；
- image 任务、processing/failed/cancelled 视频任务被拒绝；
- outputIndex 越界被拒绝；
- 客户端伪造 URL、路径、hash 没有可接受字段。

资产准备：

- 原 URL 成功下载并上传 NOS；
- 原 URL 过期、供应商刷新成功；
- 原 URL 过期、供应商任务也不存在；
- NOS 临时失败进入重试；
- 重复事件/重复点击只上传一次；
- 租约过期可以恢复；
- 文件过大进入持久化失败，空响应进入下载重试；
- 非空供应商视频不因容器、编码、分辨率或时长被拒绝；
- `duration_ms` 等历史媒体元数据字段允许为空，且不会影响分享创建；
- 临时文件始终清理。

分享策略：

- 普通用户、各订阅套餐、企业额度与其他文件共同计数；
- 订阅过期后按普通用户策略创建；
- 资产准备中的请求不创建 `html_shares`；
- 同一任务输出幂等返回已有分享；
- generic multipart 不能创建 `generated_video_file`；
- 视频内容 update 被拒绝；
- 永久删除分享不产生生成资产 NOS 删除记录。

播放：

- 无 Range、固定范围、开放尾部、suffix、HEAD、越界、多范围；
- 分享码前后；
- disabled、expired、moderation rejected、管理员预览；
- NOS 404/5xx、长度不一致、客户端中断；
- 响应和页面不包含 NOS URL。

审核：

- prompt、抽帧、音频转写均通过；
- 任一画面拒绝关闭分享；
- 抽帧/解码/ASR 错误进入 review/error；
- 视频不能以 unsupported skipped 结束；
- 抽帧数量和临时文件清理符合限制。

### 20.2 LobsterAI 测试

- 含 `mediaOrigin` 的模型视频显示分享按钮；
- 本地附件、Library、本地文件视频不显示；
- `source = tool` 但无有效任务溯源不能直接分享；
- 三条成功路径都保留 taskId/outputIndex；
- 历史 URL 哈希唯一匹配后恢复；
- 无匹配/多匹配时失败且不上传；
- IPC 请求不包含 filePath、remoteUrl、Blob、archive；
- HTTP 202 显示准备状态并按服务端间隔轮询；
- 账号切换中止旧轮询；
- 普通用户、订阅和企业继续使用现有 quota/引导弹窗；
- 视频分享弹窗没有内容更新操作；
- 新旧服务端不兼容时不回退上传。

### 20.3 管理后台测试

- 来源筛选和标签正确；
- 详情 metadata 正确且无 NOS URL；
- preview token 可以播放，普通未授权访问不能绕过；
- 审核 item 正确展示；
- 禁用、恢复、拒绝、永久删除沿用现有权限和审计日志。

服务端部分测试可能依赖 Redis、NOS、供应商或媒体二进制。实现时以单元测试和可控 fake server 覆盖核心状态机；外部依赖不可用时记录未执行原因，不要求在当前测试环境强行运行真实联调。

---

## 21. 验收标准

### 21.1 功能验收

1. 新生成的 MP4 视频可以从客户端 Artifact 分享，并获得公开或分享码链接。
2. 分享请求的网络 payload 中没有本地视频内容、文件路径和结果 URL。
3. 用户导入完全相同内容的本地 MP4 后没有分享入口。
4. 用户修改模型视频本地文件后，分享链接仍播放服务端原生成结果。
5. 新任务供应商 URL 过期后，已持久化分享仍可播放。
6. 历史任务原 URL 有效时可以在首次分享时补存 NOS。
7. 历史任务原 URL 过期但供应商可刷新时可以恢复并分享。
8. 供应商也不可恢复时显示明确失败，不出现本地上传入口。
9. 服务端准确记录视频实际时长；短视频和未来模型生成的更长视频均不会仅因时长被拒绝。
10. 浏览器可拖动播放进度，Range 返回正确 206/416。
11. 页面源码、API 和浏览器跳转中不出现 NOS URL。
12. 订阅过期用户按普通文件分享额度处理；已创建权益型链接按现有宽限期处理。
13. 禁用或永久删除视频分享不删除生成资产；再次符合策略时仍可引用原资产。
14. Admin 可以筛选、预览、审核和禁用视频分享。
15. Portal 行为不变。

### 21.2 安全验收

```text
客户端本地视频 -> 无法成为分享内容
任意用户提供的 URL -> 无法成为分享下载源
其他用户/其他企业 taskId -> 无法查询或分享
分享码未验证 -> 无法请求任何视频字节
NOS URL -> 不对用户暴露
审核解码失败 -> 不会自动视为安全
```

### 21.3 数据一致性验收

- 每个 `(task_id, output_index)` 最多一个生成资产；
- 每个视频分享恰好一个生成资产绑定；
- `html_shares.source_sha256` 与绑定资产哈希一致；
- `persisted` 资产拥有完整 NOS URL、哈希、大小、时长和媒体格式；
- 分享删除不会创建该资产的 NOS 删除任务；
- 所有 DDL、查询和状态更新兼容 MySQL 5.7，不依赖外键、CHECK、窗口函数或 MySQL 8 JSON 表函数。

---

## 22. 最终实施边界

本功能看起来与其他文件分享相同，但实现上必须保持两条不同的数据入口：

```text
普通文件分享：
  客户端内容 -> zip/multipart -> 服务端校验 -> 分享文件 NOS

模型视频分享：
  服务端任务身份 -> 服务端生成资产 NOS -> 分享只读引用
```

可以复用的是分享产品能力：账号策略、额度、访问方式、状态、审核框架、统计、公共品牌页和管理员治理。

不能复用的是客户端上传和内容更新链路。只要这一边界不被打破，就能同时满足：

- 入口体验与其他文件一致；
- 本地视频绝对不能分享；
- 分享内容一定来自平台视频模型任务；
- 供应商临时地址过期后，已经持久化的视频仍能长期访问。

---

## 23. 实施记录（2026-09-01）

本方案已经在以下三个项目落地：

- `LobsterAI`：保留视频生成任务的 `taskId + outputIndex` 溯源信息；只对模型视频展示分享能力；通过专用 IPC/API 创建和查询分享；旧消息只把结果 URL 的 SHA-256 交给服务端反查，不上传本地视频或提交结果 URL。
- `lobsterai-server`：新增 MySQL 5.7 兼容迁移 `sql/V84__generated_video_share.sql`、生成资产异步持久化、供应商地址刷新、专用分享接口、同源 Range 播放代理、提示词/抽帧/音轨审核以及 Admin 元数据接口。
- `lobsterai-admin`：新增模型生成视频筛选、生成资产元数据和审核项展示；预览继续使用现有 Admin 临时预览令牌，不返回 NOS URL。

`lobsterai-portal` 未修改。视频分享不进入现有 multipart 文件上传和文件内容更新接口。

发布前需要完成：

1. 先执行 `V84__generated_video_share.sql`，再部署服务端和管理后台，最后部署客户端；
2. 确认 NOS 上传和 Range 播放可用；启用视频内容审核时确认审核环境有可用的 `ffmpeg`；
3. 先保持 `HTML_SHARE_GENERATED_VIDEO_ENABLED=false`，完成 NOS、供应商刷新、审核和 Range 联调后再灰度开启；
4. 如需为某个上线时间之后的成功任务自动补偿持久化，配置 `HTML_SHARE_GENERATED_VIDEO_AUTO_PERSIST_CREATED_AFTER`；历史任务仍默认在分享时按需补存。

当前代码验证结果：

- LobsterAI 视频来源、分享策略、客户端 API 与本地资产持久化定向测试：151 项通过；
- LobsterAI 变更 TypeScript/TSX ESLint：通过；
- LobsterAI Electron 主进程编译和生产构建：通过；
- `lobsterai-server` `compileJava`：通过；
- `lobsterai-admin` Vue TypeScript 类型检查与变更文件 ESLint：通过；
- 按约定未执行依赖 Redis、NOS、供应商或媒体二进制的服务端测试，仍需在测试环境完成第 20、21 节中的外部联调验收。
