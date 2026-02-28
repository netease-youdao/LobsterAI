---
name: seedream
description: 使用火山引擎 Seedream 模型生成 AI 图片。支持文本生成图片(T2I)、图片编辑(I2I)、多图融合创作、组图生成、联网搜索等多种创作模式。触发场景:用户请求生成图片、制作图像、图像创作、图片编辑、图片融合等任务。
official: true
version: 1.0.0
---

# Seedream 图片生成

使用火山引擎 Seedream 模型生成高质量 AI 图片，支持文本生成图片（T2I）、图片编辑（I2I）、多图融合、组图生成、联网搜索等多种创作模式。

> ✨ **Node.js 版本**：此脚本使用 Node.js 实现，无需 Python 环境。通过入口脚本自动检测 Node.js 运行时（优先使用系统 node，回退到 LobsterAI 内置运行时），Windows 和 Mac 用户都可以开箱即用。

## 配置

- **Base URL**: `https://ark.cn-beijing.volces.com/api/v3`
- **API Key**: 从环境变量 `ARK_API_KEY` 读取
- **认证方式**: `Authorization: Bearer {API_KEY}`
- **SDK**: 兼容火山方舟 Python SDK

### 快速开始

**第一步：设置 API Key**

```bash
# macOS / Linux - 当前终端临时生效（立即使用）
export ARK_API_KEY="你的API密钥"

# Windows PowerShell - 当前会话临时生效
$env:ARK_API_KEY="你的API密钥"

# 验证设置成功（macOS/Linux）
echo $ARK_API_KEY

# 验证设置成功（Windows）
echo $env:ARK_API_KEY
```

**第二步：生成你的第一张图片**

```bash
bash "$SKILLS_ROOT/seedream/scripts/generate-image.sh" \
  --prompt "一只可爱的橘色小猫"
```

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

Seedream 图片生成采用**同步模式**，流程简单高效：

1. **提交请求** - 调用 API 提交图片生成请求
2. **等待生成** - API 直接处理并生成图片（通常 30-60 秒）
3. **下载图片** - 从返回的 URL 下载生成的图片文件

相比异步模式，同步模式更简单直接，无需轮询任务状态。

## 配额和限制

### 免费额度

所有 Seedream 模型提供免费额度，具体请参见火山方舟控制台。

### 限流限制

- **IPM（每分钟图片数）**: 500 张/分钟（Seedream 4.5, 4.0）
- 不同模型的限流不同，请参见官方文档

### 图片保存时间

⚠️ **重要提醒**：
- 任务数据（包括图片URL）仅保留 **24 小时**
- 超时后会被自动清除
- **务必及时下载保存生成的图片**

## 使用示例

**路径说明**：下面的示例使用 `$SKILLS_ROOT` 环境变量来引用脚本路径。LobsterAI 会自动设置这个变量，指向实际的 SKILLs 目录位置，因此无需手动修改路径。

### 1. 文本生成图片（T2I）

根据文字描述生成图片，适合创意激发和概念设计。

```bash
bash "$SKILLS_ROOT/seedream/scripts/generate-image.sh" \
  --prompt "充满活力的特写编辑肖像，模特眼神犀利，头戴雕塑感帽子，色彩拼接丰富，景深较浅，Vogue杂志封面美学风格" \
  --output portrait.png
```

**示例提示词：**
- "写实风格，晴朗的蓝天之下，一大片白色的雏菊花田，镜头逐渐拉近，最终定格在一朵雏菊花的特写上"
- "卡通风格，一只橘色小猫坐在窗台上，阳光洒在身上，温暖治愈的氛围"
- "赛博朋克风格，未来城市夜景，霓虹灯闪烁，高楼林立"

### 2. 图片编辑（I2I）- 单图输入

基于已有图片，结合文字指令进行图像编辑。**支持本地图片和网络URL**。

```bash
# 使用本地图片
bash "$SKILLS_ROOT/seedream/scripts/generate-image.sh" \
  --prompt "保持模特姿势不变，将服装材质改为透明玻璃质感" \
  --image "/Users/yourname/Pictures/model.jpg" \
  --output edited_model.png

# 使用网络图片
bash "$SKILLS_ROOT/seedream/scripts/generate-image.sh" \
  --prompt "将背景改为海边日落场景" \
  --image "https://example.com/photo.jpg" \
  --output beach_sunset.png
```

**支持的图片来源：**
- ✅ 本地文件：`/path/to/image.jpg`
- ✅ 网络URL：`https://example.com/image.jpg`
- ✅ file://协议：`file:///path/to/image.jpg`

