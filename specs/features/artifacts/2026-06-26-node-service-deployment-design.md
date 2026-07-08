# 动态 Node 服务本地服务分享部署设计文档

## 1. 概述

### 1.1 背景

本地服务分享允许用户把本机正在运行的 Web 服务，例如 `http://localhost:3000`，打包部署到服务端，并生成一个公网可访问的分享链接。动态 Node 服务链路面向需要运行时进程的项目，包括 Express/Koa/NestJS/Fastify、自定义 Node HTTP 服务、Next SSR standalone、Nuxt/Nitro SSR 等。

动态 Node 服务与普通 HTML/图片/Markdown 分享的关键差异：

| 项目 | 普通静态分享 | 动态 Node 服务分享 |
| ---- | ------------ | ------------------ |
| 上传内容 | 静态文件或 artifact 包 | 可运行的 Node 服务部署包 |
| 服务端运行资源 | 不需要 | 需要云函数/运行时资源 |
| 访问方式 | 读取对象存储内容 | 通过独立 share host 反向代理到运行时 |
| 资源限制 | 用户总分享限制 | 用户总分享限制 + 动态服务活跃部署限制 |
| 当前动态服务活跃限制 | 不适用 | 每个用户最多 3 个 |

静态构建产物已经有独立优化方案，见 `2026-06-26-static-service-deployment-optimization-design.md`。本文只描述 `node_service` / `runtimeLanguage = node` 的动态服务链路。

### 1.2 目标

1. 用户通过同一个“本地服务分享”入口创建动态 Node 服务部署。
2. 客户端自动发现项目目录，分析 package manager、Node 版本、构建命令、启动命令和监听端口。
3. 客户端在本地临时目录执行 install/build，生成可部署 zip，不污染用户项目目录。
4. 服务端保存分享记录和部署记录，异步创建云端运行资源。
5. 分享 URL 使用独立 service host，支持根路径、API 路径、Cookie 和前端路由。
6. 访问分享时先通过分享状态、分享码和审核控制，再代理到云端运行时。
7. 动态服务最多保留 3 个活跃部署，超过后停止最旧活跃部署并清理云资源。

### 1.3 非目标

| 非目标 | 说明 |
| ------ | ---- |
| 本机端口穿透 | 不直接暴露用户本机服务，必须上传部署包 |
| 远端构建 | 首版构建发生在 Electron 客户端临时目录 |
| 多语言运行时 | 当前动态服务实现只支持 Node；Python/Go 字段为后续预留 |
| 静态产物托管 | 静态站点走 `static_site` 链路，不应占用动态服务配额 |
| 用户自定义环境变量 | 数据表和 manifest 字段有预留，当前主链路未开放完整 UI/API |

## 2. 支持范围

### 2.1 支持的项目类型

| 类型 | 判定/打包方式 | 最终启动命令 |
| ---- | ------------- | ------------ |
| Express/Koa/NestJS/Fastify/自定义 Node 服务 | 没有可识别优化输出时，复制项目、安装依赖、构建、裁剪生产依赖后打包 | `npm/pnpm/yarn run start/serve/dev` |
| Next.js SSR standalone | 构建后存在 `.next/standalone/server.js` | `node server.js` |
| Nuxt/Nitro SSR | 构建后存在 `.output/server/index.mjs` | `node .output/server/index.mjs` |
| 其他需要运行时的 Node Web 服务 | 依赖 package scripts 和监听端口配置 | 用户确认的启动命令 |

### 2.2 静态项目分流

Vite、Create React App、Vue CLI、Angular、Astro、Parcel、Svelte Vite 以及 Next static export 等如果最终产物为纯静态文件，应由客户端打包后上传到 `/api/share-deployments/static`。动态 Node 服务链路只处理仍需运行 Node 进程的项目。

## 3. 总体流程

