---
name: seedance
description: 使用火山引擎 Seedance 模型生成 AI 视频。支持文本生成视频（T2V）、图片生成视频（I2V）、音画同步等多种创作模式。触发场景：用户请求生成视频、制作视频、视频创作等任务。
official: true
version: 1.0.0
---

# Seedance 视频生成

使用火山引擎 Seedance 模型生成高质量 AI 视频，支持文本生成视频（T2V）、图片生成视频（I2V）、音画同步等多种创作模式。

> ✨ **Node.js 版本**：此脚本使用 Node.js 实现，无需 Python 环境。通过入口脚本自动检测 Node.js 运行时（优先使用系统 node，回退到 LobsterAI 内置运行时），Windows 和 Mac 用户都可以开箱即用。

## 配置

- **Base URL**: `https://ark.cn-beijing.volces.com/api/v3`
- **API Key**: 从环境变量 `ARK_API_KEY` 读取
- **认证方式**: `Authorization: Bearer {API_KEY}`
- **SDK**: 兼容火山方舟 Python SDK

### 如何配置 API Key

**方式一：通过环境变量配置（推荐）**

在终端中设置环境变量：

```bash
# macOS/Linux
export ARK_API_KEY="你的API密钥"

# 或者添加到 ~/.zshrc 或 ~/.bashrc 以永久生效
echo 'export ARK_API_KEY="你的API密钥"' >> ~/.zshrc
source ~/.zshrc
```

```powershell
# Windows PowerShell
$env:ARK_API_KEY="你的API密钥"

# 或者设置系统环境变量以永久生效
[System.Environment]::SetEnvironmentVariable('ARK_API_KEY', '你的API密钥', 'User')
```

**方式二：通过 LobsterAI 启动时注入**

LobsterAI 会自动读取系统环境变量，确保在启动 LobsterAI 前已设置 `ARK_API_KEY`。

**如何获取 API Key：**
1. 访问火山方舟控制台：https://console.volcengine.com/ark/region:ark+cn-beijing/apikey
2. 创建新的 API Key
3. 复制密钥并设置为环境变量

## 前置检查

**无需安装任何依赖！** 该脚本已兼容 Node.js 内置模块。

LobsterAI 已包含 Node.js 运行时，所有必要的依赖已被自动打包。Windows 和 Mac 用户无需额外配置。

## 工作流程

Seedance 视频生成是一个异步过程：

1. **提交任务** - 调用 API 创建视频生成任务，获得 `task_id`
2. **轮询状态** - 每隔几秒查询任务状态，直到状态变为 `succeeded`
3. **下载视频** - 从 `video_url` 字段下载生成的 MP4 文件

## 配额和限制

### 免费额度

所有 Seedance 模型在 **default 模式（在线推理）**下提供：
- **200万 token** 免费额度
- flex 模式（离线推理）无免费额度

**注意**：文档中未明确说明 200万 token 能生成多少个视频，消耗取决于视频时长、分辨率和是否使用图片/音频。建议先小批量测试。

### 限流限制

| 模型系列 | RPM（每分钟请求数） | 并发数 | TPD（离线模式每日token） |
|---------|-------------------|--------|----------------------|
| Pro 系列 | 600 | 10 | 5000亿 |
| Lite 系列 | 300 | 5 | 2500亿 |

- **RPM 限流**：账号下同模型每分钟允许创建的任务数量上限
- **并发数限制**：同一时刻在处理中的任务数量上限
- **TPD 限流**：flex 模式下一天内对同一模型的总调用 token 上限

### 视频保存时间

⚠️ **重要提醒**：
- 任务数据（包括视频URL）仅保留 **24 小时**
- 超时后会被自动清除
- **务必及时下载保存生成的视频**

## 使用示例

**路径说明**：下面的示例使用 `$SKILLS_ROOT` 环境变量来引用脚本路径。LobsterAI 会自动设置这个变量，指向实际的 SKILLs 目录位置，因此无需手动修改路径。

### 1. 文本生成视频（T2V）

根据文字描述生成视频，适合创意激发和概念验证。

