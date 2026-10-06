# 渠道双击静默安装功能设计文档

## 1. 概述

LobsterAI 当前 Windows NSIS 安装包已经支持 `/S` 静默安装，企业或渠道侧可以通过命令行完成无人值守部署。但部分渠道希望用户直接双击安装包时也进入静默安装流程，减少安装向导步骤和人工选择，适配批量分发、预装、网管工具下发等场景。

本功能在现有渠道包构建能力上增加显式“双击静默”打包参数：`dist:win:channel` 完整安装包和 `dist:win:web` Web 安装包均根据命令行参数生成不同安装器行为。传入 `--silent` 的渠道包在用户直接打开时自动进入 NSIS silent mode；未传入该参数时保持普通交互式安装向导。已有 `/S` 命令行能力保持不变。

### 1.1 目标

- 允许通过显式打包参数生成“用户双击也静默安装”的 Windows 完整安装包或 Web 安装包。
- 静默安装（双击静默包或命令行 `/S`，如应用商店后台安装）不显示任何 LobsterAI 自有安装窗口，安装体验由分发渠道承载。
- 继续复用现有 NSIS 安装器、渠道归因、签名、OpenClaw runtime 打包和资源恢复流程。
- 将双击静默行为固化在构建产物中，不依赖用户机器环境变量或安装时读取 `.keyfrom-build`。
- 保持普通渠道包的安装向导体验不变。
- 在静默安装、命令行 `/S` 安装和普通交互安装之间保留一致的安装安全校验、日志和回滚行为。
- 让产物名称或构建日志能明确暴露该包是否为双击静默渠道包，降低渠道投放混用风险。

### 1.2 非目标

- 不绕过 Windows UAC、管理员确认、杀软拦截或系统安全策略。
- 不新增 MSI、便携版、免安装版或独立“silent setup”打包体系。
- 不改变 `keyfrom` 归因语义；`keyfrom` 仍只表示渠道来源，不直接作为用户可编辑配置。
- 不让普通用户在安装向导里切换是否静默。
- 不在运行后的 LobsterAI 应用内提供修改安装器静默策略的入口。
- 不改变安装目录、卸载、自动更新、资源解压、Defender 排除项和旧版本迁移的既有业务规则。

## 2. 核心流程

1. 开发者执行 `npm run dist:win:channel -- --keyfrom <channel>` 生成普通渠道包。
2. 当该渠道需要双击静默时，开发者显式追加 `--silent`。
3. 渠道构建脚本校验并归一化 `keyfrom`，解析本次构建的安装器 UI 参数。
4. Electron Builder 配置将参数写入 NSIS 编译期定义，而不是让安装器运行时从应用资源中推断。
5. NSIS 安装器启动时先执行初始化逻辑：
   - 如果用户显式传入 `/S`，按现有静默安装处理。
   - 如果安装器被构建为“双击静默包”，即使没有 `/S` 也调用 `SetSilent silent`。
   - 未传入参数的渠道包保持 `interactive`。
6. 安装器继续执行现有预检、关闭旧进程、旧版本迁移、资源解压、校验、注册和收尾逻辑。
7. 安装日志记录本次安装的 `ui_mode` 和触发来源，方便定位渠道包是否按预期进入静默流程。

## 3. 功能要求

### 3.1 双击静默打包参数

- `dist:win:channel` 和 `dist:win:web` 均支持显式参数 `--silent`。
- 参数只对 Windows NSIS 完整安装包和 `nsis-web` 生效；macOS、Linux 不读取该参数。
- 未传入参数时默认 `silentOnDoubleClick=false`。
- 构建脚本必须清理同名环境变量，不从开发者 shell 中继承隐式环境变量。
- 渠道值继续复用现有规则：小写，允许 `a-z`、`0-9`、`_`、`-`，长度 1 到 64。

命令示例：

```bash
npm run dist:win:channel -- --keyfrom dictbind
npm run dist:win:channel -- --keyfrom dictbind --silent
npm run dist:win:web -- --keyfrom dictbind --silent
npm run dist:win:web -- --keyfrom dictbind --silent --pkg-url <uploaded-url>
```

示例行为：

