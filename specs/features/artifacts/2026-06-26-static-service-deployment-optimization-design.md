# 静态产物本地服务分享部署优化设计文档

## 1. 概述

### 1.1 问题/背景

当前本地服务分享统一走 Node service deployment 链路。对于 Vite、Create React App、Vue CLI、Angular、Astro、Parcel、Svelte Vite，以及 Next static export 这类最终产物为静态文件的项目，客户端会在本地构建后生成一个 `server.js` 静态服务器，再把 `server.js`、静态文件和启动命令上传到服务端，由服务端按 Node 服务部署。

这个方案能跑通，但对静态站点不是最优：

| 问题 | 影响 |
| ---- | ---- |
| 静态站点被包装成 Node 服务 | 服务端需要分配运行时、执行进程管理和健康检查，部署链路比实际需要更重 |
| 生成 `server.js` 作为运行时 | 增加安全面和冷启动成本，也让“静态站点”在产品上表现成“服务部署” |
| 复用动态服务活跃配额 | 静态分享如果占用火山云动态服务配额，会挤掉真正需要运行时的服务 |
| 产物路径语义不清 | 静态 SPA 常有根路径资源、history fallback、hash 资源缓存策略，和 Node 服务启动命令没有直接关系 |
| 包体策略不匹配 | 当前 HTML 分享偏向单个 HTML artifact 的依赖扫描，Node 部署偏向完整服务包；静态构建产物需要“全量静态目录 + 专用静态托管” |

现有代码中已经有可复用能力：

- `src/main/libs/shareDeployment/nodeServiceProjectAnalyzer.ts` 已能识别静态构建类框架。
- `src/main/libs/shareDeployment/nodeServiceDeploymentPackager.ts` 已能在构建后定位 `dist` / `build` / `out` 等输出目录。
- `src/main/libs/htmlShare/htmlSharePackager.ts` 已有 `packageStaticDirectory()`，但它偏向依赖扫描模式，不适合作为静态构建产物的唯一打包策略。
- 服务端已经为 service deployment 使用独立 host，适合承载根路径静态站点。

### 1.2 目标

1. 当本地服务项目构建产物是纯静态站点时，走静态部署链路，不再生成 Node 静态服务器。
2. 静态站点仍保留本地服务分享的用户体验：同一个入口、同样的访问模式、同样可复制公网链接。
3. 静态部署使用独立 share host，支持根路径资源、SPA history fallback 和静态资源缓存。
4. 动态 Node 服务、Next SSR、Nuxt/Nitro SSR、Express/Koa/NestJS/Fastify 等项目继续走现有 Node 部署链路。
5. 客户端构建和打包不污染用户项目目录，敏感文件不进入上传包。
6. 服务端对静态部署不分配 Node runtime，不执行用户代码。

### 1.3 非目标

| 非目标 | 说明 |
| ------ | ---- |
| 把 SSR 项目强转静态 | Next SSR、Nuxt SSR、Astro SSR 等仍走 Node runtime 或后续 serverless 方案 |
| 远端云构建 | 首版仍由 Electron 客户端在本地临时目录执行 install/build |
| 本机端口穿透 | 不暴露用户本机 `localhost`，只上传构建产物 |
| 完整 CDN 平台 | 首版只要求服务端能从 NOS 等对象存储提供 share host 访问，不设计独立 CDN 产品能力 |
| 改造普通 HTML artifact 分享 | HTML/image/markdown/mermaid 等静态 artifact 分享保持现状 |

## 2. 用户场景

### 场景 1: Vite / React 静态项目分享

**Given** 用户运行了 `http://localhost:5173`，项目目录包含 `package.json`、`vite` 依赖和 `build` 脚本。  
**When** 用户在本地服务预览中点击分享并确认部署。  
**Then** 客户端在临时目录构建项目，定位 `dist/index.html`，上传静态产物，服务端返回独立 share host URL，访问该 URL 不启动 Node runtime。

### 场景 2: Next static export

**Given** 项目使用 Next.js，构建后存在 `out/index.html`，没有 `.next/standalone/server.js`。  
**When** 用户分享本地服务。  
**Then** 客户端把项目判定为 `static_site`，上传 `out` 静态产物；如果构建后存在 `.next/standalone/server.js`，则判定为 `node_service` 并保持现有 Node 部署。

