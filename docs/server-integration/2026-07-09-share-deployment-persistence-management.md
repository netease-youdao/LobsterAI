# 服务部署数据管理 Spec

> 客户端交互方案更新：2026-07-14

## 背景

当前 Node 服务分享部署已经支持通过火山云 NAS + veFaaS 实现轻量级文件系统持久化。客户端会自动识别常见本地数据路径，例如 `data/`、`uploads/`、`storage/`、`*.sqlite`，并在部署 manifest 中写入 `persistence.bindings`。

现状的问题是：用户无法参与决策，也无法在部署后管理线上服务数据。对于问卷统计、排行榜、本地数据文件这类轻量级服务，自动识别可以降低门槛，但以下场景必须给用户明确控制：

- 用户想选择哪些本地目录或文件需要在更新服务后继续保留。
- 用户想关闭自动识别出的路径。
- 用户想下载线上服务数据，用于备份、排查或本地迁移。
- 功能迭代导致数据保存方式变化，需要先下载线上服务数据进行备份和排查。
- 功能迭代后，用户想明确使用当前项目中的本地数据替换线上服务数据。

本 spec 设计客户端和服务端协作方案。目标是保持“用户不需要理解数据库、NAS、VPC”的产品体验，同时给有数据风险的操作提供足够明确的控制和确认。工程实现仍使用 `persistence` 命名，用户默认只看到“服务数据”“线上服务数据”“数据空间”等产品语言。

客户端必须明确区分两个对象：

- **本地保存位置**：用户在当前项目中选择的文件或文件夹，例如 `data/`。首次部署时，其中的内容可以用于初始化线上服务数据。
- **线上服务数据**：已部署服务运行过程中在这些位置产生或修改的数据。更新代码时默认保留，不由新部署包覆盖。

“排行榜、问卷结果、上传内容”只能作为可能的数据示例，不能直接等同于用户当前服务中的真实数据，也不能用来替代“线上服务数据”这一主体。

## 目标

1. 服务部署前，用户可以确认、添加、删除需要保存的本地内容。
2. 自动识别从“无感直接生效”改为“自动选择 + 用户可查看/可修改”，最终以用户确认结果为准。
3. 更新服务默认保留线上服务数据，不由新部署包覆盖。
4. 支持下载线上服务数据到本地备份目录。
5. 支持查看、下载线上服务数据，并在重新部署时显式选择是否用本地数据替换。
6. 对本地数据文件和数据结构变化提供明确工作流。
7. V1 默认不暴露 NAS、VPC、挂载点、SQLite、schema 等技术概念；仅在高级详情中显示。

## 非目标

- V1 不做在线 SQL migration runner。
- V1 不做线上文件浏览器的逐文件编辑。
- V1 不支持多个云存储 provider，仍只支持 `filesystem`。
- V1 不支持跨分享复用同一份数据。
- V1 不做精确实时用量统计，允许服务端返回估算值或最近一次扫描值。
- V1 客户端不提供“应用到项目”或上传任意备份 ZIP 替换线上服务数据。

## 用户体验

### 产品原则

目标用户是非技术用户。默认交互必须回答四个问题：

1. 这个服务会不会保存用户数据。
2. 更新服务后，这些数据会不会丢。
3. 首次部署时，本地哪些内容会作为线上服务数据的初始内容。
4. 我能不能下载备份，或在重新部署时用本地数据替换这些数据。

默认 UI 不直接出现以下词语：

- 持久化。
- NAS、VPC、挂载点、Provider、binding、mount path。
- SQLite、schema、migration。
- 云端路径、远端目录。

这些概念可以出现在“高级详情”“问题诊断”“开发者日志”中。

用户侧术语映射：

| 工程概念 | 用户侧文案 |
|---|---|
| persistence | 服务数据保留 |
| persistent data | 服务数据 |
| selected local binding | 本地保存位置 |
| remote/cloud data | 线上服务数据 |
| download remote archive | 下载线上服务数据 |
| quota | 数据空间 |
| SQLite/schema migration | 数据保存方式发生变化 |

交互分三层：