| 命令 | silentOnDoubleClick | 行为 |
|------|---------------------|------|
| `--keyfrom dictbind` | `false` | 双击打开普通安装向导 |
| `--keyfrom dictbind --silent` | `true` | 双击直接静默安装 |
| `--keyfrom official` | `false` | 双击打开普通安装向导 |
| `dist:win:web -- --keyfrom dictbind --silent` | `true` | 两阶段构建均保留静默策略，最终 WebSetup 双击直接静默安装 |

### 3.2 构建脚本路由

- `scripts/dist-win-channel.cjs` 在设置 `KEYFROM` 后，同时解析本次构建的 `silentOnDoubleClick`。
- `scripts/dist-win-web.cjs` 使用相同参数，并在 upload-first 流程输出包含 `--silent` 的第二阶段命令，避免最终 stub 丢失静默策略。第二阶段通过 `--prepackaged release/win-unpacked` 复用第一阶段应用目录，并设置版本锁定的 app-builder 补丁开关：读取现有 `.nsis.7z` 尾部的 embedded block map 元数据而不再次追加；构建结束后再校验 payload 的 SHA-256 完全一致，防止 WebSetup 内嵌完整性信息与已上传文件不匹配。
- 渠道构建脚本需要清理所有安装器策略相关环境变量，避免上一轮构建残留影响下一轮。
- 当 `silentOnDoubleClick=true` 时，构建日志必须明确输出该渠道为双击静默包。
- dry-run 模式需要输出将要执行的 keyfrom 和安装器 UI 策略。
- 非 Windows 渠道构建不读取或应用该策略。

### 3.3 Electron Builder 配置

- `scripts/electron-builder-config.cjs` 读取构建脚本注入的策略值。
- 当策略开启时，给 NSIS 注入编译期宏，例如 `LOBSTERAI_SILENT_ON_DOUBLE_CLICK`。
- 产物命名建议包含可识别标记，例如：

```text
LobsterAI-Setup-x64-${version}-${keyfrom}-silent.exe
LobsterAI-WebSetup-x64-${version}-${keyfrom}-silent.exe
```

- 如果不改变产物名，至少需要在构建日志和发布记录中明确标注 silent 行为。
- 不依赖 `.keyfrom-build/keyfrom.json` 决定安装器是否静默；该文件继续用于应用运行后的渠道归因。

### 3.4 NSIS 初始化行为

- 在 `scripts/nsis-installer.nsh` 的安装器初始化阶段处理双击静默。
- 判断顺序应保证显式 `/S` 与渠道双击静默最终都进入同一 silent mode。
- 双击静默包应在写安装日志前完成 `SetSilent silent`，保证 `ui_mode` 记录为 `silent`。
- 安装器不内置任何静默模式 Banner 或自有窗口；静默安装（构建标记或 `/S`）的进度体验由调用方（应用商店、渠道绑定流程、网管工具）承载。
- 原有 `${Silent}` 分支，包括失败弹窗 `/SD` 默认按钮、进程关闭、回滚和卸载路径，必须继续复用。
- 交互式安装向导与 `--updated` 更新进度页不受影响。
- 该行为只影响安装器 UI 展示，不跳过安装前置校验和失败保护。
- Windows UAC、安装器 `RequestExecutionLevel` 和 Defender 排除项逻辑保持不变；系统是否显示提权确认由 Windows 策略决定。

建议伪代码：

```nsh
!ifdef LOBSTERAI_SILENT_ON_DOUBLE_CLICK
  SetSilent silent
!endif

${If} ${Silent}
  StrCpy $lobsterUiMode "silent"
${EndIf}
```

### 3.5 日志与可观测性

- `install-timing.log` 中继续记录 `ui_mode`。
- 新增或扩展字段记录触发来源，例如 `silent_source=argv`、`silent_source=build-flag` 或 `silent_source=none`。
- 构建日志输出以下信息：
  - `keyfrom`
  - `mode=full-installer`
  - `silentOnDoubleClick`
  - 最终 artifact name
- 安装失败时仍优先写入 `$APPDATA\LobsterAI\install-timing.log`，静默渠道不吞掉错误。

### 3.6 兼容性与安全边界

