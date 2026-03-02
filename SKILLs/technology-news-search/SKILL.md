---
name: technology-news-search
description: Real-time technology news search and aggregation from 75 international and Chinese media sources across 9 core technical domains. Intelligent keyword-based routing with domain aliases searches only relevant sources. Automatically adapts to network environment - seamlessly switches between global sources (75) and China-only sources (18) based on network accessibility. Use when user requests to search for tech news by keyword. Trigger phrases include "search for [keyword] tech news", "find news about [topic]", "latest news on [subject]", or Chinese equivalents like "搜索 [关键词] 科技新闻". Provides multi-source heat analysis, automatic EN↔CN translation, and clean Markdown presentation.
official: true
version: 1.0.0
---

# Technology News Search

Real-time keyword-based search across 75 tech news sources with smart domain routing, automatic network adaptation, domain aliases, heat analysis, and translation.

## Overview

This skill searches multiple technology news sources simultaneously, automatically detects technical domains from your keyword (with alias support), routes to relevant sources only, ranks results by "heat score" (based on cross-source appearance, recency, and keyword relevance), and presents them in a clean Markdown format with automatic English-to-Chinese translation.

**Total Sources: 75 (18 China + 57 Global, across 9 core technical domains)**

**Automatic Network Adaptation**: The skill silently detects network accessibility and automatically adjusts source selection:
- ✅ **Global network accessible**: Uses all 75 sources (China + Global)
- 🇨🇳 **China-only network**: Automatically uses 18 China sources only
- ⚡ **Completely transparent**: Detection is cached for 5 minutes, no user notification needed

**News Sources by Domain:**

- **General (25 sources)**:
  - 🌍 International: TechCrunch, The Verge, Wired, Ars Technica, MIT Technology Review, VentureBeat, Hacker News
  - 🇨🇳 China: 36氪, 虎嗅, IT之家, 机器之心, 量子位, 钛媒体, 掘金, InfoQ中文站, 开源中国, 博客园, SegmentFault, V2EX, 极客公园, 爱范儿, PingWest品玩, 少数派, 雷锋网, 阿里云开发者

- **Frontend/Web (14 sources)**:
  - 🌍 Dev.to (React, Vue, Electron, JavaScript, TypeScript), Reddit (r/javascript, r/reactjs, r/vuejs, r/electronjs, r/webdev), Official Blogs (React, Vue, Electron)
  - 🇨🇳 掘金 (frontend)

- **Backend (16 sources)**:
  - 🌍 Dev.to (Python, Go, Node.js, Java, TypeScript), Reddit (r/Python, r/golang, r/node, r/java), Official Blogs (Node.js, Python, Go, Rust)
  - 🇨🇳 掘金, 博客园, 阿里云开发者
  - **Now includes databases** (MySQL, PostgreSQL, MongoDB, Redis)

- **Mobile (4 sources)**: Reddit (r/androiddev, r/iOSProgramming, r/FlutterDev), Android Developers Blog

- **AI/ML (11 sources)**:
  - 🌍 VentureBeat, Dev.to (AI, Machine Learning), Reddit (r/MachineLearning, r/artificial, r/LocalLLaMA)
  - 🇨🇳 机器之心, 量子位, 雷锋网

- **DevOps (9 sources)**:
  - 🌍 Dev.to (Docker, Kubernetes), Reddit (r/docker, r/kubernetes, r/devops), Official Blogs (Docker, Kubernetes)
  - 🇨🇳 阿里云开发者
  - **Now includes cloud** (AWS, Azure, GCP)

- **Hardware (4 sources)**: Hackaday, Arduino Blog, Reddit (r/arduino, r/raspberry_pi)

- **Security (4 sources)**: The Hacker News (security), Krebs on Security, Reddit (r/netsec, r/cybersecurity)

- **OS (1 source)**: Phoronix

## Smart Source Routing

