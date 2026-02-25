#!/usr/bin/env python3
"""
Technology news search engine

Search across multiple tech news sources and rank by heat score
"""

import json
import sys
import argparse
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict

# Add parsers and shared to path
SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR / "parsers"))
sys.path.insert(0, str(SCRIPT_DIR / "shared"))

from rss_parser import parse_rss_feed
from hn_parser import parse_hackernews
from heat_calculator import calculate_heat_score, find_duplicate_sources
from domain_classifier import classify_keyword, get_sources_for_domains
from network_detector import filter_sources_by_network


def load_sources():
    """Load news sources from references/sources.json"""
    sources_file = SCRIPT_DIR.parent / "references" / "sources.json"
    with open(sources_file, "r", encoding="utf-8") as f:
        data = json.load(f)
        return data["sources"]


def balance_sources(articles, max_per_source=5):
    """
    Balance articles across sources to ensure diversity

    Args:
        articles: List of all articles (already sorted by heat score)
        max_per_source: Maximum articles from each source

    Returns:
        Balanced list of articles
    """
    source_counts = defaultdict(int)
    balanced = []

    for article in articles:
        # Skip articles without source field (defensive programming)
        source = article.get("source")
        if not source:
            continue

        if source_counts[source] < max_per_source:
            balanced.append(article)
            source_counts[source] += 1

    return balanced


def search_news(keyword, limit=15, max_per_source=5, balance=True, all_sources=False):
    """
    Search for tech news across all sources

    Args:
        keyword: Search keyword
        limit: Max articles per source to fetch
        max_per_source: Max articles per source to display (for balancing)
        balance: Whether to balance sources in output
        all_sources: Whether to search all sources (disable smart routing)

    Returns:
        Dict with search results
    """
    all_sources_list = load_sources()

    # Step 1: Filter by network accessibility (silent, automatic)
    network_filtered_sources = filter_sources_by_network(all_sources_list)

    # Step 2: Smart routing - filter sources by detected domains
    if not all_sources:
        domains = classify_keyword(keyword)
        sources = get_sources_for_domains(network_filtered_sources, domains)

        print(f"🎯 Detected domains: {', '.join(sorted(domains))}", file=sys.stderr)
        print(f"🔍 Searching for '{keyword}' in {len(sources)} sources...\n", file=sys.stderr)
    else:
        sources = network_filtered_sources
        print(f"🔍 Searching for '{keyword}' across {len(sources)} sources...\n", file=sys.stderr)

    articles_list = []

    # Search each source
    for source in sources:
        if not source.get("enabled", True):
            continue

        print(f"  Fetching from {source['name']}...", file=sys.stderr)

        try:
            if source["type"] == "api" and "hackernews" in source["id"]:
                # Use HN API parser
                articles = parse_hackernews(source, keyword=keyword, limit=limit)
            elif source["type"] in ["rss", "newsletter_rss"]:
                # Use RSS parser
                articles = parse_rss_feed(source, keyword=keyword, limit=limit)
            else:
                print(f"    Unsupported type: {source['type']}", file=sys.stderr)
                continue

            articles_list.extend(articles)
            print(f"    Found {len(articles)} articles", file=sys.stderr)

        except Exception as e:
            print(f"    Error: {e}", file=sys.stderr)
            continue

    # Calculate heat scores
    print(f"\n📊 Calculating heat scores...\n", file=sys.stderr)
    for article in articles_list:
        article["heat_score"] = calculate_heat_score(article, articles_list, keyword)
        article["duplicate_sources"] = find_duplicate_sources(article, articles_list)

    # Sort by heat score
    articles_list.sort(key=lambda x: x["heat_score"], reverse=True)

    # Balance sources if enabled
    if balance:
        print(f"⚖️  Balancing sources (max {max_per_source} per source)...\n", file=sys.stderr)
        articles_list = balance_sources(articles_list, max_per_source)

    # Prepare output
    result = {
        "keyword": keyword,
        "total_found": len(articles_list),
        "search_time": datetime.now(timezone.utc).isoformat(),
        "results": articles_list
    }

    return result


def main():
    parser = argparse.ArgumentParser(description="Search technology news")
    parser.add_argument("keyword", help="Search keyword")
    parser.add_argument("--limit", type=int, default=15,
                       help="Max articles per source to fetch (default: 15)")
    parser.add_argument("--max-per-source", type=int, default=5,
                       help="Max articles per source to display (default: 5)")
    parser.add_argument("--no-balance", action="store_true",
                       help="Disable source balancing (show all results)")
    parser.add_argument("--all-sources", action="store_true",
                       help="Search all sources (disable smart routing)")

    args = parser.parse_args()

    # Perform search
    result = search_news(
        args.keyword,
        limit=args.limit,
        max_per_source=args.max_per_source,
        balance=not args.no_balance,
        all_sources=args.all_sources
    )

    # Output JSON
    print(json.dumps(result, ensure_ascii=False, indent=2))

    print(f"\n✅ Search complete! Found {result['total_found']} articles.", file=sys.stderr)


if __name__ == "__main__":
    main()
