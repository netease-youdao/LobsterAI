---
name: image-watermark-removal
description: 当用户明确要求去除已有图片右下角的「AI 生成 / LobsterAI」水印时，使用 LobsterAI 图片编辑服务生成一份副本。
official: true
version: 1.0.0
---

# 去除 LobsterAI 图片水印

1. 使用用户指定的那张原图。可以是当前附件、用户提供的本地文件，或前一次生图返回的文件。无法确定是哪一张时，请用户选择。
2. 调用 `lobsterai_image_generate`，设置 `action: "generate"`、`imageOperation: "remove_watermark"`、`image` 为原图路径或附件映射地址、`n: 1`。提示词填写“仅移除右下角的 AI 生成 / LobsterAI 水印，保留其他文字、画面和构图”。沿用当前会话选定的图片编辑模型和正常费用确认流程。
3. 返回任务 ID 时，用同一工具的 `status` 查询这个任务，直到拿到已保存的文件。把新文件链接发给用户，保留原文件。若模型不支持图片编辑，请用户选择支持参考图编辑的模型。
