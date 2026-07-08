<h1 align="center">
  <img src="public/logo.png" alt="LobsterAI" width="96"><br>
  LobsterAI
</h1>

<p align="center">
  <a href="https://github.com/netease-youdao/LobsterAI/stargazers"><img src="https://badgen.net/github/stars/netease-youdao/LobsterAI?label=%E2%98%85" alt="GitHub stars" /></a>
  <a href="LICENSE"><img src="https://badgen.net/github/license/netease-youdao/LobsterAI" alt="License" /></a>
  <a href="https://x.com/LobsterAIYoudao"><img src="https://img.shields.io/badge/-000000?logo=x&logoColor=white" alt="Follow LobsterAI on X" /></a>
  <a href="https://shared.ydstatic.com/market/souti/fihserChatWeb/online/2.0.7/dist/assets/wechat_group-B34qRm1G.png"><img src="https://img.shields.io/badge/-000000?logo=wechat&logoColor=white" alt="Follow LobsterAI on X" /></a>
  <br>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-4493F8?style=flat-square" alt="Supported platforms: macOS and Windows" />
  <img src="https://img.shields.io/badge/Electron-40-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron 40" />
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 18" />
</p>

<p align="center">
  <a href="README.md">English</a> · 中文
</p>

<p align="center">
  <strong>全场景办公助手 Agent。</strong><br/>
  国内大厂首个开源桌面级 Agent，网易有道出品。
</p>

<p align="center">
  <a href="#功能亮点"><strong>功能亮点</strong></a>
  &nbsp;·&nbsp;
  <a href="#本地开发"><strong>本地开发</strong></a>
  &nbsp;·&nbsp;
  <a href="#社区与支持"><strong>社区与支持</strong></a>
</p>

<h3 align="center"><a href="https://lobsterai.youdao.com/#/download-list"><ins>下载 LobsterAI</ins></a></h3>

<p align="center">
  <img src="docs/res/mainpage_zh.png" alt="main page" />
</p>

LobsterAI 是一个可以进入真实工作环境的桌面级 Agent：本地文件、终端命令、浏览器流程、文档、表格、幻灯片、IM 渠道、定时任务和项目工作区。

Cowork 是 LobsterAI 的产品与会话层，OpenClaw 是底层运行时和网关。这种分层让 LobsterAI 在桌面端负责本地持久化、权限、UI 状态、Artifacts、Agents、记忆和 IM 绑定，同时由 OpenClaw 执行 Agent 任务。

## 功能亮点

### 桌面级 Cowork 会话

围绕本地项目和文件执行长任务。LobsterAI 会实时流式展示进度、保存会话历史、渲染工具输出，并在文件操作、终端命令、网络访问等敏感动作前请求用户审批。

### 多 Agent 工作流

创建拥有独立身份、模型、技能、工作目录、启用状态和 IM 绑定的自定义 Agent。主 Agent 处理通用工作，专用 Agent 负责重复性的特定角色。

### 专家套件

安装面向场景的专家套件，将能力选择和参考信息打包成可复用工作流。专家套件与直接选择技能相互独立，因此同一任务可以同时组合套件和单个工具。

### 技能

LobsterAI 在 `SKILLs/skills.config.json` 中配置了 28 个内置技能，包括 Web 搜索、Word 文档、Excel 表格、PowerPoint、PDF 处理、Remotion 视频生成、浏览器自动化、图片/视频生成、股票研究、内容写作、邮件、天气和技能创建等。

### MCP 服务

通过 Model Context Protocol 接入外部工具和数据源。LobsterAI 会在本地保存用户配置的 MCP 服务，并将启用的服务同步到 OpenClaw。

### 定时任务

通过自然语言或定时任务 UI 创建周期任务。适合每日新闻、邮箱摘要、网站监控、周报生成等重复性工作。

### IM 远程控制

通过微信、企业微信、钉钉、飞书/Lark、QQ、Telegram、Discord、网易云信 IM、网易小蜜蜂、POPO 和邮件触达桌面 Agent。多实例平台可以把不同账号或渠道绑定到不同 Agent。

### 丰富 Artifacts

在桌面端预览和管理生成的 HTML、SVG、图片、视频、Mermaid 图表、代码、Markdown、文本、文档和本地服务类 Artifacts。

### 本地记忆与数据

会话和应用数据保存在本地 SQLite。OpenClaw 工作区记忆使用 `MEMORY.md`、`USER.md`、`SOUL.md` 和每日笔记等文件，让偏好和项目上下文能够跨会话延续。

## 实战指令

| 场景 | 示例指令 |
| --- | --- |
| 搭建本地系统 | "我还在用 Excel 记录库存和销售，帮我做一个本地进销存系统，可以录入进货和销售，自动计算库存和利润，并能在浏览器打开。" |
| 分析本地数据 | "基于 `product-growth.xlsx` 做一个可视化看板，并总结主要增长原因。" |
| 生成汇报 PPT | "调研 AI Agent 市场格局，并把结论整理成一份演示文稿。" |
| 自动检查网页后台 | "每天早上打开广告后台，检查消耗和转化是否异常，并总结可能原因。" |
| 批量筛选文档 | "把这个文件夹里的简历整理成筛选表，对照 JD 选出最匹配的人。" |
| 定时执行任务 | "每个工作日早上 9 点收集昨天的 AI 新闻，并发我一份简洁摘要。" |

## 工作原理

<p align="center">
  <img src="docs/res/architecture_v2_zh.png" alt="LobsterAI 架构" width="640">
</p>

