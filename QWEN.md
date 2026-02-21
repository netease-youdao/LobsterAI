# QWEN.md — LobsterAI 项目上下文

## 项目概述

**LobsterAI** 是一款由网易有道开发的 All-in-One 个人助理 Agent 桌面应用。基于 Electron 40 + React 18 + TypeScript 构建，支持 macOS/Windows/Linux 平台。

核心功能：
- **Cowork 模式**：基于 Claude Agent SDK 的 AI 协作会话，可自主执行工具、操作文件、运行命令
- **沙箱执行**：支持本地执行或隔离的 Alpine Linux 沙箱 VM 执行
- **内置技能**：16 种内置技能（文档生成、数据分析、视频制作、网页自动化等）
- **定时任务**：支持 Cron 表达式配置周期性自动任务
- **持久记忆**：自动从对话中提取用户偏好和个人信息
- **IM 集成**：通过钉钉/飞书/Telegram/Discord 手机端远程控制
- **权限管控**：所有工具调用需用户明确批准
- **Artifacts 系统**：渲染 HTML/SVG/Mermaid/React 组件预览

## 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Electron 40 |
| 前端 | React 18 + TypeScript |
| 构建 | Vite 5 |
| 样式 | Tailwind CSS 3 |
| 状态管理 | Redux Toolkit |
| AI 引擎 | Claude Agent SDK (@anthropic-ai/claude-agent-sdk) |
| 数据存储 | sql.js (SQLite) |
| Markdown | react-markdown + remark-gfm + rehype-katex |
| 图表 | Mermaid |
| 安全 | DOMPurify |
| IM 集成 | dingtalk-stream / @larksuiteoapi/node-sdk / grammY / discord.js |

## 构建与运行命令

**环境要求**：Node.js >=24 <25

```bash
# 安装依赖
npm install

# 开发模式（Vite  dev server 端口 5175 + Electron 热重载）
npm run electron:dev

# 生产构建（TypeScript 编译 + Vite 打包）
npm run build

# ESLint 检查
npm run lint

# 编译 Electron 主进程
npm run compile:electron

# 打包分发
npm run dist:mac        # macOS (.dmg)
npm run dist:mac:x64    # macOS Intel
npm run dist:mac:arm64  # macOS Apple Silicon
npm run dist:win        # Windows (.exe NSIS)
npm run dist:linux      # Linux (.AppImage)

# 内存提取器测试
npm run test:memory
```

## 项目架构

### 进程模型

**主进程** (`src/main/main.ts`):
- 窗口生命周期管理
- SQLite 数据持久化 (`sqliteStore.ts`)
- CoworkRunner — Claude Agent SDK 执行引擎
- IM 网关（钉钉/飞书/Telegram/Discord）
- 40+ IPC 通道处理程序
- 安全设置：启用上下文隔离，禁用 node 集成，启用沙箱

**预加载脚本** (`src/main/preload.ts`):
- 通过 `contextBridge` 暴露 `window.electron` API
- 包含 `cowork` 命名空间用于会话管理和流式事件

**渲染进程** (`src/renderer/`):
- React 18 + Redux Toolkit + Tailwind CSS
- 所有 UI 和业务逻辑
- 仅通过 IPC 与主进程通信

### 目录结构

