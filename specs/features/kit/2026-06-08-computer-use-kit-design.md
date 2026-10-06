# Computer Use Kit 设计文档

## 1. 概述

### 1.1 问题/背景

Computer Use MVP 阶段为了快速验证能力，LobsterAI 直接内置并启用了 `computer-use` skill，并在 OpenClaw 配置同步时自动注入对应 MCP server。这个方式能快速跑通本地桌面控制能力，但存在几个问题：

1. 用户没有明确的启用/关闭入口，无法通过产品 UI 管理 Computer Use。
2. `computer-use` skill 如果默认出现在 `SKILLs/` 目录下，会被 OpenClaw 的 skill 发现逻辑扫描到，导致未安装状态仍可能被模型感知。
3. Computer Use 不只是 skill，还包含全局 MCP server 和本地平台 helper runtime/exe，安装与卸载边界比普通 kit 更复杂。
4. 安装、卸载过程中如果过早触发 `openclaw.json` 同步和网关重启，可能出现 skill/exe/MCP 还未全部就位时网关已经重启的时序问题。

因此需要把 Computer Use 封装成一个内置 kit：它在 Kit 市场中展示得像普通市场 kit，但安装时额外处理 runtime 和 MCP；未安装时不在本地 skill 目录落任何 `computer-use` skill 文件。

### 1.2 目标

1. Computer Use 作为 built-in kit 混入 Kit 市场列表，页面展示上不与远端市场 kit 做区分。
2. 初始默认未安装，未安装时 `SKILLs/computer-use` 不存在，也不被 SkillManager 或 OpenClaw 发现。
3. 安装时复用现有 kit bundle 下载、解压、扫描 `SKILL.md`、拷贝到用户 `SKILLs/`、启用 skill、写安装记录的通用流程。
4. Computer Use 专属逻辑只处理 runtime/exe 安装、全局 MCP 注入条件、runtime/exe 卸载，以及安装完成后的 OpenClaw 配置同步。
5. 安装成功后才触发 `openclaw.json` 同步和必要的网关重启，避免中途重启导致流程不完整。
6. 卸载时移除 skill、安装记录、runtime/exe，并在全部移除后同步 OpenClaw 配置。

### 1.3 非目标

- 不把内部上传接口或临时转换接口写入 LobsterAI 代码或文档。
- 不把 Computer Use 实现为远端市场下发的普通 kit；它仍由客户端内置 catalog entry。
- 不在本次设计中改造通用 MCP 市场安装能力；Computer Use 的 MCP 注入走内置逻辑。
- 不改变 Kit 在对话中的 capability reference 展示设计。

## 2. 用户场景

### 场景 1: 默认未安装

**Given** 用户首次安装或启动 LobsterAI  
**When** OpenClaw 或 SkillManager 扫描 skill 目录  
**Then** 不应发现 `computer-use` skill，Computer Use MCP server 也不应写入 OpenClaw 配置。

### 场景 2: 在 Kit 市场安装 Computer Use

**Given** 用户进入专家套件市场  
**When** 用户选择 Computer Use 并点击安装  
**Then** LobsterAI 下载 Computer Use skill bundle，安装本地 helper runtime/exe，拷贝并启用 `computer-use` skill，写入 kit 安装记录，最后同步 OpenClaw 配置并按需重启网关。

### 场景 3: 安装过程中避免提前重启网关

**Given** OpenClaw 网关正在运行  
**When** Computer Use 安装流程正在下载、解压、安装 exe 或拷贝 skill  
**Then** 不应因为 skill 目录变化提前触发 `skills-changed` 配置同步；只有全部安装内容完成后，才进行一次明确的 `computer-use-kit-installed` 同步。

### 场景 4: 卸载 Computer Use

**Given** 用户已安装 Computer Use kit  
**When** 用户点击卸载  
**Then** LobsterAI 删除用户目录中的 `computer-use` skill，清理 `skills_state`，移除 kit 安装记录，删除 Computer Use runtime/exe，最后同步 OpenClaw 配置并按需重启网关。

### 场景 5: 安装记录残留或目录残留

**Given** 早期版本或异常中断留下了 `SKILLs/computer-use` 目录  
**When** Computer Use kit 未安装  
**Then** SkillManager 应兜底过滤该 skill，不向 UI 或 OpenClaw 暴露。