```text
Renderer 本地服务分享入口
  ↓
Main: detectProjectCandidates / analyzeProjectDirectory
  ↓
用户确认项目目录、访问方式、构建/启动配置
  ↓
Main: packageNodeServiceDeployment
  ↓
Main: uploadNodeDeployment -> POST /api/share-deployments/node
  ↓
Server: 创建/复用 HtmlShare，创建 share_deployments queued 记录
  ↓
Server async worker: provider.deploy
  ↓
Volcengine veFaaS/API Gateway 创建运行资源
  ↓
Deployment 标记 live，返回 service host URL
  ↓
访问 service host -> 分享鉴权 -> 反向代理到 runtime URL
```

## 4. 客户端设计

### 4.1 IPC

共享常量位于：

```text
src/shared/shareDeployment/constants.ts
```

当前 IPC：

| IPC | 用途 |
| --- | ---- |
| `shareDeployment:detectProjectCandidates` | 根据本地服务 URL 和工作目录推测项目目录 |
| `shareDeployment:analyzeProjectDirectory` | 分析指定项目目录的部署配置 |
| `shareDeployment:createNodeDeployment` | 创建本地服务部署；内部可按产物分流为 Node 或 static |
| `shareDeployment:get` | 查询部署详情 |
| `shareDeployment:getByLocalService` | 根据本地服务来源查找已有部署 |

首版保留 `createNodeDeployment` 命名以兼容 UI。长期可新增 `createLocalServiceDeployment`，但不应破坏旧 IPC。

### 4.2 项目目录发现

实现文件：

```text
src/main/libs/shareDeployment/nodeServiceProjectAnalyzer.ts
```

发现策略：

1. 从本地服务 URL 解析端口。
2. macOS/Linux 上使用 `lsof` 查找监听该端口的进程，再通过进程 cwd 向上寻找最近的 `package.json`。
3. 从当前 workspace 向上寻找最近的 Node 项目。
4. 扫描 workspace 子目录，最大深度 3，最多 300 个目录。
5. 过滤系统根目录、用户 home、Desktop/Documents/Downloads、临时目录等高风险根路径。

候选目录必须满足：

- 是目录；
- 包含 `package.json`；
- 存在可运行脚本，或 Next/Nuxt/静态框架存在 build 脚本；
- 不在受保护根目录中。

### 4.3 项目分析

分析输出 `ShareDeploymentProjectAnalysis`，包含：

| 字段 | 来源/规则 |
| ---- | --------- |
| `packageManager` | `pnpm-lock.yaml` -> pnpm；`yarn.lock` -> yarn；否则 npm |
| `installCommand` | pnpm/yarn 使用 frozen lockfile；npm 使用 `npm ci` |
| `buildCommand` | 存在 `scripts.build` 时为对应 package manager 的 run 命令 |
| `startCommand` | Next -> `node server.js`；Nuxt -> `node .output/server/index.mjs`；否则 start/serve/dev |
| `nodeVersion` | 从 `engines.node` 解析 18/20/22，默认 20 |
| `port` | 从本地服务 URL 解析 |
| `totalFiles/totalBytes` | 预构建源文件体积估算 |
| `warnings/blockers` | 缺少 lockfile、只有 dev 脚本、目录/端口不合法等 |

源文件收集会排除：

```text
node_modules
.next / .nuxt / .svelte-kit / .output / dist / build / out
.git / .hg / .svn
.vite / .cache / .turbo / .vercel / .serverless
coverage / tmp / temp / logs
.env*
secret/credential/token/private-key 命名文件
系统临时文件和符号链接
```

### 4.4 客户端构建与打包

实现文件：

```text
src/main/libs/shareDeployment/nodeServiceDeploymentPackager.ts
```

步骤：

1. 在系统临时目录创建构建根目录。
2. 复制分析阶段收集的源文件到临时项目目录。
3. 清理旧构建产物目录。
4. 执行安装命令。
5. 执行构建命令，环境变量包含：
   - `CI=true`
   - `NODE_ENV=production`
   - `PORT=<确认端口>`
   - `HOST=0.0.0.0`
   - `HOSTNAME=0.0.0.0`