| 层级 | 面向用户 | 展示内容 |
|---|---|---|
| 默认层 | 所有用户 | 是否保留服务数据、更新服务是否保留线上已有数据 |
| 查看层 | 关心数据的用户 | 当前选择了哪些本地保存位置、可添加/移除 |
| 高级层 | 开发者或客服排障 | 技术路径、云端目录、策略、诊断信息 |

### 客户端信息架构

服务部署相关交互分为三个页面状态，职责不能混在同一个弹窗中：

| 页面状态 | 进入方式 | 主要职责 |
|---|---|---|
| 首次部署确认 | 尚无部署记录时点击分享 | 确认项目、启动方式和服务数据设置 |
| 部署状态 | 已存在部署记录时点击分享 | 查看部署状态、访问地址和服务数据概况 |
| 重新部署确认 | 在部署状态页主动点击“重新部署” | 确认本次代码更新和数据处理方式 |

关闭首次部署确认或重新部署确认弹窗，不得清除已存在的部署记录。用户再次点击分享时：

1. 如果存在部署记录，始终先打开部署状态页。
2. 只有用户在部署状态页点击“重新部署”，才进入重新部署确认页。
3. 如果不存在部署记录，才打开首次部署确认页。

服务数据管理入口放在部署状态页，不要求用户为了下载数据或查看用量而进入重新部署流程。

### 部署确认弹窗

在现有“确认服务部署”弹窗中增加 `服务数据` 区块。该区块只在 Node 服务部署中显示，静态站点不显示。

默认状态：

- 如果自动识别到候选路径，默认开启服务数据保留，并选中推荐项。
- 如果没有候选路径，默认关闭，并提示用户可手动添加。
- 用户可以点击“查看保留内容”确认、添加或移除路径。

识别到候选路径时，默认收起展示：

```text
服务数据                         ☑ 保留服务数据

更新服务后，会继续保留已选择位置中的线上服务数据。
首次部署时，所选本地内容将用于初始化；之后更新不会覆盖线上已有数据。

[查看保留内容]

更新服务时默认保留线上服务数据。
```

如需解释服务数据的含义，使用辅助文案：

```text
服务数据由已部署服务运行时产生，可能包括用户提交的内容、运行记录或上传文件，具体取决于这个服务的实现。
```

辅助文案默认不必常驻，可以放在信息提示或“了解详情”中。不能使用“会保留排行榜、问卷结果、上传内容”作为主文案，因为客户端无法确认当前服务一定包含这些数据。

没有识别到候选路径时：

```text
服务数据                         ☐ 保留服务数据

未检测到需要保留的本地位置。如果这个服务会在项目目录中保存运行数据，可以手动添加对应文件夹。

[添加文件夹]
```

展开“查看保留内容”后：

```text
保留内容

[目录图标] data/
[文件图标] leaderboard.sqlite

[添加文件夹] [高级设置]
```

每个路径项支持：

- 显示本地路径，并用文件或目录图标区分类型。
- 在高级模式中修改线上保存名称，默认等于本地相对路径。
- 删除。

路径选择约束：

- 只能选择当前项目目录内的文件或目录。
- 不能选择项目根目录本身。
- 不能选择绝对路径、包含 `..` 的路径、符号链接。
- 不能选择 `.git`、`node_modules`、`.env`、构建产物目录。
- V1 最多允许 8 个绑定，默认建议只选择一个主数据目录，但不强制只能选择一个。
- 文件夹选择器默认打开当前项目目录。
- 达到 8 个绑定后禁用“添加文件夹”，并显示“最多可添加 8 个保存位置”。

### 推荐路径文案

自动识别结果使用“已为你选择 + 可查看”语义，不要求用户理解路径含义：

```text
已为你选择可能保存服务数据的位置。你可以查看或调整。
```

常见推荐规则：

| 路径 | 类型 | 推荐原因 |
|---|---|---|
| `data/` | 目录 | 可能是服务运行时保存的数据 |
| `uploads/` | 目录 | 可能包含用户上传的文件 |
| `storage/` | 目录 | 可能包含服务保存的数据 |
| `*.db` | 文件 | 本地数据文件 |
| `*.sqlite` | 文件 | 本地数据文件 |
| `*.sqlite3` | 文件 | 本地数据文件 |