## 3. 功能需求

### FR-1: 内置 Kit Catalog Entry

- 客户端在 `kits:fetchStore` 获取远端 Kit 市场数据后，向 `kits` 列表追加 Computer Use built-in kit。
- 追加前按 `id` 去重，避免远端同名 kit 与内置 kit 重复展示。
- 仅在支持的平台展示：Windows x64 和 macOS arm64 都通过远程 runtime 包安装；macOS arm64 的包由独立源码项目构建后上传到 NOS/CDN。
- 内置 entry 使用与市场 kit 一致的数据结构：
  - `id`
  - `name`
  - `description`
  - `version`
  - `tryAsking`
  - `skills.bundle`
  - `skills.list`
  - `mcpServers`
  - `connectors`

### FR-2: Skill Bundle 安装复用现有 Kit 流程

- Computer Use skill 不随仓库默认放在 `SKILLs/computer-use` 下。
- 内置 kit 的 `skills.bundle` 指向公开 CDN/NOS 上的 zip 包；macOS arm64 的 skill 包由独立源码项目构建后上传。
- 安装流程继续使用通用 kit 逻辑：
  1. 下载 zip。
  2. 解压到临时目录。
  3. 扫描 `SKILL.md` 发现 skill 目录。
  4. 拷贝到 `{userData}/SKILLs/`。
  5. 写入 `skills_state` 并启用。
  6. 写入 `kits_installed`。
- Computer Use bundle 需要额外校验 size 和 sha256，防止内置包被静默替换。

### FR-3: Runtime/Exe 安装

- Computer Use kit 安装时必须安装本地 helper runtime。
- runtime 包含平台 helper 可执行文件和 MCP server 运行所需的 runtime package。
- runtime 安装应在 skill 拷贝前完成；如果 runtime 安装失败，不应留下已安装的 `computer-use` skill。
- runtime 已存在且校验通过时可以复用。
- runtime 安装结果不作为独立用户可见 kit，只作为 Computer Use kit 的本地依赖。

### FR-4: 全局 MCP 注入

- Computer Use MCP 是全局 MCP，安装 Computer Use kit 后由 OpenClaw 配置同步逻辑自动注入。
- 未安装 Computer Use kit 时，MCP runtime 不返回 Computer Use built-in server。
- MCP 注入条件至少包括：
  - 当前平台有可用的 Computer Use runtime descriptor。
  - AskUser callback server 已启动并有 callback URL。
  - `kits_installed` 中存在 Computer Use kit 安装记录。
  - runtime 可安装或已安装。
- 不通过普通 MCP store 写入一条用户可编辑的 MCP 记录，避免和内置生命周期冲突。

### FR-5: 卸载清理

- 卸载 Computer Use kit 时删除用户目录中的 `SKILLs/computer-use`。
- 从 `skills_state` 删除 `computer-use`。
- 从 `kits_installed` 删除 Computer Use kit 安装记录。
- 删除 Computer Use runtime 当前版本目录和下载缓存。
- 全部清理完成后同步 OpenClaw 配置，使 MCP server 从 `openclaw.json` 中移除。

### FR-6: OpenClaw 同步时序

- Computer Use 安装期间必须避免中途触发 `openclaw.json` 同步。
- 安装和卸载期间应暂停 SkillManager 文件 watcher，避免 `SKILLs` 目录变化触发全局 `skills-changed` 同步。
- 显式同步必须发生在所有文件和数据库状态完成后。
- 显式同步完成后再恢复 watcher，并通知 renderer skill 列表变化。
- 如果同步失败，安装/卸载 IPC 返回失败，避免 UI 误认为 OpenClaw 侧能力已经就绪。

## 4. 实现方案

### 4.1 数据与常量

新增 Computer Use 共享常量模块：

```typescript
export const ComputerUseKitId = {
  BuiltIn: 'computer-use',
} as const;

export const ComputerUseSkillId = {
  BuiltIn: 'computer-use',
} as const;

export const ComputerUseKitBundle = {
  BuiltIn: '<public-cdn-skill-bundle-url>',
} as const;

export const ComputerUseKitBundleIntegrity = {
  Sha256: '<sha256>',
  SizeBytes: 0,
} as const;
```