```
LobsterAI/
├── src/
│   ├── main/                           # Electron 主进程
│   │   ├── main.ts                     # 入口点，IPC 处理程序
│   │   ├── preload.ts                  # 安全桥接
│   │   ├── sqliteStore.ts              # SQLite 存储
│   │   ├── coworkStore.ts              # 会话/消息 CRUD
│   │   ├── skillManager.ts             # 技能管理
│   │   ├── scheduledTaskStore.ts       # 定时任务存储
│   │   ├── trayManager.ts              # 托盘管理
│   │   ├── autoLaunchManager.ts        # 自启动管理
│   │   ├── logger.ts                   # 日志系统
│   │   ├── im/                         # IM 网关（钉钉/飞书/Telegram/Discord）
│   │   └── libs/
│   │       ├── coworkRunner.ts         # Agent SDK 执行器
│   │       ├── coworkVmRunner.ts       # 沙箱 VM 执行模式
│   │       ├── coworkSandboxRuntime.ts # 沙箱生命周期
│   │       ├── coworkMemoryExtractor.ts # 记忆提取（显式/隐式）
│   │       ├── coworkMemoryJudge.ts    # 记忆验证与评分
│   │       ├── claudeSdk.ts            # SDK 加载工具
│   │       ├── claudeSettings.ts       # API 配置管理
│   │       ├── coworkConfigStore.ts    # Cowork 配置存储
│   │       ├── coworkFormatTransform.ts # 格式转换
│   │       ├── coworkLogger.ts         # Cowork 日志
│   │       ├── coworkOpenAICompatProxy.ts # OpenAI 兼容代理
│   │       ├── coworkUtil.ts           # 工具函数
│   │       └── scheduler.ts            # 定时任务调度器
│   │
│   └── renderer/                        # React 前端
│       ├── App.tsx                     # 根组件
│       ├── main.tsx                    # 渲染入口
│       ├── config.ts                   # 默认配置
│       ├── types/                      # TypeScript 类型定义
│       ├── store/slices/               # Redux state slices
│       │   ├── coworkSlice.ts          # Cowork 会话和流式状态
│       │   ├── artifactSlice.ts        # Artifacts 状态
│       │   └── modelSlice.ts           # 模型选择状态
│       ├── services/                   # 业务逻辑（API/IPC/i18n）
│       │   ├── api.ts                  # LLM API（SSE 流式）
│       │   ├── cowork.ts               # Cowork 服务（IPC 封装）
│       │   ├── config.ts               # 配置管理
│       │   ├── i18n.ts                 # 国际化（中/英）
│       │   ├── theme.ts                # 主题切换
│       │   ├── scheduledTask.ts        # 定时任务服务
│       │   ├── skill.ts                # 技能服务
│       │   ├── im.ts                   # IM 集成服务
│       │   ├── appUpdate.ts            # 应用更新
│       │   └── shortcuts.ts            # 快捷键处理
│       └── components/
│           ├── cowork/                 # Cowork UI 组件
│           │   ├── CoworkView.tsx              # 主界面
│           │   ├── CoworkSessionList.tsx       # 会话侧边栏
│           │   ├── CoworkSessionDetail.tsx     # 消息显示
│           │   └── CoworkPermissionModal.tsx   # 工具权限审批
│           ├── artifacts/              # Artifacts 渲染器
│           ├── skills/                 # 技能管理 UI
│           ├── scheduledTasks/         # 定时任务 UI
│           ├── im/                     # IM 集成 UI
│           ├── Settings.tsx            # 设置面板
│           └── update/                 # 应用更新 UI
│
├── SKILLs/                              # 技能定义
│   ├── skills.config.json              # 技能启用/排序配置
│   ├── web-search/                     # 网页搜索
│   ├── docx/                           # Word 文档生成
│   ├── xlsx/                           # Excel 表格生成
│   ├── pptx/                           # PPT 演示文稿生成
│   ├── pdf/                            # PDF 处理
│   ├── remotion/                       # 视频生成（Remotion）
│   ├── playwright/                     # Web 自动化
│   ├── canvas-design/                  # Canvas 绘图设计
│   ├── frontend-design/                # 前端 UI 设计
│   ├── develop-web-game/               # Web 游戏开发
│   ├── scheduled-task/                 # 定时任务
│   ├── weather/                        # 天气查询
│   ├── local-tools/                    # 本地系统工具
│   ├── create-plan/                    # 计划撰写
│   ├── skill-creator/                  # 自定义技能创建
│   └── imap-smtp-email/                # 邮件收发
│
├── scripts/                             # 构建脚本
│   ├── build-sandbox-image-*.sh        # 沙箱镜像构建
│   ├── setup-mingit.js                 # Windows PortableGit 配置
│   ├── electron-builder-hooks.cjs      # electron-builder 钩子
│   └── notarize.js                     # macOS 公证
│
├── resources/                           # 资源文件
│   └── tray/                           # 托盘图标
│
├── sandbox/                             # 沙箱环境
│   └── agent-runner/                   # Agent 运行环境
│
├── docs/                                # 文档
│   └── res/                            # 架构图等资源
│
├── package.json                         # 项目配置
├── tsconfig.json                        # TypeScript 配置（渲染进程）
├── electron-tsconfig.json               # TypeScript 配置（主进程）
├── vite.config.ts                       # Vite 配置
├── electron-builder.json                # electron-builder 配置
├── tailwind.config.js                   # Tailwind CSS 配置
└── postcss.config.js                    # PostCSS 配置
```