### 更新服务时的数据策略

重新部署确认页提供一个默认不勾选的选项：

```text
☐ 用本地数据替换线上数据
  重新部署前将删除这些线上数据，再使用当前项目中的对应数据重新初始化。
  此操作不会自动备份线上数据。
```

manifest 使用 `persistence.updateMode` 表达本次部署的数据策略：

- `preserve`：默认值。已有绑定继续使用 NAS 中的线上数据，不合并或覆盖同名本地内容；本次新增的绑定在 NAS 目标不存在时，使用部署包中的对应本地内容初始化一次。
- `replace`：先停止同一 share 的旧函数，再清空该 share 的 NAS 根目录，最后用本次部署包中的绑定数据重新初始化。

首次启用服务数据时，无论客户端是否传入 `replace`，都按初始化部署处理：将本地绑定内容复制到 NAS。保留模式以规范化后的 `dataPath` 判断新增绑定；从新版本移除的绑定不再挂载，但 NAS 中的已有数据不会被删除。

运行时不能仅以“NAS 目标不存在”作为复制本地数据的条件。只有首次部署、显式覆盖或本次新增的绑定可以初始化本地内容；普通冷启动中，已有绑定的目标若缺失，只创建空文件或目录并挂载。

默认未勾选时展示：

```text
本次更新不会覆盖线上服务数据。
如果这次修改了数据保存方式，建议先下载线上服务数据，再确认新版本可以正常使用。
```

### 本地数据文件迁移提示

如果选择项中包含 `.db`、`.sqlite`、`.sqlite3`，部署弹窗显示用户可理解的提示，不直接出现 SQLite/schema：

```text
检测到服务使用本地数据文件。
如果这次你让龙虾修改了数据保存方式，建议先下载线上服务数据，再部署。
```

提供操作：

- `下载线上服务数据`
- `查看迁移建议`

迁移建议：

1. 下载线上服务数据到本地备份目录。
2. 在本地用新代码启动服务或运行迁移脚本。
3. 验证数据和功能正常。
4. 确认新版本可以兼容或自动迁移线上数据后，再使用 `保留线上服务数据` 部署。

## 部署后管理

在服务分享详情或服务部署详情中增加 `服务数据` 面板。对于已经部署的服务，这是用户管理线上服务数据的主入口。

默认展示字段：

- 说明：`服务数据保存在云端，重新部署服务时不会被覆盖。`
- 数据位置列表：仅显示项目内路径，并用文件或目录图标区分类型。

高级详情展示字段：

- Provider：显示为“文件系统”，不显示 NAS。
- 本地挂载路径，例如 `/data`。
- 线上保存根目录。
- 绑定列表的线上路径。
- 最近部署策略。

操作：

| 操作 | V1 支持 | 说明 |
|---|---|---|
| 下载线上服务数据 | 是 | 下载整个服务数据目录 zip |
| 查看线上文件列表 | 可选 | V1 可只展示绑定级别，不做文件树 |
| 删除分享时删除数据 | 可选 | 默认停止服务不删数据 |

推荐面板文案：

```text
服务数据
服务数据保存在云端，重新部署服务时不会被覆盖。

数据位置
[目录图标] data

[下载]
```

NAS 文件用量不能通过当前管理 API 低成本实时读取，因此默认页面不展示
`已使用 x / 100 MB`，避免把部署包内本地大小或过期扫描值误认为线上实时用量。

默认策略：

- 停止部署或替换部署时，不删除线上服务数据。
- 删除分享时，默认保留线上服务数据，并提示用户可手动删除。
- 只有用户在重新部署时勾选“用本地数据替换线上数据”，或后续明确执行删除服务数据时才删除。

## 下载线上服务数据

### 用户流程

入口：

- 重新部署确认弹窗：`下载线上服务数据`
- 服务详情服务数据面板：`下载线上服务数据`

下载行为：

