---
name: web-search
description: Real-time web search using Playwright-controlled browser. Use this skill when you need current information, latest documentation, recent news, or any data beyond your knowledge cutoff (January 2025).
official: true
---

# Web Search Skill

## When to Use This Skill

Use the web-search skill when you need:

- **Current information** - Events, news, or data after January 2025
- **Latest documentation** - Up-to-date framework/library docs (React 19, Next.js 15, etc.)
- **Real-time data** - Stock prices, weather, sports scores, etc.
- **Fact verification** - Check current status of projects, companies, or technologies
- **Recent discussions** - Community opinions, GitHub issues, Stack Overflow answers
- **Product comparisons** - Latest reviews and comparisons
- **Troubleshooting** - Search for specific error messages or solutions

**Examples of when to use:**
- User: "What are the new features in React 19?"
- User: "Search for the latest Next.js App Router documentation"
- User: "What's the current status of the Rust async project?"
- User: "Find recent discussions about Vue 3 performance"

## How It Works

```
┌──────────┐    Bash    ┌─────────┐    HTTP    ┌──────────────┐    CDP    ┌────────┐
│  Claude  │───────────▶│ CLI.sh  │───────────▶│ Bridge Server│──────────▶│ Chrome │
│          │            │         │            │ (localhost)  │ Playwright│        │
└──────────┘            └─────────┘            └──────────────┘            └────────┘
                                                      │
                                                  ▼
                                             Google/Bing Search
                                                Extract Results
```

**Architecture:**
1. **CLI Script** - Simple bash interface for Claude
2. **Bridge Server** - Express HTTP API (auto-started by Electron)
3. **Playwright Manager** - Browser connection and session management
4. **Search Engine Layer** - Google primary, Bing fallback
5. **Chrome Browser** - Visible browser window (all operations transparent)

## Basic Usage

### Simple Search (Recommended)

**IMPORTANT:** Always use the `$SKILLS_ROOT` environment variable to locate the skill scripts. This ensures the skill works in both development and production environments.

```bash
bash "$SKILLS_ROOT/web-search/scripts/search.sh" "search query" [max_results]
```

For non-ASCII queries (Chinese/Japanese/etc.), prefer UTF-8 file input to avoid shell encoding issues on Windows:

```bash
cat > /tmp/web-query.txt <<'TXT'
苹果 Siri AI 2026 发布计划
TXT

bash "$SKILLS_ROOT/web-search/scripts/search.sh" @/tmp/web-query.txt 10
```

**Examples:**

```bash
# Search with default 10 results
bash "$SKILLS_ROOT/web-search/scripts/search.sh" "TypeScript 5.0 new features"

# Limit to 5 results
bash "$SKILLS_ROOT/web-search/scripts/search.sh" "React Server Components guide" 5

# Search for recent news
bash "$SKILLS_ROOT/web-search/scripts/search.sh" "AI news January 2026" 10
```

**Output Format:**

The script returns Markdown-formatted results:

```markdown
# Search Results: TypeScript 5.0 new features

**Query:** TypeScript 5.0 new features
**Results:** 5
**Time:** 834ms

---

## TypeScript 5.0 Release Notes

**URL:** [https://www.typescriptlang.org/docs/...]

TypeScript 5.0 introduces decorators, const type parameters...

---

## (More results...)
```

### Workflow Example

```bash
# 1. Search for topic
bash "$SKILLS_ROOT/web-search/scripts/search.sh" "Next.js 14 features" 5

# 2. Analyze results and answer user

# 3. Follow-up search if needed
bash "$SKILLS_ROOT/web-search/scripts/search.sh" "Next.js Server Actions tutorial" 3
```

## Advanced Usage

### Server Management

The Bridge Server is **automatically managed** by Electron. You typically don't need to start/stop it manually.

However, for manual control:

```bash
# Start server (if not already running)
bash "$SKILLS_ROOT/web-search/scripts/start-server.sh"

# Stop server
bash "$SKILLS_ROOT/web-search/scripts/stop-server.sh"

# Check health (start script will print endpoint status)
bash "$SKILLS_ROOT/web-search/scripts/start-server.sh"
```

### Direct API Calls

For advanced use cases, you can call the HTTP API directly:

```bash
# Get or create connection
CONNECTION_ID=$(curl -s -X POST http://127.0.0.1:8923/api/browser/connect \
  -H "Content-Type: application/json" \
  -d '{}' | grep -o '"connectionId":"[^"]*"' | cut -d'"' -f4)

# Perform search
curl -X POST http://127.0.0.1:8923/api/search \
  -H "Content-Type: application/json" \
  -d "{
    \"connectionId\": \"$CONNECTION_ID\",
    \"query\": \"Playwright tutorial\",
    \"maxResults\": 5
  }"

# Navigate to specific URL
curl -X POST http://127.0.0.1:8923/api/page/navigate \
  -H "Content-Type: application/json" \
  -d "{
    \"connectionId\": \"$CONNECTION_ID\",
    \"url\": \"https://example.com\"
  }"

# Take screenshot
curl -X POST http://127.0.0.1:8923/api/page/screenshot \
  -H "Content-Type: application/json" \
  -d "{
    \"connectionId\": \"$CONNECTION_ID\",
    \"format\": \"png\"
  }"
```

## Best Practices

### 1. Use Specific Queries

❌ Bad: `bash scripts/search.sh "react"`
✅ Good: `bash scripts/search.sh "React 19 new features and breaking changes"`

### 2. Limit Results Appropriately

- Quick lookup: 3-5 results
- Comprehensive research: 10 results
- Don't request more than needed (faster + less noise)

### 3. Check Server Status First

If search fails, verify the server is running:

```bash
bash "$SKILLS_ROOT/web-search/scripts/start-server.sh" || echo "Server not running"
```

### 4. Reuse Connections

The CLI script automatically caches connections. Multiple searches in the same session will reuse the same browser connection for better performance.

### 5. Clean Output

Parse the Markdown output to extract key information for the user. Don't just dump all results - synthesize and summarize.

## Common Patterns

### Pattern 1: Latest Documentation

```bash
# User asks about latest framework features
bash SKILLs/web-search/scripts/search.sh "Next.js 15 documentation" 5

# Parse results, find official docs, summarize features
```

### Pattern 2: Troubleshooting

```bash
# User reports an error
bash SKILLs/web-search/scripts/search.sh "TypeError: Cannot read property of undefined React" 5

# Find Stack Overflow answers and GitHub issues, provide solution
```

### Pattern 3: Current Events

```bash
# User asks about recent news
bash SKILLs/web-search/scripts/search.sh "AI developments January 2026" 10

# Summarize key news items from results
```

### Pattern 4: Comparison Research

```bash
# User wants to compare technologies
bash SKILLs/web-search/scripts/search.sh "Vue 3 vs React 18 performance 2026" 5

# Synthesize comparison from multiple sources
```

### Pattern 5: API/Library Usage

```bash
# User needs specific API documentation
bash SKILLs/web-search/scripts/search.sh "Playwright page.evaluate examples" 5

# Extract code examples and usage patterns
```

## Error Handling

### Server Not Running

**Error:** `✗ Bridge Server is not running`

**Solution:**
- The server should auto-start with Electron
- If manual start needed: `bash SKILLs/web-search/scripts/start-server.sh`
- Check logs: `cat SKILLs/web-search/.server.log`

### Browser Launch Failed

**Error:** `Failed to launch browser`

**Cause:** Chrome not installed or not found

**Solution:**
- macOS: Install from https://www.google.com/chrome/
- Linux: `sudo apt install chromium-browser`
- Windows: Install from https://www.google.com/chrome/

### Connection Timeout

**Error:** `CDP port not ready` or `Connection timeout`