说明：

- 公开 CDN URL 可以写入客户端代码。
- 内部上传/置换接口不得写入客户端代码、spec 或日志。
- `ComputerUseKitId.BuiltIn` 和 `ComputerUseSkillId.BuiltIn` 当前同名，但语义不同，分别表示 kit 和 skill。

### 4.2 Built-in Kit 构造

主进程提供 `buildComputerUseMarketplaceKit()` 构造内置 kit entry：

```typescript
{
  id: 'computer-use',
  name: { zh: 'Computer Use', en: 'Computer Use' },
  version: ComputerUseRuntime.Version,
  skills: {
    bundle: ComputerUseKitBundle.BuiltIn,
    bundleSha256: ComputerUseKitBundleIntegrity.Sha256,
    bundleSizeBytes: ComputerUseKitBundleIntegrity.SizeBytes,
    list: [{ id: 'computer-use', name, description }],
  },
  mcpServers: [{ id: 'computer-use', name: 'Computer Use' }],
  connectors: [],
}
```

`kits:fetchStore` 的响应处理：

1. 解析远端 store response。
2. 读取 `data.value.kits`。
3. 移除同 id 的远端项。
4. 追加 Computer Use built-in kit。
5. 保持原 response 外层结构返回给 renderer。

### 4.3 安装时序

Computer Use kit 使用 `kits:install`，但在通用流程中插入专属步骤。推荐时序如下：

```text
用户点击安装
  -> 校验 kitId 和 bundleUrl
  -> 下载 skill bundle
  -> 校验 bundle size/sha256
  -> 解压 bundle
  -> 扫描 SKILL.md
  -> 安装或校验 runtime/exe
  -> 暂停 SkillManager watcher
  -> 删除旧 computer-use skill 残留
  -> 拷贝 skill 到 {userData}/SKILLs/
  -> 规范 Windows 文件属性
  -> 写 skills_state，启用 skill
  -> 写 kits_installed 安装记录
  -> await syncOpenClawConfig(reason='computer-use-kit-installed', restartGatewayIfRunning=true)
  -> 恢复 SkillManager watcher
  -> 发送 skills:changed 通知 renderer
  -> 返回安装成功
```

关键约束：

- `syncOpenClawConfig` 必须在 `kits_installed`、skill 文件、runtime/exe 全部就位后执行。
- `skills:changed` 通知必须晚于显式同步，否则主进程中的 `onSkillsChanged` 监听可能提前排队一次 `skills-changed` 同步。
- SkillManager watcher 必须覆盖 `computer-use` skill 删除和拷贝阶段，避免文件系统事件提前触发。
- `syncOpenClawConfig` 使用 `await`，安装 IPC 应等待同步结果，而不是 fire-and-forget。

### 4.4 卸载时序

卸载流程同样需要避免中途同步：

```text
用户点击卸载
  -> 读取 kits_installed 中的 kitRecord
  -> 暂停 SkillManager watcher
  -> 删除 kitRecord.skills.skillIds 对应 skill 目录
  -> 删除 skills_state 对应条目
  -> 删除 kits_installed 安装记录
  -> 删除 computer-use skill 残留
  -> 删除 runtime/exe 和下载缓存
  -> await syncOpenClawConfig(reason='computer-use-kit-uninstalled', restartGatewayIfRunning=true)
  -> 恢复 SkillManager watcher
  -> 发送 skills:changed 通知 renderer
  -> 返回卸载成功
```

关键约束：

- 删除 installed record 后再同步 OpenClaw 配置，确保 MCP 注入条件已经变为 false。
- runtime 删除应在同步前完成，避免网关重启后仍能解析到旧 helper。
- 即使卸载失败，也应在 finally 中恢复 SkillManager watcher。

### 4.5 MCP 解析逻辑

OpenClaw 配置同步前会刷新 MCP resolved server cache。Computer Use MCP server 的解析逻辑应按安装状态判断：

```typescript
const shouldEnableComputerUse =
  isComputerUseRuntimeSupportedPlatform()
  && askUserCallbackUrl !== null
  && isComputerUseKitInstalled(store);
```

