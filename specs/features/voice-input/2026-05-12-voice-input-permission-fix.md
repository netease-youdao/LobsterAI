# 语音输入：权限处理 + macOS 听写快捷键配置

## 1. 概述

### 1.1 问题/背景

语音输入功能（PR #1947）在 macOS 上通过 AppleScript 模拟按键触发系统听写，底层使用 `System Events`。要正常工作需要满足三个条件：

| # | 条件 | 用户操作 |
|---|------|---------|
| 1 | 辅助功能权限 | 系统设置 → 隐私与安全性 → 辅助功能 |
| 2 | 听写功能开启 | 系统设置 → 键盘 → 听写 → 开启 |
| 3 | 快捷键匹配 | 代码模拟的按键必须与用户配置的听写快捷键一致 |

**条件 1（权限）** — 首次点击时 macOS 弹出权限弹窗。如果用户拒绝，`osascript` 命令抛出错误（stderr 包含 `not allowed assistive access` 等），但原始代码仅 `console.warn`，用户无任何可见反馈。

**条件 3（快捷键匹配）** — macOS 听写快捷键可由用户自定义（Fn 连按、Command 连按等），但原始代码硬编码模拟 `Fn+Fn`（key code 63）。如果用户配置了其他快捷键，模拟会静默无效。macOS 没有公开 API 读取用户配置的听写快捷键，也没有不依赖快捷键的方式直接触发听写。

Windows 使用 `keybd_event` 模拟 Win+H，是标准 Win32 API，不需要额外权限，也不存在快捷键不匹配问题。

### 1.2 目标

- macOS 上权限被拒后，向用户显示清晰的提示信息，引导去系统设置开启权限
- macOS 上首次使用语音输入时，引导用户在应用设置中配置听写快捷键
- 根据用户配置动态模拟对应的按键，而非硬编码 Fn+Fn
- 保持 Windows 行为不变

## 2. 用户场景

### 场景 1: macOS 首次使用，拒绝权限
**Given** 用户在 macOS 上首次点击语音输入按钮，系统弹出辅助功能权限弹窗
**When** 用户点击「拒绝」
**Then** 应用显示 toast 提示，引导用户前往 系统设置 → 隐私与安全性 → 辅助功能 中开启权限

### 场景 2: macOS 权限已拒，再次点击
**Given** 用户之前已拒绝辅助功能权限
**When** 用户再次点击语音输入按钮
**Then** 显示同样的 toast 提示

### 场景 3: macOS 权限已授予
**Given** 用户已在系统设置中授予辅助功能权限
**When** 用户点击语音输入按钮
**Then** 正常触发系统听写（行为与之前相同）

### 场景 4: Windows 不受影响
**Given** 用户在 Windows 上使用
**When** 用户点击语音输入按钮
**Then** 行为与之前完全相同，Win+H 正常触发

### 场景 5: macOS 首次使用，未配置听写快捷键
**Given** 用户在 macOS 上首次点击语音输入按钮，尚未配置听写快捷键（`macDictation` 配置项不存在）
**When** 用户点击麦克风图标
**Then** 弹出 toast 提示"首次使用语音输入，请先配置听写快捷键"，并自动打开设置页 → 快捷键 tab

### 场景 6: macOS 配置听写快捷键
**Given** 用户进入设置页 → 快捷键 tab
**When** 用户在"听写快捷键（macOS）"下拉中选择与系统一致的快捷键
**Then** 配置保存后，后续点击麦克风按钮将模拟对应的按键触发听写

### 场景 7: 快捷键设置页引导
**Given** 用户在设置页看到听写快捷键下拉
**When** 用户不确定自己的系统听写快捷键是什么
**Then** 可以点击"查看系统设置"链接，直接打开 macOS 系统设置 → 键盘 → 听写 页面

## 3. 功能需求

### FR-1: macOS 权限拒绝检测
- 主进程捕获 `osascript` 的 stderr 输出
- 根据关键词识别权限拒绝错误
- 返回结构化错误类型 `permission_denied`

### FR-2: 用户提示（权限）
- 前端收到 `permission_denied` 后，通过项目现有 toast 机制展示提示
- 提示内容包含具体的系统设置路径，方便用户操作
- 自动打开系统设置 → 辅助功能权限页面

### FR-3: i18n
- 新增翻译键，支持中英文

### FR-4: macOS 听写快捷键配置
- 在 `AppConfig.shortcuts` 中新增 `macDictation` 可选字段
- 可选值：`'mic'` | `'control'` | `'fn'` | `'rightCmd'` | `'leftCmd'` | `'eitherCmd'`
- 未配置时视为首次使用

### FR-5: Settings UI — 听写快捷键下拉
- 在设置页 → 快捷键 tab 中新增 macOS 专属区域（仅 `darwin` 平台显示）
- 下拉选项（与 macOS 系统设置一致）：
  - 按下 🎙（单次按键）
  - 连按两下 Control 键
  - 连按两下 🌐
  - 连按两下右 Command 键
  - 连按两下左 Command 键
  - 连按两下任一 Command 键
- 附带说明文字和"查看系统设置"链接，点击打开 macOS 系统设置 → 键盘 → 听写

### FR-6: 首次使用引导
- macOS 用户首次点击麦克风时（判断依据：`macDictation` 配置项不存在）
- 弹 toast 提示 + 自动打开设置页定位到快捷键 tab