```bash
bash "$SKILLS_ROOT/seedance/scripts/generate-video.sh" \
  --prompt "一只小猫在草地上玩耍，阳光明媚，镜头缓缓推进" \
  --duration 5 \
  --output generated_video.mp4
```

**示例提示词：**
- "写实风格，晴朗的蓝天之下，一大片白色的雏菊花田，镜头逐渐拉近，最终定格在一朵雏菊花的特写上，花瓣上有几颗晶莹的露珠"
- "一辆地铁轰隆隆驶过，书页飞扬，镜头开始环绕着女孩360度旋转"
- "海边日落，海浪轻拍沙滩，宁静祥和的氛围"

### 2. 图片生成视频（I2V）- 首帧引导

基于首帧图片生成动态视频，**支持本地图片和网络URL**。

```bash
# 使用本地图片
bash "$SKILLS_ROOT/seedance/scripts/generate-video.sh" \
  --prompt "女孩睁开眼，温柔地看向镜头，头发被风吹动" \
  --image "/Users/yourname/Pictures/girl.jpg" \
  --duration 5 \
  --output i2v_video.mp4

# 使用网络图片
bash "$SKILLS_ROOT/seedance/scripts/generate-video.sh" \
  --prompt "女孩睁开眼，温柔地看向镜头，头发被风吹动" \
  --image "https://example.com/first_frame.jpg" \
  --duration 5 \
  --output i2v_video.mp4
```

**支持的图片来源：**
- ✅ 本地文件：`/path/to/image.jpg`
- ✅ 网络URL：`https://example.com/image.jpg`
- ✅ file://协议：`file:///path/to/image.jpg`

**支持的图片格式：**
- jpg, jpeg, png, gif, webp, bmp, tiff, heic

### 3. 图片生成视频（I2V）- 首尾帧引导

提供首帧和尾帧，生成过渡动画。**支持本地图片**。

```bash
bash "$SKILLS_ROOT/seedance/scripts/generate-video.sh" \
  --prompt "360度环绕运镜，流畅过渡" \
  --image "/Users/yourname/Pictures/first_frame.jpg" \
  --image "/Users/yourname/Pictures/last_frame.jpg" \
  --duration 5 \
  --output transition_video.mp4
```

### 4. 多参考图生成视频

融合多张参考图的特征生成视频。**支持混合使用本地图片和网络图片**。

```bash
bash "$SKILLS_ROOT/seedance/scripts/generate-video.sh" \
  --prompt "[图1]戴着眼镜穿着蓝色T恤的男生和[图2]的柯基小狗，坐在[图3]的草坪上，视频卡通风格" \
  --image "/Users/yourname/Pictures/person.jpg" \
  --image "https://example.com/dog.jpg" \
  --image "/Users/yourname/Pictures/grass.jpg" \
  --model "doubao-seedance-1-0-lite-i2v-250428" \
  --duration 5 \
  --output multi_ref_video.mp4
```

### 5. 音画同步视频生成（仅 1.5 pro）

生成包含音频的视频（环境音、动作音、背景音乐等）。**支持本地图片**。

```bash
bash "$SKILLS_ROOT/seedance/scripts/generate-video.sh" \
  --prompt "镜头围绕人物推镜头拉近，特写人物面部，她正在用京剧唱腔唱'月移花影，疑是玉人来'，唱词充满情感" \
  --image "/Users/yourname/Pictures/actress.jpg" \
  --audio \
  --duration 5 \
  --model "doubao-seedance-1-5-pro-251215" \
  --output audio_video.mp4
```

## 参数说明

### 必需参数

| 参数 | 说明 | 示例 |
|-----|------|------|
| `--prompt` | 视频描述提示词（必需） | "小猫在玩耍" |

### 可选参数

| 参数 | 说明 | 默认值 | 可选值 |
|-----|------|-------|--------|
| `--image` | 参考图片路径或URL（可多次使用） | 无 | 本地文件路径或URL |
| `--model` | 模型ID | `doubao-seedance-1-5-pro-251215` | 见模型列表 |
| `--duration` | 视频时长（秒） | 5 | 2-12（不同模型范围不同） |
| `--ratio` | 宽高比 | `adaptive` | `adaptive`, `16:9`, `9:16`, `1:1` |
| `--audio` | 生成音频（仅1.5 pro支持） | 否 | 标志参数 |
| `--no-watermark` | 不添加水印 | 否 | 标志参数 |
| `--output` | 输出文件路径 | `generated_video.mp4` | 文件路径 |
| `--poll-interval` | 状态查询间隔（秒） | 5 | 1-10 |
| `--timeout` | 最大等待时间（秒） | 300 | 60-600 |

