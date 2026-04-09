# Plan: Fix Clipboard Image Attachment Persistence

## Context

截图粘贴和从网页复制的图片在 Cowork 对话中只存于内存（base64），不写入磁盘。这导致 agent 在第二轮对话中无法找到图片文件。其他所有附件类型都有磁盘路径，只有这条代码路径是特例。

详见 [attachment/spec.md](../spec.md) 中的路径 E 分析和 [spec.md](spec.md) 中的根因分析。

## Approach

修改 `handleIncomingFiles` 中无 `nativePath` 的图片分支：先写磁盘，再用真实路径添加附件。利用已有的 `saveInlineFile` 和 `addAttachment` 函数，无需新增任何函数或 IPC。

## Changes

### 1. `src/renderer/components/cowork/CoworkPromptInput.tsx`（第 516-527 行）

**当前代码**（路径 E — 仅内存，无磁盘文件）：

```typescript
} else {
  // No native path (clipboard/drag from browser) - read via FileReader
  try {
    const dataUrl = await fileToDataUrl(file);
    addImageAttachmentFromDataUrl(file.name, dataUrl);
  } catch (error) {
    console.error('Failed to read image from clipboard:', error);
    const stagedPath = await saveInlineFile(file);
    if (stagedPath) {
      addAttachment(stagedPath);
    }
  }
}
```

**修改后**（写磁盘 + dataUrl，优雅降级）：

```typescript
} else {
  // No native path (clipboard/drag from browser):
  // 1. Read as dataUrl for preview + base64 vision
  // 2. Save to disk so the agent can access the file in later turns
  let dataUrl: string | null = null;
  try {
    dataUrl = await fileToDataUrl(file);
  } catch (error) {
    console.error('Failed to read clipboard image as data URL:', error);
  }

  const stagedPath = await saveInlineFile(file);

  if (stagedPath) {
    // File saved to disk + dataUrl for vision
    addAttachment(stagedPath, {
      isImage: true,
      dataUrl: dataUrl ?? undefined,
    });
  } else if (dataUrl) {
    // Disk save failed — fallback to memory-only (vision works for turn 1)
    console.warn('Clipboard image saved only in memory (disk save failed)');
    addImageAttachmentFromDataUrl(file.name, dataUrl);
  } else {
    // Both failed
    console.error('Failed to process clipboard image');
  }
}
```

### 为什么不需要改其他文件

| 关注点 | 说明 |
|--------|------|
| `addAttachment` | 已支持 `{ isImage: true, dataUrl }` 参数（路径 C 已在用） |
| 提交时 base64 提取 | 检查 `isImage && dataUrl`，与路径无关，不受影响 |
| 提交时路径拼接 | 过滤 `inline:` 前缀，真实路径自动通过 |
| `saveInlineFile` | 已有完整实现，生成唯一文件名，处理目录创建 |
| IPC handler `dialog:saveInlineFile` | 已有，无需修改 |
| `useCallback` 依赖数组 | 第 549 行已包含 `saveInlineFile` 和 `addAttachment` |
| `addImageAttachmentFromDataUrl` | 保留作为降级路径，不删除 |

### Edge Cases

| 场景 | 处理 |
|------|------|
| Clipboard 图片名为 `image.png`（通用名） | `saveInlineFile` 生成 `image-{timestamp}-{random}.png`，不冲突 |
| 图片超过 25MB | `saveInlineFile` 返回失败，降级到 `addImageAttachmentFromDataUrl` |
| 工作目录未设置 | `resolveInlineAttachmentDir` 降级到 `/tmp/lobsterai/attachments/` |
| 工作目录只读 | `saveInlineFile` 返回失败，降级到仅 vision |
| File 对象被读两次 | `fileToDataUrl` 和 `saveInlineFile` 内部的 `fileToBase64` 各自创建 `FileReader` 实例，互不干扰 |

## Files to Modify

1. `src/renderer/components/cowork/CoworkPromptInput.tsx` — 第 516-527 行，clipboard 图片处理分支（**唯一改动文件**）

## Verification

1. 截图粘贴到对话框 → 确认文件出现在 `.cowork-temp/attachments/manual/` 中
2. 发送消息 → 检查 console log 确认 prompt 包含文件路径
3. 第一轮对话 → 确认 LLM 能描述图片内容（vision 正常）
4. 第二轮对话要求处理图片 → 确认 agent 能找到并操作文件
5. 从浏览器拖拽图片 → 同样走此路径，验证行为一致
6. 从 Finder 复制文件粘贴 → 确认走路径 C，行为不变
7. 文件选择器上传 → 确认走路径 A，行为不变
