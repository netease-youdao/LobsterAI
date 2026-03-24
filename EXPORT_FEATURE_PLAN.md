# PR 实现计划：聊天记录导出为 Markdown/JSON

## Issue #719
用户希望支持将聊天记录导出为 Markdown/JSON 格式，以便对 OpenClaw 回复的内容进行归档。

## 实现方案

### 1. 后端 (Main Process)

#### 1.1 在 `src/main/main.ts` 中添加 IPC 处理程序
- 添加 `cowork:session:exportMarkdown` - 导出为 Markdown 格式
- 添加 `cowork:session:exportJSON` - 导出为 JSON 格式

#### 1.2 实现导出逻辑
- 从 `CoworkStore` 获取会话和消息
- Markdown 格式：将消息转换为 Markdown 格式（用户消息作为引用，AI 回复作为正文）
- JSON 格式：导出完整的会话数据，包括消息、时间戳、元数据等
- 使用 Electron 的 `dialog.showSaveDialog` 让用户选择保存位置

### 2. 前端 (Renderer Process)

#### 2.1 在 `src/main/preload.ts` 中添加 API 暴露
- 添加 `cowork.exportMarkdown(sessionId, defaultFileName)`
- 添加 `cowork.exportJSON(sessionId, defaultFileName)`

#### 2.2 在 `src/renderer/services/cowork.ts` 中添加服务方法
- 添加 `exportSessionMarkdown(sessionId, defaultFileName)`
- 添加 `exportSessionJSON(sessionId, defaultFileName)`

#### 2.3 在 UI 中添加导出按钮
- 在 `CoworkSessionDetail.tsx` 的菜单中添加导出选项
- 添加子菜单或对话框让用户选择导出格式（Markdown/JSON）

### 3. 国际化
- 在 `src/renderer/services/i18n.ts` 或相关语言文件中添加翻译键
- 中文：`导出为 Markdown`、`导出为 JSON`
- 英文：`Export as Markdown`、`Export as JSON`

## 导出格式设计

### Markdown 格式示例
```markdown
# 会话标题

**导出时间**: 2026-03-24 15:30:00

---

## 用户 (2026-03-24 15:00:00)

你好，请帮我写一个 Python 函数

## 助手 (2026-03-24 15:00:05)

当然，这是一个 Python 函数示例：

```python
def hello():
    print("Hello, World!")
```

---
```

### JSON 格式示例
```json
{
  "version": "1.0",
  "exportedAt": "2026-03-24T15:30:00.000Z",
  "session": {
    "id": "uuid",
    "title": "会话标题",
    "createdAt": 1700000000000,
    "updatedAt": 1700000100000,
    "messages": [
      {
        "id": "msg-1",
        "type": "user",
        "content": "你好，请帮我写一个 Python 函数",
        "timestamp": 1700000000000
      },
      {
        "id": "msg-2",
        "type": "assistant",
        "content": "当然，这是一个 Python 函数示例...",
        "timestamp": 1700000005000
      }
    ]
  }
}
```

## 实现步骤

1. [ ] 修改 `src/main/main.ts` - 添加 IPC 处理程序
2. [ ] 修改 `src/main/preload.ts` - 添加 API 暴露
3. [ ] 修改 `src/renderer/services/cowork.ts` - 添加服务方法
4. [ ] 修改 `src/renderer/components/cowork/CoworkSessionDetail.tsx` - 添加 UI
5. [ ] 添加国际化文本
6. [ ] 测试功能
7. [ ] 提交 PR

## 注意事项

1. 处理大消息内容的截断（参考现有的 IPC 内容截断逻辑）
2. 确保导出文件名安全（使用现有的 `sanitizeExportFileName` 函数）
3. 处理保存对话框的取消操作
4. 添加适当的错误处理和用户反馈（Toast 通知）