**Enhanced with Domain Aliases + Network Adaptation**: The skill automatically detects technical domains from your keyword and searches only relevant sources. Network accessibility is detected silently in the background - if global sources are not accessible, the system automatically uses China sources only. Detection result is cached for 5 minutes.

**How it works**:
1. Silently detect network environment (cached for 5 minutes)
2. Filter sources by network accessibility (global vs China-only)
3. Analyze keyword (supports English and Chinese)
4. Detect technical domains (e.g., "Electron" → frontend, "ChatGPT" → AI, "web" → frontend via alias)
5. Search relevant sources + general sources
6. Rank by heat score and return results

**Examples** (assuming global network accessible):
- "**Electron 技术资讯**" → Detects: `{general, frontend}` → Searches: ~37 sources
- "**web development**" → Detects: `{general, frontend}` → Searches: ~37 sources (alias: "web" → frontend)
- "**前端框架**" → Detects: `{general, frontend}` → Searches: ~37 sources
- "**ChatGPT 最新消息**" → Detects: `{general, ai}` → Searches: ~30 sources
- "**ML models**" → Detects: `{general, ai}` → Searches: ~30 sources (alias: "ML" → ai)
- "**机器学习**" → Detects: `{general, ai}` → Searches: ~30 sources
- "**Docker 安全漏洞**" → Detects: `{general, devops, security}` → Searches: ~32 sources
- "**云计算**" → Detects: `{general, devops}` → Searches: ~28 sources (alias: "云" → devops)
- "**database optimization**" → Detects: `{general, backend}` → Searches: ~35 sources (merged: database → backend)
- "**运维自动化**" → Detects: `{general, devops}` → Searches: ~28 sources
- "**树莓派 IoT**" → Detects: `{general, hardware}` → Searches: ~23 sources
- "**OpenAI ChatGPT**" → Detects: `{general, ai}` → Searches: ~30 sources (company + product keywords)
- "**技术新闻**" (generic) → Detects: `{general}` → Searches: ~25 general sources only

**Network Adaptation** (completely transparent to user):
- 🌍 **Global accessible**: Uses all 75 sources
- 🇨🇳 **China-only network**: Automatically switches to 18 China sources (掘金, InfoQ中文站, 开源中国, 博客园, SegmentFault, V2EX, 36氪, 虎嗅, IT之家, 机器之心, 量子位, 钛媒体, 极客公园, 爱范儿, PingWest品玩, 少数派, 雷锋网, 阿里云开发者)
- ⚡ **Fast detection**: 3-second timeout with 5-minute cache
- 🔇 **Silent operation**: No user notification, completely seamless

To disable smart routing and search all available sources (respects network availability):
```bash
bash "$SKILLS_ROOT/technology-news-search/scripts/search-news.sh" "keyword" --all-sources
```

## Supported Technical Domains

The smart routing system recognizes keywords in these **9 core domains** (English and Chinese):

1. **Frontend/Web**: React, Vue, Angular, Electron, JavaScript, TypeScript, Webpack, Vite, Vercel, Netlify, JAMstack, MERN, 前端, 网页, 界面
2. **Backend**: Python, Go, Java, Rust, Node.js, Django, Flask, Spring, **MySQL, PostgreSQL, MongoDB, Redis** (databases merged), LAMP, LEMP, 后端, 服务器, API, 数据库, 存储
3. **Mobile**: Android, iOS, Flutter, React Native, Swift, Kotlin, 移动开发, 手机, App
4. **AI/ML**: AI, ChatGPT, LLM, **OpenAI, Anthropic, Google AI, DeepMind**, Machine Learning, PyTorch, TensorFlow, Copilot, 人工智能, 机器学习, 大模型, 百度, 阿里
5. **DevOps**: Docker, Kubernetes, CI/CD, Jenkins, Terraform, Ansible, **AWS, Azure, GCP, Cloud Computing** (cloud merged), HashiCorp, 运维, 部署, 云计算, 云服务, 阿里云, 腾讯云
6. **Hardware**: Arduino, Raspberry Pi, IoT, ESP32, 硬件, 物联网, 嵌入式
7. **Security**: Security, Vulnerability, CVE, Exploit, Encryption, 安全, 漏洞, 网络安全, 信息安全
8. **OS**: Linux, Windows, macOS, Kernel, Ubuntu, 操作系统, 内核, 系统
9. **Blockchain**: Ethereum, Bitcoin, Web3, Smart Contract, Solana, DeFi, NFT, 区块链, 加密货币, 比特币, 以太坊