当 `shouldEnableComputerUse` 为 true：

1. 调用 `installComputerUseRuntime()`，确保 runtime 可用。
2. 调用 `resolveComputerUseMcpServer()` 生成 stdio server。
3. 将 server 追加进 OpenClaw resolved servers。

### 4.6 macOS clean-room runtime source

macOS Computer Use runtime 不从第三方安装包或 app bundle 中抽取，而是由独立源码项目（`lobsterai-computer-use-runtime`）构建 LobsterAI 自有 runtime archive：

```text
runtime.json
node_modules/@lobsterai/computer-use/
  package.json
  bin/macos/lobster-computer-use
  dist/macos/computer_use_client.js
skill/computer-use/SKILL.md
```

源码项目职责：

- Swift helper 只使用 Apple 公开的 Accessibility、Screen Capture、CoreGraphics、AppKit 与 Text Input Source API。
- TypeScript client 通过 JSON line 协议包装 helper，向 MCP bridge 暴露与 Windows helper 对齐的方法，并把 bridge 的回合元信息（`_meta`）透传给 helper；诊断日志写入 `LOBSTER_COMPUTER_USE_LOG_DIR`（不记录输入的文本）。
- 构建脚本产出 runtime zip 和 skill zip，并生成 size/sha256；runtime zip 内同时携带 `skill/computer-use`，用于 runtime 升级时刷新已安装 kit 的 skill。
- `SKILL.md` 必须带 YAML frontmatter（`name: computer-use` 与 `description`），否则 OpenClaw 会以 `description is required` 跳过该 skill。

交互与投递策略（`delivery`）：

- `get_window_state` 返回截图（JPEG）和带索引的可访问性 outline（`[12] button "保存" @410,88`，`@x,y` 为截图像素坐标），索引绑定 `state_id`；只列出可视区域内的元素，滚出视野的内容汇总为 `… N more items`。Electron/Chromium 应用首次观察时设置 `AXManualAccessibility`，等待网页树就绪。
- 默认 `auto`：优先在后台执行语义动作，不移动用户鼠标、不切换前台应用（AXPress、聚焦输入框、选中行、`set_value`、滚动条滚动、文本选区实现的 `cmd+a`、可访问性文本插入或投递到目标进程的键盘事件）。
- macOS 只接受真实输入的场景（画布/自绘区域的坐标点击、拖拽、无滚动条的滚轮、后台应用的 `cmd+…` 菜单快捷键）会短暂激活目标窗口、使用真实鼠标/键盘，并在完成后把鼠标放回原位。
- `delivery: "background"` 时上述场景直接失败而不接管；环境变量 `LOBSTER_COMPUTER_USE_FOREGROUND_FALLBACK=never` 可把它设为默认。
- 按键解析严格：支持 cmd/ctrl/alt/shift/fn 及 `Control_L`、`Page_Down` 等别名，未知按键或修饰键直接报错，不会退化为输入错误字符。通过键盘事件输入文本时，若当前是中文等输入法，临时切换到 ASCII 键盘布局，结束后恢复。

授权、停止与权限：

- 应用授权：macOS client 不调用 `nodeRepl.createElicitation`，因此由 MCP bridge 在 `get_window_state`、各类输入动作和 `launch_app` 前统一做按应用授权（按应用名与 bundle id 记忆，会话内只问一次）。授权文案跟随应用语言（`LOBSTER_COMPUTER_USE_LOCALE`）。`launch_app` 先 `resolve_app` 解析出真实（本地化）应用名再弹窗，不存在的应用直接报错不弹窗。
- 黑名单在授权前生效：终端类、密码管理器、钥匙串、系统认证弹窗、活动监视器等直接拒绝；LobsterAI 自身窗口（`LOBSTER_COMPUTER_USE_SELF_PID` / `LOBSTER_COMPUTER_USE_SELF_APP`）不出现在窗口列表中且不可操作，避免 agent 操作自己的授权卡片。
- 停止：helper 在操作期间显示「LobsterAI正在使用你的电脑 · 按 Esc 取消」HUD；HUD 可见期间按下物理 Esc，helper 写入 bridge 约定的中断标记，下一次工具调用返回停止信息并开启新回合。合成事件带标记，不会误触发。
- 权限：helper 继承 LobsterAI.app 的 TCC 身份。Kit 安装完成后主进程请求「辅助功能」权限；首次截图时 helper 请求「屏幕录制」权限；`check_permissions` 返回缺失项与修复指引，`request_permissions` 打开对应的系统设置面板；缺少辅助功能时输入类动作明确报错，而不是报告成功。