**支持的图片格式：**
- jpg, jpeg, png, gif, webp, bmp, tiff, heic

### 3. 多图融合（多图输入单图输出）

融合多张参考图的特征生成新图像。**支持混合使用本地图片和网络图片**。

```bash
bash "$SKILLS_ROOT/seedream/scripts/generate-image.sh" \
  --prompt "将图1的服装换为图2的服装" \
  --image "/Users/yourname/Pictures/person.jpg" \
  --image "https://example.com/clothes.jpg" \
  --output fusion_result.png
```

**常见使用场景：**
- 服装试穿：人物图 + 服装图 → 穿搭效果图
- 风格迁移：照片 + 风格参考图 → 风格化作品
- 场景融合：人物 + 背景 → 合成场景

### 4. 组图生成（多图输出）

生成一组内容关联的图片，适合漫画分镜、品牌视觉等。

#### 文生组图

```bash
bash "$SKILLS_ROOT/seedream/scripts/generate-image.sh" \
  --prompt "生成一组共4张连贯插画，核心为同一庭院一角的四季变迁，以统一风格展现四季独特色彩、元素与氛围" \
  --sequential \
  --max-images 4 \
  --output seasons.png
```

输出文件会自动编号：`seasons_1.png`, `seasons_2.png`, `seasons_3.png`, `seasons_4.png`

#### 单图生组图

```bash
bash "$SKILLS_ROOT/seedream/scripts/generate-image.sh" \
  --prompt "参考这个LOGO，做一套户外运动品牌视觉设计，品牌名称为'GREEN'，包括包装袋、帽子、卡片、挂绳等" \
  --image "/Users/yourname/Pictures/logo.png" \
  --sequential \
  --max-images 4 \
  --output brand_design.png
```

### 5. 联网搜索增强生成（Seedream 5.0 lite）

启用实时网络搜索，融合最新网络信息。

```bash
bash "$SKILLS_ROOT/seedream/scripts/generate-image.sh" \
  --prompt "搜索下近期热门的白鸭子单手拿着风车形象，以极具冲击力的视角，设计成巨型装置" \
  --search \
  --output search_result.png
```

**注意**：
- 联网搜索功能仅限 Seedream 5.0 lite 模型
- 使用 `--search` 参数会自动切换到 5.0 lite 模型
- 适合需要融合实时信息的创作场景

## 参数说明

### 必需参数

| 参数 | 说明 | 示例 |
|-----|------|------|
| `--prompt` | 图片描述提示词（必需） | "一只可爱的小猫" |

### 可选参数

| 参数 | 说明 | 默认值 | 可选值 |
|-----|------|-------|--------|
| `--image` | 参考图片路径或URL（可多次使用） | 无 | 本地文件路径或URL |
| `--model` | 模型ID | `doubao-seedream-4-5-251128` | 见模型列表 |
| `--size` | 图片尺寸 | `2K` | `1K`, `2K`, `4K` |
| `--no-watermark` | 不添加水印 | 否 | 标志参数 |
| `--sequential` | 生成组图 | 否 | 标志参数 |
| `--max-images` | 组图数量 | 4 | 1-8 |
| `--search` | 启用联网搜索 | 否 | 标志参数 |
| `--output` | 输出文件路径 | `generated_image.png` | 文件路径 |
| `--poll-interval` | 状态查询间隔（秒） | 5 | 1-10 |
| `--timeout` | 最大等待时间（秒） | 300 | 60-600 |

## 模型选择

选择合适的模型以平衡质量、速度和成本：

### Seedream 4.5（推荐）

- **模型ID**: `doubao-seedream-4-5-251128`
- **特点**: 最新版本，综合质量最佳
- **支持**: 文生图、图生图、多图融合、组图生成
- **输出**: 1K-4K分辨率可选
- **限流**: IPM 500

### Seedream 4.0

- **模型ID**: `doubao-seedream-4-0-250828`
- **特点**: 成熟稳定版本
- **支持**: 文生图、图生图、多图融合、组图生成
- **输出**: 1K-4K分辨率可选
- **限流**: IPM 500

### Seedream 5.0 lite（联网搜索专用）

- **模型ID**: `doubao-seedream-5-0-260128`
- **特点**: 支持联网搜索，融合实时网络信息
- **使用**: 通过 `--search` 参数自动启用
- **注意**: 2026年2月24日18点后正式开放 API

**推荐使用场景：**
- 追求最高质量 → 4.5
- 稳定生产环境 → 4.0
- 需要实时信息 → 5.0 lite（使用 `--search`）

## 高级选项

### 自定义图片尺寸

根据使用场景选择合适的尺寸：