1. 客户端调用服务端同步下载 zip，并展示不确定进度条，不展示预计等待时间。
2. 服务端临时创建一个挂载相同 NAS 的 veFaaS 函数，从该分享的服务数据根目录打包 zip，完成后销毁函数。
3. 客户端保存到默认目录：

```text
<project>/.lobster/persistence/<shareId>/<yyyyMMdd-HHmmss>/<shareId>-service-data.zip
```

4. 下载完成后显示：

```text
线上服务数据已下载到 .lobster/persistence/shr_xxx/20260709-153000/shr_xxx-service-data.zip
```

下载完成后只提供 `在 Finder 中显示`。下载操作只生成备份，不修改当前项目。

## 客户端数据结构

### 分析结果

将现有 `analysis.persistence` 拆成“候选项”和“最终选择”两个概念。

```ts
interface ShareDeploymentPersistenceCandidate {
  appPath: string;
  kind: 'file' | 'directory';
  sizeBytes: number;
  reason: 'common_data_dir' | 'upload_dir' | 'sqlite_database' | 'manual';
  recommended: boolean;
}

interface ShareDeploymentPersistenceSelection {
  enabled: boolean;
  quotaBytes: number;
  bindings: ShareDeploymentPersistenceBinding[];
}
```

V1 可以兼容现有字段：

```ts
interface ShareDeploymentProjectAnalysis {
  persistence?: ShareDeploymentPersistence;
  persistenceCandidates?: ShareDeploymentPersistenceCandidate[];
}
```

兼容规则：

- 老服务端或老客户端只认识 `persistence`。
- 新客户端内部使用 `persistenceCandidates` 渲染 UI。
- 用户确认后仍生成现有 `manifest.persistence`，避免一次性改动服务端主链路。

### Manifest

保持现有 manifest 结构，增加可选策略字段：

```json
{
  "persistence": {
    "enabled": true,
    "provider": "filesystem",
    "quotaBytes": 104857600,
    "updateMode": "replace",
    "bindings": [
      {
        "appPath": "data",
        "dataPath": "data",
        "kind": "directory",
        "sizeBytes": 506
      }
    ]
  }
}
```

`updateMode` 只允许 `preserve` 或 `replace`，缺省按 `preserve` 处理。客户端每次进入重新部署确认页都默认使用 `preserve`，不把上一次的破坏性选择写入项目偏好。

### 本地偏好缓存

同一项目下，用户的服务数据选择应被记住，避免每次部署重复选择。

缓存 key：

```text
share-deployment:persistence-selection:<clientSourceKey>
```

缓存内容：

```json
{
  "enabled": true,
  "bindings": [
    { "appPath": "data", "dataPath": "data", "kind": "directory" }
  ],
  "updatedAt": "2026-07-09T15:30:00+08:00"
}
```

合并规则：

1. 新分析得到候选项。
2. 如果存在缓存，优先恢复用户上次选择。
3. 如果缓存路径已不存在，显示为“路径不存在”，默认取消勾选。
4. 新增候选项显示为“新检测到”，默认勾选。

## 服务端 API 设计

### 查询服务数据信息

```http
GET /api/share-deployments/{deploymentId}/persistence
```

返回：

```json
{
  "enabled": true,
  "provider": "filesystem",
  "mountPath": "/data",
  "quotaBytes": 104857600,
  "usedBytes": 20480,
  "usedBytesEstimated": true,
  "status": "ready",
  "bindings": [
    {
      "appPath": "data",
      "dataPath": "data",
      "kind": "directory",
      "sizeBytes": 506
    }
  ],
  "lastDownloadedAt": null,
  "updatedAt": "2026-07-09T15:30:00"
}
```

也可以先把这些字段复用到现有部署详情 response 的 `persistence` 字段里，独立接口作为后续增强。

### 下载线上服务数据

V1 可用同步下载：

```http
GET /api/share-deployments/{deploymentId}/persistence/archive
```

返回：

```http
Content-Type: application/zip
Content-Disposition: attachment; filename="shr_xxx-persistence-20260709-153000.zip"
```