### FR-7: 动态 key code 映射
- 主进程根据 `macDictationShortcut` 参数映射为对应的 CGKeyCode：
  - `mic` → 63（Microphone key，**单次按键**）
  - `control` → 59（Left Control，连按两下）
  - `fn` → 63（🌐 Globe key，连按两下）
  - `rightCmd` → 54（Right Command，连按两下）
  - `leftCmd` → 55（Left Command，连按两下）
  - `eitherCmd` → 55（使用 Left Command，连按两下）
- `mic` 选项仅模拟单次按键，其余均模拟连按两下
- 默认回退到 63（🌐）

## 4. 实现方案

### 4.1 AppConfig 类型

`src/renderer/config.ts` — `shortcuts` 接口新增：

```typescript
macDictation?: string;  // macOS 听写快捷键: 'fn' | 'leftCmd' | 'rightCmd' | 'eitherCmd'
```

### 4.2 主进程 — 权限拒绝检测 + 动态 key code

修改 `src/main/main.ts` 中 `voice:triggerDictation` handler：
- 接受 `macDictationShortcut` 参数
- 根据参数映射 key code
- macOS 分支保留 stderr 权限检测

```typescript
ipcMain.handle('voice:triggerDictation', async (_event, macDictationShortcut?: string) => {
  // ...
  } else if (process.platform === 'darwin') {
    const keyCodeMap: Record<string, number> = {
      fn: 63, leftCmd: 55, rightCmd: 54, eitherCmd: 55,
    };
    const keyCode = keyCodeMap[macDictationShortcut ?? 'fn'] ?? 63;
    // simulate double-press via AppleScript
    await execAsync(`osascript -e 'tell application "System Events" to key code ${keyCode}' -e 'delay 0.05' -e 'tell application "System Events" to key code ${keyCode}'`);
  }
});
```

### 4.3 前端 hook — 传参

修改 `src/renderer/hooks/useSpeechToText.ts`，`triggerSystemDictation` 接受 `macDictationShortcut` 参数并传递给 IPC。

### 4.4 UI — 首次引导 + toast

修改 `src/renderer/components/cowork/CoworkPromptInput.tsx` 中 `handleVoiceInput`：
- macOS 上检查 `macDictation` 配置是否存在
- 不存在 → toast 提示 + 派发 `app:showSettings` CustomEvent 打开设置页
- 存在 → 传入 shortcut 调用 `triggerSystemDictation`

### 4.5 Settings UI — 下拉组件

修改 `src/renderer/components/Settings.tsx`：
- 新增 `MacDictationSelect` 组件（仿照 `SendShortcutSelect` 模式）
- 在快捷键 tab 中 `sendMessage` 下方添加 macOS-only 区域
- `handleShortcutChange` 中跳过 `macDictation` 的冲突检测

### 4.6 app:showSettings 事件

修改 `src/renderer/App.tsx`：
- 新增 `app:showSettings` CustomEvent 监听
- 调用 `handleShowSettings(detail)` 打开设置页并定位到指定 tab

### 4.7 IPC Bridge + 类型

- `src/main/preload.ts`：`triggerDictation` 传参
- `src/renderer/types/electron.d.ts`：更新类型签名

### 4.8 i18n

在 `src/renderer/services/i18n.ts` 中新增翻译键（中英文）。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| macOS 权限拒绝 | 弹 toast 提示去系统设置 + 自动打开辅助功能页面 |
| macOS 权限已授予 | 正常触发听写 |
| macOS 未配置听写快捷键 | 弹 toast + 打开设置页快捷键 tab |
| macOS 配置的快捷键与系统不一致 | 模拟不匹配的按键，静默无效（设置页有引导链接帮助用户确认） |
| Windows | 不受影响，行为不变，不显示听写快捷键设置 |
| osascript 因非权限原因失败 | 静默处理（console.warn），与之前一致 |

## 6. 涉及文件

| 操作 | 文件 |
|------|------|
| 修改 | `src/renderer/config.ts` |
| 修改 | `src/main/main.ts` |
| 修改 | `src/renderer/hooks/useSpeechToText.ts` |
| 修改 | `src/renderer/components/cowork/CoworkPromptInput.tsx` |
| 修改 | `src/renderer/components/Settings.tsx` |
| 修改 | `src/renderer/App.tsx` |
| 修改 | `src/main/preload.ts` |
| 修改 | `src/renderer/types/electron.d.ts` |
| 修改 | `src/renderer/services/i18n.ts` |

## 7. 验收标准

- [ ] macOS 拒绝辅助功能权限后，点击语音按钮弹出 toast 提示
- [ ] toast 内容包含系统设置路径引导
- [ ] macOS 授权后正常触发系统听写
- [ ] macOS 首次点击麦克风（未配置 `macDictation`），弹 toast + 跳设置页快捷键 tab
- [ ] 设置页快捷键 tab 仅 macOS 显示"听写快捷键"下拉
- [ ] 下拉包含 4 个选项，默认无选中（首次引导）
- [ ] "查看系统设置"链接打开 macOS 系统设置 → 键盘 → 听写
- [ ] 配置保存后，点击麦克风模拟对应 key code
- [ ] Windows 行为不受影响，设置页不显示听写快捷键
- [ ] lint 检查通过
