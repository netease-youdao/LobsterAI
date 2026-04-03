# Plan: Skill Version Upgrade Support

## Context

When a user installs a skill from the marketplace (e.g., youdaonote v1.0.0), and the marketplace later updates to v1.0.1, there's no way to upgrade. The UI only shows "Installed" with no update option. Users must delete and reinstall manually.

The root cause is that `isSkillInstalled()` in [SkillsManager.tsx:283](src/renderer/components/skills/SkillsManager.tsx#L283) only checks if the skill ID exists locally — it performs no version comparison.

## Approach

1. 三态判断：`not_installed` / `installed` / `update_available`
2. 后端增加 `upgradeSkill()` 方法，复用 `syncBundledSkillsToUserData()` 的升级模式
3. 已安装 tab 顶部增加"一键更新"按钮（无可更新时隐藏），单个技能卡片也有更新按钮
4. 技能市场 tab 对有更新的技能展示更新按钮（替代"已安装"徽章）
5. 更新过程使用全局遮罩层展示进度，防止用户操作冲突

## OpenClaw 兼容性

更新技能文件后，OpenClaw 通过两个机制自动感知变化：
1. `notifySkillsChanged()` → `syncOpenClawConfig()` 链路同步 `openclaw.json` 中的 skill entries
2. OpenClaw 原生文件监听（`watch: true`，250ms debounce）自动检测技能目录变化

无需额外 RPC 调用。

## Changes

### 1. Backend: `src/main/skillManager.ts`

**Extend pending install type** (line 1084) to support upgrades:
```typescript
private pendingInstalls = new Map<string, {
  tempDir: string;
  cleanupPath: string | null;
  root: string;
  skillDirs: string[];
  timer: NodeJS.Timeout;
  isUpgrade?: boolean;           // NEW
  existingSkillDir?: string;     // NEW
}>();
```

**Add `upgradeSkill(skillId, downloadUrl)` method**:
1. Find the installed skill by ID via `listSkills()`, get its `skillPath` (parent dir of SKILL.md)
2. Download new version using the same download/extract logic from `downloadSkill()` (lines 1351-1464)
3. Run security scan — if risky, store as pending with `isUpgrade: true` and `existingSkillDir`
4. If safe, perform安全升级（见下方安全升级流程）
5. Call `this.startWatching()` and `this.notifySkillsChanged()`
6. Return `{ success: true, skills: this.listSkills() }`

**安全升级流程**（防中断丢失）:
```
1. 备份 .env 和 _meta.json 到内存
2. 将旧目录重命名为 {skillDir}.upgrading（原子操作）
3. 拷贝新版本到 {skillDir}
4. 还原 .env 和 _meta.json
5. 删除 {skillDir}.upgrading 备份目录
```

中断后的状态保证：
- 步骤 2 之前中断 → 旧版本完好
- 步骤 2-3 之间中断 → 旧版本在 `.upgrading`，启动时回滚
- 步骤 3-5 之间中断 → 新版本已就位，启动时清理 `.upgrading`

**Add `recoverInterruptedUpgrades()` method**（启动时调用）:
- 扫描 `userData/SKILLs/` 下所有 `.upgrading` 后缀目录
- 如果对应的 `{skillDir}` 存在且包含 SKILL.md → 更新已完成，删除 `.upgrading`
- 如果对应的 `{skillDir}` 不存在 → 更新被中断，将 `.upgrading` 重命名回 `{skillDir}`（回滚到旧版本）

**Modify `confirmPendingInstall()`** (line 1561): Add branch for `isUpgrade === true` — use上述安全升级流程 instead of the "find unique dir" loop.

### 2. IPC Wiring

**[src/main/main.ts](src/main/main.ts)** (~line 2164): Add handler:
```typescript
ipcMain.handle('skills:upgrade', async (_event, skillId: string, downloadUrl: string) => {
  return skillManager.upgradeSkill(skillId, downloadUrl);
});
```

**[src/main/main.ts](src/main/main.ts)** (`initApp()` ~line 4633): 在 `syncBundledSkillsToUserData()` 之后调用 `recoverInterruptedUpgrades()`，恢复被中断的升级。

**[src/main/preload.ts](src/main/preload.ts)**: Add `upgrade` to the `skills` object in `contextBridge`.

**[src/renderer/types/electron.d.ts](src/renderer/types/electron.d.ts)**: Add type for `upgrade` method.

### 3. Renderer Service: `src/renderer/services/skill.ts`

- Add `upgradeSkill(skillId, downloadUrl)` method (mirrors `downloadSkill` pattern)
- Add `compareVersions(a, b)` utility function (copy of the ~10-line backend version) for client-side version comparison

### 4. UI: `src/renderer/components/skills/SkillsManager.tsx`

#### 4a. 三态判断函数（两个 tab 共用）

Replace `isSkillInstalled()` with:
```typescript
const getSkillInstallStatus = (marketplaceSkill: MarketplaceSkill):
  'not_installed' | 'installed' | 'update_available' => {
  const installed = skills.find(s => s.id === marketplaceSkill.id);
  if (!installed) return 'not_installed';
  if (installed.isBuiltIn) return 'installed'; // built-in managed separately
  if (!installed.version || !marketplaceSkill.version) return 'installed';
  if (compareVersions(marketplaceSkill.version, installed.version) > 0) return 'update_available';
  return 'installed';
};
```

#### 4b. Marketplace tab

Three-way branch for card badge and detail modal:
- `not_installed` → blue "Install" button (unchanged)
- `installed` → green "Installed" badge (unchanged)
- `update_available` → amber "Update" button, 显示版本号如 `v1.0.0 → v1.0.1`

#### 4c. Installed tab

**单个技能卡片**：如果在市场中有更新版本，卡片上显示橙色"更新"按钮（通过 `marketplaceSkills` 数据做匹配对比）

**顶部"一键更新"按钮**：
- 计算所有可更新技能数量（已安装 × 市场数据对比）
- 有可更新技能时显示，如"更新全部 (3)"；无可更新时隐藏
- 点击后串行更新所有技能，触发全局遮罩层

#### 4d. 全局更新遮罩层

更新过程中（无论单个更新还是一键更新）覆盖整个技能管理区域的遮罩：

```
┌─────────────────────────────────┐
│                                 │
│       正在更新技能 (2/3)         │
│       ████████░░░░  66%         │
│       当前：youdaonote v1.0.1   │
│                                 │
│          [ 取消更新 ]            │
│                                 │
└─────────────────────────────────┘
```

- 显示总进度 (current/total) 和当前正在更新的技能名 + 目标版本
- 提供"取消更新"按钮：已完成的不回滚，剩余的跳过
- 遮罩仅覆盖技能管理区域，不阻塞 app 其他功能
- 单个技能更新时也使用遮罩（进度为 1/1）
- 更新完成后自动关闭遮罩，刷新技能列表

**State 设计**:
```typescript
const [upgradeState, setUpgradeState] = useState<{
  isActive: boolean;
  total: number;
  current: number;
  currentSkillName: string;
  currentSkillVersion: string;
  cancelled: boolean;
} | null>(null);
```

#### 4e. 更新执行流程

```
用户点击"更新全部"或单个"更新"
→ 显示遮罩层
→ 串行遍历待更新技能列表
  → 每个技能：更新遮罩进度 → 调用 skillService.upgradeSkill()
  → 如果触发安全审查 → 暂停遮罩，弹出安全报告弹窗 → 用户确认后继续
  → 如果用户点击取消 → 停止后续更新
→ 全部完成 → dispatch 更新后的 skills 到 Redux → 关闭遮罩
```

### 5. i18n: `src/renderer/services/i18n.ts`

| Key | English | Chinese |
|-----|---------|---------|
| `skillUpdate` | `Update` | `更新` |
| `skillUpdateAll` | `Update All ({count})` | `更新全部 ({count})` |
| `skillUpgrading` | `Updating skills ({current}/{total})` | `正在更新技能 ({current}/{total})` |
| `skillUpgradingCurrent` | `Current: {name} v{version}` | `当前：{name} v{version}` |
| `skillUpgradeFailed` | `Update failed` | `更新失败` |
| `skillUpdateAvailable` | `Update available` | `有新版本` |
| `skillUpgradeCancel` | `Cancel Update` | `取消更新` |

### 6. Edge Cases

| Case | Handling |
|------|----------|
| Installed skill has no version | Show "Installed" (no upgrade possible) |
| Marketplace skill has no version | Show "Installed" |
| Versions equal | Show "Installed" |
| Installed version newer than marketplace | Show "Installed" (no downgrade) |
| Built-in skill in marketplace | Show "Installed" (managed by bundled sync) |
| `.env` doesn't exist | Skip backup/restore |
| `_meta.json` doesn't exist | Skip backup/restore |
| Upgrade fails mid-copy | 旧版本保留在 `.upgrading` 目录，下次启动自动回滚 |
| App exits during upgrade | `recoverInterruptedUpgrades()` 在启动时自动检测并恢复 |
| Security scan triggered during batch update | Pause overlay, show security report modal, resume after user decision |
| User cancels during batch update | Stop remaining updates, keep already-completed ones |

## Files to Modify

1. `src/main/skillManager.ts` — `upgradeSkill()`, `recoverInterruptedUpgrades()`, modify `confirmPendingInstall()`
2. `src/main/main.ts` — `skills:upgrade` IPC handler, startup recovery call
3. `src/main/preload.ts` — expose `upgrade` in bridge
4. `src/renderer/types/electron.d.ts` — type for `upgrade`
5. `src/renderer/services/skill.ts` — `upgradeSkill()`, `compareVersions()`
6. `src/renderer/services/i18n.ts` — new i18n keys
7. `src/renderer/components/skills/SkillsManager.tsx` — three-state UI, update overlay, batch update logic

## Verification

1. Install a skill from marketplace, verify it shows "Installed"
2. Manually lower the version in the installed skill's SKILL.md frontmatter
3. Refresh marketplace — verify "Update" button appears in both tabs with version info
4. Click single "Update" — verify overlay appears (1/1), skill upgraded, `.env` preserved
5. Lower multiple skills' versions, click "Update All" — verify overlay shows progress (1/3, 2/3, 3/3)
6. Click "Cancel" mid-batch — verify already-updated skills kept, remaining skipped
7. Verify marketplace shows "Installed" again after all upgrades
8. Test with skill that has no version field — should show "Installed" with no update option
9. Test with built-in skill — should always show "Installed"
10. Verify "Update All" button hidden when no updates available