如果该 share 的 NAS 根目录下没有任何文件或目录条目，返回：

```http
HTTP/1.1 204 No Content
Cache-Control: no-store
```

客户端不得创建空 ZIP，直接提示“线上暂无可下载的服务数据”。零字节文件仍是有效条目，应正常返回 ZIP。

同步下载支持两种服务端数据访问方式：

1. `local_mount`：`lobsterai-server` 所在主机已经挂载同一个 NAS，直接读取本地挂载目录。
2. `ephemeral_function`：每次操作创建一个挂载同一 NAS 的 veFaaS 临时函数，`lobsterai-server` 通过一次性 HMAC 密钥请求读取数据，操作后删除函数和 APIG 路由。测试和生产默认使用此方式。

FileNAS OpenAPI 只管理文件系统、挂载点、权限组和配额，不提供读取任意 NAS 文件内容的 API。因此不能通过 `DescribeFileSystems` 等管理 API 下载服务数据。

直接挂载模式配置：

```properties
share-deployment.volcengine.nas.local-mount-path=${SHARE_DEPLOYMENT_VOLCENGINE_NAS_LOCAL_MOUNT_PATH:}
```

临时函数模式配置：

```properties
share-deployment.persistence.data-access-mode=${SHARE_DEPLOYMENT_PERSISTENCE_DATA_ACCESS_MODE:ephemeral_function}
share-deployment.persistence.manager.request-timeout-seconds=${SHARE_DEPLOYMENT_PERSISTENCE_MANAGER_TIMEOUT_SECONDS:300}
share-deployment.persistence.manager.readiness-timeout-seconds=${SHARE_DEPLOYMENT_PERSISTENCE_MANAGER_READINESS_TIMEOUT_SECONDS:240}
share-deployment.persistence.manager.cleanup-attempts=${SHARE_DEPLOYMENT_PERSISTENCE_MANAGER_CLEANUP_ATTEMPTS:3}
```

无需配置常驻函数 URL 或固定密钥。服务端每次生成独立随机密钥，并把唯一允许访问的 `shareId` 放入临时函数包。包强制通过 `direct_zip` 上传，密钥不进入 TOS、properties、Overmind 或数据库。下载操作创建并销毁一个临时函数，复用用户服务的 VPC、子网、安全组、NAS 和 APIG 配置。

函数服务自身挂载 NAS 不等于 `lobsterai-server` 已经挂载。临时函数创建或执行失败时，接口可能返回业务错误 JSON；客户端必须校验 HTTP 状态、业务码和 ZIP 文件头，不能将错误 JSON 保存为 `.zip`。

客户端相关 IPC/HTTP 请求必须使用长超时、展示不确定进度，并在整个过程禁用重复操作。每次操作都由服务端在 `finally` 中清理 APIG route、upstream 和函数，失败时默认重试清理 3 次。

如果数据较大或打包耗时，升级为异步任务：

```http
POST /api/share-deployments/{deploymentId}/persistence/export
GET /api/share-deployments/{deploymentId}/persistence/export/{taskId}
```

## 服务端运行时策略

`run.sh` 根据部署记录中的持久化状态执行：

1. `configured`：首次启用服务数据。每个部署只执行一次本地数据初始化。
2. `live`：普通更新和普通冷启动。已有绑定始终保留 NAS 内容，目标缺失时只创建空文件或目录；本次新增绑定只在首次启动且目标不存在时复制本地内容。
3. `reset_pending`：显式选择 `updateMode=replace`。Worker 先停止同一 share 的旧函数；新函数首次启动时清空 share 根目录，再复制本次部署包中的绑定数据。

`configured`、`reset_pending` 和包含新增绑定的 `live` 部署都使用位于 share 根目录之外的部署级完成标记。初始化成功后写入 `<deploymentId>.complete`；同一部署后续冷启动看到标记后不得再次复制或清空 NAS。

注意：

- 删除必须限制在 `PERSIST_ROOT` 内。
- 对文件和目录分别处理。

## 安全和权限

客户端校验：

- 禁止选择项目外路径。
- 禁止 `.env`、密钥、隐藏配置。
- 禁止 `node_modules` 和构建产物。
- 禁止符号链接。

