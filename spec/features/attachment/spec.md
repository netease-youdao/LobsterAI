# Feature Specification: Cowork Attachment System

**Feature ID**: attachment
**Created**: 2026-04-07
**Status**: Active
**Last Updated**: 2026-04-07

## Overview

Cowork 对话的附件系统，负责文件和图片从用户输入到 LLM/Agent 消费的完整生命周期管理。支持文件选择器上传、拖拽、粘贴（本地文件/截图/网页图片）等多种输入方式，兼顾 vision 模型的图片识别和 agent 工具的文件操作需求。

## Data Model

### 类型定义

```typescript
// src/renderer/types/cowork.ts
// 发送给 LLM vision API 的图片数据
interface CoworkImageAttachment {
  name: string;        // 文件名
  mimeType: string;    // MIME 类型，如 image/png
  base64Data: string;  // 纯 base64 编码数据
}

// src/renderer/store/slices/coworkSlice.ts
// Redux draft 状态中的附件
interface DraftAttachment {
  path: string;        // 磁盘路径或伪路径 inline:{name}:{timestamp}
  name: string;        // 显示文件名
  isImage?: boolean;   // 标记为图片附件
  dataUrl?: string;    // data:mime;base64,... 用于预览和 vision 提取
}
```

### Redux 状态

```typescript
// coworkSlice state
{
  draftAttachments: Record<string, DraftAttachment[]>
  // key = sessionId 或 '__home__'（新会话），每个会话独立的附件草稿
}
```

**Reducers:**
- `addDraftAttachment({ draftKey, attachment })` — 追加附件，按 path 去重
- `setDraftAttachments({ draftKey, attachments })` — 替换整组附件（用于删除单个附件）
- `clearDraftAttachments(draftKey)` — 清空会话的所有附件

### SQLite 持久化

```sql
-- src/main/coworkStore.ts
CREATE TABLE cowork_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,       -- 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system'
  content TEXT NOT NULL,    -- prompt 文本（含附件路径行）
  metadata TEXT,            -- JSON: { imageAttachments?: CoworkImageAttachment[], skillIds?, ... }
  created_at INTEGER NOT NULL,
  sequence INTEGER
);
```

`imageAttachments` 以 JSON 形式保存在 `metadata` 字段中，包含完整的 base64 数据。

## 支持的图片格式

```
.png .jpg .jpeg .gif .webp .bmp .svg .tiff .tif .ico .avif
```

Vision 支持取决于模型配置中的 `supportsImage` 字段。

## 文件大小限制

| 限制 | 值 | 适用场景 |
|------|----|---------|
| `MAX_INLINE_ATTACHMENT_BYTES` | 25 MB | `saveInlineFile` 写入磁盘时 |
| `MAX_READ_AS_DATA_URL_BYTES` | 20 MB | `readFileAsDataUrl` 读取图片为 dataUrl 时 |

文件选择器上传的原生文件路径附件无大小限制（仅传路径，不读取内容）。

## 附件输入流程

### 入口

所有附件最终汇入 `handleIncomingFiles(fileList)` 统一处理：

| 入口 | 触发方式 | 说明 |
|------|---------|------|
| 文件选择器 | `handleAddFile` → `dialog.selectFiles` IPC | 系统文件对话框，返回 `nativePath[]` |
| 拖拽 | `handleDrop` → `handleIncomingFiles` | `dataTransfer.files`。从 OS 文件管理器拖入的文件有 `nativePath`；从网页内容拖入的文件无 `nativePath` |
| 粘贴 | `handlePaste` → `handleIncomingFiles` | `clipboardData.files`。从 OS 复制的文件有 `nativePath`；截图/网页复制的图片无 `nativePath` |

### 处理路径分类

`handleIncomingFiles` 根据两个维度决定处理方式：

```
                     ┌─ 有 nativePath ──┐
                     │                  │
              ┌──────┤                  ├──────┐
              │      └──────────────────┘      │
          是图片+vision              其他文件
              │                          │
     路径 C:                        路径 A/B:
     addAttachment(path,            addAttachment(path)
       {isImage, dataUrl})
              │
              │
              │
                     ┌─ 无 nativePath ──┐
                     │                  │
              ┌──────┤                  ├──────┐
              │      └──────────────────┘      │
          是图片+vision              其他文件
              │                          │
     路径 E:                        路径 D:
     saveInlineFile → disk          saveInlineFile → disk
     addAttachment(savedPath,       addAttachment(savedPath)
       {isImage, dataUrl})
```

