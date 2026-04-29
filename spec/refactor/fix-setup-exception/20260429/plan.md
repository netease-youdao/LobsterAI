# Renderer 初始化失败修复 — 实施计划（2026-04-28）

**前置文档：** [audit.md](./audit.md)（排查报告） | [spec.md](./spec.md)（验收规格）

---

## 本次改动：错误界面增加"重启应用"按钮

偶现的初始化失败问题（主因：首次安装时 skill 全量拷贝阻塞主进程事件循环，IPC 无响应导致 renderer init 超时），重启一次即可恢复。增加"重启应用"按钮让用户无需手动杀进程。

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/main/main.ts` | 新增 `app:relaunch` IPC handler |
| `src/main/preload.ts` | 暴露 `relaunch()` API |
| `src/renderer/types/electron.d.ts` | 类型声明 |
| `src/renderer/services/i18n.ts` | 新增 i18n key `restartApp` |
| `src/renderer/App.tsx` | 错误界面增加重启按钮 |

### 实现细节

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

### 验证

1. `npx tsc --noEmit` — 类型检查通过
2. `npm run electron:dev` → 手动触发 init 错误 → 确认两个按钮显示
3. 点击"重启应用" → 应用退出后自动重新启动

---

## 后续优化（待定）

- 将 `syncBundledSkillsToUserData` 改为 async fs 操作，消除首次安装时事件循环阻塞
- 或增加主进程 ready 信号，renderer 等主进程就绪后再开始 init
