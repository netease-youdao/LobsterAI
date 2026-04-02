---
name: article-writer
description: |
  Multi-style article creation skill. Supports 5 writing styles (deep analysis, practical guide, story-driven, opinion, news brief),
  including complete workflow: material collection → outline → content → formatting. Activated when users mention "write article", "write post", "create", or "draft".
official: true
---

# Multi-Style Article Creation

## Use Cases

- User says "写一篇关于XX的文章"
- User says "帮我写一篇公众号文章"
- User selects a topic from the content calendar to start writing
- User specifies a writing style (e.g., "深度分析风格", "写个教程")

## 5 Writing Styles

| Style ID | Name | Characteristics | Word Count | Use Cases |
|----------|------|-----------------|------------|-----------|
| `deep-analysis` | 深度分析 | Rigorous structure, data-backed | 2000-4000 words | Trend analysis, in-depth reporting |
| `practical-guide` | 实用指南 | Clear steps, highly actionable | 1500-3000 words | Tool tutorials, how-to guides |
| `story-driven` | 故事驱动 | Conversational, emotional resonance | 1500-2500 words | Personal stories, case reviews |
| `opinion` | 观点评论 | Sharp opening, pros/cons argumentation | 1000-2000 words | Hot takes, controversial topics |
| `news-brief` | 新闻简报 | Inverted pyramid, fact-focused | 500-1000 words | Breaking news, information roundups |

## Workflow

### Step 1: Read the Brief

Obtain topic information from:
1. Entries with status `planned` in `content_calendar.json`
2. Topic description directly provided by the user

Extract key information:
- Topic direction / title
- Target audience
- Writing style (if not specified, recommend based on topic content)
- Reference material URLs

### Step 2: Determine Writing Style

If user hasn't specified, recommend based on topic:

| Topic Characteristics | Recommended Style |
|----------------------|-------------------|
| Involves data, trends, underlying causes | `deep-analysis` |
| "How to", "tutorial", "steps" | `practical-guide` |
| Involves people, experiences, insights | `story-driven` |
| Involves controversy, hot topic commentary | `opinion` |
| Breaking events, quick information | `news-brief` |

Confirm the style choice with the user.

### Step 3: Material Collection

Use content-planner's search script to collect reference materials:

```bash
node "$SKILLS_ROOT/content-planner/scripts/wechat_search.js" "topic keywords" -n 10
```

Also use web-search skill for additional materials.

Organize material list:
- Citable data/statistics
- Reference cases/stories
- Facts that need verification

### Step 4: Generate Outline

Generate an outline based on the selected style using the corresponding structure template.

#### deep-analysis Template

```
## 引入 (200-300字) — 反直觉数据/现象开头
## 背景 (300-500字) — 事件/现象的来龙去脉
## 分析维度1 (400-600字) — 核心论点 + 数据支撑
## 分析维度2 (400-600字) — 对比/反面论证
## 分析维度3 (400-600字) — 深层原因 + 影响预测
## 总结与展望 (200-300字) — 核心观点 + CTA
```

#### practical-guide Template

```
## 开头 (100-200字) — 痛点共鸣 + 承诺
## 前置准备 (200-300字)
## 步骤1 (300-500字) — 具体操作 + 常见坑
## 步骤2 (300-500字) — 具体操作 + 关键参数
## 步骤3 (300-500字) — 具体操作 + 验证方法
## 进阶技巧 (200-300字)
## 总结 (100-200字) — FAQ + CTA
```

#### story-driven Template

```
## 开头 (150-200字) — 场景切入 + 悬念
## 背景铺垫 (200-300字) — 人物/背景/冲突
## 转折1 (300-400字) — 关键事件 + 感受
## 转折2 (300-400字) — 新尝试 + 结果
## 高潮 (200-300字) — 核心洞察
## 结尾 (150-200字) — 启发 + CTA
```

#### opinion Template

```
## 锐利开头 (100-150字) — 直接亮观点
## 现象描述 (200-300字) — 主流观点
## 正面论证 (300-400字) — 我的论点 + 数据
## 反面回应 (200-300字) — 预设反驳 + 反驳
## 深度思考 (200-300字) — 本质 + 影响
## 总结 (100-150字) — 重申观点 + CTA
```

