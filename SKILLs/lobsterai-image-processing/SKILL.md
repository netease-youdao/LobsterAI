---
name: lobsterai-image-processing
description: 处理已有图片，支持擦除水印和文字、增强画质、人像美化、修复老照片，以及抠出前景并交付透明 PNG。
official: true
version: 1.0.0
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

1. 使用用户指定的附件、本地文件、图片 URL 或前一次操作返回的文件。原图或擦除目标有歧义时，先请用户指明。
2. 设置 `action: "generate"`、`image`、`imageOperation` 和 `n: 1`，将用户的具体要求原样写入 `prompt`。仅当用户明确要去掉「AI 生成 / LobsterAI」水印时，为 `erase` 加上 `eraseTarget: "lobsterai_watermark"`。示例：

   ```json
   {"action":"generate","image":"./海报.png","imageOperation":"erase","eraseTarget":"lobsterai_watermark","prompt":"去掉右下角的 LobsterAI 水印","n":1}
   ```

3. 使用会话中选定的编辑模型，沿用工具的费用确认流程。`list` 可查询各模型支持的操作。抠图需要支持 `matting` 的模型。当前模型不支持时，告知用户可选的兼容模型。
4. 每个任务只提交一次。拿到任务 ID 后，通过同一工具的 `action: "status"` 查询原任务。成功后返回已保存的新文件，保留原图；若失败，报告工具返回的错误。