## 模型选择

选择合适的模型以平衡质量、速度和成本：

### Seedance 1.5 pro（推荐）

- **模型ID**: `doubao-seedance-1-5-pro-251215`
- **特点**: 音画同生，最高质量
- **支持**: 文生视频、图生视频、首尾帧、有声视频
- **输出**: 480p-1080p，24fps，4-12秒
- **限流**: RPM 600，并发10

### Seedance 1.0 pro

- **模型ID**: `doubao-seedance-1-0-pro-250528`
- **特点**: 高质量标准版本
- **支持**: 文生视频、图生视频、首尾帧
- **输出**: 480p-1080p，24fps，2-12秒
- **限流**: RPM 600，并发10

### Seedance 1.0 pro fast

- **模型ID**: `doubao-seedance-1-0-pro-fast-251015`
- **特点**: 快速生成，成本更低
- **支持**: 文生视频、图生视频
- **输出**: 480p-1080p，24fps，2-12秒
- **限流**: RPM 600，并发10

### Seedance 1.0 lite（轻量版）

- **文生视频**: `doubao-seedance-1-0-lite-t2v-250428`
- **图生视频**: `doubao-seedance-1-0-lite-i2v-250428`
- **特点**: 更快速度，支持多参考图
- **限流**: RPM 300，并发5

### Seedance 2.0（即将支持）