## Cowork 系统

Cowork 是 LobsterAI 的核心功能 — 基于 Claude Agent SDK 构建的 AI 协作会话系统。

### 执行模式

| 模式 | 描述 |
|------|------|
| `auto` | 根据上下文自动选择 |
| `local` | 本地直接执行，全速运行 |
| `sandbox` | 隔离的 Alpine Linux VM，安全优先 |

### 流式事件（IPC 主进程→渲染进程）

- `message` — 新消息添加到会话
- `messageUpdate` — 增量流式内容更新
- `permissionRequest` — 工具执行需用户批准
- `complete` — 会话执行完成
- `error` — 执行出错

### 权限控制

所有涉及文件系统访问、终端命令或网络请求的工具调用都需要用户在 `CoworkPermissionModal` 中明确批准。支持单次使用和会话级批准。

### 关键 IPC 通道

- `cowork:startSession` / `cowork:continueSession` / `cowork:stopSession`
- `cowork:getSession` / `cowork:listSessions` / `cowork:deleteSession`
- `cowork:respondToPermission` / `cowork:getConfig` / `cowork:setConfig`
- `store:get` / `store:set` / `store:delete` — KV 存储操作

## 技能系统

通过 `SKILLs/skills.config.json` 配置 16 种内置技能：

| 技能 | 功能 | 典型用例 |
|------|------|---------|
| web-search | 网页搜索 | 信息检索、调研 |
| docx | Word 文档生成 | 报告、提案 |
| xlsx | Excel 表格生成 | 数据分析、仪表盘 |
| pptx | PPT 演示文稿创建 | 演示文稿、业务复盘 |
| pdf | PDF 处理 | 文档解析、格式转换 |
| remotion | 视频生成（Remotion） | 宣传视频、数据可视化动画 |
| playwright | Web 自动化 | 浏览器任务、自动化测试 |
| canvas-design | Canvas 绘图设计 | 海报、图表设计 |
| frontend-design | 前端 UI 设计 | 原型设计、页面设计 |
| develop-web-game | Web 游戏开发 | 快速游戏原型 |
| scheduled-task | 定时任务 | 周期性自动化工作流 |
| weather | 天气查询 | 天气信息 |
| local-tools | 本地系统工具 | 文件管理、系统操作 |
| create-plan | 计划撰写 | 项目规划、任务分解 |
| skill-creator | 自定义技能创建 | 扩展新能力 |
| imap-smtp-email | 邮件收发 | 邮件处理、自动回复 |

支持通过 `skill-creator` 创建自定义技能并热加载。

## 定时任务

支持通过 Cron 表达式配置周期性任务：

- **对话创建**：用自然语言告诉 Agent（如"每天早上 9 点收集科技新闻"）
- **GUI 创建**：在定时任务管理面板可视化配置

典型场景：新闻收集、邮箱清理、数据报告、内容监控、工作提醒

## IM 集成 — 手机端远程控制

通过 IM 网关将 Agent 桥接到多个 IM 平台：

| 平台 | 协议 | 描述 |
|------|------|------|
| 钉钉 | DingTalk Stream | 企业机器人双向通信 |
| 飞书 | Lark SDK | 飞书应用机器人 |
| Telegram | grammY | Bot API 集成 |
| Discord | discord.js | Discord 机器人集成 |

在设置面板配置对应平台的 Token/Secret 即可启用。

## 持久记忆系统

自动从对话中提取并存储用户信息：

### 记忆捕获方式

- **自动提取**：识别个人信息（姓名、职业）、偏好（语言、格式、风格）、个人事实（宠物、工具）
- **显式请求**：直接告诉 Agent"记住我偏好 Markdown 格式"
- **手动管理**：在设置面板的记忆管理中添加/编辑/删除

### 提取类型

| 类型 | 示例 | 置信度 |
|------|------|--------|
| 个人档案 | "我叫 Alex"，"我是产品经理" | 高 |
| 个人所有物 | "我有一只猫"，"我用 MacBook" | 高 |
| 个人偏好 | "我喜欢简洁风格"，"我偏好英文回复" | 中高 |
| 助手偏好 | "回复不要用 emoji"，"代码用 TypeScript 写" | 中高 |
| 显式请求 | "记住这个"，"请记下来" | 最高 |