### 场景 3: Nuxt/Nitro SSR

**Given** Nuxt 项目构建后存在 `.output/server/index.mjs`。  
**When** 用户分享本地服务。  
**Then** 客户端判定该项目需要运行时，继续使用 Node/Nitro 部署链路。

### 场景 4: SPA 子路由刷新

**Given** 静态站点使用 history router，用户访问 `https://<share-host>/settings/profile`。  
**When** 静态存储中不存在 `settings/profile` 文件。  
**Then** 服务端在 `spaFallback = true` 时返回入口 `index.html`，让前端路由接管。

### 场景 5: 动态 API 项目

**Given** 本地服务使用 Express 或 NestJS，构建产物没有静态 `index.html` 输出目录，或需要启动 `npm run start`。  
**When** 用户分享本地服务。  
**Then** 客户端不尝试静态部署，继续走 Node service deployment。

## 3. 功能需求

### FR-1: 部署类型显式化

项目分析结果新增部署类型字段：

```typescript
export const ShareDeploymentKind = {
  NodeService: 'node_service',
  StaticSite: 'static_site',
} as const;
export type ShareDeploymentKind = typeof ShareDeploymentKind[keyof typeof ShareDeploymentKind];
```

`ShareDeploymentProjectAnalysis` 增加：

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `deploymentKind` | `node_service | static_site` | 客户端最终选择的部署类型 |
| `frameworkHint` | `next | nuxt | vite | react-scripts | vue-cli | angular | astro | parcel | svelte-vite | node | unknown` | 仅用于 UI 和诊断 |
| `staticOutputDirectory?` | `string` | 构建后静态输出目录，分析前可为空，构建后必须是临时目录内路径 |
| `staticEntryFile?` | `string` | 默认 `index.html` |
| `spaFallback?` | `boolean` | 静态部署是否启用 history fallback |

分析阶段可以先给出“候选类型”，最终类型以构建后输出检查为准。

### FR-2: 静态框架识别规则

依赖识别仍使用 `dependencies + devDependencies`，但它只是候选信号：

| 信号 | 候选类型 |
| ---- | -------- |
| `vite` | static site |
| `react-scripts` | static site |
| `@vue/cli-service` | static site |
| `@angular/cli` | static site |
| `astro` | static site 或 node service，构建后判定 |
| `parcel` | static site |
| `@sveltejs/vite-plugin-svelte` | static site |
| `next` | static site 或 node service，构建后判定 |
| `nuxt` / `nuxt3` | static site 或 node service，构建后判定 |
| 无静态框架信号，但有 `start` / `serve` / `dev` | node service |

最终判定规则：

| 构建输出 | 最终类型 |
| -------- | -------- |
| `.next/standalone/server.js` | node service |
| `.output/server/index.mjs` | node service |
| `dist/server/**` 且框架是 Astro/SvelteKit/Nuxt | node service |
| `out/index.html` | static site |
| `dist/index.html` | static site |
| `build/index.html` | static site |
| `dist/<name>/browser/index.html` | static site |
| `.output/public/index.html` 且没有 `.output/server/index.mjs` | static site |
| 没有可用静态入口，但有启动脚本 | node service |

### FR-3: 静态构建打包不生成运行时

静态部署禁止生成 `.lobster-static-runtime/server.js`，也不上传 `startCommand = node server.js`。

静态部署包只包含构建输出目录中的静态文件和 manifest：

```text
deployment.zip
├── index.html
├── assets/...
├── favicon.ico
├── manifest.webmanifest
└── 其他允许的静态文件
```

客户端应新增 `packageStaticBuildDirectory()`，不要复用依赖扫描模式作为唯一来源。构建产物中的懒加载 chunk、web worker、service worker、manifest、favicon、字体和未被 `index.html` 直接引用的资源都需要被包含。

建议实现方式：

| 模式 | 用途 | 行为 |
| ---- | ---- | ---- |
| `dependencyGraph` | 普通 HTML artifact 分享 | 以 HTML/CSS 依赖扫描为主 |
| `fullStaticOutput` | 本地服务静态构建产物 | 递归包含输出目录内所有允许文件 |

### FR-4: 静态部署使用专用服务端接口

新增服务端接口：