### 五条处理路径

| 路径 | 来源示例 | nativePath | 图片+vision | 处理方式 | 磁盘文件 | 路径入 prompt | vision |
|------|---------|------------|------------|---------|---------|--------------|--------|
| A | 文件选择器上传非图片 | ✅ | ❌ | `addAttachment(nativePath)` | ✅ 原文件 | ✅ | — |
| B | 从 Finder 粘贴文件 | ✅ | ❌ | `addAttachment(nativePath)` | ✅ 原文件 | ✅ | — |
| C | 从 Finder 粘贴图片文件 | ✅ | ✅ | `addAttachment(nativePath, {isImage, dataUrl})` | ✅ 原文件 | ✅ | ✅ |
| D | 从网页拖入非图片文件（无 nativePath） | ❌ | ❌ | `saveInlineFile()` → `addAttachment(savedPath)` | ✅ 写入磁盘 | ✅ | — |
| E | 截图粘贴 / 从网页复制图片（无 nativePath） | ❌ | ✅ | `saveInlineFile()` → `addAttachment(savedPath, {isImage, dataUrl})` | ✅ 写入磁盘 | ✅ | ✅ |

> 路径 E 在 [001-clipboard-image-persistence](001-clipboard-image-persistence/spec.md) 中从"仅内存"修改为"写入磁盘"。

### 关键函数

| 函数 | 位置 | 说明 |
|------|------|------|
| `addAttachment(path, imageInfo?)` | CoworkPromptInput.tsx:397 | 用**真实磁盘路径**添加附件到 Redux draft |
| `addImageAttachmentFromDataUrl(name, dataUrl)` | CoworkPromptInput.tsx:410 | 用**伪路径** `inline:{name}:{timestamp}` 添加纯内存图片附件。仅作降级使用 |
| `saveInlineFile(file)` | CoworkPromptInput.tsx:465 | 通过 IPC 写入磁盘，返回路径 |
| `fileToDataUrl(file)` | CoworkPromptInput.tsx:424 | File → `data:mime;base64,...` 字符串 |
| `fileToBase64(file)` | CoworkPromptInput.tsx:440 | File → 纯 base64 字符串 |
| `extractBase64FromDataUrl(dataUrl)` | CoworkPromptInput.tsx:42 | 从 dataUrl 提取 mimeType + base64Data |
| `getNativeFilePath(file)` | CoworkPromptInput.tsx:457 | 提取 Electron File 对象的 `.path` 属性 |

## 磁盘存储

### saveInlineFile → dialog:saveInlineFile IPC

无 `nativePath` 的文件（clipboard/拖拽）通过此链路写入磁盘：

1. Renderer: `fileToBase64(file)` 读取文件的 base64 数据
2. IPC: `dialog:saveInlineFile({ dataBase64, fileName, mimeType, cwd })`
3. Main process:
   - 校验 base64 非空、大小 ≤ 25MB
   - `sanitizeAttachmentFileName()` — 去除非法字符（`<>:"/\|?*` 等），提取 basename
   - `inferAttachmentExtension()` — 从文件名或 MIME 推断扩展名
   - 生成唯一文件名: `{baseName}-{timestamp}-{random6}{ext}`
   - 写入 `resolveInlineAttachmentDir(cwd)` 目录
4. 返回 `{ success: true, path: outputPath }`

### 存储目录

```
resolveInlineAttachmentDir(cwd):
  cwd 有效且存在 → {cwd}/.cowork-temp/attachments/manual/
  否则           → {os.tmpdir()}/lobsterai/attachments/
```

`.cowork-temp` 目录已在以下位置被忽略：
- `coworkRunner.ts`: `INFERRED_FILE_SEARCH_IGNORE` 集合中（agent 搜索文件时跳过）

## 提交流程

`handleSubmit` 在发送消息时做两件事：

### 1. 提取 vision 数据（第 273-286 行）