6. 检查优化输出：
   - Next standalone：打包 `.next/standalone`、`.next/static`、`public`。
   - Nitro：打包 `.output`。
   - 静态输出：转入静态部署链路。
7. 未命中优化输出时执行生产依赖裁剪：
   - npm: `npm prune --omit=dev`
   - pnpm: `pnpm prune --prod`
   - yarn: 当前不自动 prune。
8. 收集部署目录并写入 `deployment.zip`。
9. 计算 zip SHA-256，返回 `archivePath/sourceSha256/archiveBytes`。

客户端限制：

| 限制 | 当前值 |
| ---- | ------ |
| 源文件总量 | 100 MB |
| 部署目录总量 | 500 MB |
| zip 大小 | 100 MB |
| 文件数 | 50,000 |
| 单条命令超时 | 10 分钟 |
| 命令输出错误摘要 | 保留尾部 4,000 字符，Next document 错误会做专项精简 |

## 5. 上传协议

实现文件：

```text
src/main/libs/shareDeployment/shareDeploymentClient.ts
```

动态 Node 服务上传接口：

```http
POST /api/share-deployments/node
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

字段：

| 字段 | 必填 | 说明 |
| ---- | ---- | ---- |
| `sessionId` | 否 | Cowork session ID |
| `artifactId` | 否 | local-service artifact ID |
| `title` | 是 | 分享标题 |
| `accessMode` | 否 | `code` 或 `public` |
| `clientSourceKey` | 否 | 同一项目稳定来源 key，用于复用分享 |
| `sourceSha256` | 是 | zip SHA-256 |
| `manifest` | 是 | 部署 manifest JSON |
| `sourceArchive` | 是 | `deployment.zip` |

manifest 示例：

```json
{
  "schemaVersion": 1,
  "deploymentKind": "node_service",
  "runtimeLanguage": "node",
  "runtimeVersion": "20",
  "packageManager": "npm",
  "installCommand": "npm ci",
  "buildCommand": "npm run build",
  "startCommand": "node server.js",
  "listenPort": 3000,
  "healthPath": "/",
  "projectRootName": "my-api",
  "projectRootHash": "a1b2c3d4e5f6",
  "includedFileCount": 120,
  "estimatedSourceArchiveBytes": 456789,
  "localServiceUrl": "http://localhost:3000/",
  "env": []
}
```

响应映射为 `ShareDeploymentRecord`，关键字段：

| 字段 | 说明 |
| ---- | ---- |
| `deploymentId` | 部署业务 ID |
| `shareId` | 分享 ID |
| `url` | 独立 service host URL |
| `status/deploymentStatus` | `queued/deploying/live/deploy_failed/stopped` 等 |
| `runtimeLanguage` | `node` |
| `runtimeVersion` | Node 版本 |
| `provider` | 当前为 `volcengine_vefaas` |
| `providerResourceId` | 云函数资源 ID |
| `providerEndpoint` | 脱敏后的运行时 URL |
| `events` | 部署事件 |

### 5.1 来源 key 和复用

当前 Node 服务主 key：

```text
sha256("service-deployment:v3:<normalized-project-directory>")
```

兼容查询顺序：

1. 静态部署 source key。
2. Node v3 source key。
3. Node v2 source key，包含项目目录和 local service origin。
4. legacy source key，包含 sessionId 和完整 local service URL。

动态 Node 重新部署成功后，同一 `shareId` 的旧 active deployment 会被置为 inactive/stop，并保留新的 active 版本。

## 6. 服务端设计

服务端代码目录：

```text
/Users/admin/Documents/lobsterai/lobsterai-server
```

### 6.1 Controller

入口：

```text
src/main/java/com/youdao/lobsterai/web/controller/ShareDeploymentController.java
```

接口：

```http
POST /api/share-deployments/node
GET  /api/share-deployments/{deploymentId}
```

Controller 负责解析 multipart、从 JWT 解析用户 ID，然后转交 `ShareDeploymentService`。

### 6.2 创建部署

实现：

```text
src/main/java/com/youdao/lobsterai/service/sharedeployment/ShareDeploymentService.java
```

`createNodeDeployment()` 的职责：

1. 校验 `share-deployment.enabled`。
2. 校验 zip 非空且不超过 `maxSourceArchiveBytes`。
3. 解析 manifest。
4. 校验：
   - `runtimeLanguage` 必须是 `node`；
   - `startCommand` 必须存在；
   - `listenPort` 必须在 1024-65535，且不能是 9000/9001/9990。
5. 调用 `HtmlShareService.createDeploymentShareRecord()` 创建或复用 `node_service_deployment` 分享记录。
6. 持久化 zip 到本地 archive 目录。
7. 插入 `share_deployments` 记录，初始状态为 `queued`、`active=false`。
8. 写入 `queued` 事件。
9. 事务提交后调用 `ShareDeploymentWorkerService.deployAsync(deploymentId)`。

### 6.3 分享记录

动态服务复用 HTML 分享的访问控制模型：

| 字段 | 动态服务值 |
| ---- | ---------- |
| `source_type` | `node_service_deployment` |
| `entry_file` | `/` |
| `status` | `live/disabled/failed` |
| `access_mode` | `code/public` |
| `public_url` | service host URL |

分享码、公开访问、关闭/开启分享、管理员禁用、审核拒绝等状态沿用 HTML 分享表和接口。

### 6.4 部署记录和事件

主要表：

```text
share_deployments
share_deployment_events
```

`share_deployments` 关键字段：

| 字段 | 说明 |
| ---- | ---- |
| `deployment_id` | `dep_...` |
| `share_id` | 关联 HTML share |
| `source_type` | `node_service_deployment` |
| `runtime_language` | `node` |
| `runtime_version` | Node 版本 |
| `provider` | `volcengine_vefaas` |
| `status` | 部署状态 |
| `active` | 当前 share 生效版本 |
| `start_command` | 云端启动命令 |
| `listen_port` | 云端监听端口 |
| `provider_resource_id` | 云函数 ID |
| `provider_revision_id` | release/route/upstream 元数据 |
| `provider_runtime_url` | 内部运行时访问入口 |
| `source_archive_url` | 服务端本地临时 zip 路径 |
| `expires_at` | 当前新部署为 null；历史迁移需保证字段可空 |

事件表记录 `queued/deploy_started/live/deploy_failed/stopped/cleanup_failed` 等阶段。

## 7. 异步部署 Worker

实现：

```text
src/main/java/com/youdao/lobsterai/service/sharedeployment/ShareDeploymentWorkerService.java
```

流程：

1. `deployAsync()` 根据 deploymentId 读取部署记录。
2. `deploy()` 标记 `deploying`，记录 `deploy_started`。
3. 查找同一 `shareId` 和同一 `clientSourceKey` 的旧 active deployments。
4. 调用 `ShareDeploymentProvider.deploy(deployment)` 创建云资源。
5. 部署成功后：
   - 先把同一 share 的旧 deployments 置为 inactive；
   - 当前 deployment 标记为 `live`、`active=true`；
   - 写入 provider resource/revision/runtime URL；
   - 记录 `live` 事件。
6. 停止被替换的旧 active deployments 并清理云资源。
7. 执行用户级活跃动态服务数量限制，超过 3 个时停止最旧的 active Node deployment。
8. finally 中删除本地 archive zip。

失败时：

- 标记 `deploy_failed`。
- 记录 `failure_code/failure_message`。
- 尝试清理已创建的云资源。

## 8. Provider 设计

抽象：

```text
ShareDeploymentProvider.deploy(deployment): ProviderDeploymentResult
ShareDeploymentProvider.stop(deployment): void
```

当前实现：

```text
src/main/java/com/youdao/lobsterai/service/sharedeployment/VolcengineVefaasDeploymentProvider.java
```

部署步骤：

1. 校验火山云凭据。
2. 解压客户端上传的 source archive 到临时 build root。
3. 生成 provider deployment package。
4. 创建 veFaaS function：
   - Runtime: `native-node20/v1`
   - Command: `sh ./run.sh`
   - Port: manifest listen port
   - Env: `NODE_ENV=production`、`PORT`、`HOST=0.0.0.0`
   - Memory: 默认 1024 MB
   - Request timeout: 默认 60s
   - MaxConcurrency: 10
   - EnableSharedInternetAccess: true
5. release direct zip revision。
6. 如配置了 API Gateway，则创建 upstream 和 route：
   - route prefix: `{routePrefix}/{deploymentId}/`
   - method: GET/POST/PUT/DELETE/HEAD/OPTIONS/PATCH
   - URL rewrite 到 `/`
7. 解析 runtime URL：
   - 优先 API Gateway URL；
   - 其次 `runtimeUrlTemplate`；
   - 再从 create/release/getFunction/listTriggers 响应中寻找 URL。
8. 返回 provider resource ID、revision metadata、runtime URL。

停止部署：

1. 从 `providerRevisionId` 解析 route/upstream。
2. 删除 API Gateway route/upstream。
3. 删除 veFaaS function。

## 9. Service Host 和代理

host 生成：

```text
{scheme}://{shareId-with-dashes}-share-service.{serviceHostSuffix}/
```

示例：

```text
https://shr-b25df9ca33df4d5f-share-service.example.com/
```

实现：

```text
ShareDeploymentHostService
ShareDeploymentServiceHostFilter
NodeServiceDeploymentProxyService
```

请求处理：

1. Filter 从 Host 解析 `shareId`。
2. 不是 service host 时放行给普通 Spring 路由。
3. 读取 `HtmlShare`，确认 `source_type=node_service_deployment` 且分享未关闭。
4. 如分享码模式且无有效 cookie：
   - `/` GET 返回分享码页面；
   - `/_lobster_share/verify` 校验分享码并写 cookie；
   - 其他路径返回 403。
5. 读取 active deployment。
6. deployment 为 `live` 且存在 `providerRuntimeUrl` 时，反向代理到云运行时。
7. 非 live 状态返回部署状态页，例如创建中、失败、已停止。

动态代理支持方法：

```text
GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS
```

代理行为：

- 保留请求 path 和 query。
- 透传请求 body。
- 跳过 hop-by-hop headers 和 `Authorization`。
- 添加 `X-Forwarded-For`、`X-Forwarded-Host`、`X-Forwarded-Proto`、`X-Lobster-Share-Id`。
- 响应侧过滤 hop-by-hop headers。
- `Set-Cookie` 去掉 Domain，确保 Path 默认 `/`。
- `Location` 按运行时 URL 做 share host 语义重写。
- 添加安全响应头：
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`

