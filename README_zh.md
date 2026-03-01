# LobsterAI — 全场景个人助理 Agent

<p align="center">
  <img src="public/logo.png" alt="LobsterAI" width="120">
</p>

<p align="center">
  <strong>7×24 小时帮你干活的全场景个人助理，由网易有道开发</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <br>
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Mobile-brightgreen?style=for-the-badge" alt="Platform">
  <br>
  <img src="https://img.shields.io/badge/Electron-40-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React">
</p>

<p align="center">
  <a href="README.md">English</a> · 中文
</p>

---

**LobsterAI** 是由[网易有道](https://www.youdao.com/)开发的全场景个人助理 Agent。它 7×24 小时待命，能够帮你完成日常办公中的各类事务 —— 数据分析、制作 PPT、生成视频、撰写文档、搜索信息、收发邮件、定时任务，以及更多。

LobsterAI 的核心是 **Cowork 模式**，它能在本地或沙箱环境中执行工具、操作文件、运行命令，一切都在你的监督下自主完成。此外，LobsterAI 支持通过钉钉、飞书、Telegram、Discord 等 IM 平台远程触发，让你在手机上也能随时指挥 Agent 工作。

## 核心特性

- **全场景办公助理** — 数据分析、PPT 制作、视频生成、文档撰写、Web 搜索、邮件收发，覆盖日常办公全流程
- **本地 + 沙箱执行** — 任务执行支持本地直接运行或隔离的 Alpine Linux 沙箱
- **内置技能** — 包括 Office 文档生成、Web 搜索、Playwright 自动化、Remotion 视频生成等
- **Windows 内置 Python 运行时** — Windows 安装包内置可直接使用的 Python 解释器运行时；Python 技能依赖可按需安装
- **定时任务** — 支持对话式发起或 GUI 界面添加定时任务，如每日新闻收集、邮箱整理、周期性报告生成等
- **持久记忆** — 自动从对话中提取用户偏好与个人信息，跨会话记住你的习惯，越用越懂你
- **IM 远程操控** — 通过钉钉、飞书、Telegram、Discord 在手机端随时触发 Agent
- **权限门控** — 所有敏感工具调用需用户明确批准后执行
- **跨平台** — macOS（Intel + Apple Silicon）、Windows、Linux 桌面端，配合 IM 实现移动端覆盖
- **数据本地化** — SQLite 本地存储，聊天记录和配置不离开你的设备

## 工作原理

<p align="center">
  <img src="docs/res/architecture_zh.png" alt="Architecture" width="500">
</p>

## 快速开始

### 环境要求

- **Node.js** >= 24 < 25
- **npm**

### 安装与开发

```bash
# 克隆仓库
git clone https://github.com/netease-youdao/LobsterAI.git
cd lobsterai

# 安装依赖
npm install

# 启动开发环境（Vite 开发服务器 + Electron 热重载）
npm run electron:dev
```

开发服务器默认运行在 `http://localhost:5175`。

### 生产构建

```bash
# 编译 TypeScript + Vite 打包
npm run build

# ESLint 代码检查
npm run lint
```

## 打包分发

使用 [electron-builder](https://www.electron.build/) 生成各平台安装包，输出到 `release/` 目录。

```bash
# macOS (.dmg)
npm run dist:mac

# macOS - 仅 Intel
npm run dist:mac:x64

# macOS - 仅 Apple Silicon
npm run dist:mac:arm64

# macOS - Universal (双架构)
npm run dist:mac:universal

# Windows (.exe NSIS 安装包)
npm run dist:win

# Linux (.AppImage)
npm run dist:linux
```

Windows 打包会内置便携 Python 运行时到 `resources/python-win`（安装包资源目录为 `python-win`），终端用户无需手动安装 Python。
该运行时以解释器为主，不预装 LobsterAI 技能所需的 Python 三方包；相关依赖可在运行时按需安装。
默认情况下，如果未提供预构建压缩包，打包脚本会直接从 python.org 下载官方 embeddable Python 运行时。
离线或无法联网的构建场景，请显式提供预构建运行时压缩包。

企业离线/私有源打包可通过以下环境变量配置：
- `LOBSTERAI_PORTABLE_PYTHON_ARCHIVE`：本地预构建运行时压缩包路径（离线 CI/CD 推荐）
- `LOBSTERAI_PORTABLE_PYTHON_URL`：预构建运行时压缩包下载地址
- `LOBSTERAI_WINDOWS_EMBED_PYTHON_VERSION` / `LOBSTERAI_WINDOWS_EMBED_PYTHON_URL` / `LOBSTERAI_WINDOWS_GET_PIP_URL`：Windows 主机构建时自动拉取源的可选覆盖项

## 架构概览

LobsterAI 采用 Electron 严格进程隔离架构，所有跨进程通信通过 IPC 完成。

### 进程模型

**Main Process**（`src/main/main.ts`）：
- 窗口生命周期管理
- SQLite 数据持久化
- CoworkRunner — Claude Agent SDK 执行引擎
- IM 网关 — 钉钉、飞书、Telegram、Discord 远程接入
- 40+ IPC 通道处理
- 安全：context isolation 启用，node integration 禁用，sandbox 启用

**Preload Script**（`src/main/preload.ts`）：
- 通过 `contextBridge` 暴露 `window.electron` API
- 包含 `cowork` 命名空间用于会话管理和流式事件

**Renderer Process**（`src/renderer/`）：
- React 18 + Redux Toolkit + Tailwind CSS
- 所有 UI 和业务逻辑
- 仅通过 IPC 与主进程通信

### 目录结构

```
src/
├── main/                           # Electron 主进程
│   ├── main.ts                     # 入口，IPC 处理
│   ├── preload.ts                  # 安全桥接
│   ├── sqliteStore.ts              # SQLite 存储
│   ├── coworkStore.ts              # 会话/消息 CRUD
│   ├── skillManager.ts             # 技能管理
│   ├── im/                         # IM 网关（钉钉/飞书/Telegram/Discord）
│   └── libs/
│       ├── coworkRunner.ts         # Agent SDK 执行器
│       ├── coworkVmRunner.ts       # 沙箱 VM 执行
│       ├── coworkSandboxRuntime.ts # 沙箱生命周期
│       └── coworkMemoryExtractor.ts # 记忆提取
│
├── renderer/                        # React 前端
│   ├── App.tsx                     # 根组件
│   ├── types/                      # TypeScript 类型定义
│   ├── store/slices/               # Redux 状态切片
│   ├── services/                   # 业务逻辑层（API/IPC/i18n）
│   └── components/
│       ├── cowork/                 # Cowork UI 组件
│       ├── artifacts/              # Artifact 渲染器
│       ├── skills/                 # 技能管理 UI
│       ├── im/                     # IM 集成 UI
│       └── Settings.tsx            # 设置面板
│
SKILLs/                              # 技能定义目录
├── skills.config.json              # 技能启停与排序配置
├── web-search/                     # Web 搜索
├── docx/                           # Word 文档生成
├── xlsx/                           # Excel 表格
├── pptx/                           # PowerPoint 演示
├── pdf/                            # PDF 处理
├── remotion/                       # 视频生成
├── playwright/                     # Web 自动化
└── ...                             # 更多技能
```

## Cowork 系统

Cowork 是 LobsterAI 的核心功能 —— 基于 Claude Agent SDK 的 AI 工作会话系统。它面向办公场景设计，能够自主完成数据分析、文档生成、信息检索等复杂任务。

### 执行模式

| 模式 | 说明 |
|------|------|
| `auto` | 自动根据上下文选择执行方式 |
| `local` | 本地直接执行，全速运行 |
| `sandbox` | 隔离的 Alpine Linux VM，安全优先 |

### 流式事件

Cowork 通过 IPC 事件实现实时双向通信：

- `message` — 新消息加入会话
- `messageUpdate` — 流式内容增量更新
- `permissionRequest` — 工具执行需要用户审批
- `complete` — 会话执行完毕
- `error` — 执行出错

### 权限控制

所有涉及文件系统、终端命令、网络请求的工具调用都需要用户在 `CoworkPermissionModal` 中明确批准。支持单次批准和会话级批准。


## 技能系统

LobsterAI 内置 16 种技能，覆盖办公、创作、自动化等多种场景，通过 `SKILLs/skills.config.json` 配置启停和排序：

| 技能 | 功能 | 典型场景 |
|------|------|---------|
| web-search | Web 搜索 | 信息检索、资料收集 |
| docx | Word 文档生成 | 报告撰写、方案输出 |
| xlsx | Excel 表格生成 | 数据分析、报表制作 |
| pptx | PowerPoint 制作 | 演示文稿、汇报材料 |
| pdf | PDF 处理 | 文档解析、格式转换 |
| remotion | 视频生成（Remotion） | 宣传视频、数据可视化动画 |
| playwright | Web 自动化 | 网页操作、自动化测试 |
| canvas-design | Canvas 绘图设计 | 海报、图表设计 |
| frontend-design | 前端 UI 设计 | 原型制作、页面设计 |
| develop-web-game | Web 游戏开发 | 小游戏快速原型 |
| scheduled-task | 定时任务 | 周期性工作自动执行 |
| weather | 天气查询 | 天气信息获取 |
| local-tools | 本地系统工具 | 文件管理、系统操作 |
| create-plan | 计划编排 | 项目规划、任务分解 |
| skill-creator | 自定义技能创建 | 扩展新能力 |
| imap-smtp-email | 邮件收发 | 邮件处理、自动回复 |

支持通过 `skill-creator` 创建自定义技能并热加载。

## 定时任务

LobsterAI 支持创建定时任务，让 Agent 按计划自动执行重复性工作。

### 创建方式

- **对话式创建** — 直接用自然语言告诉 Agent（如「每天早上 9 点帮我收集科技新闻」），Agent 会自动创建对应的定时任务
- **GUI 界面创建** — 在定时任务管理面板中手动添加，可视化配置执行时间和任务内容

### 典型场景

| 场景 | 示例 |
|------|------|
| 新闻收集 | 每天早上自动收集行业资讯并生成摘要 |
| 邮箱整理 | 定时检查收件箱，分类整理并汇总重要邮件 |
| 数据报告 | 每周自动生成业务数据分析报告 |
| 信息监控 | 定期检查指定网站内容变化并通知 |
| 工作提醒 | 按计划生成待办事项清单或会议纪要 |

定时任务基于 Cron 表达式调度，支持分钟、小时、日、周、月等多种周期粒度。任务执行时会自动启动 Cowork 会话，结果可通过桌面端查看或经 IM 推送到手机。

## IM 集成 — 手机端远程操控

LobsterAI 支持将 Agent 桥接到多种 IM 平台。在手机上通过 IM 发送消息即可远程触发桌面端的 Agent 执行任务，随时随地指挥你的个人助理。

| 平台 | 协议 | 说明 |
|------|------|------|
| 钉钉 | DingTalk Stream | 企业机器人双向通信 |
| 飞书 | Lark SDK | 飞书应用机器人 |
| Telegram | grammY | Bot API 接入 |
| Discord | discord.js | Discord Bot 接入 |
| 云信 IM | node-nim V2 SDK | 网易云信 IM P2P 私聊 |

在设置面板中配置对应平台的 Token/密钥即可启用。配置完成后，你可以在手机 IM 中直接对 Agent 下达指令（如「帮我分析这份数据」「做一份本周工作汇报 PPT」），Agent 会在桌面端自动执行并返回结果。

## 持久记忆

LobsterAI 内置记忆系统，能够跨会话记住你的个人信息和偏好，让 Agent 越用越懂你。

### 记忆获取方式

- **自动提取** — 对话过程中，系统自动识别并记录你的个人信息（姓名、职业等）、偏好习惯（喜好的语言、格式、风格）和个人事实（养的宠物、使用的工具等），无需手动操作
- **主动告知** — 在对话中直接说「记住我喜欢用 Markdown 格式」「记下我的项目叫 LobsterAI」等，Agent 会以更高置信度存储
- **手动管理** — 在设置面板的记忆管理界面中手动添加、编辑或删除记忆条目

### 工作机制

每轮对话结束后，记忆提取器会分析对话内容：

| 提取类型 | 示例 | 置信度 |
|---------|------|--------|
| 个人档案 | 「我叫张三」「我是产品经理」 | 高 |
| 个人所有 | 「我养了一只猫」「我有一台 MacBook」 | 高 |
| 个人偏好 | 「我喜欢简洁的风格」「我偏好英文回复」 | 中高 |
| 助手偏好 | 「回复时不要用 emoji」「代码用 TypeScript」 | 中高 |
| 主动告知 | 「记住这个」「请记下来」 | 最高 |

提取的记忆会自动去重、合并，并在后续会话中注入到 Agent 的上下文中，使 Agent 的回复更加个性化和贴合你的需求。

### 记忆设置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| 记忆开关 | 启用或关闭记忆功能 | 开启 |
| 自动捕获 | 是否自动从对话中提取记忆 | 开启 |
| 捕获严格度 | 严格 / 标准 / 宽松，控制自动提取的灵敏度 | 标准 |
| 最大注入条数 | 每次会话注入的记忆上限（1-60） | 12 |

## 数据存储

所有数据存储在本地 SQLite 数据库（`lobsterai.sqlite`，位于用户数据目录）。

| 表 | 用途 |
|----|------|
| `kv` | 应用配置键值对 |
| `cowork_config` | Cowork 设置（工作目录、系统提示词、执行模式） |
| `cowork_sessions` | 会话元数据 |
| `cowork_messages` | 消息历史 |
| `scheduled_tasks` | 定时任务定义 |

## 安全模型

LobsterAI 在多个层面实施安全控制：

- **进程隔离** — context isolation 启用，node integration 禁用
- **权限门控** — 敏感工具调用需用户明确审批
- **沙箱执行** — 可选 Alpine Linux VM 隔离执行环境
- **工作区边界** — 文件操作限制在指定工作目录内
- **IPC 验证** — 所有跨进程调用经过类型检查

## 技术栈

| 层 | 技术 |
|----|------|
| 框架 | Electron 40 |
| 前端 | React 18 + TypeScript |
| 构建 | Vite 5 |
| 样式 | Tailwind CSS 3 |
| 状态 | Redux Toolkit |
| AI 引擎 | Claude Agent SDK (Anthropic) |
| 存储 | sql.js |
| Markdown | react-markdown + remark-gfm + rehype-katex |
| 图表 | Mermaid |
| 安全 | DOMPurify |
| IM | dingtalk-stream · @larksuiteoapi/node-sdk · grammY · discord.js |

## 配置

### 应用配置

应用级配置存储在 SQLite `kv` 表中，通过设置面板修改。

### Cowork 配置

Cowork 会话配置包含：

- **工作目录** — Agent 操作的根目录
- **系统提示词** — 自定义 Agent 行为
- **执行模式** — `auto` / `local` / `sandbox`

### 国际化

支持中文（默认）和英文两种语言，通过设置面板切换。

## 开发规范

- TypeScript 严格模式，函数式组件 + Hooks
- 2 空格缩进，单引号，分号
- 组件 `PascalCase`，函数/变量 `camelCase`，Redux 切片 `*Slice.ts`
- Tailwind CSS 优先，避免自定义 CSS
- 提交信息遵循 `type: short imperative summary` 格式（如 `feat: add artifact toolbar`）

## 贡献

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/your-feature`)
3. 提交改动 (`git commit -m 'feat: add something'`)
4. 推送到远程 (`git push origin feature/your-feature`)
5. 发起 Pull Request

PR 描述中请包含：变更说明、关联 issue、UI 变更附截图，以及涉及 Electron 特定行为的说明。

## 许可证

[MIT License](LICENSE)


## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=netease-youdao/LobsterAI&type=date&legend=top-left)](https://www.star-history.com/#netease-youdao/LobsterAI&type=date&legend=top-left)


---

由[网易有道](https://www.youdao.com/)开发维护。