运维：

- `installComputerUseRuntime()` 成功后删除旧版本 runtime 目录和旧下载包（保留正在解压的临时目录）。
- runtime 安装/复用后，若 kit 已安装，用 runtime 内的 `skill/computer-use/SKILL.md` 刷新用户目录中的 skill，并把 kit 安装记录升级到 runtime 版本，避免出现「需要重新安装」提示。
- MCP server env 中的 bridge secret 写为 `${LOBSTER_MCP_BRIDGE_SECRET}` 占位符，由 OpenClaw 加载配置时从网关环境替换，不在 `openclaw.json` 中落明文。
- `wait_for_text` / `expect_text` 最长等待 45s，低于 OpenClaw 默认 60s 的 MCP 请求超时。

当 `shouldEnableComputerUse` 为 false：

- 不安装 runtime。
- 不返回 Computer Use MCP server。
- OpenClaw 配置中不出现该 MCP。

### 4.6 Skill 发现兜底

虽然正常情况下未安装时不应存在 `SKILLs/computer-use`，但为了兼容旧版本和异常中断，SkillManager 需要兜底过滤：

```typescript
if (skillId === ComputerUseSkillId.BuiltIn && !isComputerUseKitInstalled(store)) {
  return;
}
```

这可以确保：

- UI skill 列表不展示未安装的 Computer Use skill。
- OpenClaw config sync 构建 skills entries 时不会把残留目录暴露出去。
- 后续用户重新安装时仍走统一 kit 安装流程。

### 4.7 安装记录

Computer Use kit 写入 `kits_installed` 的结构与普通 kit 保持一致：

```typescript
{
  id: 'computer-use',
  version: ComputerUseRuntime.Version,
  installedAt: Date.now(),
  skills: {
    skillIds: ['computer-use'],
    metadata: {
      'computer-use': { id, name, description },
    },
  },
  mcpServers: [{ id: 'computer-use', name: 'Computer Use' }],
  connectors: [],
}
```

说明：

- `skills.skillIds` 使用实际安装后的目录名。
- `mcpServers` 表示 kit 能力归属，不表示普通 MCP store 中有一条用户记录。
- Computer Use MCP 是否真正写入 `openclaw.json` 由 `isComputerUseKitInstalled()` 和 MCP runtime 解析共同决定。

## 5. 边界情况

| 场景 | 处理方式 |
|------|----------|
| 平台不是 Windows x64 或 macOS arm64 | Kit 市场不追加 Computer Use built-in entry；MCP resolver 也不返回 Computer Use server |
| macOS 未授予辅助功能/屏幕录制 | 工具返回缺失项和系统设置路径；`request_permissions` 打开对应面板；授权后新的 helper 进程生效 |
| 用户拒绝某个应用的授权 | 该应用的动作直接失败并提示模型不要重试；本会话不再询问 |
| macOS 后台无法投递的输入 | 默认短暂前台接管并恢复鼠标；`delivery: "background"` 时直接失败 |
| runtime 升级后 skill 过期 | runtime 内携带的 skill 自动刷新已安装 skill 和安装记录版本 |
| skill bundle 下载失败 | 安装失败，不写 skill、不写安装记录、不触发 OpenClaw 同步 |
| skill bundle size/sha256 不匹配 | 安装失败，删除临时文件，不写 skill、不写安装记录 |
| bundle 中没有 `SKILL.md` | 安装失败，不安装 runtime，不写安装记录 |
| runtime 下载或校验失败 | 安装失败，不拷贝 skill，不写安装记录 |
| 拷贝 skill 期间失败 | 安装失败，恢复 watcher；后续可重新安装 |
| OpenClaw 配置同步失败 | IPC 返回失败；watcher 在 finally 中恢复 |
| 旧版本留下 `SKILLs/computer-use` | 安装前删除残留；未安装状态由 SkillManager 兜底过滤 |
| 用户卸载时 runtime 文件被占用 | 尝试删除失败时返回卸载失败；后续可重试 |
| 卸载后历史消息引用 Computer Use kit | 历史消息仍可展示 kit reference，但 runtime capability 不再可用 |
| 安装时网关有活跃任务 | `syncOpenClawConfig` 遵循现有 deferred restart 机制，不强行中断活跃任务 |