**Domain Aliases** (auto-resolved):
- **"web", "网站"** → Frontend
- **"database", "db", "数据库", "存储"** → Backend
- **"cloud", "云", "云服务"** → DevOps
- **"ML", "machine-learning", "数据科学"** → AI
- **"ops", "SRE", "infrastructure"** → DevOps
- **"fe"** → Frontend
- **"be", "server", "服务端"** → Backend
- **"IoT", "embedded"** → Hardware
- **"infosec", "cybersecurity", "信息安全"** → Security

## Quick Start

When user asks: **"Search for Electron tech news"** or **"搜索 Electron 技术资讯"**

Execute:
```bash
bash "$SKILLS_ROOT/technology-news-search/scripts/search-news.sh" "Electron" --limit 15
```

The script will:
1. Detect domains: `{general, frontend}`
2. Search 26 relevant sources (13 general + 13 frontend)
3. Output JSON with articles ranked by heat score

Read the JSON and present results in Markdown format with translations.

## Workflow

1. **Extract keyword** from user query
   - English examples: "Search for OpenAI news", "Find articles about ChatGPT"
   - Chinese examples: "搜索 苹果 的科技新闻", "查找 AI 相关资讯"

2. **Run search script**
   ```bash
   bash "$SKILLS_ROOT/technology-news-search/scripts/search-news.sh" "[keyword]" --limit 15 --max-per-source 5

   # To search all sources (disable smart routing)
   bash "$SKILLS_ROOT/technology-news-search/scripts/search-news.sh" "[keyword]" --limit 15 --all-sources
   ```

   **Parameters:**
   - `--limit 15`: Fetch up to 15 articles from each source
   - `--max-per-source 5`: Display max 5 articles per source (ensures diversity)
   - `--no-balance`: Disable balancing (show all results sorted by heat)
   - `--all-sources`: Search all 75 sources (disable smart routing)

3. **Read JSON output**
   - Script outputs to stdout
   - Contains: keyword, total_found, search_time, results array
   - Each result has: title, summary, url, published_at, source, language, heat_score, duplicate_sources

4. **Translate English content**
   - For articles with `language: "en"`, translate title and summary to Chinese
   - Keep technical terms in English (AI, GPT, API, SDK, etc.)
   - Format: `English Title / 中文翻译`

5. **Format results by heat tier**
   - **🔥 Hot News (90+)**: Top stories appearing on multiple sources or very recent
   - **📈 Trending (60-89)**: Moderately popular or recent stories
   - **📰 Related (<60)**: Other relevant matches

6. **Present as Markdown**
   - See Output Format section below

## Source Balancing

**Default behavior:** The script limits each source to 5 articles to ensure diversity across different news sources.

**Why balancing matters:**
- Prevents single sources (like Hacker News) from dominating results
- Ensures exposure to different editorial perspectives
- Provides better coverage across international and Chinese sources

**Customization:**
```bash
# Show more articles per source
bash "$SKILLS_ROOT/technology-news-search/scripts/search-news.sh" "AI" --max-per-source 10

# Disable balancing (show all by heat score only)
bash "$SKILLS_ROOT/technology-news-search/scripts/search-news.sh" "AI" --no-balance
```

**How it works:**
1. Fetch articles from all sources (up to `--limit` per source)
2. Calculate heat scores for all articles
3. Sort by heat score (highest first)
4. Apply diversity filter: keep top `--max-per-source` from each source
5. Result: Balanced mix of high-quality articles from diverse sources