服务端必须重复校验：

- `appPath`、`dataPath` 必须是安全相对路径。
- 不允许绝对路径。
- 不允许 `..`。
- 不允许空路径。
- 不允许超过最大绑定数。
- 不允许超过单部署配额。

下载权限：

- 只有分享拥有者可以下载线上服务数据。
- 管理员接口必须走后台权限。
- 下载链接不能长期公开，若使用临时 URL，必须短 TTL。

日志要求：

- 不打印完整线上服务数据内容。
- 不打印 zip 下载临时签名 URL。
- 只记录路径、大小、任务状态。

## 数据空间

V1 默认单部署服务数据空间：

```text
100 MiB
```

客户端展示为：

```text
数据空间 100 MB
```

行为：

- 部署前按本地选择项大小做静态提示。
- 线上真实用量由服务端估算或定期扫描。
- 超额时服务端拒绝写入或部署，并返回可读错误。

V1 不做用户自定义额度。后续可按套餐或后台配置下发。
服务端必须忽略客户端试图放大的 `quotaBytes`，以服务端配置额度为准。

## 错误处理

### 下载失败

提示：

```text
线上服务数据下载失败，请稍后重试。
```

详情展开显示服务端错误。

### 路径不存在

如果缓存的本地路径不存在：

```text
上次选择的 data/ 不存在，已取消选择。
```

### 线上无数据

```text
线上暂无可下载的服务数据。
```

## 分阶段实施

### Phase 1：部署前选择

- `nodeServiceProjectAnalyzer` 输出候选项。
- 部署确认弹窗默认展示 `保留服务数据` 的开关状态。
- 自动识别到候选项时显示“已为你选择可能保存服务数据的位置”。
- 用户点击 `查看保留内容` 后可勾选/取消、添加项目内路径。
- 文件夹选择器默认打开当前项目目录。
- 生成现有 `manifest.persistence`。
- 缓存用户选择。

### Phase 2：服务详情管理

- 服务详情展示 `服务数据` 面板。
- 已存在部署时，点击分享优先打开部署状态页。
- 支持下载线上服务数据 zip。
- 支持下载后保存到 `.lobster/persistence/...`。
- 支持“在 Finder 中显示”。

### Phase 3：覆盖部署

- 重新部署确认页增加默认不勾选的“用本地数据替换线上数据”。
- 勾选后按钮改为“覆盖并重新部署”，manifest 发送 `persistence.updateMode=replace`。
- 服务端先停止旧函数，再由新部署一次性清空并初始化 NAS。
- 取消部署状态页中的独立清空入口和对应 HTTP/IPC API。

### Phase 4：迁移增强

- 本地数据文件识别后显示迁移引导。
- 提供数据保存方式变化的迁移建议。

## 本地 API 和功能测试要求

所有涉及火山云 API、veFaaS、TOS、VPC、NAS 挂载或 NAS 数据读取的改动，合入前必须在本地跑真实 API 测试，不能只依赖 mock。

必须覆盖：

1. OpenAPI smoke test：调用真实 veFaaS `ListFunctions`，验证 AK/SK、签名、区域和 OpenAPI endpoint。
2. NAS 功能测试：用 `/Users/admin/lobsterai/project/brotato-clone` 打包部署，写入排行榜，通过真实临时函数下载 ZIP，并验证 `preserve` 与 `replace` 两种重新部署路径。低层管理器的清理/恢复能力可继续用于测试数据回填，但客户端不暴露入口。
3. 上传路径测试：brotato 默认走 TOS 上传。direct zip 只能用于小包验证，因为 zip base64 后会膨胀，较大的 JSON body 可能触发 OpenAPI request parsing error。

推荐命令：