```http
POST /api/share-deployments/static
```

请求仍为 multipart：

| 字段 | 必填 | 说明 |
| ---- | ---- | ---- |
| `sessionId` | 是 | Cowork session ID |
| `artifactId` | 是 | 本地服务 artifact ID |
| `title` | 是 | 分享标题 |
| `accessMode` | 否 | `code` 或 `public`，默认服务端策略 |
| `clientSourceKey` | 是 | 本地项目稳定来源 key |
| `sourceSha256` | 是 | zip SHA-256 |
| `entryFile` | 是 | 静态入口文件，默认 `index.html` |
| `manifest` | 是 | 静态部署 manifest JSON |
| `sourceArchive` | 是 | 静态产物 zip |

响应复用 `ShareDeploymentRecord`：

| 字段 | 静态部署语义 |
| ---- | ------------ |
| `deploymentId` | 静态部署记录 ID |
| `shareId` | 分享/访问控制 ID |
| `url` | 独立 share host URL |
| `deploymentStatus` | 通常上传成功后为 `live` |
| `runtimeLanguage` | `static` |
| `runtimeVersion` | 可为空 |
| `startCommand` | 空或不返回 |
| `listenPort` | 空或不返回 |
| `sourceArchiveBytes` | 静态 zip 大小 |

客户端不应把静态部署上传到 `/api/share-deployments/node`。

服务端处理模型与 HTML 分享相似：客户端上传 zip，服务端负责解压、校验、写入 NOS，并把数据库记录指向当前内容版本。静态部署不要求服务端保存可执行项目目录，也不要求构建或启动用户代码。

建议 NOS key 结构：

```text
html-shares/{shareId}/...                         # 现有 HTML/artifact 静态分享
share-deployments/static/{shareId}/{version}/...  # 新增静态站点部署
```

其中 `{version}` 可以使用 `sourceSha256` 前缀、内容版本号或服务端生成的 deployment revision。重新部署成功后只切换当前版本指针，不覆盖旧对象；旧版本由服务端生命周期任务异步清理。

### FR-5: 静态部署使用独立 host

静态部署 URL 仍使用 service deployment 独立 host 形态，避免 `/s/{shareId}/` 子路径破坏根路径资源：

```text
https://{shareId}-share-service.{serviceHostSuffix}/
```

服务端根据 `shareId` 判断部署类型：

| 类型 | 处理方式 |
| ---- | -------- |
| `node_service` | 反向代理到运行时 |
| `static_site` | 从 NOS 静态对象读取文件并返回 |

静态 host 请求规则：

1. 只允许 `GET` / `HEAD`。
2. 对 URL path 做规范化，拒绝 `..`、反斜杠、空字节和路径穿越。
3. `/` 映射到 `entryFile`。
4. 文件存在时返回文件。
5. 文件不存在且 `spaFallback = true` 时返回 `entryFile`。
6. 文件不存在且未启用 fallback 时返回 404。
7. 访问模式、分享码 cookie、禁用状态和审核状态沿用现有分享控制。

### FR-6: 缓存策略

服务端对静态部署使用分层缓存：

| 文件类型 | 建议缓存 |
| -------- | -------- |
| `index.html` / `entryFile` | `no-cache` 或短缓存，必须可快速更新 |
| 带 hash 的 assets | `public, max-age=31536000, immutable` |
| 不带 hash 的 assets | `public, max-age=3600` |
| 分享码校验页 / 错误页 | `no-store` |

hash 文件可用文件名正则识别，例如：

```text
app.[a-f0-9]{8,}.js
style-[a-f0-9]{8,}.css
```

### FR-7: 静态分享只受总分享限制，动态服务单独限额

静态产物部署本质上是静态内容分享，服务端把文件写入 NOS 后由 share host 托管，不创建火山云运行资源。因此静态部署只受用户总分享限制约束，不占用动态服务部署配额，也不触发动态服务的 oldest-active stop 策略。

配额模型：

| 资源 | 配额 |
| ---- | ---- |
| Static site deployment | 计入用户总分享限制，和 HTML/image/markdown/mermaid 等静态分享一致 |
| Node service deployment | 计入火山云动态服务活跃部署限制；当前每个用户最多 3 个 |