## 10. 配额和资源回收

配置：

```text
share-deployment.max-active-deployments-per-user = 3
```

规则：

1. 新 deployment live 后，同一 share 的旧 active deployment 会被停止。
2. 同一 source key 的旧 active deployment 会被停止。
3. 如果用户 active Node deployment 总数超过 3，按 `created_at ASC, id ASC` 停止最旧部署。
4. 停止包含数据库状态更新和 provider 云资源删除。
5. 清理失败时记录 `cleanup_failed` 事件，不阻塞当前新部署 live。

静态部署不参与这个动态服务限制。

## 11. 安全设计

| 风险 | 当前控制 |
| ---- | -------- |
| 上传敏感文件 | 客户端排除 `.env*`、secret/credential/token/private-key 文件、VCS、缓存目录和符号链接 |
| 上传过大项目 | 客户端和服务端都有 zip/文件数/总大小限制 |
| 直接暴露本机服务 | 不做端口穿透，只上传部署包 |
| 分享码绕过 | service host 请求先走 HtmlShare 鉴权 |
| Cookie 串域 | 独立 share host；代理重写 `Set-Cookie`，去掉 Domain |
| API 路径冲突 | 动态服务使用独立 host，不占用 `/s/{shareId}` 或 LobsterAI `/api/*` |
| 云资源泄露 | 替换、超额、失败时调用 provider stop/cleanup |
| Header 注入 | 代理校验 header name，过滤控制字符和 hop-by-hop header |

