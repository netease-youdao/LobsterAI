#!/usr/bin/env python3
"""
Generic RSS/Atom feed parser
"""

import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# Add shared directory to path
sys.path.insert(0, str(Path(__file__).parent.parent / "shared"))
from web_utils import fetch_url


def extract_reddit_upvotes(content: str) -> int:
    """
    Extract upvote count from Reddit RSS content

    Reddit RSS includes upvote count in content like "X points" or "X upvotes"

    Args:
        content: RSS item content/description HTML

    Returns:
        Upvote count (0 if not found)
    """
    # Try to find patterns like "123 points" or "123 upvotes"
    match = re.search(r'(\d+)\s+(points?|upvotes?)', content, re.IGNORECASE)
    if match:
        return int(match.group(1))
    return 0


def parse_rss_feed(source_config, keyword=None, limit=10):
    """
    Parse RSS or Atom feed

    Args:
        source_config: Dict with 'url', 'name', 'language', 'category'
        keyword: Optional keyword to filter results
        limit: Maximum number of articles to return

    Returns:
        List of article dicts with keys: title, summary, url, published_at, source, language
    """
    articles = []

    content = fetch_url(source_config["url"])
    if not content:
        return articles

    # Extract items/entries
    # Try RSS <item> tags first
    item_pattern = r'<item>(.*?)</item>'
    items = re.findall(item_pattern, content, re.DOTALL)

    # If no items, try Atom <entry> tags
    if not items:
        item_pattern = r'<entry>(.*?)</entry>'
        items = re.findall(item_pattern, content, re.DOTALL)

    for item in items[:limit * 2]:  # Get more than limit for filtering
        try:
            # Extract title
            title_match = re.search(r'<title>(.*?)</title>', item, re.DOTALL)
            if not title_match:
                continue
            title = clean_html(title_match.group(1))

            # Extract link/url
            link_match = re.search(r'<link>(.*?)</link>', item, re.DOTALL) or \
                        re.search(r'<link[^>]+href=["\']([^"\']+)["\']', item)
            if not link_match:
                continue
            url = clean_html(link_match.group(1))

            # Extract summary/description
            summary_match = re.search(r'<description>(.*?)</description>', item, re.DOTALL) or \
                          re.search(r'<summary>(.*?)</summary>', item, re.DOTALL) or \
                          re.search(r'<content[^>]*>(.*?)</content>', item, re.DOTALL)
            summary = ""
            if summary_match:
                summary = clean_html(summary_match.group(1))
                # Limit summary length
                summary = summary[:300] + "..." if len(summary) > 300 else summary

            # Extract publish date
            pub_date_match = re.search(r'<pubDate>(.*?)</pubDate>', item, re.DOTALL) or \
                           re.search(r'<published>(.*?)</published>', item, re.DOTALL) or \
                           re.search(r'<updated>(.*?)</updated>', item, re.DOTALL)
            published_at = None
            if pub_date_match:
                try:
                    published_at = parse_date(pub_date_match.group(1))
                except:
                    pass

            # Keyword filtering
            if keyword:
                keyword_lower = keyword.lower()
                if keyword_lower not in title.lower() and keyword_lower not in summary.lower():
                    continue

            # Build article dict
            article = {
                "title": title,
                "summary": summary,
                "url": url,
                "published_at": published_at,
                "source": source_config["name"],
                "language": source_config.get("language", "en"),
                "category": source_config.get("category", "general")
            }

            # Extract Reddit upvotes if this is a Reddit source
            if "reddit.com" in source_config.get("url", ""):
                upvotes = extract_reddit_upvotes(item)
                if upvotes > 0:
                    article["reddit_upvotes"] = upvotes

            articles.append(article)

            if len(articles) >= limit:
                break

        except Exception as e:
            print(f"Error parsing item from {source_config['name']}: {e}", file=sys.stderr)
            continue

    return articles


def clean_html(text):
    """Remove HTML tags and decode entities"""
    if not text:
        return ""

    # Remove CDATA
    text = re.sub(r'<!\[CDATA\[(.*?)\]\]>', r'\1', text, flags=re.DOTALL)

    # Remove HTML tags
    text = re.sub(r'<[^>]+>', '', text)

    # Decode common HTML entities
    entities = {
        '&lt;': '<',
        '&gt;': '>',
        '&amp;': '&',
        '&quot;': '"',
        '&apos;': "'",
        '&#39;': "'",
        '&#x27;': "'",
        '&nbsp;': ' ',
        '&mdash;': '—',
        '&ndash;': '–',
    }
    for entity, char in entities.items():
        text = text.replace(entity, char)

    # Clean whitespace
    text = re.sub(r'\s+', ' ', text).strip()

    return text


def parse_date(date_str):
    """Parse various date formats to ISO 8601"""
    date_str = date_str.strip()

    # RFC 822 (RSS)
    try:
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(date_str).isoformat()
    except:
        pass

    # ISO 8601 (Atom)
    try:
        dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        return dt.isoformat()
    except:
        pass

    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    # Test with TechCrunch
    test_source = {
        "name": "TechCrunch",
        "url": "https://techcrunch.com/feed/",
        "language": "en",
        "category": "startup"
    }

    print(f"Testing RSS parser with {test_source['name']}...")
    articles = parse_rss_feed(test_source, limit=5)

    print(f"\nFound {len(articles)} articles:\n")
    for i, article in enumerate(articles, 1):
        print(f"{i}. {article['title']}")
        print(f"   URL: {article['url']}")
        print(f"   Summary: {article['summary'][:100]}...")
        print()
