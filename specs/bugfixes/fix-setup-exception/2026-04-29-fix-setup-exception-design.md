# Renderer 初始化失败修复设计

## 问题描述

Windows 用户启动应用后**偶现**"初始化应用程序失败。请检查您的配置。"错误界面，需要杀进程重启才能恢复。

Branch `liuzhq/setup-exception-fix` 已将 renderer init 超时从 5s 提高到 10s/15s（commit b5baf9a），但问题仍偶现。

## 核心结论

**本质原因是多个独立但叠加的问题：**

| # | 根因 | 影响 | 严重程度 |
|---|------|------|---------|
| 1 | `syncBundledSkillsToUserData()` 使用同步 `fs.*Sync` 拷贝 115+ 个 skill 文件，阻塞主进程事件循环 | renderer init 期间 IPC 调用受阻或超时 | 高 |
| 2 | `store:set` IPC handler 在 `app_config` 写入时同步等待 `syncOpenClawConfig`（含 gateway 重启 30s+），阻塞 IPC 响应 | 间接放大事件循环阻塞，导致后续 IPC 延迟 | 高 |
| 3 | `initializeApp()` 中 3 个异步步骤无超时保护（`enterprise.getConfig`、`authService.init`、`store.get('privacy_agreed')`） | 主进程阻塞或网络不通时无限等待，最终触发错误界面 | 中 |
| 4 | `fetchWithAuth` 的 `net.fetch` 无 `AbortSignal.timeout`，已登录 + 网络不稳定时无限等待 | 已登录用户在弱网启动可能 hang | 中 |
| 5 | 错误界面只有"打开设置"按钮，无法重启应用 | 偶现问题重启即可恢复，用户只能手动杀进程 | 低（体验） |

---

## 现象与日志分析

**日志来源：** `release/lobsterai-logs-20260426-021837/main-2026-04-28.log`（Windows 用户 fudong，版本 2026.4.28）

### 关键发现

1. **main log 中完全没有 `[Renderer][App]` 条目**

   b5baf9a 添加了 `mark()` 函数通过 `log:fromRenderer` IPC 转发 renderer 日志到 main log，但一条都没出现。说明 renderer init 期间 IPC 调用受阻（主进程事件循环被占满或 IPC 响应延迟）。

2. **OpenClaw gateway 首次启动耗时 29 秒**

   ```
   [21:57:32] waitForGatewayReady: gateway healthy after 27937ms (18 polls)
   [21:57:32] startGateway: gateway is running, total startup time: 29591ms
   ```

3. **MCP bridge 触发 hard restart（+25s 处）**

   ```
   [21:57:46] mcp-bridge config CHANGED: callbackUrl null → http://127.0.0.1:62503/mcp/execute
   [21:57:46] needsHardRestart=true (mcpBridgeChanged=true configChanged=true)
   [21:57:46] ──── HARD RESTART EXECUTING
   ```

   这会导致 `syncOpenClawConfig` 阻塞 30+ 秒。

4. **`[Main] initApp:` 启动 profiler 条目缺失**

   main log 从 21:57:21 开始，缺少 `[Main] initApp: app is ready`、`createWindow` 等条目，说明 electron-log 在 app 早期可能未完全捕获 console.log。

### 错误触发路径

`src/renderer/App.tsx:211-218`：`initializeApp()` 中任何 `await` 步骤抛出异常或超时，catch 块设置 `initError` → 显示错误界面。

```typescript
} catch (error) {
  const elapsed = Math.round(performance.now() - t0);
  const msg = error instanceof Error ? error.message : String(error);
  setInitError(i18nService.t('initializationError'));
  setIsInitialized(true);
}
```

### 超时保护现状

`initializeApp()` 的步骤及其超时保护情况：