服务端必须按 `deploymentKind` 或 `runtimeLanguage` 区分两类资源。只有 `node_service` / `runtimeLanguage = node` 的部署参与火山云动态服务计数；`static_site` / `runtimeLanguage = static` 不参与该计数。

### FR-8: 客户端交互保持一致

静态站点和动态 Node 服务对用户都表现为“本地服务分享”，不新增入口、不新增用户需要理解的部署类型选择，也不要求用户手动判断项目是静态还是动态。

统一交互流程：

```text
发现/打开本地服务
  ↓
点击分享
  ↓
检查登录、订阅、已有部署
  ↓
确认项目目录和构建/启动配置
  ↓
提交
  ↓
展示部署进度
  ↓
复制链接或管理分享码/公开访问/开关状态
```

内部部署类型只用于客户端分流和服务端资源模型：

| 类型 | 用户是否选择 | 客户端处理 |
| ---- | ------------ | ---------- |
| `static_site` | 否 | 构建后上传静态产物到静态部署接口 |
| `node_service` | 否 | 打包 Node 服务并上传到 Node 部署接口 |

确认弹窗默认只展示通用字段：

| 字段 | 静态站点 | 动态服务 |
| ---- | -------- | -------- |
| 本地服务 | 相同 | 相同 |
| 项目目录 | 相同 | 相同 |
| 安装命令 | 相同 | 相同 |
| 构建命令 | 相同 | 相同 |
| 访问方式 | 相同 | 相同 |
| 提交按钮 | 相同 | 相同 |

Node 版本、监听端口、启动命令、静态输出目录、入口文件等技术细节只放在高级配置或诊断折叠区域。静态站点可以不展示 Node 版本和启动命令；动态服务可以不展示静态输出目录和入口文件。默认主流程和按钮文案保持一致，避免用户感知为两个产品能力。

### FR-9: 已有部署查询与兼容

新增静态部署来源类型：

```typescript
export const HtmlShareSourceType = {
  // existing...
  NodeServiceDeployment: 'node_service_deployment',
  StaticServiceDeployment: 'static_service_deployment',
} as const;
```

客户端查询本地服务已有部署时按顺序查找：

1. `static_service_deployment` + 新 source key。
2. `node_service_deployment` + 当前 v3 source key。
3. 历史 v2 / legacy source key。

如果命中历史 Node 部署但当前分析结果是静态站点：

- 状态弹窗仍展示历史部署，允许复制旧链接。
- 用户点击“重新部署”时，使用新静态部署链路。
- 重新部署成功后，本地缓存的项目目录和部署记录切换到静态部署。
- 首次从历史 Node 静态服务器迁移到静态部署时，URL 可能变化；后续静态部署使用稳定 source key 保持同一 URL。

## 4. 实现方案

### 4.1 类型与常量

涉及文件：

```text
src/shared/shareDeployment/constants.ts
src/shared/htmlShare/constants.ts
```

新增：

```typescript
export const ShareDeploymentKind = {
  NodeService: 'node_service',
  StaticSite: 'static_site',
} as const;
```

`ShareDeploymentProjectAnalysis` 增加静态部署字段。`ShareDeploymentRecord` 增加可选字段：

```typescript
deploymentKind?: ShareDeploymentKind;
entryFile?: string;
staticOutputDirectory?: string;
spaFallback?: boolean;
```

### 4.2 项目分析

涉及文件：

```text
src/main/libs/shareDeployment/nodeServiceProjectAnalyzer.ts
src/main/libs/shareDeployment/nodeServiceProjectAnalyzer.test.ts
```

设计要点：

1. 保留当前 package manager 和命令推导。
2. 新增 `frameworkHint` 推导。
3. 分析阶段只判断候选部署类型：
   - 静态框架 + build 脚本：候选 `static_site`。
   - Next/Nuxt/Astro：候选 `unknown` 或 `node_or_static`，构建后再定。
   - 普通 Node 脚本：候选 `node_service`。
4. 分析成功条件保持：必须有 `package.json`、有效本地端口、可运行脚本或可构建脚本。
5. 静态候选不再把默认 `startCommand` 设置为 `node server.js`；UI 上用 `deploymentKind` 区分。

### 4.3 构建与最终分类

涉及文件：

