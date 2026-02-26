---
name: feishu
description: 飞书消息推送。用于发送文本消息或文件到飞书个人或群聊。触发词：发送飞书、推送到飞书、发送到飞书、飞书通知、推送到群聊、发送文件到飞书。
---

# 飞书消息推送

## 功能

- 发送文本消息到飞书个人或群聊
- 发送文件（PDF、图片、文档等）到飞书
- 支持定时任务完成通知

## 使用方法

### 命令行发送

```bash
node SKILLS_ROOT/feishu/scripts/send-message.js "消息内容" [文件路径] [目标]
```

**参数说明：**
- 消息内容：要发送的文本（可选）
- 文件路径：要发送的文件路径（可选）
- 目标：`first`（默认第一个用户）| `ou_xxxxx`（用户open_id）| `oc_xxxxx`（群聊chat_id）

### 环境变量方式

```bash
FEISHU_MESSAGE="消息内容" FEISHU_FILE="/path/to/file.pdf" node SKILLS_ROOT/feishu/scripts/send-message.js
```

## 示例

### 发送文本消息

```bash
node SKILLS_ROOT/feishu/scripts/send-message.js "任务已完成"
```

### 发送文本 + 文件

```bash
node SKILLS_ROOT/feishu/scripts/send-message.js "请查收这份报告" /path/to/report.pdf
```

### 仅发送文件（无文本）

```bash
node SKILLS_ROOT/feishu/scripts/send-message.js "" /path/to/file.pdf
```

### 发送给指定群聊

```bash
node SKILLS_ROOT/feishu/scripts/send-message.js "通知" oc_xxxxxxxxxxxx
```

### 发送给指定用户

```bash
node SKILLS_ROOT/feishu/scripts/send-message.js "你好" ou_xxxxxxxxxxxx
```

## 定时任务中使用

在 scheduled-task 的 prompt 中添加：

```
完成后发送消息到飞书: node /Users/panyf/Java/code/LLM/LobsterAI/SKILLs/feishu/scripts/send-message.js "任务完成"
```

发送文件：
```
完成后发送文件到飞书: node /Users/panyf/Java/code/LLM/LobsterAI/SKILLs/feishu/scripts/send-message.js "请查收" /path/to/result.pdf
```

## 支持的文件类型

- 文档：pdf, doc, docx, xls, xlsx, ppt, pptx, txt, csv
- 图片：png, jpg, jpeg, gif
- 压缩包：zip
- 视频音频：mp4, mp3

## 注意事项

- 需要飞书应用已开通 `contact:contact:readonly` 和 `im:resource` 权限
- 默认发送给应用可见的第一个用户
- 文件大小限制以飞书官方为准