- **模型ID**: `doubao-seedance-2-0-260128`
- **特点**: 下一代视频生成模型，质量和性能全面提升
- **可用性**: ⏰ 预计 **2026年2月24日18点** 开放 API 调用
- **当前状态**: 仅在 [控制台体验中心](https://console.volcengine.com/ark/region:ark+cn-beijing/experience/vision?modelId=doubao-seedance-2-0-260128&tab=GenVideo) 可用

**使用方式（2月24日后）：**

```bash
# 命令行方式
bash "$SKILLS_ROOT/seedance/scripts/generate-video.sh" \
  --prompt "你的提示词" \
  --model "doubao-seedance-2-0-260128" \
  --duration 5
```

或在 LobsterAI 对话中说："用 Seedance 2.0 生成视频..."

**推荐使用场景：**
- 追求最高质量 + 音画同步 → 1.5 pro
- 标准高质量视频 → 1.0 pro
- 快速生成预览 → 1.0 pro fast
- 多参考图融合 → 1.0 lite
- 下一代最新模型（2月24日后）→ 2.0

## 高级选项

### 自定义宽高比

根据使用场景选择合适的宽高比：

```bash
# 横屏视频（适合 YouTube、B站）
--ratio "16:9"

# 竖屏视频（适合抖音、快手）
--ratio "9:16"

# 正方形视频（适合 Instagram）
--ratio "1:1"

# 自适应（根据内容自动选择）
--ratio "adaptive"
```

### 自定义视频时长

不同模型支持的时长范围不同：

```bash
# 短视频（快速生成）
--duration 2

# 标准时长
--duration 5

# 长视频（内容更丰富）
--duration 10
```

**注意：**
- Seedance 1.5 pro 支持 4-12 秒
- Seedance 1.0 系列支持 2-12 秒
- 时长越长，生成时间越久

### 去除水印

生成无水印视频（用于商业用途）：

```bash
--no-watermark
```

### 轮询和超时控制

调整轮询策略以适应不同场景：

```bash
# 快速查询（适合短视频）
--poll-interval 3 --timeout 180

# 标准配置
--poll-interval 5 --timeout 300

# 耐心等待（适合长视频或高峰期）
--poll-interval 10 --timeout 600
```

## 状态说明

生成过程中可能出现的任务状态：

| 状态 | 说明 | 操作 |
|------|------|------|
| `queued` | 任务排队中 | 继续等待 |
| `running` | 正在生成视频 | 继续等待 |
| `succeeded` | 生成成功 | 下载视频 |
| `failed` | 生成失败 | 查看错误信息 |

## 错误处理

### 常见错误及解决方案

**错误：未设置环境变量 ARK_API_KEY**
- 原因：未配置 API Key
- 解决：按照"如何配置 API Key"部分的说明进行配置

**错误：任务创建失败 (HTTP 401)**
- 原因：API Key 无效或已过期
- 解决：检查 API Key 是否正确，或在控制台重新生成

**错误：任务创建失败 (HTTP 400)**
- 原因：参数错误（如 duration 超出范围）
- 解决：检查参数是否符合模型要求

**错误：任务超时**
- 原因：生成时间过长或 API 繁忙
- 解决：增加 `--timeout` 值，或稍后重试

**错误：任务失败**
- 原因：内容违规、提示词不清晰、图片格式错误等
- 解决：检查提示词内容，确保图片URL可访问

**错误：限流 (HTTP 429)**
- 原因：超过 RPM 或并发限制
- 解决：等待1分钟后重试，或升级配额

## 输出格式

生成的视频具有以下特征：

- **格式**: MP4
- **编码**: H.264
- **分辨率**: 480p / 720p / 1080p（根据模型自动选择）
- **帧率**: 24 fps
- **音频**: AAC（如果启用 `--audio`）
- **文件大小**: 约 2-5 MB/秒（1080p）

## 提示词最佳实践

### 优秀提示词的特点

1. **清晰的场景描述** - 说明环境、时间、氛围
2. **具体的动作细节** - 描述物体或人物的具体动作
3. **镜头运动** - 说明推拉摇移、特写等镜头语言
4. **风格指定** - 写实、卡通、动漫等风格说明

### 提示词模板

```
[风格]，[场景描述]，[主体动作]，[镜头运动]，[氛围/情绪]
```

**示例：**
```
写实风格，海边日落，一只海鸥在空中盘旋，镜头从远处缓缓推进到海鸥特写，宁静祥和的氛围
```

### 提示词注意事项

- ✅ 具体描述："小猫追逐蝴蝶" 而非 "小猫玩耍"
- ✅ 镜头语言："镜头360度环绕" 而非 "旋转"
- ✅ 情绪氛围："温暖明亮的阳光" 而非 "好天气"
- ❌ 避免模糊：过于抽象的描述会导致随机性增加
- ❌ 避免过长：保持在 200 字以内效果最佳
- ❌ 避免违规：不要包含暴力、色情等违规内容

## 常见使用场景

### 短视频创作
```bash
bash "$SKILLS_ROOT/seedance/scripts/generate-video.sh" \
  --prompt "产品展示：智能手表从不同角度旋转展示" \
  --ratio "9:16" \
  --duration 5
```

### 动画短片
```bash
bash "$SKILLS_ROOT/seedance/scripts/generate-video.sh" \
  --prompt "卡通风格，小兔子在森林里蹦蹦跳跳" \
  --ratio "16:9" \
  --duration 8 \
  --model "doubao-seedance-1-0-pro-250528"
```

### 社交媒体内容
```bash
bash "$SKILLS_ROOT/seedance/scripts/generate-video.sh" \
  --prompt "美食特写：热气腾腾的拉面，筷子夹起面条" \
  --ratio "1:1" \
  --duration 3
```

### 教学演示
```bash
bash "$SKILLS_ROOT/seedance/scripts/generate-video.sh" \
  --prompt "科普动画：地球自转，太阳光照射地球表面" \
  --ratio "16:9" \
  --duration 10
```

## 参考资料

- API 参考：https://www.volcengine.com/docs/82379/1520758
- 控制台：https://console.volcengine.com/ark
- API Key 管理：https://console.volcengine.com/ark/region:ark+cn-beijing/apikey

## 技术支持

如遇到问题，可以：
1. 查看脚本输出的错误信息
2. 检查 API Key 配置是否正确
3. 访问火山方舟控制台查看任务详情
4. 参考官网文档了解更多细节
