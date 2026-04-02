---
name: daily-trending
description: >-
  Fetch today's trending topics from tophub.today across multiple platforms.
  Triggered when users ask "what's trending today", "hot topics", "今日热搜", or "微博热搜".
official: true
---

# Daily Trending

Fetch today's trending topics by scraping data from various platforms via tophub.today.

## Data Collection

### Multi-Platform Trending Lists

Fetch trending lists from the following platforms on tophub.today:
- Zhihu Hot List: `/n/mproPpoq6O`
- Weibo Trending: `/n/KqndgxeLl9`
- Baidu Real-time Hot Topics: `/n/Jb0vmloB1G`
- 36Kr 24-Hour Hot List: `/n/Q1Vd5Ko85R`
- Huxiu Hot Articles: `/n/5VaobgvAj1`
- The Paper Hot List: `/n/wWmoO5Rd4E`

### Fetching Strategy

**To avoid context overflow, fetch in batches with character limits!**

**Option A: Core Platforms First (Recommended)**

Use web-search skill or web_fetch to fetch only 2-3 core platforms:

```
web_fetch("https://tophub.today/n/KqndgxeLl9")  # Weibo
web_fetch("https://tophub.today/n/mproPpoq6O")  # Zhihu
web_fetch("https://tophub.today/n/Jb0vmloB1G")  # Baidu
```

**Fetching Priority:**
1. Prioritize Weibo + Zhihu + Baidu (covers 90% of hot topics)
2. Only fetch other platforms if suitable topics are not found in these 3
3. Fetch one platform at a time, filter immediately, then decide whether to fetch the next

### Filtering Criteria

From all platform trending lists, filter out **truly important topics**:

**Include:**
- Major Events: Significant policies, international relations, social events
- Hot Discussion Topics: Topics that spark widespread discussion
- Factual Content: Keep the events themselves without commentary

**Exclude:**
- Headlines with subjective commentary
- Pure entertainment gossip
- Obvious promotional content
- Emotional expressions

**Output Requirements:**
- Each news item must be complete with clear beginning and end
- Describe events like news headlines
- Avoid single words or incomplete fragments

## Output Format

Output only the 5 most valuable items:

```
======

🔥 今日热搜（3月25日）

1. [完整新闻标题1]
2. [完整新闻标题2]
3. [完整新闻标题3]
4. [完整新闻标题4]
5. [完整新闻标题5]

======
```

Notes:
- Each news item should be complete with clear beginning and end
- No source attribution needed
- Facts only, exclude subjective commentary
- Output only the required content, no extra text