```text
src/main/libs/shareDeployment/nodeServiceDeploymentPackager.ts
```

将当前 `packageNodeServiceDeployment()` 拆出内部流程：

```text
copy source to temp project
  ↓
run install command
  ↓
run build command
  ↓
inspect build outputs
  ↓
static output found: package static deployment
node runtime output found: package node deployment
fallback: prune prod deps and package node deployment
```

最终分类顺序：

1. Next standalone / Nitro server / known server output 优先判定为 `node_service`。
2. 明确静态输出目录存在且含 `index.html` 时判定为 `static_site`。
3. 没有静态输出但有 `start` / `serve` / `dev` 时判定为 `node_service`。
4. 都不满足时失败，返回可操作错误。

错误示例：

```text
Build completed, but no static output directory with index.html was found.
Expected one of: dist, build, out, dist/*/browser, .output/public.
```

### 4.4 静态产物打包

涉及文件：

```text
src/main/libs/htmlShare/htmlSharePackager.ts
src/main/libs/shareDeployment/staticServiceDeploymentPackager.ts
```

建议新增 `staticServiceDeploymentPackager.ts`，避免把本地服务构建产物的规则塞进 HTML artifact 分享打包器。

核心接口：

```typescript
export interface StaticServiceDeploymentPackageResult {
  archivePath: string;
  sourceSha256: string;
  entryFile: string;
  outputDirectory: string;
  totalFiles: number;
  totalBytes: number;
  archiveBytes: number;
  warnings: string[];
}
```

打包规则：

| 规则 | 说明 |
| ---- | ---- |
| 入口文件 | 默认 `index.html`，必须在输出目录内 |
| 文件来源 | 递归包含输出目录内所有允许静态文件 |
| 排除 | `.DS_Store`、`Thumbs.db`、`.env*`、secret/credential/token/private-key 命名文件、符号链接 |
| 路径 | archiveName 必须是 POSIX 相对路径 |
| 大小限制 | 建议 archive 100 MB、总文件 500 MB、文件数 50,000；若服务端限制更低，以服务端为准并在 UI 提示 |
| MIME | 服务端按扩展名解析，不信任客户端 MIME |

不要把以下内容放进静态部署包：

```text
node_modules
package.json
lock files
source files
build cache
server.js
.next/standalone
.output/server
```

### 4.5 上传客户端

涉及文件：

```text
src/main/libs/shareDeployment/shareDeploymentClient.ts
```

新增：

```typescript
export interface UploadStaticDeploymentInput {
  sessionId: string;
  artifactId: string;
  title: string;
  localServiceUrl: string;
  projectDirectory: string;
  accessMode?: HtmlShareAccessMode;
  archivePath: string;
  sourceSha256: string;
  archiveBytes: number;
  clientSourceKey: string;
  analysis: ShareDeploymentProjectAnalysis;
  entryFile: string;
  spaFallback: boolean;
}

export async function uploadStaticDeployment(...): Promise<ShareDeploymentResult>
```

manifest 示例：

```json
{
  "schemaVersion": 1,
  "deploymentKind": "static_site",
  "runtimeLanguage": "static",
  "packageManager": "npm",
  "buildCommand": "npm run build",
  "entryFile": "index.html",
  "spaFallback": true,
  "projectRootName": "my-app",
  "includedFileCount": 42,
  "estimatedSourceArchiveBytes": 123456,
  "localServiceUrl": "http://localhost:5173/"
}
```

### 4.6 IPC 与主进程路由

涉及文件：

```text
src/shared/shareDeployment/constants.ts
src/main/main.ts
src/main/preload.ts
src/renderer/types/electron.d.ts
```

不必新增 Renderer 入口，可以让现有 `shareDeployment:createNodeDeployment` 演进为“创建本地服务部署”。但为了命名清晰，建议逐步新增：

```typescript
ShareDeploymentIpc.CreateLocalServiceDeployment = 'shareDeployment:createLocalServiceDeployment'
```

迁移策略：

1. 首版保留旧 IPC，内部根据 `deploymentKind` 分流，减少 UI 改动。
2. 新增 IPC 后，Renderer 改用新名称。
3. 旧 IPC 保留一到两个版本作为兼容别名。

### 4.7 Renderer 交互

涉及文件：

