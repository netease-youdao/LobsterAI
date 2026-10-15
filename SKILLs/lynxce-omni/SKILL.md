---
name: lynxce-omni
description: "灵策全能AI：通过「灵策全能AI」MCP 服务一句话作图（海报、商品主图、封面、插画）、修图（变清晰、无损放大、换背景、老照片修复、抠图、图片文字翻译）、做短视频（文生视频 / 图生视频）、写歌，以及提取抖音视频口播文案。Use when the user asks to generate or edit images, make a short video, compose music, or extract a Douyin video script, and the lynxce_* tools are available."
version: 1.0.0
---

# 灵策全能AI

通过 MCP 服务「灵策全能AI」（`https://web.lynxce.cn/api/mcp`）完成作图、修图、做视频、写歌和抖音文案提取。所有调用按用户灵策账号的积分计费。

## 前置条件

本技能依赖名称以 `lynxce_` 开头的 MCP 工具（例如 `lynxce_generate_image`）。

- **当前可用工具里有 `lynxce_` 工具** → 直接按下文流程使用。
- **没有这些工具** → 告诉用户：在「MCP → 市场」里找到「灵策全能AI」，点「连接并登录」，在浏览器里用灵策账号授权后再试。**不要假装已经生成，也不要编造图片或视频链接。**
- 工具返回未登录 / 授权失效（401、`unauthorized`、`invalid_token`）→ 提示用户在 MCP 页面的「灵策全能AI」卡片上重新点「登录」。

## 工具速查

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `lynxce_account` | 查积分余额、会员状态、本连接今日 / 本月已用积分与上限 | 无 |
| `lynxce_list_models` | 列出可用模型 | `modality`: image / video / audio |
| `lynxce_generate_image` | 文生图、参考图生图 | `prompt`、`aspect_ratio`（如 1:1、3:4、16:9、9:16）或 `size`、`n`（1~4）、`images`（参考图 URL） |
| `lynxce_edit_image` | 修图 | `operation`、`image`，见下文 |
| `lynxce_generate_video` | 文生视频、图生视频 | `prompt`、`duration`、`resolution`、`image`（首帧图 URL） |
| `lynxce_generate_music` | 作曲（一次两首） | 灵感模式 `prompt`；自定义模式 `title` + `style` + `lyrics`；`instrumental` 纯音乐 |
| `lynxce_extract_douyin` | 提取抖音视频口播文案 | `share_text`：分享文案或链接 |
| `lynxce_get_generation` | 按 `task_id` 查询任务状态与结果 | `task_id`、`wait_seconds`（不超过 50） |
| `lynxce_list_works` | 列出通过本连接生成的作品 | `media_type`、`limit` |

## 工作流程

### 1. 先确认需求，再花积分

- 用户需求模糊时（用途、尺寸、风格、文字内容不清楚），先问一句再生成。
- 做视频、批量作图（`n` > 1 或多轮）之前，先调 `lynxce_account` 看余额和今日上限；余额不够时直接告诉用户，不要硬调。
- 视频比图片贵得多。没有用户明确要求时，一次只生成一个视频。

### 2. 作图

- `prompt` 写具体：主体、场景、风格、构图、光线、色调；需要画面里出现文字时，把文字原样写进 prompt 并加引号。
- 用途对应画幅：手机海报 / 小红书封面用 `3:4` 或 `9:16`，横版 banner 用 `16:9`，商品主图用 `1:1`。
- 用户给了图片要「参考」「照着改」时，把图片 URL 放进 `images`。
- 默认同步等待约 50 秒；返回 `task_id` 时用 `lynxce_get_generation` 查询（`wait_seconds` 设 30~50），直到状态为 `succeeded` 或失败。

### 3. 修图（`lynxce_edit_image`）

| 用户说法 | `operation` | 补充参数 |
|----------|-------------|----------|
| 变清晰、提升画质 | `upscale` | — |
| 无损放大 2 倍 / 4 倍 | `super-resolution` | `scale`: 2 或 4 |
| 换背景、白底图 | `background-replace` | `prompt` 写新背景，如「纯白摄影棚背景」 |
| 老照片修复 | `restore` | — |
| 抠图、去背景、透明底 | `segment` | `segment_kind`: generic / commodity / human / cloth |
| 翻译图片里的文字 | `translate` | `target_lang`: en、ja、ko 等 |

`image` 可以直接用上一步生成结果的 URL。

### 4. 做视频

- 先把用户的想法整理成一段画面描述（主体、动作、镜头运动、风格），确认后再提交。
- 「让这张图动起来」→ 把图片 URL 放进 `image` 做图生视频。
- 视频通常要 1~5 分钟，工具多半先返回 `task_id`。告诉用户大概要等多久，然后用 `lynxce_get_generation` 每次等 30~50 秒地查询，不要一直空转。

### 5. 写歌

- 只有大概想法 → 灵感模式，把主题、情绪、风格写进 `prompt`。
- 用户给了歌名、曲风、歌词 → 自定义模式，填 `title`、`style`、`lyrics`；纯音乐设 `instrumental: true`。
- 通常 1~3 分钟，按 `task_id` 查询结果；一次会生成两首，两首都给用户。

### 6. 抖音文案提取

用户贴来抖音分享文案或链接 → 调 `lynxce_extract_douyin`，把口播文案整理成段落返回。用户要「改写」「仿写」时，再基于这份文案改写。

## 展示结果

- 图片用 Markdown 图片语法直接展示：`![描述](URL)`；视频、音乐给出可点击的链接。
- 说明本次用了哪个能力、画幅 / 时长等关键参数；工具返回了消耗积分或余额时一并告诉用户。
- 用户之后想找回之前的作品 → 调 `lynxce_list_works`。

## 出错时

- **积分不足 / 超过今日上限** → 告诉用户余额或上限情况，建议在灵策个人中心充值或调高本连接的每日上限，不要反复重试。
- **需要会员**（`member_required`）→ 说明该能力需要灵策会员，可以先用其他能力。
- **内容审核未通过** → 请用户调整描述，不要换个说法规避审核。
- **任务失败或超时** → 把错误原因告诉用户，询问是否重试；同一请求不要自动重试超过一次。