- 已经通过 `/S` 启动的任何渠道包保持现有静默安装行为。
- 未传入 `--silent` 的渠道，双击必须继续显示交互式安装向导。
- UAC 行为由 Windows 和安装器权限决定，本功能不得尝试规避。
- 双击静默包不能要求用户选择安装目录；必须接受 NSIS 默认目录或既有安装目录。
- 如果旧版本迁移、资源解压或校验失败，必须保持现有 rollback 和失败可诊断能力。
- 更新流程中使用 `--updated` 的可见进度安装不纳入本功能，不因为本次打包参数变成完全静默更新。

## 4. 实现边界

| 层级 | 职责 |
|------|------|
| `scripts/build-env.cjs` | 增加构建期安装器策略环境变量常量，并纳入渠道构建清理列表 |
| `scripts/dist-win-channel.cjs` | 解析 keyfrom 和双击静默参数，注入本次构建环境，输出 dry-run 和构建日志 |
| `scripts/electron-builder-config.cjs` | 将策略转换为 NSIS 编译期宏和可选 artifact 命名标记 |
| `scripts/nsis-installer.nsh` | 在安装器初始化阶段调用 `SetSilent silent`，复用现有 silent 分支 |
| `scripts/dist-win-web.cjs` | 在完整构建和 stub-only 构建中显式注入同一双击静默策略；stub-only 复用预打包目录并强制校验 payload 哈希不变 |
| `specs/features/keyfrom-channel-attribution/` | 保持渠道归因语义说明，不承载安装器 UI 策略 |

主进程和 Renderer 不需要感知安装器双击静默策略；应用启动后的 `keyfrom` 归因仍通过现有 `.keyfrom-build` 资源读取和 SQLite 持久化完成。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 用户双击普通渠道包 | 显示普通安装向导 |
| 用户双击双击静默包 | 自动进入 silent mode 并执行默认安装流程 |
| 用户对普通渠道包传 `/S` | 按现有命令行静默安装处理 |
| 用户对双击静默包传 `/S` | 与双击静默等价，不重复执行特殊逻辑 |
| 用户对双击静默包传 `/D=<path>` | 遵循 NSIS silent install 对安装目录参数的既有规则 |
| 未传入双击静默参数 | 默认交互式安装，不失败 |
| 渠道值非法 | 构建脚本按现有规则失败或回退，不能生成未标识策略的异常包 |
| 旧版本正在运行 | 复用现有进程停止与日志逻辑；静默安装不显示任何安装器自有窗口 |
| 安装资源解压失败 | 复用现有失败处理、日志、回滚和 silent MessageBox 默认选择 |
| UAC 被取消 | 安装不继续，静默策略不绕过系统确认 |
| 更新安装器带 `--updated` | 保持现有更新模式，不因打包参数隐藏必要进度 |

## 6. 验收标准

1. 未传入 `--silent` 时，`npm run dist:win:channel -- --keyfrom dictbind` 双击安装包仍展示安装向导。
2. 传入 `--silent` 时，`npm run dist:win:channel -- --keyfrom dictbind --silent` 双击安装包不展示安装向导，直接进入静默安装流程。
3. 普通渠道包和双击静默包在传入 `/S` 时均能完成现有静默安装。
4. 双击静默包安装完成后，应用启动读取到的 `latestKeyfrom` 仍为该渠道值。
5. `install-timing.log` 对双击静默包记录 `ui_mode=silent`，并能区分是构建参数触发还是命令行 `/S` 触发。
6. 双击静默包遇到资源解压失败、旧版本迁移失败或校验失败时，仍保留现有日志、回滚和错误默认处理。
7. 构建日志能清楚显示 `keyfrom`、`silentOnDoubleClick` 和产物路径，发布人员可以区分普通渠道包和双击静默渠道包。
8. 传入 `dist:win:web -- --keyfrom dictbind --silent` 时，最终 WebSetup 产物名包含 `-silent`，双击后下载与安装过程均不展示 LobsterAI 安装器 UI；Windows UAC 不在此约束内。
9. WebSetup 静默下载失败时使用非交互默认选项退出，不因错误弹窗阻塞无人值守流程。
10. macOS、Linux 和应用运行时 UI 不受该功能影响。
11. 任何静默安装（双击静默包或命令行 `/S`）均不显示 LobsterAI 自有窗口；交互式安装向导与 `--updated` 更新进度页保持既有 UI。
