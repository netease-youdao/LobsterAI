# Bug Fix Specification: Clipboard Image Not Persisted to Disk

**Issue ID**: 001-clipboard-image-persistence
**Created**: 2026-04-07
**Status**: Implemented
**Parent Spec**: [attachment/spec.md](../spec.md)

## Problem Statement

截图粘贴或从网页复制的图片在 Cowork 对话中仅存于内存（base64 dataUrl），不写入磁盘。第二轮对话时 agent 用工具在磁盘上找不到文件，提示用户"请重新发送图片"。

这是附件系统五条处理路径中**唯一不写磁盘**的分支（路径 E）。详见 [attachment/spec.md](../spec.md) 的处理路径分类表。

## Root Cause

[CoworkPromptInput.tsx](src/renderer/components/cowork/CoworkPromptInput.tsx) 第 516-527 行：

```typescript
} else {
  // No native path (clipboard/drag from browser) - read via FileReader
  try {
    const dataUrl = await fileToDataUrl(file);
    addImageAttachmentFromDataUrl(file.name, dataUrl);  // ← 仅内存，伪路径 inline:...
  } catch (error) {
    const stagedPath = await saveInlineFile(file);       // ← 写磁盘仅在 error fallback
    if (stagedPath) addAttachment(stagedPath);
  }
}
```

**两个问题叠加**：
1. `addImageAttachmentFromDataUrl` 生成伪路径 `inline:{name}:{timestamp}`，不对应磁盘文件
2. 提交时 `!a.path.startsWith('inline:')` 过滤掉伪路径，prompt 中不包含文件信息

## User Scenarios

### Scenario 1: 截图粘贴后第一轮对话

**Given** 用户截图并粘贴到对话框，模型支持 vision
**When** 用户发送 "这张图片说了什么？"
**Then** LLM 通过 base64 vision 正确识别图片 ✅（修复前后均可用）

### Scenario 2: 截图粘贴后第二轮对话

**Given** 用户在第一轮发送了截图
**When** 用户在第二轮发送 "把这张图片的背景改成白色"
**Then** agent 通过 prompt 中的路径找到磁盘文件，使用工具处理 ✅（修复后）

### Scenario 3: 磁盘保存失败的降级

**Given** 工作目录不可写
**When** 用户截图粘贴
**Then** 降级为仅 vision（`addImageAttachmentFromDataUrl`），不阻塞用户 ✅

## Functional Requirements

### FR-1: Clipboard 图片写入磁盘

无 `nativePath` 的图片必须通过 `saveInlineFile` 写入磁盘，使用 `addAttachment(savedPath, { isImage, dataUrl })` 以真实路径添加。

### FR-2: Vision 功能不受影响

`dataUrl` 仍然读取并存储在 `DraftAttachment` 中，提交时 base64 提取逻辑不变。

### FR-3: 优雅降级

磁盘写入失败时降级为 `addImageAttachmentFromDataUrl`（修复前行为），dataUrl 读取失败时仅保存磁盘文件。两者都失败时记录错误，不添加附件。

## Acceptance Criteria

1. 截图粘贴后，`.cowork-temp/attachments/manual/` 中出现对应文件
2. 发送消息后，prompt 文本包含图片的磁盘路径
3. 第二轮对话中 agent 能通过路径访问文件
4. LLM vision 识别功能不受影响
5. 从 Finder 粘贴文件、文件选择器上传等路径不受影响
6. 磁盘保存失败时不阻塞用户，降级为仅 vision