#### news-brief Template

```
## 核心信息 (100-200字) — What/When/Where/Who
## 事件详情 (200-300字)
## 背景 (100-200字)
## 反应 (100-200字)
## 编者按 (50-100字)
```

### Step 5: User Approval of Outline

**This is a mandatory approval gate and cannot be skipped.**

Present the outline to the user and ask for confirmation or modification requests.

### Step 6: Write the Content

After approval, write content paragraph by paragraph following the outline.

**Universal Writing Rules:**

1. **Use stories instead of preaching**
   - ❌ "风险管理很重要，应该做应急预案"
   - ✅ "去年，我的创业团队差点因为一个核心员工离职而崩溃，因为我们没有任何备选方案。"

2. **Use analogies and metaphors**
   - ❌ "分布式系统很复杂"
   - ✅ "分布式系统就像连锁餐厅——每个分店需要协作，同时又要独立运营。"

3. **Support with data but don't pile it on**
   - ❌ "据IDC报告，全球AI市场2023年增长45%，预计2025年达1000亿美元..."
   - ✅ "AI市场疯狂增长——每年翻一番。但在增长背后，真正赚钱的公司不到5家。"

4. **State opinions directly, avoid ambiguity**
   - ❌ "有人认为...也有人认为...各有道理"
   - ✅ "说实话，我认为XX的做法是错的，因为..."

5. **Use short sentences and line breaks**

**Data integrity rules:**
- If specific data is needed but uncertain, mark `[数据待确认]` and confirm with user
- Use search tools to verify key facts
- Can tell fictional stories using "我见过..." or "一个朋友...", but don't fabricate data

### Step 7: Formatting Optimization

**WeChat Formatting Hard Rules:**

1. **Paragraphs no more than 4 lines** (mobile screen visible range)
2. **Insert a subheading or bold sentence every 3-4 paragraphs**
3. **Must have a hook within the first 3 lines** (question, data, story, counter-intuitive viewpoint)
4. **Must have a clear CTA at the end** (follow/share/comment prompt)

**Markdown Formatting Standards:**
- No first-line indentation, use blank lines to separate paragraphs
- Maximum 2 heading levels (`##`), no deep nesting
- Bold only the 1-2 most important words per paragraph
- Use quotes for data, golden sentences, or important viewpoints
- Lists maximum 5 items

### Step 8: Output Draft

Save the article as Markdown:

Filename format: `drafts/YYYYMMDD_[topic-slug].md`

```markdown
---
title: Article Title
date: YYYY-MM-DD
style: deep-analysis
summary: Article summary (within 100 words)
---

## Opening

Content...
```

### Step 9: Quality Checklist

```
✅ Title — Sparks curiosity or resonance
✅ Opening — First 100 words are engaging
✅ Body — Has 2-3 clear viewpoints
✅ Cases — Uses stories not preaching
✅ Formatting — Easy to read (short paragraphs, bold, subheadings)
✅ Word Count — Within style-specified range
✅ CTA — Ending has action prompt
```

## Title Optimization Process

### Step 1: Generate 10 Candidate Titles

Use these psychological strategies:

| Strategy | Description | Example |
|----------|-------------|---------|
| Suspense | Spark curiosity | "为什么我放弃了年薪50万的工作" |
| Benefit | Clarify reader gains | "掌握这3个技巧，效率提升200%" |
| Pain Point | Hit reader anxiety | "别让这个习惯毁了你的职业生涯" |
| Numbers | Specific and tangible | "50%的人都误解了这个真相" |
| Rhetorical | Stimulate thinking | "你真的了解AI吗？" |
| Contrast | Create contrast | "BAT vs 创业公司：差别在哪" |

### Step 2: Score and Filter

Score on 3 dimensions (Attractiveness 40%, Shareability 30%, SEO 30%) and present top 3 to user.

## Integration with Other Skills

- **Upstream**: content-planner's `content_calendar.json` provides topic input
- **Downstream**: Markdown files in drafts/ can be further processed