- **Renderer**：React、Redux Toolkit、Tailwind、Artifact 渲染器、设置、Agent/会话 UI、技能、MCP、定时任务和 IM 配置。
- **Main process**：Electron 生命周期、IPC、SQLite 持久化、登录鉴权、日志、OpenClaw 启动、运行时修复、技能同步、IM 网关和 Artifact 服务。
- **OpenClaw 集成**：`openclawEngineManager`、`openclawConfigSync`、`openclawRuntimeAdapter` 和 `coworkEngineRouter` 将 LobsterAI 状态转换成 OpenClaw 运行时行为。

## 安装

### 桌面端

从[官网](https://lobsterai.youdao.com/)或[GitHub Releases](https://github.com/netease-youdao/LobsterAI/releases) 下载最新 macOS 和 Windows 安装包。

### 从源码运行

环境要求：

- Node.js `>=24.15.0 <25`
- npm

```bash
git clone https://github.com/netease-youdao/LobsterAI.git
cd LobsterAI
npm install
```

首次开发启动：

```bash
npm run electron:dev:openclaw
```

OpenClaw runtime 已构建后，日常开发使用：

```bash
npm run electron:dev
```

Renderer 开发服务器默认运行在 `http://localhost:5175`。

## 本地开发

```bash
# 生产 renderer bundle
npm run build

# Electron main/preload TypeScript 构建
npm run compile:electron

# CI 使用的 Vitest 入口
npm test

# src 全量 ESLint；可能暴露既有历史 lint debt
npm run lint

# 对改动过的 TypeScript 文件执行 CI 风格 lint
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <files>
```

### OpenClaw Runtime

锁定的 OpenClaw 版本和第三方插件列表位于 `package.json` 的 `openclaw` 字段。

```bash
# 手动构建当前平台 runtime
npm run openclaw:runtime:host

# 指定 OpenClaw 源码路径
OPENCLAW_SRC=/path/to/openclaw npm run electron:dev:openclaw

# 强制重建 runtime
OPENCLAW_FORCE_BUILD=1 npm run electron:dev:openclaw

# 保持本地 OpenClaw checkout 在当前分支或 tag
OPENCLAW_SKIP_ENSURE=1 npm run electron:dev:openclaw
```

## 打包

<details>
<summary>构建桌面安装包</summary>

```bash
# macOS
npm run dist:mac
npm run dist:mac:x64
npm run dist:mac:arm64
npm run dist:mac:universal

# Windows
npm run dist:win

# Linux
npm run dist:linux
```

打包会把 OpenClaw runtime 内置到 `Resources/cfmind`。Windows 构建还会把便携 Python 运行时内置到 `resources/python-win`，终端用户无需手动安装 Python。

离线或私有源打包可使用：

- `LOBSTERAI_PORTABLE_PYTHON_ARCHIVE`
- `LOBSTERAI_PORTABLE_PYTHON_URL`
- `LOBSTERAI_WINDOWS_EMBED_PYTHON_VERSION`
- `LOBSTERAI_WINDOWS_EMBED_PYTHON_URL`
- `LOBSTERAI_WINDOWS_GET_PIP_URL`

</details>

## 项目地图

| 路径 | 用途 |
| --- | --- |
| `src/main/main.ts` | Electron 生命周期、IPC 注册、鉴权、日志、runtime 启动和服务装配 |
| `src/main/libs/openclawEngineManager.ts` | OpenClaw 网关进程、运行时状态、端口、日志、重启和修复 |
| `src/main/libs/openclawConfigSync.ts` | 将 LobsterAI 的 provider、model、agent、IM 绑定、skills、MCP 和工作区指令渲染为 OpenClaw 配置 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 将 OpenClaw 网关事件翻译为 Cowork 流式事件 |
| `src/main/coworkStore.ts` | Cowork 会话、消息、配置、Agents、记忆元数据和 SQLite CRUD |
| `src/renderer/components/cowork/` | 主 Cowork UI、输入框、会话详情、权限、思考/工具展示、媒体和语音输入 |
| `src/renderer/components/agent/` | Agent 创建和设置 UI |
| `src/renderer/components/skills/` | 技能管理 UI |
| `src/renderer/components/mcp/` | MCP 服务管理 UI |
| `src/renderer/components/scheduledTasks/` | 定时任务列表、表单、详情、运行历史和模板 |
| `src/renderer/services/i18n.ts` | Renderer i18n 字典和 `t()` helper |
| `SKILLs/` | LobsterAI 内置技能 |

## 安全与数据

- Renderer 窗口启用 context isolation，禁用 Node integration，并启用 sandbox。
- Renderer 到 Main 的访问都通过 preload IPC API。
- 敏感工具动作需要权限门控，并会记录日志。
- 应用数据保存在 Electron `userData` 下的本地 `lobsterai.sqlite`。
- OpenClaw 状态、工作区记忆、生成配置和网关日志位于 `userData/openclaw`。

## 社区与支持

扫码加入微信交流群，获取帮助、反馈问题、了解最新动态：

<p align="center">
  <img src="https://shared.ydstatic.com/market/souti/fihserChatWeb/online/2.0.4/dist/assets/wechat_group-B34qRm1G.png" alt="微信社群二维码" width="200">
</p>

Bug 和功能建议请使用仓库 issue 模板。提交 PR 时请包含简要说明、相关 issue、UI 改动截图，以及涉及 Electron IPC、存储、runtime 或窗口行为的说明。

## Star History

[![Star History Chart](docs/res/star-history-202677.png)](https://www.star-history.com/?repos=netease-youdao%2Flobsterai&type=date&legend=bottom-right)


## 许可证

[MIT License](LICENSE)

由[网易有道](https://www.youdao.com/)开发维护。
