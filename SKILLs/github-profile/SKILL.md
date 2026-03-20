---
name: github-profile
description: Query GitHub user profiles, repository information, stars, and activity stats. Use when user asks about GitHub users, their repositories, contribution activity, or repo statistics.
official: true
version: 1.0.0
---

# GitHub Profile Skill

## When to Use This Skill

Use this skill when the user asks about:

- GitHub user profiles and their information
- Repository statistics (stars, forks, issues)
- User contribution activity
- Repository language statistics
- Organization information
- GitHub trending repos or users

## How It Works

This skill uses the GitHub REST API via `curl`. No `gh` CLI required.

### API Base URL

```
https://api.github.com
```

### Authentication

For higher rate limits (5000 requests/hour vs 60/hour), use a GitHub token:

```bash
# Check for token in environment
echo $GITHUB_TOKEN

# If not set, try to get from LobsterAI config
# The skill will work without token but with lower rate limits
```

## User Profile

### Get User Information

```bash
# Basic user info
curl -s "https://api.github.com/users/{username}"

# Response includes: login, name, bio, company, location, blog, 
# public_repos, followers, following, created_at, etc.
```

### Example: Get User Profile

```bash
curl -s "https://api.github.com/users/openai" | jq '{login, name, company, location, public_repos, followers}'
```

### Get User Repositories

```bash
# List user's repos (sorted by updated)
curl -s "https://api.github.com/users/{username}/repos?sort=updated&per_page=10"

# Get repo details
curl -s "https://api.github.com/repos/{owner}/{repo}"
```

## Repository Information

### Get Repository Stats

```bash
curl -s "https://api.github.com/repos/{owner}/{repo}" | jq '{name, stars: .stargazers_count, forks: .forks_count, open_issues: .open_issues_count, language, description}'
```

### List Repository Contents

```bash
curl -s "https://api.github.com/repos/{owner}/{repo}/contents"
```

### Get Repository Languages

```bash
curl -s "https://api.github.com/repos/{owner}/{repo}/languages"
```

Returns: `{"JavaScript": 12345, "TypeScript": 6789, ...}`

## Contribution Activity

### Get User Events

```bash
curl -s "https://api.github.com/users/{username}/events?per_page=30"
```

### Get Contribution Stats

```bash
curl -s "https://api.github.com/users/{username}/stats/contributions"
```

## Search

### Search Repositories

```bash
curl -s "https://api.github.com/search/repositories?q={query}&sort=stars&per_page=5"
```

### Search Users

```bash
curl -s "https://api.github.com/search/users?q={query}&per_page=5"
```

## Rate Limits

| Type | Without Token | With Token |
|------|---------------|------------|
| Requests/hour | 60 | 5000 |
| Search requests | 10 | 30 |

## Error Handling

### Rate Limited

If you get a 403 error:
```
"API rate limit exceeded"
```

Wait and retry, or suggest user provides a GitHub token.

### Not Found

If user/repo doesn't exist:
```
"Not Found"
```

## Usage Examples

### Example 1: Get User Profile

**User asks:** "What's openai's GitHub profile?"

```bash
curl -s "https://api.github.com/users/openai" | jq '{login, name, bio, public_repos, followers, following}'
```

### Example 2: Get Repository Info

**User asks:** "How many stars does OpenClaw have?"

```bash
curl -s "https://api.github.com/repos/openclaw/openclaw" | jq '{name, stars: .stargazers_count, forks: .forks_count}'
```

### Example 3: Find Popular Repos

**User asks:** "What are the most popular JavaScript frameworks?"

```bash
curl -s "https://api.github.com/search/repositories?q=javascript+stars:>10000&sort=stars&per_page=5" | jq '.items[] | {name: .full_name, stars: .stargazers_count}'
```

### Example 4: User's Recent Activity

**User asks:** "What has OpenAI been working on recently?"

```bash
curl -s "https://api.github.com/users/openai/events?per_page=10" | jq '.[] | {type: .type, repo: .repo.name, created_at}'
```

### Example 5: Repository Languages

**User asks:** "What language is OpenClaw written in?"

```bash
curl -s "https://api.github.com/repos/openclaw/openclaw/languages"
```

## Best Practices

1. **Use `jq` for JSON parsing** - Makes output readable
2. **Limit results** - Use `per_page=N` to avoid large outputs
3. **Handle rate limits** - Wait 1 hour if rate limited, or use token
4. **Check errors** - Handle 404 (not found) and 403 (rate limited) errors
5. **Cache results** - If user asks multiple questions about same repo, reuse previous response

## Limitations

1. **No write operations** - This skill is read-only
2. **Rate limits** - Unauthenticated requests limited to 60/hour
3. **No search within code** - Use GitHub search UI for code search
4. **No private data** - Cannot access private repos without authentication

## Security Considerations

1. **Don't expose tokens** - If using token, don't show it in output
2. **Respect rate limits** - Don't spam the API
3. **Public data only** - This skill only accesses public GitHub data

## Tips

1. **Use `-s` flag** with curl for silent output
2. **Use `jq` for JSON parsing** - Available in LobsterAI environment
3. **Combine filters** - Use jq to extract only needed fields
4. **Check headers** - Use `-I` to check API status without downloading body