遍历所有 `isImage && dataUrl` 的附件，提取 `{ name, mimeType, base64Data }` 组成 `imageAttachments` 数组，传给后端用于 LLM vision API。

### 2. 拼接文件路径到 prompt（第 288-298 行）

```typescript
const attachmentLines = attachments
  .filter((a) => !a.path.startsWith('inline:'))  // 排除伪路径
  .map((a) => `${t('inputFileLabel')}: ${a.path}`)
  .join('\n');
```

真实路径以 `附件: /path/to/file.png` 的格式追加到 prompt 末尾，agent 据此找到磁盘文件。

## 后端数据流

```
Renderer                          Main Process                    OpenClaw
────────                          ────────────                    ────────
handleSubmit()
  ├─ imageAtts (base64)
  └─ finalPrompt (含路径)
       │
       ▼
  coworkService.startSession()
  / continueSession()
       │
       ▼ IPC
  cowork:session:start/continue ──►  CoworkEngineRouter
       │                                    │
       │                             Store user message
       │                             metadata: { imageAttachments }
       │                                    │
       │                             openclawRuntimeAdapter.runTurn()
       │                                    │
       │                             chat.send({
       │                               sessionKey,
       │                               message: prompt,    ◄── 含文件路径
       │                               attachments: [{     ◄── base64 for vision
       │                                 type: 'image',
       │                                 mimeType, content
       │                               }]
       │                             })
       │                                    │
       │                                    ▼
       │                              OpenClaw Gateway
       │                              → LLM API (vision content block)
       │                              → Agent tools (read file by path)
```

### 消息持久化

用户消息存入 SQLite `cowork_messages` 表：
- `content`: prompt 文本（含附件路径行）
- `metadata`: JSON，包含 `imageAttachments`（完整 base64）和 `skillIds`

IPC 传输时，`sanitizeCoworkMessageForIpc()` 特殊处理 `imageAttachments` 字段，确保 base64 大数据不被通用截断逻辑裁剪。

## IM 附件集成

IM 网关（WeChat、Feishu、DingTalk 等）的附件处理独立于 Cowork 直接输入：

- IM 消息中的图片/文件由各平台 SDK 下载到本地，存为 `IMMediaAttachment`（含 `localPath`）
- `IMCoworkHandler` 将附件信息以文本形式追加到 prompt: `[附件信息]\n- 类型: image, 路径: /path/to/file`
- 不走 `DraftAttachment` / `handleIncomingFiles` 流程
- 不使用 vision base64（走文件路径方式）

## 附件 UI

### 输入区预览

[AttachmentCard.tsx](src/renderer/components/cowork/AttachmentCard.tsx) 提供两种展示：

- **图片卡片**: 64×64 缩略图 + 文件名覆盖层 + 悬浮删除按钮
  - 有 `dataUrl` → 直接显示
  - 无 `dataUrl` 且非 `inline:` 路径 → 通过 `readFileAsDataUrl` IPC 加载
  - 加载中显示蓝色图标 + spinner
- **文件卡片**: 40×16 水平卡片 + 文件类型图标 + 文件名 + 悬浮删除按钮

### 草稿生命周期

1. 用户添加附件 → `addDraftAttachment()` → Redux
2. 切换会话 → 草稿按 draftKey 独立保留
3. 发送消息 → 附件传入 IPC → `clearDraftAttachments(draftKey)` 清空
4. App 重启 → Redux-Persist 恢复草稿状态

## 已知限制

1. **OpenClaw 不保留图片历史**: `historyImageBlocks=0`，后续轮次 LLM 看不到之前的图片 content block，只能通过文件路径使用工具访问
2. **大文件 vision 限制**: 超过 20MB 的图片无法生成 dataUrl，vision 不可用
3. **临时文件无自动清理**: `.cowork-temp/attachments/manual/` 目录累积文件，需后续添加清理策略
4. **IM 附件不走 vision**: IM 平台的图片仅以文件路径传递，不提取 base64

## 变更记录

| 编号 | 日期 | 说明 | 文档 |
|------|------|------|------|
| 001 | 2026-04-07 | 修复 clipboard 图片不写磁盘导致第二轮对话找不到文件 | [001-clipboard-image-persistence](001-clipboard-image-persistence/) |
