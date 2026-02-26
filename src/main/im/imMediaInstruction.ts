/**
 * IM Media Instruction Builder
 * 
 * 构建 IM 媒体发送能力的系统提示词指令。
 * 当 AI 通过 IM 渠道（钉钉、飞书、Telegram、Discord、云信）与用户交互时，
 * 需要告知 AI 可以通过特定的文本标记格式来触发图片/音视频/文件的发送。
 * 
 * 该指令会被追加到系统提示词的末尾，确保 AI 始终了解自己的媒体发送能力。
 */

import type { IMSettings } from './types';

/**
 * Build the IM media sending instruction for system prompt.
 * Returns the instruction text, or empty string if not applicable.
 */
export function buildIMMediaInstruction(_imSettings: IMSettings): string {
  // Always include the media instruction for IM sessions.
  // The actual sending is handled by each gateway's replyFn (parseMediaMarkers → sendMedia).
  // This instruction tells the AI how to format its response to trigger media sending.

  return `<im_media_capabilities>
## IM 媒体发送能力

你当前正在通过 IM 渠道与用户对话。你可以在回复中发送图片、音频、视频和文件。

### 发送方式

在回复文本中使用以下 Markdown 格式嵌入本地文件路径，系统会自动检测并将其作为对应类型的媒体消息发送给用户：

- **图片**: \`![描述文字](/absolute/path/to/image.png)\`
- **音频**: \`[音频文件](/absolute/path/to/audio.mp3)\`
- **视频**: \`[视频文件](/absolute/path/to/video.mp4)\`
- **文件**: \`[文件名](/absolute/path/to/document.pdf)\`

也可以直接在文本中写出文件的绝对路径（裸路径），系统同样能识别：
- \`/Users/xxx/output/chart.png\`
- \`/tmp/result.xlsx\`

### 支持的文件类型

- 图片: jpg, jpeg, png, gif, webp, bmp
- 音频: mp3, wav, aac, m4a, ogg, amr
- 视频: mp4, mov, avi, mkv, webm
- 文件: pdf, doc/docx, xls/xlsx, ppt/pptx, zip, txt, json, csv, md 等

### 使用规则

1. **必须使用绝对路径**，如 \`/Users/...\`、\`/tmp/...\` 等。
2. 文件必须是你通过工具创建或已确认存在于本地磁盘的文件。
3. 你可以在同一条回复中混合文本和多个媒体标记。系统会先发送纯文本部分，再逐个发送媒体文件。
4. 当用户要求你生成图片、图表、文档等并发送时，先用工具将内容写入本地文件，然后在回复中引用该文件路径即可。
</im_media_capabilities>`;
}
