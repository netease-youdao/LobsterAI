# Windows 用户删除 Skill 失败（EPERM）修复 Spec

## 问题描述

线上有个别 Windows 用户删除已安装 skill 时“无反应”。  
从主进程日志看，删除请求实际已触发，但目录删除阶段持续报错：

```text
[skills] deleteSkill: id=Desktop, targetDir=C:\Users\jjh\AppData\Roaming\LobsterAI\SKILLs\Desktop, platform=win32
[skills] deleteSkill: failed to remove "Desktop" ... Error: EPERM, Permission denied
[skills] Failed to delete skill: Desktop Error: EPERM, Permission denied
```

该问题并非通用失败，而是用户环境差异导致的 Windows 文件系统权限/占用异常。

---

## 核心结论

**删除链路本身正常，失败点在 Windows 目录删除系统调用。**

- UI 已调用删除
- IPC 已进入 `skills:delete`
- `SkillManager.deleteSkill()` 被执行
- 失败发生在 `fs.rmSync(targetDir)`，错误为 `EPERM`（可能伴随 `EACCES` / `EBUSY`）

---

## 根因分析

在个别 Windows 机器上，skill 目录可能出现以下情况之一：

1. 目录或子文件被进程占用（防病毒、同步盘、资源管理器预览、外部编辑器）
2. 目录属性异常（只读/系统/隐藏组合）
3. ACL/所有者不一致（历史管理员创建目录，当前用户删除权限不足）

当前实现仅依赖 Node 的 `fs.rmSync`，遇到上述环境差异时会直接失败，导致用户体感“点了没反应”。

---

## 修复目标

1. 在保持现有删除主路径不变的前提下，提升 Windows 删除成功率
2. 仅在已知 Windows 权限类错误时启用兜底，避免扩大行为风险
3. 增强日志可观测性，明确是否走了兜底路径
4. 为导入成功增加明确反馈（toast），降低“已导入但无感知”的体验问题

---

## 修复方案

### 方案概览

在 `deleteSkill()` 中引入 Windows 专用兜底删除策略：

1. 先执行原有 `fs.rmSync(targetDir, { recursive: true, force: true, ... })`
2. 若为 Windows 且抛出 `EPERM` / `EACCES` / `EBUSY`，执行兜底命令：
   - `attrib -r -s -h "<targetDir>" /s /d`
   - `rmdir /s /q "<targetDir>"`
3. 兜底成功后继续状态清理与 `skills:changed` 广播
4. 兜底失败时保留原错误路径，继续返回删除失败

### 关键实现点

- 新增 `isWindowsDeletePermissionError(error)`：识别 Windows 删除权限类错误
- 新增 `tryWindowsDeleteFallback(targetDir)`：执行 `cmd.exe` 下的属性清理+递归删除
- 删除流程中新增分支日志：
  - 兜底成功：`directory removed via Windows fallback`
  - 兜底失败：`Windows fallback failed`

### 增量优化决策（仅 Windows）

为进一步降低“安装成功但删除失败”的概率，后续增量优化限定为 Windows：

1. 在 skill 安装落盘后（`cpRecursiveSync` 完成后），对目标目录执行属性归一化  
   `attrib -r -s -h "<targetDir>" /s /d`
2. 该步骤仅在 `process.platform === 'win32'` 执行
3. 归一化失败不阻塞安装流程，仅记录 `console.warn`
4. 保留当前删除阶段 fallback 作为最终兜底

不在本次变更中引入 macOS/Linux 的权限批量修正，避免跨平台权限语义差异带来的副作用。

### 本次落地范围（确认版）

#### 权限处理范围

安装权限归一化通过后端公共安装落盘点统一执行，因此覆盖以下 4 类入口：

1. 上传 `.zip`
2. 上传文件夹
3. 远程导入（GitHub/ClawHub/URL）
4. 技能市场安装

#### 成功提示范围

仅为以下 3 类入口增加导入成功 toast：

1. 上传 `.zip`
2. 上传文件夹
3. 远程导入

不为“技能市场安装”新增 toast（市场页已有“已安装”状态标识）。
不处理“通过对话创建 skill”入口。

### UI 主题适配要求

