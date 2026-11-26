---
name: lobsterai-image-processing
description: 处理已有图片，支持擦除水印和文字、增强画质、人像美化、修复老照片，以及抠出前景并交付透明 PNG。
official: true
version: 1.1.0
---

# LobsterAI 图片处理

用户指定一张图片并要求以下处理时，调用 `lobsterai_image_generate`。每次选择一张原图和一个操作。

| 用户意图 | `imageOperation` | 处理内容 |
| --- | --- | --- |
| 擦除 | `erase` | 移除指定的水印、文字、字幕、标志、印章或标签。把目标及位置写进提示词。 |
| 增强画质 | `enhance` | 提高清晰度、放大、降噪、去模糊或改善暗光。用户要求特定输出尺寸时，在模型支持范围内传入尺寸。 |
| 人像美化 | `beauty` | 按要求祛痘、修饰肤色或调整面部，保留人物特征。 |
| 照片修复 | `restore` | 修复划痕、折痕、霉斑、褪色、破损或缺失区域。 |
| 抠图 | `matting` | 提取指定人物、商品或其他前景，输出透明 PNG。换底色、换背景需要进一步合成。 |

1. 使用用户指定的附件、本地文件、图片 URL 或前一次操作返回的文件。用户对刚生成的 LobsterAI 成图说“去水印”时，按去除 LobsterAI 固定水印处理。图上有多个标记且目标有歧义时，先请用户指明。
2. 设置 `action: "generate"`、`image`、`imageOperation` 和 `n: 1`，将用户的具体要求原样写入 `prompt`。仅当用户明确要去掉「AI 生成 / LobsterAI」水印时，为 `erase` 加上 `eraseTarget: "lobsterai_watermark"`。示例：

   ```json
   {"action":"generate","image":"./海报.png","imageOperation":"erase","eraseTarget":"lobsterai_watermark","prompt":"去掉右下角的 LobsterAI 水印","n":1}
   ```

3. 去除 LobsterAI 固定水印时，服务端按当前账号和成图取回贴印前的原图，免积分，无需选择模型。直接交付返回的文件或链接。若找不到，请用户选择最初保存的成图或交付链接，停止本次操作，避免重新生成或改用通用擦除。
4. 其他编辑操作使用会话中选定的模型，沿用费用确认流程。`list` 可查询模型能力。抠图需要支持 `matting` 的模型。每个任务只提交一次，拿到任务 ID 后用 `status` 查询。成功后交付新的图片，保留用户原文件。