### 记忆设置

| 设置 | 描述 | 默认值 |
|------|------|--------|
| 记忆开关 | 启用/禁用记忆功能 | 开启 |
| 自动捕获 | 是否自动从对话中提取记忆 | 开启 |
| 捕获严格度 | Strict/Standard/Relaxed — 控制自动提取敏感度 | Standard |
| 最大注入项数 | 每会话注入的记忆数量上限（1-60） | 12 |

## 数据存储

所有数据存储在本地 SQLite 数据库（用户数据目录下的 `lobsterai.sqlite`）：

| 表名 | 用途 |
|------|------|
| `kv` | 应用配置键值对 |
| `cowork_config` | Cowork 设置（工作目录、系统提示、执行模式） |
| `cowork_sessions` | 会话元数据 |
| `cowork_messages` | 消息历史 |
| `scheduled_tasks` | 定时任务定义 |

## 安全模型

- **进程隔离**：启用上下文隔离，禁用 node 集成
- **权限管控**：工具调用需用户明确批准
- **沙箱执行**：可选 Alpine Linux VM 隔离执行
- **内容安全**：HTML 沙箱、DOMPurify、Mermaid 严格模式
- **工作区边界**：文件操作限制在指定工作目录内
- **IPC 验证**：所有跨进程调用类型检查

## 配置说明

### 应用配置

- 存储在 SQLite `kv` 表
- 通过设置面板编辑
- 包括 API 配置、主题、语言等

### Cowork 配置

- 工作目录：Agent 操作根目录
- 系统提示：自定义 Agent 行为
- 执行模式：`auto` / `local` / `sandbox`

### 国际化

支持中文和英文，在设置面板切换语言。首次运行时根据系统区域设置自动检测。

## 开发规范

- **TypeScript**：严格模式，函数式 React 组件 + Hooks
- **代码风格**：2 空格缩进，单引号，分号
- **命名约定**：
  - 组件：`PascalCase`（如 `CoworkView.tsx`）
  - 函数/变量：`camelCase`
  - Redux slices：`*Slice.ts`
- **样式**：优先使用 Tailwind CSS 工具类
- **提交信息**：`type: short imperative summary` 格式（如 `feat: add artifact toolbar`）

## 测试指南

- 使用 Node.js 内置 `node:test` 模块（非 Jest/Mocha/Vitest）
- 测试文件位于 `tests/` 目录
- 运行测试：`npm run test:memory`
- UI 变更手动验证：运行 `npm run electron:dev` 测试关键流程

## 关键依赖

- `@anthropic-ai/claude-agent-sdk` — Cowork 会话的 Claude Agent SDK
- `sql.js` — SQLite 数据库持久化
- `react-markdown`, `remark-gfm`, `rehype-katex` — Markdown 渲染（含数学公式）
- `mermaid` — 图表渲染
- `dompurify` — SVG/HTML 消毒
- `dingtalk-stream`, `@larksuiteoapi/node-sdk`, `grammy`, `discord.js` — IM 集成

## TypeScript 配置

- `tsconfig.json`：渲染进程配置（ES2020，ESNext 模块）
- `electron-tsconfig.json`：主进程配置（CommonJS 输出到 `dist-electron/`）

## 路径别名

- `@` 映射到 `src/renderer/`（Vite 配置中定义）

## Artifacts 系统

支持渲染多种代码输出类型：

| 类型 | 渲染方式 |
|------|---------|
| `html` | 沙箱 iframe 渲染完整 HTML 页面 |
| `svg` | DOMPurify 消毒 + 缩放控制 |
| `mermaid` | Mermaid.js 渲染流程图/时序图/类图 |
| `react` | Babel 编译的 React/JSX 组件（隔离 iframe） |
| `code` | 带行号的语法高亮代码 |

**检测方式**：
1. 显式标记：` ```artifact:html title="My Page" `
2. 启发式检测：分析代码块语言和内容模式

**安全措施**：
- HTML：`sandbox="allow-scripts"` 无 `allow-same-origin`
- SVG：DOMPurify 移除所有脚本内容
- React：完全隔离的 iframe，无网络访问
- Mermaid：`securityLevel: 'strict'` 配置
