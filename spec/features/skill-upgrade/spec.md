# Feature Specification: Skill Version Upgrade Support

**Feature ID**: skill-upgrade
**Created**: 2026-03-28
**Status**: Implemented

## Problem Statement

用户从技能市场安装技能后（如 youdaonote v1.0.0），当市场发布新版本（v1.0.1）时，没有任何升级入口。技能市场仍显示"已安装"徽章，用户必须手动删除旧版本再重新安装才能获取更新。

根因：`isSkillInstalled()` 仅做 ID 匹配，不比较版本号。

## User Scenarios

### Scenario 1: 技能市场发现有更新

**Given** 用户已安装 youdaonote v1.0.0
**When** 用户打开技能市场，市场中 youdaonote 已更新到 v1.0.1
**Then** 卡片和详情弹窗显示橙色"更新"按钮，版本号显示 `v1.0.0 → v1.0.1`

### Scenario 2: 已安装 tab 发现有更新

**Given** 用户已安装多个技能，其中 3 个有新版本
**When** 用户切换到"已安装" tab
**Then** 每个可更新技能卡片右下角显示橙色"更新"按钮
**And** tab 顶部显示"更新全部 (3)"按钮

### Scenario 3: 单个技能更新

**Given** 用户在任一 tab 点击某个技能的"更新"按钮
**When** 更新执行中
**Then** 显示全局遮罩层，展示进度和当前技能名
**And** 更新完成后遮罩自动关闭，技能列表刷新

### Scenario 4: 一键批量更新

**Given** 用户点击"更新全部"按钮
**When** 多个技能串行更新
**Then** 遮罩层显示 (1/3)、(2/3)、(3/3) 进度
**And** 提供"取消更新"按钮，已完成的不回滚

### Scenario 5: 更新过程中 App 退出

**Given** 更新正在执行，旧目录已重命名为 `.upgrading`
**When** 用户强制退出 App
**Then** 下次启动时 `recoverInterruptedUpgrades()` 自动检测并回滚到旧版本

### Scenario 6: 无更新可用

**Given** 所有已安装技能版本与市场一致
**When** 用户查看已安装 tab
**Then** 不显示"更新全部"按钮，各卡片无更新标识

## Functional Requirements

### FR-1: 三态安装判断

- `not_installed` → 蓝色"安装"按钮
- `installed` → 绿色"已安装"徽章
- `update_available` → 橙色"更新"按钮

### FR-2: 安全升级流程

1. 备份 `.env` 和 `_meta.json` 到内存
2. 原子重命名旧目录为 `{dir}.upgrading`
3. 拷贝新版本到原路径
4. 还原备份文件
5. 删除 `.upgrading` 备份

### FR-3: 中断恢复

App 启动时扫描 `.upgrading` 后缀目录：
- 对应原目录存在且完整 → 删除备份（升级已完成）
- 对应原目录不存在 → 重命名回原目录（回滚）

### FR-4: 安全审查兼容

升级流程复用安装时的安全扫描机制。风险技能需用户确认后继续。

### FR-5: OpenClaw 兼容

通过已有的 `notifySkillsChanged()` → `syncOpenClawConfig()` 链路 + OpenClaw 原生文件监听自动感知变化，无需额外 RPC。

## Non-Functional Requirements

- 不支持降级（本地版本 > 市场版本时显示"已安装"）
- 内置技能不参与市场版本对比（由 `syncBundledSkillsToUserData()` 管理）
- 无版本号的技能不参与更新检测
- 批量更新串行执行，避免并发写盘冲突

## Acceptance Criteria

1. 技能市场和已安装 tab 均正确展示三态
2. 单个更新和批量更新均正常工作
3. 更新后 `.env` 和 `_meta.json` 保留
4. 更新后 enabled/disabled 状态保留（存储在 SQLite，不受影响）
5. 中断后启动能自动恢复
6. 无可更新技能时"更新全部"按钮隐藏