| # | 步骤 | 代码位置 | 超时保护 | 风险 |
|---|------|---------|---------|------|
| 1 | `configService.init()` | App.tsx:139 | ✅ 15s (Win) / 10s | `store:get` IPC，主进程事件循环阻塞时可能超时 |
| 2 | `enterprise.getConfig()` | App.tsx:142 | ❌ **无** | IPC 调用，事件循环阻塞时无限等待 |
| 3 | `themeService.initialize()` | App.tsx:146 | N/A（同步） | 无风险 |
| 4 | `i18nService.initialize()` | App.tsx:150 | ✅ 15s (Win) / 10s | 首次启动时调 `getSystemLocale` IPC |
| 5 | `authService.init()` | App.tsx:154 | ❌ **无** | 调 `auth:getUser` IPC → `fetchWithAuth` → `net.fetch`，无 abort signal |
| 6 | `configService.getConfig()` | App.tsx:157 | N/A（同步） | 无风险 |
| 7 | `store.get('privacy_agreed')` | App.tsx:200 | ❌ **无** | `store:get` IPC |

---

## 详细根因分析

### 根因 1：`syncBundledSkillsToUserData()` 阻塞主进程事件循环

`src/main/main.ts:5863-5924`：

```typescript
createWindow();  // renderer 开始加载

await Promise.all([
  (async () => {
    manager.syncBundledSkillsToUserData();  // 同步文件拷贝 115+ 文件
  })(),
  (async () => {
    await ensurePythonRuntimeReady();
  })(),
]);
```

`createWindow()` 后主进程立即执行 `syncBundledSkillsToUserData()`，该函数使用同步 `fs.*Sync` 操作拷贝 skill 文件，阻塞事件循环。此时 renderer 正在加载并发送 IPC 请求，但主进程无法处理。

**偶现原因：** 取决于 skill 文件是否有变更（增量同步 vs 全量同步）、磁盘繁忙程度、杀毒软件扫描延迟等。

### 根因 2：`store:set` IPC handler 阻塞

`src/main/main.ts:2010`：

```typescript
ipcMain.handle('store:set', async (_event, key, value) => {
    getStore().set(key, value);
    if (key === 'app_config') {
      const syncResult = await syncOpenClawConfig({  // ← 阻塞 IPC 返回
        reason: 'app-config-change',
        restartGatewayIfRunning: true,
      });
    }
});
```

当 `app_config` 被写入时，handler 等待 `syncOpenClawConfig` 完成（包含潜在的 gateway 重启，Windows 上 30+ 秒）才返回 IPC 响应。

**触发场景：** `i18nService.initialize()` 在首次启动时调用 `configService.updateConfig({language_initialized: true})`，虽然这个调用本身没有 `await`，但主进程在处理这个 `store:set` 时会长时间阻塞事件循环，延迟后续 IPC 响应。

### 根因 3：`authService.init()` 网络请求无超时

`src/main/main.ts:2322`：`auth:getUser` handler 调用 `fetchWithAuth` → `net.fetch`，无 `AbortSignal.timeout`。

`src/main/main.ts:2209`：`fetchWithAuth` 内部的 `net.fetch` 无超时：

```typescript
const doFetch = (accessToken: string) =>
  net.fetch(url, {
    ...options,
    headers: { ..., Authorization: `Bearer ${accessToken}` },
  });
```

**注意：** 如果用户未登录（无 token），`auth:getUser` 立即返回 `{ success: false }`，不会发网络请求。此路径仅影响**已登录**且**网络不稳定**的用户。

### 根因 4：错误界面缺少恢复手段

当前错误界面只有"打开设置"按钮，无法重启应用。偶现问题重启即可恢复，但用户只能手动杀进程。

### 现有保护措施的不足

| 已有保护 | 不足 |
|----------|------|
| `configService.init()` + `i18nService.initialize()` 有 15s 超时 | 其余 3 个异步步骤无超时 |
| `authService.init()` 内部 try-catch | 只捕获 reject，不防 hang（pending forever） |
| `localStore.getItem()` 内部 try-catch | 只捕获 reject，不防 IPC 延迟 |
| `log:fromRenderer` IPC 诊断桥 | 主进程事件循环被阻塞时 IPC 同样被延迟 |