```bash
# 真实 OpenAPI smoke test，不创建云资源。
SHARE_DEPLOYMENT_VOLCENGINE_API_TEST=true \
SHARE_DEPLOYMENT_VOLCENGINE_CREDENTIAL_JSON='{"accessKeyId":"...","secretAccessKey":"..."}' \
./gradlew test --tests com.youdao.lobsterai.service.sharedeployment.VolcengineVefaasCloudIntegrationTest.listFunctionsThroughVolcengineOpenApiClient --rerun-tasks

# brotato-clone 端到端 NAS 功能测试，会创建临时函数并在结束后清理。
SHARE_DEPLOYMENT_BROTATO_PERSISTENCE_CLOUD_TEST=true \
SHARE_DEPLOYMENT_VOLCENGINE_CREDENTIAL_JSON='{"accessKeyId":"...","secretAccessKey":"..."}' \
./gradlew test --tests com.youdao.lobsterai.service.sharedeployment.VolcengineVefaasCloudIntegrationTest.deployBrotatoAndManageNasDataThroughEphemeralFunctions --rerun-tasks
```

测试通过条件：

- API smoke test 不跳过，且 `BUILD SUCCESSFUL`。
- brotato 测试不跳过，且完成用户函数创建、排行榜写入、有效 ZIP 下载、默认保留和显式覆盖；内部清理/恢复仅用于测试数据回填。
- 测试结束后临时函数被清理；如果设置 `SHARE_DEPLOYMENT_CLOUD_TEST_KEEP_FUNCTION=true`，必须在人工验证后手动删除。

2026-07-13 本地验证结果：客户端 23 个相关测试、变更文件 ESLint、Electron TypeScript
编译均通过；`brotato-clone` 真实云闭环耗时约 135 秒，单次临时函数业务操作约
15.6 到 15.9 秒。闭环完成后再次调用 `ListFunctions`，未发现
`lobster-persistence-op-` 前缀的遗留函数。

## 验收标准

1. 对 `/Users/admin/lobsterai/project/brotato-clone` 这类项目，部署前默认开启 `保留服务数据`。
2. 点击 `查看保留内容` 后能看到带目录图标的 `data/`，不显示额外说明文字。
3. 用户取消 `data/` 后，manifest 不包含 `persistence` 配置。
4. 用户选择 `data/` 后，部署 response 返回 `persistence.enabled=true`。
5. 线上写入排行榜后，更新服务仍保留排行榜数据。
6. 点击 `下载线上服务数据` 后，本地生成 `.lobster/persistence/<shareId>/<timestamp>/<shareId>-service-data.zip`，且不会自动覆盖当前项目。
7. 本地数据文件被选择时，部署确认弹窗显示“数据保存方式发生变化”的迁移提示，不默认出现 SQLite/schema。
8. 重新部署时默认不勾选“用本地数据替换线上数据”。
9. 用户无法选择项目外路径、`.env`、`node_modules`。
10. 点击“添加文件夹”时，选择器默认打开当前项目目录；允许选择多个位置，但最多 8 个。
11. 已存在部署时，关闭重新部署确认弹窗后再次点击分享，显示部署状态页，而不是直接回到重新部署确认页。
12. 默认主文案不把排行榜、问卷结果或上传内容描述为当前服务一定存在的数据。
13. 从部署状态页可以直接查看服务数据概况和下载线上服务数据，不显示独立清空按钮。
14. `updateMode=preserve` 时不清空 NAS：已有绑定不合并或覆盖本地内容；新增绑定在 NAS 目标不存在时初始化一次。
15. `updateMode=replace` 时先停止线上函数，再删除 share 根目录下的文件和目录，并使用本次部署包重新初始化；停止失败时不得修改 NAS。
16. 覆盖初始化使用部署级完成标记，同一部署后续冷启动不会再次清空或复制。
17. 线上空目录下载返回 `204`，客户端不生成空 ZIP，直接提示线上暂无数据。
18. 新版本移除绑定后不再挂载该位置，但保留 NAS 中的原有数据；只有 `replace` 才删除这些遗留数据。

## Open Questions

1. 下载线上服务数据是否需要支持只下载单个保存项，还是 V1 下载整个 share 数据目录即可。
2. 线上用量统计是部署时计算、按需扫描，还是后台定时扫描。
3. 删除分享时是否提供“同时删除线上服务数据”的选项，默认建议不删除。