```text
src/renderer/components/artifacts/ArtifactPanel.tsx
src/renderer/services/i18n.ts
```

调整点：

1. 本地服务分享入口、确认弹窗、提交按钮、状态弹窗和分享管理弹窗保持同一套组件。
2. Renderer 不提供“静态站点 / Node 服务”的用户选择；`deploymentKind` 只作为分析结果和诊断信息。
3. 默认确认弹窗展示通用字段：本地服务、项目目录、安装命令、构建命令、访问方式。
4. 技术细节放入高级配置或诊断折叠：动态服务可展示 Node 版本、监听端口、启动命令；静态站点可展示输出目录、入口文件、SPA fallback。
5. 部署状态仍复用当前进度：准备、检查、上传、部署、完成。
6. 完成弹窗复用现有分享链接、分享码、访问方式、开启/关闭分享控件。

新增 i18n key：

```text
nodeDeploymentKind
nodeDeploymentKindStaticSite
nodeDeploymentKindNodeService
nodeDeploymentStaticOutputDirectory
nodeDeploymentStaticEntryFile
nodeDeploymentStaticModeHint
```

### 4.8 服务端静态托管

服务端需要新增静态部署处理，但客户端仓库只记录依赖边界。

建议服务端模块：

| 模块 | 职责 |
| ---- | ---- |
| `StaticShareDeploymentController` | 接收 `/api/share-deployments/static` |
| `StaticShareDeploymentService` | 校验 manifest、解压/检查 zip、上传静态文件到 NOS，并更新当前版本指针 |
| `ShareDeploymentHostRouter` | 根据 `shareId` 和部署类型路由到 Node runtime 或 NOS static storage |
| `StaticDeploymentFileService` | 路径规范化、MIME、缓存、SPA fallback |

服务端安全要求：

1. 解压 zip 时拒绝 zip-slip、绝对路径、反斜杠路径和重复路径覆盖。
2. 拒绝 `.env*`、secret、credential、token、private-key 命名文件。
3. 不执行上传内容中的任何代码。
4. 静态部署 host 与主站 API cookie 隔离。
5. 访问控制、禁用状态、审核状态先于文件读取检查。

服务端存储流程建议：

```text
receive multipart zip
  ↓
write upload to server temp storage
  ↓
inspect zip central directory
  ↓
extract to isolated temp directory
  ↓
validate allowed paths, file count, file sizes, entryFile
  ↓
upload each static file to NOS under share-deployments/static/{shareId}/{version}/
  ↓
persist deployment record, entryFile, spaFallback, contentVersion, objectPrefix
  ↓
delete server temp files
```

访问流程建议：

```text
request share host path
  ↓
resolve shareId and current static deployment version
  ↓
check share status, access mode, code cookie and moderation state
  ↓
normalize path; map / to entryFile
  ↓
fetch object from NOS
  ↓
if missing and spaFallback=true, fetch entryFile from NOS
  ↓
return file with MIME and cache headers
```

这条链路应尽量复用 HTML 分享已有的 NOS 客户端、对象上传、静态文件响应、访问模式和分享状态控制代码，但不要复用 `/s/{shareId}/` 子路径访问形态。静态站点部署仍走独立 share host，避免根路径资源和 SPA fallback 被路径前缀破坏。

## 5. 边界情况

| 场景 | 处理方式 |
| ---- | -------- |
| 构建成功但没有 `index.html` | 判定静态部署失败；如果有启动脚本则回退 Node，否则提示用户配置输出目录 |
| `dist` 同时存在 `index.html` 和 `server` 目录 | 对 Astro/SvelteKit/Nuxt 优先按 SSR 处理，避免误静态化 |
| 用户配置了自定义输出目录 | UI 允许高级配置覆盖；必须包含入口 HTML |
| 静态资源使用绝对 `/assets/...` | 独立 host 下可正常访问 |
| SPA 子路径刷新 404 | `spaFallback = true` 返回入口 HTML |
| 静态站点调用 `/api/*` | 静态 host 不提供后端 API；如果资源不存在则按 fallback/404 处理，不代理到 LobsterAI API |
| 构建依赖需要环境变量 | 首版不采集 `.env`；用户可在本地已配置环境中构建，敏感文件不上传 |
| 包体超过静态限制 | 上传前阻止并展示具体限制 |
| 旧静态项目已有 Node 部署 | 允许查看旧部署；重新部署时切到静态链路 |
| 服务端不支持静态部署接口 | 客户端回退到当前 Node 静态服务器方案，或隐藏优化入口并显示服务端能力不足 |