### 影响范围

- **Windows 用户** — 主要影响，磁盘 I/O 较慢
- **首次安装 / 升级** — 更容易触发（skill 全量同步、gateway 首次启动）
- **已登录 + 网络不稳定** — `authService.init()` 可能 hang
- **偶现** — 取决于磁盘繁忙程度和 gateway 启动耗时

---

## 修复方案

本轮先落地"错误界面增加重启按钮"的最小可用修复，让用户在偶现失败时能一键恢复；其余根因（事件循环阻塞、IPC 超时、网络超时）的代码改动作为终态目标列出，分阶段推进。

### Fix A（本次落地）：错误界面增加"重启应用"按钮

偶现的初始化失败问题（主因：首次安装时 skill 全量拷贝阻塞主进程事件循环，IPC 无响应导致 renderer init 超时），重启一次即可恢复。增加"重启应用"按钮让用户无需手动杀进程。

#### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/main/main.ts` | 新增 `app:relaunch` IPC handler |
| `src/main/preload.ts` | 暴露 `relaunch()` API |
| `src/renderer/types/electron.d.ts` | 类型声明 |
| `src/renderer/services/i18n.ts` | 新增 i18n key `restartApp` |
| `src/renderer/App.tsx` | 错误界面增加重启按钮 |

#### 实现细节

**1. `src/main/main.ts`** — 在 `app:getVersion` 附近新增：

```typescript
ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});
```

**2. `src/main/preload.ts`** — 在 `appInfo` 对象中新增：

```typescript
relaunch: () => ipcRenderer.invoke('app:relaunch'),
```

**3. `src/renderer/types/electron.d.ts`** — 在 `appInfo` 接口中新增：

```typescript
relaunch: () => Promise<void>;
```

**4. `src/renderer/services/i18n.ts`** — 中英文：

```typescript
// zh:
restartApp: '重启应用',
// en:
restartApp: 'Restart App',
```

**5. `src/renderer/App.tsx`** — 错误界面 (line ~728-734)：

"重启应用"按钮放前面（primary 样式），"打开设置"按钮改为 secondary 样式，两个并排。

### Fix B（终态目标）：消除阻塞与无超时

以下改动以终态形式列出，逐步推进：

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

5. **skill bootstrap 让出事件循环**
   - `createWindow()` 后、`syncBundledSkillsToUserData()` 前有 `setTimeout` 延迟
   - 给 renderer 的早期 IPC 让出处理窗口

---

## 验收标准

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

### 不在范围内

- `syncBundledSkillsToUserData()` 改为 async fs 操作（长期优化，需改动 skillManager）
- `enterprise.getConfig()` 后端 IPC handler 优化
- 增加全局 init 超时（当前以单步超时 + 容错为主）
- 日志系统改进（electron-log 早期条目缺失问题）

---

## 验证方法

### 验证 Fix A（重启按钮）

1. `npx tsc --noEmit` — 类型检查通过
2. `npm run electron:dev` → 手动触发 init 错误（如临时在 `initializeApp` 抛异常） → 确认两个按钮显示
3. 点击"重启应用" → 应用退出后自动重新启动
4. 点击"打开设置" → 设置弹窗正常打开

### 验证 Fix B（超时与非阻塞）

1. 应用 Fix B 后启动应用，确认日志中出现 `[Renderer][App] initializeApp: shell ready`
2. 断网后启动 → 确认应用正常加载，未触发错误界面
3. 在主进程模拟 `syncOpenClawConfig` 长耗时（如 sleep 30s）→ 确认 `store:set` IPC 立即返回，renderer 正常完成 init
4. 已登录用户在弱网下启动 → 确认 `authService.init()` 在 10s 内超时降级，不 hang

### 后续优化（待定）

- 将 `syncBundledSkillsToUserData` 改为 async fs 操作，消除首次安装时事件循环阻塞
- 或增加主进程 ready 信号，renderer 等主进程就绪后再开始 init
