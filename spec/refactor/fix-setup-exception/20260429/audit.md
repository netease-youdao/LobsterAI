# 排查报告：Renderer 初始化失败（偶现）— 更新于 2026-04-28

## 现象

Windows 用户启动应用后**偶现**"初始化应用程序失败。请检查您的配置。"错误界面，需要杀进程重启才能恢复。

Branch `liuzhq/setup-exception-fix` 已将 renderer init 超时从 5s 提高到 10s/15s（commit b5baf9a），但问题仍偶现。

## 日志分析

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

## 错误触发路径

`src/renderer/App.tsx:211-218`：`initializeApp()` 中任何 `await` 步骤抛出异常或超时，catch 块设置 `initError` → 显示错误界面。

```typescript
} catch (error) {
  const elapsed = Math.round(performance.now() - t0);
  const msg = error instanceof Error ? error.message : String(error);
  setInitError(i18nService.t('initializationError'));
  setIsInitialized(true);
}
```

## 超时保护分析

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

## 根因分析

### 原因 1：`store:set` IPC handler 阻塞（最可能的偶现触发因素）

`src/main/main.ts:2010`：

```typescript
ipcMain.handle('store:set', async (_event, key, value) => {
    getStore().set(key, value);  // 同步写入 — 立即完成
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

### 原因 2：`syncBundledSkillsToUserData()` 阻塞主进程事件循环

`src/main/main.ts:5863-5924`：

```typescript
createWindow();  // renderer 开始加载

// 紧接着执行重量级同步文件 I/O
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

### 原因 3：`authService.init()` 网络请求无超时

`src/main/main.ts:2322`：`auth:getUser` handler 调用 `fetchWithAuth` → `net.fetch`，无 `AbortSignal.timeout`。

`src/main/main.ts:2209`：`fetchWithAuth` 内部的 `net.fetch` 无超时：

```typescript
const doFetch = (accessToken: string) =>
  net.fetch(url, {
    ...options,
    headers: { ..., Authorization: `Bearer ${accessToken}` },
    // 无 signal — 网络不通时无限等待
  });
```

**注意：** 如果用户未登录（无 token），`auth:getUser` 立即返回 `{ success: false }`，不会发网络请求。此路径仅影响**已登录**且**网络不稳定**的用户。

### 原因 4：错误界面缺少恢复手段

当前错误界面只有"打开设置"按钮，无法重启应用。偶现问题重启即可恢复，但用户只能手动杀进程。

## 现有保护措施的不足

| 已有保护 | 不足 |
|----------|------|
| `configService.init()` + `i18nService.initialize()` 有 15s 超时 | 其余 3 个异步步骤无超时 |
| `authService.init()` 内部 try-catch | 只捕获 reject，不防 hang（pending forever） |
| `localStore.getItem()` 内部 try-catch | 只捕获 reject，不防 IPC 延迟 |
| `log:fromRenderer` IPC 诊断桥 | 主进程事件循环被阻塞时 IPC 同样被延迟 |

## 影响范围

- **Windows 用户** — 主要影响，磁盘 I/O 较慢
- **首次安装 / 升级** — 更容易触发（skill 全量同步、gateway 首次启动）
- **已登录 + 网络不稳定** — `authService.init()` 可能 hang
- **偶现** — 取决于磁盘繁忙程度和 gateway 启动耗时
