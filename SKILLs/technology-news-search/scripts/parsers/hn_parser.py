#!/usr/bin/env python3
"""
Hacker News API parser using Algolia search
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

# Add shared directory to path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
from web_utils import fetch_json


def parse_hackernews(source_config, keyword=None, limit=10):
    """
    Parse Hacker News front page using Algolia API

    Args:
        source_config: Dict with 'url', 'name'
        keyword: Optional keyword to filter results
        limit: Maximum number of articles to return

    Returns:
        List of article dicts
    """
    articles = []

    # Build search query
    if keyword:
        url = f"https://hn.algolia.com/api/v1/search?query={keyword}&tags=story&hitsPerPage={limit}"
    else:
        url = f"https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage={limit}"

    data = fetch_json(url)
    if not data or "hits" not in data:
        return articles

    for hit in data["hits"]:
        try:
            title = hit.get("title", "")
            if not title:
                continue

            # Get URL (prefer story URL, fall back to HN discussion)
            url = hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID')}"

            # Build summary from HN points and comments
            points = hit.get("points", 0)
            num_comments = hit.get("num_comments", 0)
            summary = f"HN: {points} points, {num_comments} comments"

            # Parse timestamp
            published_at = None
            if "created_at" in hit:
                try:
                    dt = datetime.fromisoformat(hit["created_at"].replace('Z', '+00:00'))
                    published_at = dt.isoformat()
                except:
                    published_at = datetime.now(timezone.utc).isoformat()

            articles.append({
                "title": title,
                "summary": summary,
                "url": url,
                "published_at": published_at,
                "source": source_config["name"],
                "language": "en",
                "category": "community",
                "hn_points": points,
                "hn_comments": num_comments
            })

        except Exception as e:
            print(f"Error parsing HN item: {e}", file=sys.stderr)
            continue

    return articles


if __name__ == "__main__":
    # Test HN parser
    test_source = {
        "name": "Hacker News",
        "url": "https://hn.algolia.com/api/v1/search?tags=front_page"
    }

    print("Testing HN parser with front page...")
    articles = parse_hackernews(test_source, limit=5)

    print(f"\nFound {len(articles)} articles:\n")
    for i, article in enumerate(articles, 1):
        print(f"{i}. {article['title']}")
        print(f"   URL: {article['url']}")
        print(f"   {article['summary']}")
        print()

    # Test with keyword
    print("\n\nTesting HN parser with keyword 'AI'...")
    articles = parse_hackernews(test_source, keyword="AI", limit=5)

    print(f"\nFound {len(articles)} articles:\n")
    for i, article in enumerate(articles, 1):
        print(f"{i}. {article['title']}")
        print(f"   {article['summary']}")
        print()
