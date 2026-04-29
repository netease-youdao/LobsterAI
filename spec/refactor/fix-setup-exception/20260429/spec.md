# Renderer 初始化失败修复 — 验收规格（2026-04-28）

## Overview

修复 Windows 上偶现的 "初始化应用程序失败" 错误：消除 IPC 阻塞源、给所有异步 init 步骤加超时容错、增加错误界面恢复手段。

## 终态要求

### 代码层面

1. **`initializeApp()` 中所有 `await` 步骤有超时保护**
   - `enterprise.getConfig()`、`authService.init()`、`store.get('privacy_agreed')` 均包裹在 `waitWithTimeout()` 中
   - 超时后降级继续（warn 日志 + 使用安全默认值），不触发错误界面

2. **`store:set` IPC handler 不阻塞**
   - `getStore().set(key, value)` 同步写入后立即返回 IPC 响应
   - `syncOpenClawConfig` 改为 fire-and-forget（`void ... .catch()`）
   - 不影响 gateway 正常启动和配置同步

3. **`fetchWithAuth` 有网络超时**
   - `net.fetch` 调用带 `AbortSignal.timeout(10_000)`
   - token refresh 的 `net.fetch` 同样有超时

4. **`authService.init()` 中 `loadServerModels()` 不阻塞**
   - 改为 fire-and-forget，init 不等待 server models 加载
   - `setAuthLoading(false)` 在 `finally` 块中确保清除

5. **错误界面增加"重启应用"按钮**
   - 新增 `app:relaunch` IPC handler（`app.relaunch()` + `app.exit(0)`）
   - preload 暴露 `relaunch()` API
   - 错误界面显示两个按钮："重启应用"（primary）+ "打开设置"（secondary）
   - 新增 i18n key `restartApp`（中: 重启应用 / en: Restart App）

6. **skill bootstrap 让出事件循环**
   - `createWindow()` 后、`syncBundledSkillsToUserData()` 前有 `setTimeout` 延迟
   - 给 renderer 的早期 IPC 让出处理窗口

### 功能验证

| 验收项 | 验证方法 |
|--------|----------|
| 正常启动无回归 | `npm run electron:dev` → 应用正常加载，cowork 可用 |
| auth 正常恢复 | 已登录用户重启后保持登录态，quota 和 server models 正常显示 |
| 断网启动不卡死 | 断网后启动 → 应用正常加载，auth 降级为未登录 |
| 错误界面重启按钮 | 模拟 init 失败 → 点击"重启应用" → 应用正常重新启动 |
| 错误界面设置按钮 | 模拟 init 失败 → 点击"打开设置" → 设置弹窗正常打开 |
| gateway 正常启动 | config 变更后 gateway 仍在后台正常重启（`store:set` 非阻塞不影响） |
| renderer 诊断日志 | main log 中出现 `[Renderer][App] initializeApp: shell ready` |

### 构建验证

| 验收项 | 命令 |
|--------|------|
| TypeScript 编译通过 | `npx tsc --noEmit` 无报错 |
| Electron 主进程编译 | `npm run compile:electron` 成功 |
| 测试通过 | `npm test` 通过 |
| 生产构建成功 | `npm run build` 成功 |
| Lint 通过 | `npm run lint` 无新增告警 |

## 不在范围内

- `syncBundledSkillsToUserData()` 改为 async fs 操作（长期优化，需改动 skillManager）
- `enterprise.getConfig()` 后端 IPC handler 优化
- 增加全局 init 超时（当前以单步超时 + 容错为主）
- 日志系统改进（electron-log 早期条目缺失问题）
