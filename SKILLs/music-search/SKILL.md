---
name: music-search
description: "搜索音乐资源（歌曲、专辑、无损音乐），从夸克网盘、百度网盘、阿里云盘、UC网盘获取资源链接。触发词：找音乐、找歌、无损音乐、FLAC下载、音乐网盘、歌曲下载、专辑资源、音乐资源、APE下载、DSD音乐、Hi-Res。"
official: false
---

# Music Search Skill

搜索音乐资源（歌曲、专辑、无损音乐），通过实时爬虫深度抓取资源页面，从各网盘平台获取公开分享的资源链接。

## 前置条件

- **web-search** skill（必需，用于搜索发现资源页面）
- **Python 3**（必需，用于 cloudscraper 深度页面抓取。依赖首次运行时自动安装到 `.venv`）

## 命令

### 搜索资源

```bash
bash "$SKILLS_ROOT/music-search/scripts/music-search.sh" search "关键词" [选项]
```

**选项：**

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--pan <type>` | 筛选网盘类型: `quark`, `baidu`, `aliyun`, `uc`, `all` | `all` |
| `--format <f>` | 筛选音频格式: `flac`, `ape`, `wav`, `dsd`, `hires`, `mp3`, `aac`, `all` | `all` |
| `--limit <n>` | 每个平台最大结果数 | `5` |
| `--engine <e>` | 搜索引擎: `deep`, `web` | `deep` |

**引擎说明：**

- `deep`（默认，推荐）— web-search 搜索发现资源页面 + cloudscraper 深度抓取提取网盘链接和提取码，结果最准确
- `web` — 仅从 web-search 搜索引擎摘要中提取链接（速度快，但准确率较低，不做深度抓取）

**示例：**

```bash
# 搜索所有平台的音乐资源（默认使用深度搜索）
bash "$SKILLS_ROOT/music-search/scripts/music-search.sh" search "周杰伦 范特西"

# 只搜夸克网盘 FLAC 资源
bash "$SKILLS_ROOT/music-search/scripts/music-search.sh" search "周杰伦 范特西" --pan quark --format flac

# 搜索 Hi-Res 高解析音乐
bash "$SKILLS_ROOT/music-search/scripts/music-search.sh" search "邓紫棋 光年之外" --format hires

# 限制结果数量
bash "$SKILLS_ROOT/music-search/scripts/music-search.sh" search "林俊杰 她说" --limit 10

# 使用浅层搜索（不深度抓取页面）
bash "$SKILLS_ROOT/music-search/scripts/music-search.sh" search "陈奕迅 十年" --engine web
```

Windows 系统使用 PowerShell 脚本：
```powershell
powershell -File "$SKILLS_ROOT/music-search/scripts/music-search.ps1" search "周杰伦 范特西" --pan quark
```

### 热门推荐

```bash
bash "$SKILLS_ROOT/music-search/scripts/music-search.sh" hot "2025年热门专辑"
```

本质上是以推荐类关键词调用搜索，返回相关网盘资源。

### 解析跳转链接

```bash
bash "$SKILLS_ROOT/music-search/scripts/music-search.sh" resolve "https://example.com/goto/xxx"
```

当搜索结果中的链接需要二次跳转时，用此命令解析出真实网盘地址。

## Agent 使用流程

1. 用户说「帮我找 XXX 的音乐」→ 执行 `search "XXX"`
2. 解析返回的 JSON，提取网盘链接
3. 按网盘类型和音频格式分组呈现给用户
4. 如果结果中有提取码 (`extractCode`)，一并展示给用户
5. 如果结果中有 `pageUrl` 但没有直接 `url`，用 `resolve` 命令获取真实地址

**示例对话：**

> 用户：帮我找一下周杰伦范特西专辑的无损资源，要FLAC格式
>
> Agent：
> 1. 执行 `search "周杰伦 范特西" --format flac`
> 2. 从 JSON 结果中取出匹配项
> 3. 返回：标题 + 格式 + 网盘链接 + 提取码（如有）

## 输出格式

所有命令输出 JSON，结构如下：

```json
{
  "success": true,
  "data": {
    "query": "周杰伦 范特西",
    "total": 5,
    "results": [
      {
        "title": "资源标题",
        "pan": "quark",
        "url": "https://pan.quark.cn/s/xxx",
        "format": "FLAC",
        "extractCode": "ab12",
        "source": "deep-search",
        "pageUrl": "https://example.com/resource/123"
      }
    ]
  }
}
```

**字段说明：**
- `pan`: 网盘类型 — `quark`(夸克), `baidu`(百度), `aliyun`(阿里), `uc`(UC), `magnet`(磁力)
- `format`: 检测到的音频格式 — `FLAC`, `APE`, `WAV`, `DSD`, `Hi-Res`, `AIFF`, `MP3`, `AAC`, `OGG`, 空字符串表示未检测到
- `source`: 结果来源 — `deep-search`(深度抓取), `web-search`(搜索摘要)
- `url`: 网盘分享链接（可直接访问）
- `extractCode`: 提取码/密码（如果检测到）
- `pageUrl`: 结果来源页面 URL

## 配置

编辑 `music-search/.env` 可自定义偏好：

```bash
# 偏好的网盘类型（逗号分隔，排在前面的优先展示）
MUSIC_SEARCH_PREFERRED_PAN=quark,aliyun,baidu,uc

# 深度搜索开关（推荐开启）
MUSIC_SEARCH_DEEP_ENABLED=true

# 每次搜索最多访问的结果页面数
MUSIC_SEARCH_DEEP_MAX_PAGES=6

# 并发抓取页面数
MUSIC_SEARCH_DEEP_CONCURRENCY=4
```

## 注意事项

- 搜索建议使用**中文歌手名+专辑名或歌曲名**，效果最好
- 深度搜索（`--engine deep`）比浅层搜索多 2-3 秒，但结果准确得多
- 首次使用时会自动安装 Python cloudscraper 到 `.venv`（需要 Python 3）
- 深度搜索需要 web-search skill 启用，首次搜索可能需要等待浏览器启动
- 网盘分享链接可能随时失效，建议尽快使用

## 免责声明

本工具仅供个人学习和研究使用。不托管、不分发、不提供任何版权内容，仅聚合搜索引擎上公开可访问的链接。请遵守所在地区的法律法规。