## 12. 状态机

```text
queued
  ↓
deploying
  ↓ success
live
  ↓ replaced / limit / admin
stopped

queued/deploying
  ↓ failure
deploy_failed
```

说明：

- 当前实现没有独立远端健康检查探测；provider release 成功且 runtime URL 可解析后即标记 `live`，并设置 `health_checked_at`。
- `expiresAt` 当前新部署为 null，不按时间自动过期。

## 13. 可观测性

部署事件：

| stage | 说明 |
| ----- | ---- |
| `queued` | 请求已入队 |
| `deploy_started` | 开始创建服务 |
| `live` | 部署可访问 |
| `deploy_failed` | 部署失败 |
| `stopped` | 被替换、超额或管理员停止 |
| `cleanup_failed` | 旧资源清理失败 |

客户端展示：

- 上传中；
- 部署中；
- live 链接；
- 失败信息；
- 分享码/公开访问/停止分享状态。

服务端日志应包含模块标签和 deploymentId/shareId，不应打印敏感凭据或完整用户 token。

## 14. 部署后默认页面审核方案

动态 Node 服务不会把源码或构建产物拆成 `html_share_files` 上传到 NOS，因此不能直接复用普通 HTML 分享的逐文件审核。当前方案复用 HTML 分享的审核状态机和模型调用，但审核对象改为“部署成功后的默认页面内容”。