## Output Format

Present search results in this Markdown format:

```markdown
# 🔍 "[Keyword]" Technology News

> 📊 Found 12 articles from 7 sources
> 🕐 Search time: 2026-02-18 14:30

---

## 🔥 Hot News (Heat 90+)

### 1. OpenAI Announces GPT-5 Release Date / OpenAI 宣布 GPT-5 发布日期
**Source**: TechCrunch | **Published**: 2h ago | **Heat**: ⭐⭐⭐⭐⭐ (95)

**Summary**: OpenAI CEO Sam Altman revealed that GPT-5 will launch in Q2 2026... / OpenAI CEO Sam Altman 透露 GPT-5 将在 2026 年第二季度推出...

🔗 [Read more](https://techcrunch.com/2026/02/18/openai-gpt5)

*💡 Also on: The Verge, Wired, MIT Tech Review*

---

### 2. GPT-5 性能测试曝光：超越人类专家水平
**Source**: 机器之心 | **Published**: 5h ago | **Heat**: ⭐⭐⭐⭐ (88)

**Summary**: 据可靠消息源透露，GPT-5 在多项基准测试中已超越人类专家水平...

🔗 [Read more](https://jiqizhixin.com/articles/2026-02-18-gpt5)

---

## 📈 Trending News (Heat 60-89)

### 3. [Title] / [Translation]
...

## 📰 Related News (Heat <60)

### 10. [Title]
...
```

**Format Notes:**
- Group by heat score tiers (Hot 90+, Trending 60-89, Related <60)
- Always translate English content to Chinese
- Include source attribution and publish time
- Show duplicate sources with "Also on: ..." line
- Use star ratings for heat visualization (5 stars = 90-100, 4 stars = 70-89, etc.)
- Provide clickable links to original articles

## Source Configuration

Sources are configured in [references/sources.json](references/sources.json).

To enable/disable sources: Edit the JSON file and set `"enabled": true/false`.

To add new sources: Add entry to sources array with required fields (id, name, url, type, language, category).

The heat score (0-100) combines multiple factors:

- **Multi-source bonus**: +20 per duplicate source (same story on multiple sites)
- **Time decay**:
  - 24h or less: +40 points (very fresh)
  - 24-48h: +28 points (recent)
  - 48-72h: +16 points (somewhat recent)
  - 72h+: +8 points (older)
- **Keyword match quality**:
  - Exact title match: +30
  - Partial title match: +15
  - Summary match: +5
- **HN engagement**: +1 per 10 points (max +20)
- **Reddit engagement**: +1 per 10 upvotes (max +20, NEW)
- **Official source bonus**: +10 (for official blogs, NEW)
- **Base score**: 20

Articles appearing on multiple sources rank higher, indicating broader industry interest. Official blog posts from React, Vue, Docker, etc. get priority. Reddit posts with high upvotes get boosted.

## Notes

- **Always translate**: English titles and summaries should have Chinese translations
- **Preserve technical terms**: Keep AI, GPT, API, SDK, LLM, etc. in English
- **Clean presentation**: Use Markdown only, no complex HTML artifacts
- **Cross-reference duplicates**: Show which sources covered the same story
- **Keyword matching**: Script searches in both titles and summaries across all languages

## Troubleshooting

**No results found:**
- Try broader keywords (e.g., "AI" instead of "GPT-5 benchmarks")
- Check if sources are accessible (firewall/network issues)
- Verify sources are enabled in [references/sources.json](references/sources.json)

**Script errors:**
- Ensure Node.js is available or LobsterAI Electron is running
- Check network connectivity
- Review stderr output for specific error messages
- Some sources may be temporarily unavailable

**Slow performance:**
- Reduce `--limit` parameter (default is 15)
- Disable some sources in references/sources.json
- Network speed affects RSS fetching time