```bash
# 小尺寸（快速预览）
--size "1K"

# 标准尺寸（推荐）
--size "2K"

# 高清晰度
--size "4K"
```

**注意：**
- 尺寸越大，生成时间越长
- 4K 图片可能需要 40-60 秒

### 去除水印

生成无水印图片（用于商业用途）：

```bash
--no-watermark
```

### 轮询和超时控制

调整轮询策略以适应不同场景：

```bash
# 快速查询（适合小图）
--poll-interval 3 --timeout 180

# 标准配置
--poll-interval 5 --timeout 300

# 耐心等待（适合4K或组图）
--poll-interval 10 --timeout 600
```

## 状态说明

生成过程中可能出现的任务状态：

| 状态 | 说明 | 操作 |
|------|------|------|
| `queued` | 任务排队中 | 继续等待 |
| `running` | 正在生成图片 | 继续等待 |
| `succeeded` | 生成成功 | 下载图片 |
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
- 原因：参数错误（如 size 不支持、prompt 为空等）
- 解决：检查参数是否符合要求

**错误：任务超时**
- 原因：生成时间过长或 API 繁忙
- 解决：增加 `--timeout` 值，或稍后重试

**错误：任务失败**
- 原因：内容违规、提示词不清晰、图片格式错误等
- 解决：检查提示词内容，确保图片URL可访问

**错误：限流 (HTTP 429)**
- 原因：超过 IPM 限制
- 解决：等待1分钟后重试，或升级配额

**错误：图片文件不存在**
- 原因：本地图片路径错误
- 解决：检查文件路径是否正确，使用绝对路径

## 输出格式

生成的图片具有以下特征：

- **格式**: PNG, JPEG（根据output参数自动识别）
- **分辨率**: 1K / 2K / 4K（根据 size 参数）
- **文件大小**: 约 0.5-10 MB（取决于尺寸和复杂度）
- **命名规则**:
  - 单图：指定的文件名
  - 组图：`文件名_1.png`, `文件名_2.png`, ...

## 提示词最佳实践

### 优秀提示词的特点

1. **清晰的主体描述** - 说明画面的主要内容
2. **具体的风格指定** - 写实、卡通、赛博朋克等
3. **细节补充** - 色彩、光线、氛围等
4. **构图说明** - 特写、全景、俯视等视角

### 提示词模板

```
[风格]，[主体描述]，[细节补充]，[构图/氛围]
```

**示例：**
```
写实风格，一只橘色小猫坐在木制窗台上，阳光从左侧洒进来，温暖治愈的氛围，特写构图
```

### 提示词注意事项

- ✅ 具体描述："小猫在追逐蝴蝶" 而非 "小猫玩耍"
- ✅ 风格说明："赛博朋克风格" 而非 "好看的"
- ✅ 细节丰富："橘色长毛小猫，蓝色眼睛" 而非 "猫"
- ❌ 避免模糊：过于抽象的描述会导致随机性增加
- ❌ 避免过长：保持在 200 字以内效果最佳
- ❌ 避免违规：不要包含暴力、色情等违规内容

## 常见使用场景

### 产品设计

```bash
bash "$SKILLS_ROOT/seedream/scripts/generate-image.sh" \
  --prompt "现代简约风格，智能手表产品展示，白色背景，工作室灯光" \
  --size "4K"
```

### 艺术创作

```bash
bash "$SKILLS_ROOT/seedream/scripts/generate-image.sh" \
  --prompt "超现实主义，漂浮的岛屿，瀑布从天而降，梦幻色彩" \
  --size "2K"
```

### 社交媒体内容

```bash
bash "$SKILLS_ROOT/seedream/scripts/generate-image.sh" \
  --prompt "美食特写，热气腾腾的拉面，筷子夹起面条，暖色调" \
  --size "2K"
```

### 品牌视觉设计

```bash
bash "$SKILLS_ROOT/seedream/scripts/generate-image.sh" \
  --prompt "参考logo，生成一套完整的品牌视觉系统，包括名片、海报、包装设计" \
  --image brand_logo.png \
  --sequential \
  --max-images 4
```

## 参考资料

- API 参考：https://www.volcengine.com/docs/82379/1541523
- 控制台：https://console.volcengine.com/ark
- API Key 管理：https://console.volcengine.com/ark/region:ark+cn-beijing/apikey
- 模型列表：https://www.volcengine.com/docs/82379/1330310

## 技术支持

如遇到问题，可以：
1. 查看脚本输出的错误信息
2. 检查 API Key 配置是否正确
3. 访问火山方舟控制台查看任务详情
4. 参考官网文档了解更多细节