### 14.1 触发时机

1. `ShareDeploymentWorkerService.deploy()` 在 provider 部署成功后，把 deployment 标记为 `live`。
2. 标记 live 后立即调度异步审核任务，不阻塞当前部署成功返回。
3. 异步任务默认延迟 10 秒再执行，用于等待云函数/API Gateway 路由和 Node 进程完成冷启动。
4. 延迟结束后调用现有 `HtmlShareModerationService.moderateShare(shareId)`。

配置项：

```properties
html-share.moderation.node-service.enabled=true
html-share.moderation.node-service.path=/
html-share.moderation.node-service.initial-delay-ms=10000
html-share.moderation.node-service.fetch-timeout-ms=8000
html-share.moderation.node-service.max-response-bytes=1048576
html-share.moderation.node-service.max-redirects=3
```

### 14.2 抓取对象

服务端读取当前 `shareId` 的 active deployment，只有满足以下条件才抓取：

- `source_type = node_service_deployment`
- `runtime_language = node`
- `status = live`
- `provider_runtime_url` 非空

抓取 URL 为 `provider_runtime_url + node-service.path`，默认访问 `/`。这里访问 provider runtime URL，不访问公网 service host，避免分享码页、cookie 校验或 host rewrite 干扰审核结果。

抓取策略：

- HTTP `GET`，请求头包含 `User-Agent: LobsterAI-Share-Moderation/1.0` 和文本优先的 `Accept`。
- 超时默认 8 秒。
- 响应体最多读取 1 MB，超过后记为审核错误。
- 最多跟随 3 次重定向。
- 只允许同源重定向，跨域重定向记为审核错误。
- 按响应 `Content-Type` 的 charset 解码，缺省使用 UTF-8。

### 14.3 审核范围和状态映射

当前首版只审核默认页面的文本类响应：

