# PR: 支持将聊天记录导出为 Markdown/JSON 格式

## 关联 Issue
Closes #719

## 功能描述

实现了将聊天记录导出为 Markdown 和 JSON 格式的功能，方便用户对 OpenClaw 回复的内容进行归档。

## 实现内容

### 1. 后端 (Main Process)

在 `src/main/main.ts` 中添加了以下 IPC 处理程序：
- `cowork:session:exportMarkdown` - 导出会话为 Markdown 格式
- `cowork:session:exportJSON` - 导出会话为 JSON 格式

#### Markdown 导出格式
```markdown
# 会话标题

**Exported at**: 2026-03-24T15:30:00.000Z
**Session ID**: uuid
**Created at**: 2026-03-24T15:00:00.000Z

---

## User (2026-03-24T15:00:00.000Z)

用户消息内容

## Assistant (2026-03-24T15:00:05.000Z)

AI 回复内容

---

*Exported from LobsterAI*
```

#### JSON 导出格式
```json
{
  "version": "1.0",
  "exportedAt": "2026-03-24T15:30:00.000Z",
  "session": {
    "id": "uuid",
    "title": "会话标题",
    "status": "completed",
    "pinned": false,
    "cwd": "/path/to/workspace",
    "systemPrompt": "...",
    "executionMode": "auto",
    "activeSkillIds": [],
    "createdAt": 1700000000000,
    "updatedAt": 1700000100000,
    "messages": [
      {
        "id": "msg-1",
        "type": "user",
        "content": "用户消息",
        "timestamp": 1700000000000,
        "metadata": {}
      }
    ]
  }
}
```

### 2. 前端 (Renderer Process)

#### API 暴露 (`src/main/preload.ts`)
- 添加了 `cowork.exportMarkdown(options)`
- 添加了 `cowork.exportJSON(options)`

#### 服务层 (`src/renderer/services/cowork.ts`)
- 添加了 `exportSessionMarkdown(sessionId, defaultFileName)`
- 添加了 `exportSessionJSON(sessionId, defaultFileName)`

#### UI 层 (`src/renderer/components/cowork/CoworkSessionDetail.tsx`)
- 在会话操作菜单中添加了"导出为 Markdown"和"导出为 JSON"选项
- 添加了相应的处理函数和状态管理
- 添加了图标和加载状态

### 3. 国际化

在 `src/renderer/services/i18n.ts` 中添加了以下翻译键：

**中文：**
- `coworkExportMarkdown`: "导出为 Markdown"
- `coworkExportJSON`: "导出为 JSON"
- `coworkExportMarkdownSuccess`: "Markdown 导出成功"
- `coworkExportMarkdownFailed`: "导出 Markdown 失败"
- `coworkExportJSONSuccess`: "JSON 导出成功"
- `coworkExportJSONFailed`: "导出 JSON 失败"

**英文：**
- `coworkExportMarkdown`: "Export as Markdown"
- `coworkExportJSON`: "Export as JSON"
- `coworkExportMarkdownSuccess`: "Markdown exported successfully"
- `coworkExportMarkdownFailed`: "Failed to export Markdown"
- `coworkExportJSONSuccess`: "JSON exported successfully"
- `coworkExportJSONFailed`: "Failed to export JSON"

### 4. 类型定义

在 `src/renderer/types/electron.d.ts` 中添加了类型定义：
- `exportMarkdown: (options: { sessionId: string; defaultFileName?: string }) => Promise<...>`
- `exportJSON: (options: { sessionId: string; defaultFileName?: string }) => Promise<...>`

## 使用方式

1. 打开任意会话
2. 点击右上角的菜单按钮（三个点）
3. 选择"导出为 Markdown"或"导出为 JSON"
4. 选择保存位置
5. 导出成功后会有 Toast 提示

## 测试

- [x] 本地构建通过 (`npm run build`)
- [x] 开发服务器正常运行 (`npm run dev`)
- [x] Markdown 导出功能正常
- [x] JSON 导出功能正常
- [x] 国际化文本显示正确
- [x] 导出取消操作正常
- [x] 错误处理正常

## 截图

（此处可以添加功能截图）

## 兼容性

- 支持 Windows、macOS 和 Linux
- 支持深色和浅色主题
- 支持中英文界面

## 注意事项

1. 导出文件名会自动添加时间戳，避免覆盖
2. 如果用户取消保存对话框，不会显示错误提示
3. 导出过程中按钮会显示加载状态，防止重复点击