1. toast 使用现有全局事件与现有样式体系（`app:showToast`），不新增独立弹层样式实现
2. 不引入硬编码颜色，沿用当前主题 token / 组件风格，保证浅色/深色主题一致性
3. 成功提示文案简短，避免与已有错误提示组件（`ErrorMessage`）冲突

### i18n 要求

1. 新增导入成功提示 key，必须同时补齐中英文：
   - `skillImportSuccess`
2. 如果需要区分来源，可增加可选 key（同样中英文齐全）：
   - `skillImportSuccessFromZip`
   - `skillImportSuccessFromFolder`
   - `skillImportSuccessFromRemote`
3. 前端展示层不得硬编码用户可见文案，统一走 `i18nService.t(...)`

### 异常处理要求

1. Windows 权限归一化失败：
   - 不阻塞安装成功返回
   - 打 `console.warn` 并包含 skill id / 目录路径 / 错误摘要
2. 导入主流程失败时不弹成功 toast，沿用现有错误显示逻辑
3. 安全扫描需要确认安装（`pendingInstallId`）时，不提前弹成功 toast，待最终确认成功后再提示
4. 任何异常路径必须保持 loading 结束，避免按钮长时间禁用

---

## 涉及文件

| 文件 | 变更说明 |
|---|---|
| `src/main/skillManager.ts` | 删除兜底（已完成）+ 安装落盘后 Windows 属性归一化（仅 win32，失败不阻塞） |
| `src/renderer/components/skills/SkillsManager.tsx` | 为上传 zip/上传文件夹/远程导入补充成功 toast；保持现有 loading 流程 |
| `src/renderer/services/i18n.ts` | 增加导入成功提示的中英文文案 key |

---

## 日志与观测

### 成功链路（主路径）

- `[skills] deleteSkill: id=%s, targetDir=%s, platform=%s`
- `[skills] deleteSkill: directory removed in %dms`
- `[skills] deleteSkill: completed successfully for "%s"`

### 成功链路（兜底路径）

- `[skills] deleteSkill: id=%s, targetDir=%s, platform=%s`
- `[skills] deleteSkill: directory removed via Windows fallback in %dms`
- `[skills] deleteSkill: completed successfully for "%s"`

### 失败链路

- `[skills] deleteSkill: Windows fallback failed for "%s": %s`
- `[skills] deleteSkill: failed to remove "%s" at %s:`
- `[skills] Failed to delete skill:`

---

## 验证方法

### 目标用户复测

1. 在问题用户机器执行同一 skill 删除操作
2. 观察日志是否出现 `directory removed via Windows fallback`
3. 确认 skill 从已安装列表移除，并在重启应用后不再出现

### 回归检查

| 场景 | 预期 |
|---|---|
| 普通环境可删除 | 仍走原路径成功，不影响既有行为 |
| Windows 权限类失败（EPERM/EACCES/EBUSY） | 自动触发兜底并尽可能删除成功 |
| Windows 导入后目录包含只读/系统/隐藏属性 | 安装后归一化清理属性，后续删除成功率提升 |
| 兜底仍失败（强占用/企业策略） | 返回失败并输出清晰错误日志 |
| 上传 zip 成功 | 显示导入成功 toast，列表刷新 |
| 上传文件夹成功 | 显示导入成功 toast，列表刷新 |
| 远程导入成功 | 显示导入成功 toast，列表刷新 |
| 技能市场安装成功 | 不弹新增 toast，继续显示“已安装”状态 |
| 远程导入返回 pendingInstallId（需确认） | 不提前提示成功，确认安装完成后再提示 |

---

## 已知边界

1. 兜底无法覆盖所有系统级限制（如企业 DLP/Defender 策略强拦截）
2. 若目录被持续独占，`rmdir /s /q` 仍可能失败
3. 安装权限归一化是“最佳努力”步骤，不能替代系统级权限修复
4. 技能市场安装不新增成功 toast，成功反馈依赖既有“已安装”状态

---

## 后续优化建议

1. 在前端对 Windows 权限错误提供更友好提示（例如“关闭占用该目录的程序后重试”）
2. 删除失败时增加短退避重试（例如 300ms/800ms）
3. 增加 Windows 平台集成测试或模拟测试覆盖权限错误分支
4. 为安装后属性归一化补充日志字段：`normalizedAttrs=true/false`