| 场景 | moderation item type | 分享审核状态影响 |
| ---- | -------------------- | ---------------- |
| 2xx/3xx/4xx 文本、HTML、JSON、XML、JS 响应且 body 非空 | `node_service_home_html`；404 记录为 `node_service_home_not_found` | 调用文本审核模型，按模型结果 pass/review/reject/error 处理 |
| 401/403 | `node_service_home_auth_required` | 进入 review |
| 5xx | `node_service_home_error` | 进入 error |
| 默认页为空 | `node_service_home_empty` | 进入 review |
| 非文本响应 | `node_service_home_skipped` | 不单独阻断 |
| deployment 不可用、抓取失败、跨域重定向、超过大小限制 | `node_service_home_error` | 进入 error |
| 审核开关关闭 | `node_service_home_skipped` | 不单独阻断 |

如果文本模型返回 reject，服务端调用现有 `html_shares.disableByModeration()` 禁用分享；service host 访问会被 HTML 分享状态拦截。review/error/passed 继续写入 `html_shares.moderation_status`、`moderation_checked_at`、`moderation_reason` 和 `moderation_model`。

### 14.4 重试和一致性

- 首次 live 后的延迟审核负责覆盖正常路径。
- 现有审核重试任务会继续扫描 `pending/error` 状态的分享；动态服务再次进入 `moderateShare()` 时会重新读取 active deployment 并重新抓取默认页。
- 每条审核 item 仍带 `share_source_sha256` 和 `share_content_updated_at`，写最终状态前会检查分享版本是否仍是当前版本，避免旧部署审核结果覆盖新版本。
- Node 服务源码和部署包本身首版不做模型审核；客户端已有敏感文件排除和大小限制负责上传前约束。

### 14.5 后续优化

1. 对默认页截图做视觉审核，覆盖纯图片、Canvas 或动态渲染内容。
2. 支持配置多个审核路径，例如 `/`、`/health`、用户 manifest 指定页面。
3. 对服务端渲染页面提取可见文本，减少 HTML 标签和脚本对模型上下文的干扰。
4. 在 provider live 后增加健康检查，把审核延迟从固定时间优化为“健康检查通过后触发”。

## 15. 已知限制和后续优化

1. 构建发生在客户端，用户本机 Node/package manager 环境会影响成功率。
2. npm/pnpm 支持生产依赖裁剪；yarn 暂不自动裁剪。
3. `env` manifest 和 `share_deployment_env_vars` 表存在预留，但产品 UI/API 尚未完整开放。
4. 当前 live 判定依赖 provider release 成功和 runtime URL 解析，没有独立 HTTP health probe。
5. 构建日志只通过错误摘要返回给客户端，服务端没有完整构建日志，因为构建发生在客户端。
6. veFaaS runtime 当前固定要求 `native-node20/v1`，Node 18/22 的 manifest 主要用于客户端分析和后续扩展。
7. 动态服务使用云资源，成本和并发能力需要继续结合真实访问量做策略调优。
8. 动态服务首版只审核默认页面文本响应，源码、完整路由和截图审核属于后续增强。

## 16. 验收标准

1. Express/Koa/NestJS/Fastify 等普通 Node Web 服务可以通过本地服务分享部署并访问 `/api/*`。
2. Next standalone 构建后上传优化包，云端以 `node server.js` 启动。
3. Nuxt/Nitro 构建后上传 `.output`，云端以 `node .output/server/index.mjs` 启动。
4. 分享链接使用独立 service host，不通过 `/s/{shareId}/` 访问。
5. 分享码、公开访问、关闭分享、重新开启分享和访问模式切换与 HTML 分享一致。
6. 替换同一分享时旧云资源被停止，当前部署保持 active。
7. 用户 active Node deployment 超过 3 个时，最旧部署被停止。
8. 静态站点不会进入 `/api/share-deployments/node`，不会占用动态服务 3 个限制。
9. Node deployment live 后异步延迟抓取默认页，并把文本审核结果写入 HTML 分享审核状态。