**Solution:**
```bash
# Stop server
bash SKILLs/web-search/scripts/stop-server.sh

# Clear cache
rm SKILLs/web-search/.connection

# Restart
bash SKILLs/web-search/scripts/start-server.sh
```

### No Search Results

**Error:** `Found 0 results`

**Possible causes:**
- Query too specific or unusual
- Bing changed page structure (rare)
- Network issues

**Solution:**
- Try broader query
- Check internet connection
- Verify page loads manually at bing.com

### Search Timeout

**Error:** `Search failed: timeout`

**Solution:**
- Check internet connection
- Reduce max results
- Try again (might be temporary network issue)

## Understanding Results

### Result Structure

Each search result contains:

```markdown
## [Title of Result]

**URL:** [https://example.com/page]

[Snippet/description from search results]
```

**Fields:**
- **Title** - Page/article title
- **URL** - Direct link (may include Bing tracking)
- **Snippet** - Preview text from the page

### Parsing Results

The search output is Markdown. Extract:
1. Total results count
2. Search duration
3. Individual result titles and URLs
4. Snippets for context

### Result Quality

- **Official docs** - Usually appear in top 3 results
- **Stack Overflow** - Appears for technical questions
- **Recent articles** - Bing prioritizes recent content
- **Chinese content** - Bing works well in China, includes Chinese sources

## Performance Considerations

### Typical Latencies

- Server startup: ~2 seconds (one-time, auto-started)
- Browser launch: ~3 seconds (one-time per session)
- First search: ~2-3 seconds (includes browser connection)
- Subsequent searches: ~1 second (connection cached)

### Optimization Tips

1. **Reuse connections** - The CLI script caches connections automatically
2. **Limit results** - Request only what you need (5-10 is usually enough)
3. **Batch searches** - If multiple searches needed, do them consecutively to reuse connection
4. **Specific queries** - More specific = faster and better results

## Security and Privacy

### Security Measures

- **Localhost only** - Bridge Server binds to 127.0.0.1 (no external access)
- **No network exposure** - Not accessible from other machines
- **Isolated browser** - Uses separate Chrome profile, won't affect user's main browser
- **Visible operations** - All browser actions shown in visible window (transparent)
- **No credentials** - Skill never handles passwords or sensitive data

### Privacy Considerations

- Search queries go through Google and/or Bing depending on availability
- Google/Bing may track searches (their standard privacy policies apply)
- No local storage of search history by the skill
- User can observe all browser activity in real-time

## Limitations

### Current Limitations

1. **No CAPTCHA handling** - If Google or Bing shows CAPTCHA, user must solve manually
2. **Engine availability varies by network/region** - Auto mode falls back between Google and Bing
3. **English/Chinese focus** - Optimized for English and Chinese results
4. **Basic extraction** - Extracts titles and snippets, not full page content
5. **No authentication** - Cannot search pages requiring login

### Not Suitable For

- Searches requiring authentication
- Filling out forms or submitting data
- Actions requiring CAPTCHA solving (unless user manually solves)
- Mass scraping or automated bulk searches
- Accessing pages behind paywalls

## Troubleshooting Guide

### Quick Diagnostics

```bash
# 1. Check server health
curl http://127.0.0.1:8923/api/health

# 2. Check server logs
cat SKILLs/web-search/.server.log | tail -50

# 3. Test basic search
bash SKILLs/web-search/scripts/search.sh "test" 1

# 4. Check Chrome installation
which google-chrome || which chromium || which chromium-browser
```

### Common Issues

| Issue | Symptom | Solution |
|-------|---------|----------|
| Server down | `Connection refused` | Start server or restart Electron |
| Browser missing | `Chrome not found` | Install Chrome/Chromium |
| Port conflict | `Address already in use` | Stop conflicting process on port 8923 |
| Stale connection | `Connection not found` | Remove `.connection` cache file |
| Network issue | `Search timeout` | Check internet connection |

### Reset Everything

If all else fails, full reset:

```bash
cd SKILLs/web-search

# Stop server
bash scripts/stop-server.sh

# Clean cache and state
rm -f .connection .server.pid .server.log

# Rebuild
npm run build

# Restart
bash scripts/start-server.sh

# Test
bash scripts/search.sh "test" 1
```

## Examples for Claude

### Example 1: User Asks About Latest Framework

**User:** "What are the new features in Next.js 15?"

**Claude's approach:**
```bash
# Search for Next.js 15 features
bash "$SKILLS_ROOT/web-search/scripts/search.sh" "Next.js 15 new features" 5
```

**Then:** Parse results, identify official Next.js blog/docs, summarize key features for user.

### Example 2: Troubleshooting Error

**User:** "I'm getting 'Cannot find module' error in TypeScript"

**Claude's approach:**
```bash
# Search for the specific error
bash "$SKILLS_ROOT/web-search/scripts/search.sh" "TypeScript Cannot find module error solution" 5
```

**Then:** Extract solutions from Stack Overflow results, provide step-by-step fix.

### Example 3: Current Events

**User:** "What happened in AI this month?"

**Claude's approach:**
```bash
# Search for recent AI news
bash "$SKILLS_ROOT/web-search/scripts/search.sh" "AI news January 2026" 10
```

**Then:** Synthesize news from multiple sources, provide summary of key events.

### Example 4: Documentation Lookup

**User:** "How do I use React Server Components?"

**Claude's approach:**
```bash
# Search for RSC documentation and tutorials
bash "$SKILLS_ROOT/web-search/scripts/search.sh" "React Server Components guide tutorial" 5
```

**Then:** Find official React docs and good tutorials, explain with examples.

### Example 5: Comparison Research

**User:** "Should I use Vite or webpack in 2026?"

**Claude's approach:**
```bash
# Search for recent comparisons
bash "$SKILLS_ROOT/web-search/scripts/search.sh" "Vite vs webpack 2026 comparison" 5
```

**Then:** Analyze multiple perspectives, provide balanced recommendation.

## Tips for Effective Use

1. **Be specific in queries** - Include version numbers, dates, or specific aspects
2. **Parse results carefully** - Don't just copy-paste, synthesize information
3. **Verify with multiple sources** - Cross-check important information
4. **Cite sources** - Tell user which sources you're using
5. **Explain limitations** - If search doesn't find good results, tell user
6. **Use follow-up searches** - One search might not be enough, do multiple if needed
7. **Check result dates** - Prefer recent articles for current info
8. **Look for official sources** - Prioritize official docs and authoritative sources

## Technical Details

### Technologies Used

- **Playwright Core** - Browser automation framework
- **Chrome DevTools Protocol** - Low-level browser control
- **Express.js** - HTTP API server
- **Google + Bing Search** - Multi-engine fallback search strategy
- **Bash Scripts** - Simple CLI interface

### System Requirements

- Node.js 18+
- Google Chrome or Chromium installed
- Internet connection for searches
- ~100MB RAM for Bridge Server
- ~200MB RAM for Chrome instance

### File Locations

- Server: `SKILLs/web-search/dist/server/index.js`
- Logs: `SKILLs/web-search/.server.log`
- PID: `SKILLs/web-search/.server.pid`
- Connection cache: `SKILLs/web-search/.connection`

## Additional Resources

- **Full documentation:** `SKILLs/web-search/README.md`
- **Usage examples:** `SKILLs/web-search/examples/basic-search.md`
- **API reference:** See README.md for complete API documentation
- **Troubleshooting:** See examples/basic-search.md

## Support

For issues:
1. Check `.server.log` for errors
2. Run basic test: `node SKILLs/web-search/scripts/test-basic.js`
3. Verify Chrome installation
4. Check internet connection
5. Review troubleshooting section above

---

**Remember:** This skill provides real-time access to current information. Use it whenever users need information beyond your knowledge cutoff or when accuracy of current data is important.
