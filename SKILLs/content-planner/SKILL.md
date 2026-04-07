---
name: content-planner
description: |
  WeChat Official Account topic planning and content calendar management. Based on WeChat article search and trending analysis,
  generates differentiated topic recommendations and outputs structured content calendars. Activated when users mention
  "topic", "planning", "content calendar", "trending", or "what to write next week".
official: true
---

# Topic Planning + Content Calendar

## Use Cases

- User says "帮我规划下周公众号内容"
- User says "最近有什么热门选题可以写"
- User says "帮我做一份内容日历"
- User wants to know what competitor accounts are writing about
- Need to make topic decisions based on data

## Dependencies

Node.js + cheerio (install once):

```bash
npm install -g cheerio
```

## Script Directory

| Script | Purpose | Usage |
|--------|---------|-------|
| `scripts/wechat_search.js` | Sogou WeChat article search | `node "$SKILLS_ROOT/content-planner/scripts/wechat_search.js" "keyword"` |

### Search Script Parameters

**IMPORTANT:** Always use the `$SKILLS_ROOT` environment variable to locate scripts.

```bash
# Basic search
node "$SKILLS_ROOT/content-planner/scripts/wechat_search.js" "keyword"

# Limit result count
node "$SKILLS_ROOT/content-planner/scripts/wechat_search.js" "keyword" -n 15

# Save to file
node "$SKILLS_ROOT/content-planner/scripts/wechat_search.js" "keyword" -n 20 -o result.json

# Parse real URLs (extra network requests, may be blocked by anti-scraping)
node "$SKILLS_ROOT/content-planner/scripts/wechat_search.js" "keyword" -n 5 -r
```

**Output Fields:** Article title, article URL, article summary, publish time, source account name

## Workflow

### Step 1: Clarify Planning Scope

Confirm the following information with the user (ask all at once):

```
帮你规划内容，先确认几件事：

1. 规划周期？（本周 / 下周 / 自定义时间范围）
2. 有没有特定想写的方向或关键词？
3. 每周几篇？（默认3篇）
```

### Step 2: Trending Scan

Execute multiple rounds of searches covering different dimensions:

**Search Strategy:**

1. **Core domain keyword search** — Search with 2-3 core keywords related to the account's field
2. **User-specified keyword search** — If user has specific directions
3. **General trending search** — Search with combinations of "热点", "热门", "最新" with domain keywords

```bash
# Example: Tech domain
node "$SKILLS_ROOT/content-planner/scripts/wechat_search.js" "AI 最新趋势" -n 10
node "$SKILLS_ROOT/content-planner/scripts/wechat_search.js" "大模型应用" -n 10
node "$SKILLS_ROOT/content-planner/scripts/wechat_search.js" "科技热点 2026" -n 10
```

Wait 3-5 seconds between each search to avoid triggering anti-scraping mechanisms.

### Step 3: Competitor Analysis

Extract from search results:

| Analysis Dimension | Extracted Content |
|-------------------|-------------------|
| Title Strategy | Which title patterns get high engagement |
| Topic Direction | Which directions are recent hot topics |
| Content Angle | What angles do existing articles take, how to differentiate |
| Publish Time | Competitors' publishing frequency and timing |

### Step 4: Generate Topic Recommendations

Based on trending data and competitor analysis, generate 5-10 topic suggestions. Each topic must include:

- **Alternative Titles** (2 styles)
- **Target Audience**
- **Content Angle** (differentiation point)
- **Recommended Style**: deep-analysis / practical-guide / story-driven / opinion / news-brief
- **Urgency**: 🔥 Urgent / 📅 This week / 📦 Reserve
- **Reference Articles** (from search results)

**Topic Quality Requirements:**
- Each topic must be based on real search data, not fabricated
- Each topic must have a clear differentiation angle
- Must include at least 1 high-urgency topic (🔥) and 2 reserve topics (📦)

### Step 5: User Approval

**This is a mandatory approval gate and cannot be skipped.**

Present the topic list and ask user to select, adjust, and schedule.

### Step 6: Generate Content Calendar

Output `content_calendar.json`:

```json
{
  "week": "2026-W13",
  "created_at": "2026-03-25",
  "articles": [
    {
      "id": 1,
      "date": "2026-03-26",
      "day": "Wednesday",
      "topic": "Topic Title",
      "angle": "Differentiation Angle",
      "style": "deep-analysis",
      "audience": "Target Audience",
      "urgency": "this-week",
      "status": "planned",
      "keywords": ["keyword1", "keyword2"]
    }
  ]
}
```

### Step 7: Output Confirmation

Present a summary table and prompt user to start writing with article-writer skill.

## Search Considerations

- Search results may be empty (anti-scraping), retry with different keywords
- Multiple searches in short time may trigger restrictions, recommend 3-5 second intervals
- The `-r` parameter for parsing real URLs has low success rate, avoid unless necessary

## Integration with Other Skills

- The generated `content_calendar.json` is the input source for **article-writer**
- article-writer reads entries with status `planned` from the calendar