## 6. 涉及文件

客户端：

```text
src/shared/shareDeployment/constants.ts
src/shared/htmlShare/constants.ts
src/main/libs/shareDeployment/nodeServiceProjectAnalyzer.ts
src/main/libs/shareDeployment/nodeServiceDeploymentPackager.ts
src/main/libs/shareDeployment/staticServiceDeploymentPackager.ts
src/main/libs/shareDeployment/shareDeploymentClient.ts
src/main/main.ts
src/main/preload.ts
src/renderer/components/artifacts/ArtifactPanel.tsx
src/renderer/services/i18n.ts
src/renderer/types/electron.d.ts
```

测试：

```text
src/main/libs/shareDeployment/nodeServiceProjectAnalyzer.test.ts
src/main/libs/shareDeployment/nodeServiceDeploymentPackager.test.ts
src/main/libs/shareDeployment/staticServiceDeploymentPackager.test.ts
src/main/libs/shareDeployment/shareDeploymentClient.test.ts
```

服务端依赖：

```text
POST /api/share-deployments/static
GET /api/share-deployments/{deploymentId}
GET /api/html-shares/source?sourceType=static_service_deployment&clientSourceKey=...
GET /api/html-shares/{shareId}/deployment
PUT /api/html-shares/{shareId}/status
PUT /api/html-shares/{shareId}/access-mode
```

服务端存储依赖：

```text
NOS object prefix: share-deployments/static/{shareId}/{version}/
Deployment metadata: shareId, deploymentId, deploymentKind=static_site, entryFile, spaFallback, objectPrefix, contentVersion, sourceSha256
```

## 7. 验收标准

1. Vite 项目分享后，上传包不包含 `server.js`、`node_modules`、源码目录和 lock file。
2. Vite 项目分享后，服务端返回 `runtimeLanguage = static`，访问返回独立 share host URL。
3. 静态站点根路径 `/`、静态资源 `/assets/app.js` 和 SPA 子路由 `/settings` 都能访问。
4. Next standalone 项目仍走 Node service deployment，启动命令仍为 `node server.js`。
5. Nuxt/Nitro SSR 项目仍走 `node .output/server/index.mjs`。
6. `dist/<project>/browser/index.html` 的 Angular 产物能被识别为静态站点。
7. 静态部署只受用户总分享限制约束，不占用火山云动态服务 3 个活跃部署限制。
8. 分享码访问、公开访问、关闭分享、重新开启分享和访问模式切换行为与现有服务部署一致。
9. 静态部署上传包中包含懒加载 chunk、web worker、manifest、favicon 和字体文件。
10. 构建失败时，错误信息包含命令和精简后的 stdout/stderr，不上传任何包。

## 8. 分阶段实施计划

### 阶段 1: 客户端分类与打包

1. 增加 `ShareDeploymentKind` 和分析字段。
2. 增加静态输出目录检测。
3. 增加 `staticServiceDeploymentPackager.ts`。
4. 单测覆盖 Vite、CRA、Angular、Next static export、Next standalone、Nuxt SSR。

### 阶段 2: 服务端静态部署 API

1. 新增 `/api/share-deployments/static`。
2. 新增静态部署 manifest 校验。
3. 独立 host 支持 NOS static object routing。
4. 动态服务继续使用火山云 3 个活跃部署限制；静态部署计入用户总分享限制。

### 阶段 3: Electron 上传分流

1. `packageNodeServiceDeployment()` 内部按最终分类返回 union result。
2. 静态结果调用 `uploadStaticDeployment()`。
3. Node 结果继续调用 `uploadNodeDeployment()`。
4. 服务端能力不足时保留旧 Node 静态服务器回退。

### 阶段 4: UI 优化与迁移

1. 确认弹窗展示部署类型。
2. 静态模式隐藏 Node runtime 字段。
3. 已有 Node 静态部署重新部署时迁移到静态部署。
4. 手动验证线上/测试模式、订阅门禁、访问模式和分享状态控制。