## 6. 涉及文件

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/shared/computerUse/constants.ts` | Computer Use kit/skill/bundle 常量 |
| `src/main/computerUse/computerUseKit.ts` | 内置 kit catalog、安装记录、安装状态和清理辅助函数 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `SKILLs/skills.config.json` | 移除默认 `computer-use` skill 配置 |
| `SKILLs/computer-use/SKILL.md` | 从仓库内置 skill 目录删除 |
| `src/main/ipcHandlers/kits/handlers.ts` | 混入 built-in kit；安装/卸载 Computer Use runtime；控制 OpenClaw 同步时序 |
| `src/main/computerUse/computerUseRuntime.ts` | 提供 runtime 安装、检查和卸载能力 |
| `src/main/mcp/mcpRuntime.ts` | 仅在 Computer Use kit 已安装时注入内置 MCP server |
| `src/main/skillManager.ts` | 未安装时过滤 `computer-use` skill 残留 |
| `src/main/main.ts` | 向 kit handlers 注入 `syncOpenClawConfig` |
| `src/shared/kit/constants.ts` | 增加 `KitStoreKey.Installed` 常量 |

## 7. 验收标准

1. 新安装或清空用户数据后，`SKILLs/computer-use` 不存在，SkillManager 不列出 Computer Use skill。
2. Kit 市场在 Windows x64 上展示 Computer Use built-in kit，且与普通 kit 混合展示。
3. 安装 Computer Use kit 后，用户目录中出现 `SKILLs/computer-use/SKILL.md`。
4. 安装 Computer Use kit 后，`kits_installed` 中出现 `computer-use` 记录。
5. 安装 Computer Use kit 后，runtime/exe 安装到用户数据目录的 Computer Use runtime 位置。
6. 安装全部完成后才触发 `computer-use-kit-installed` OpenClaw 配置同步。
7. 安装过程中不会因为 `SKILLs` 目录变化提前触发 `skills-changed` 同步。
8. OpenClaw 网关运行时，安装完成后的同步能按需重启或延迟重启网关。
9. 未安装 Computer Use kit 时，`openclaw.json` 不包含 Computer Use MCP server。
10. 安装 Computer Use kit 后，`openclaw.json` 包含 Computer Use MCP server。
11. 卸载 Computer Use kit 后，`SKILLs/computer-use` 被删除。
12. 卸载 Computer Use kit 后，runtime/exe 当前版本目录和下载缓存被删除。
13. 卸载全部完成后才触发 `computer-use-kit-uninstalled` OpenClaw 配置同步。
14. 卸载后 `openclaw.json` 不再包含 Computer Use MCP server。
15. 如果旧版本残留 `SKILLs/computer-use`，但 `kits_installed` 没有安装记录，SkillManager 不展示该 skill。

## 8. 验证计划

### 单元/静态验证

- `npx tsc --project electron-tsconfig.json --noEmit`
- `npx eslint` 针对本次涉及文件
- `npm test -- computerUseMcpServer`
- `npm test -- skillManager`
- `npm test -- kitCapability`

### 手工验证

1. 清理本地 `kits_installed` 和 `SKILLs/computer-use` 后启动应用，确认 Computer Use 未出现在 skill 列表。
2. 打开专家套件市场，确认 Computer Use kit 出现在列表中。
3. 点击安装，观察安装完成后 `SKILLs/computer-use`、runtime/exe、`kits_installed` 均已就位。
4. 在 OpenClaw 网关运行状态下安装，确认重启发生在安装完成之后。
5. 发起一次需要 Computer Use 的 Cowork 请求，确认 MCP 工具可用并会请求用户授权。
6. 卸载 Computer Use kit，确认 skill、runtime/exe、安装记录被清除。
7. 卸载后再次同步或启动 OpenClaw，确认 Computer Use MCP 不再存在。
