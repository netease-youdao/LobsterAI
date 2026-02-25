#!/usr/bin/env python3
"""
Heat score calculator for news articles
"""

from datetime import datetime, timezone
from collections import defaultdict


def calculate_heat_score(article, all_articles, keyword):
    """
    Calculate heat score for an article

    Scoring factors:
    - Multi-source bonus: +20 per duplicate source (same article on multiple sites)
    - Time decay: 24h=100%, 48h=70%, 72h=40%, >72h=20%
    - Keyword match quality: title exact=+30, title partial=+15, summary=+5
    - HN engagement: points/10 (max +20, if from Hacker News)
    - Reddit engagement: upvotes/10 (max +20, if from Reddit)
    - Official source bonus: +10 (if from official blog)

    Args:
        article: Article dict
        all_articles: List of all articles (for finding duplicates)
        keyword: Search keyword

    Returns:
        Heat score (0-100)
    """
    score = 0

    # Base score
    score += 20

    # Time decay
    if article.get("published_at"):
        try:
            pub_time = datetime.fromisoformat(article["published_at"].replace('Z', '+00:00'))
            now = datetime.now(timezone.utc)
            hours_ago = (now - pub_time).total_seconds() / 3600

            if hours_ago <= 24:
                score += 40  # Very fresh
            elif hours_ago <= 48:
                score += 28  # Recent
            elif hours_ago <= 72:
                score += 16  # Somewhat recent
            else:
                score += 8   # Older

        except:
            score += 10  # Default if can't parse

    # Keyword match quality
    if keyword:
        keyword_lower = keyword.lower()
        title_lower = article.get("title", "").lower()
        summary_lower = article.get("summary", "").lower()

        if keyword_lower == title_lower:
            score += 30  # Exact match
        elif keyword_lower in title_lower:
            score += 15  # Partial match in title
        elif keyword_lower in summary_lower:
            score += 5   # Match in summary

    # HN engagement bonus
    if "hn_points" in article:
        score += min(article["hn_points"] // 10, 20)  # Max +20 from HN points

    # Reddit engagement bonus
    if "reddit_upvotes" in article:
        score += min(article["reddit_upvotes"] // 10, 20)  # Max +20 from Reddit upvotes

    # Official source bonus (for official blogs)
    if article.get("category") == "official_blog":
        score += 10  # Official announcements get priority

    # Multi-source bonus (check for duplicate titles)
    if article.get("title"):
        title_normalized = normalize_title(article["title"])
        duplicate_count = sum(
            1 for a in all_articles
            if a.get("title") and normalize_title(a["title"]) == title_normalized
            and a["source"] != article["source"]
        )
        score += duplicate_count * 20  # +20 per duplicate source

    # Normalize to 0-100
    return min(score, 100)


def normalize_title(title):
    """Normalize title for duplicate detection"""
    import re
    # Remove common punctuation and whitespace, lowercase
    title = re.sub(r'[^\w\s]', '', title.lower())
    title = re.sub(r'\s+', ' ', title).strip()
    return title


def find_duplicate_sources(article, all_articles):
    """
    Find other sources that have the same story

    Args:
        article: Article dict
        all_articles: List of all articles

    Returns:
        List of source names with duplicate stories
    """
    if not article.get("title"):
        return []

    title_normalized = normalize_title(article["title"])

    duplicates = []
    for a in all_articles:
        if (a.get("title") and
            normalize_title(a["title"]) == title_normalized and
            a["source"] != article["source"]):
            duplicates.append(a["source"])

    return duplicates


if __name__ == "__main__":
    # Test heat calculator
    from datetime import timedelta

    now = datetime.now(timezone.utc)

    test_articles = [
        {
            "title": "OpenAI Announces GPT-5",
            "summary": "OpenAI CEO reveals GPT-5 launch date",
            "source": "TechCrunch",
            "published_at": now.isoformat(),  # Just published
        },
        {
            "title": "OpenAI announces GPT-5!",  # Duplicate
            "summary": "Major AI news from OpenAI",
            "source": "The Verge",
            "published_at": (now - timedelta(hours=2)).isoformat(),
        },
        {
            "title": "Apple releases new iPhone",
            "summary": "Latest iPhone model announced",
            "source": "Wired",
            "published_at": (now - timedelta(hours=50)).isoformat(),  # 2 days old
        },
        {
            "title": "AI regulations discussed in Congress",
            "summary": "AI policy debate continues",
            "source": "MIT Tech Review",
            "published_at": (now - timedelta(days=5)).isoformat(),  # 5 days old
            "hn_points": 250
        }
    ]

    keyword = "GPT"

    print("Testing heat score calculator:\n")
    for article in test_articles:
        score = calculate_heat_score(article, test_articles, keyword)
        duplicates = find_duplicate_sources(article, test_articles)

        print(f"Article: {article['title']}")
        print(f"Source: {article['source']}")
        print(f"Heat Score: {score}")
        if duplicates:
            print(f"Also on: {', '.join(duplicates)}")
        print()
