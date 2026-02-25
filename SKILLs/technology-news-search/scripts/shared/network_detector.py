#!/usr/bin/env python3
"""
Network connectivity detector for news-technology skill

Silently detects if user can access global sources and automatically
falls back to China-only sources if needed. Detection is cached for
5 minutes to avoid repeated checks.
"""

import urllib.request
import socket
import time
from pathlib import Path


# Cache file location
CACHE_FILE = Path(__file__).parent.parent.parent / ".network_cache"
CACHE_DURATION = 300  # 5 minutes in seconds


def check_global_access(timeout=3, use_cache=True):
    """
    Check if global (non-China) sources are accessible.

    Silently tests connectivity to international websites. Uses cached
    result if available and fresh (within 5 minutes).

    Args:
        timeout: Timeout in seconds for each test (default: 3)
        use_cache: Whether to use cached result (default: True)

    Returns:
        True if global sources are accessible, False otherwise
    """
    # Check cache first
    if use_cache:
        cached_result = _read_cache()
        if cached_result is not None:
            return cached_result

    # Test URLs (lightweight, reliable endpoints)
    test_urls = [
        ('https://www.cloudflare.com/cdn-cgi/trace', 200),
        ('https://techcrunch.com/feed/', 200),
    ]

    for url, expected_status in test_urls:
        try:
            req = urllib.request.Request(
                url,
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            with urllib.request.urlopen(req, timeout=timeout) as response:
                if response.status == expected_status:
                    # Success - global sources accessible
                    result = True
                    _write_cache(result)
                    return result
        except (urllib.error.URLError, socket.timeout, Exception):
            # This URL failed, try next one
            continue

    # All tests failed - global sources not accessible
    result = False
    _write_cache(result)
    return result


def _read_cache():
    """
    Read cached network detection result.

    Returns:
        True/False if cache is valid, None if cache is stale or missing
    """
    try:
        if not CACHE_FILE.exists():
            return None

        # Check if cache is still fresh
        cache_age = time.time() - CACHE_FILE.stat().st_mtime
        if cache_age > CACHE_DURATION:
            # Cache expired
            CACHE_FILE.unlink()
            return None

        # Read cached result
        with open(CACHE_FILE, 'r') as f:
            value = f.read().strip()
            return value == 'true'
    except Exception:
        # Any error reading cache, ignore it
        return None


def _write_cache(result):
    """
    Write network detection result to cache.

    Args:
        result: True if global accessible, False otherwise
    """
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(CACHE_FILE, 'w') as f:
            f.write('true' if result else 'false')
    except Exception:
        # Silently fail if can't write cache
        pass


def filter_sources_by_network(all_sources, force_region=None):
    """
    Filter sources based on network accessibility.

    Automatically detects network environment and returns appropriate sources.
    This function is completely silent - no output to user.

    Args:
        all_sources: List of all news sources
        force_region: Force specific region ('cn' or 'global'), None for auto

    Returns:
        Filtered list of sources appropriate for current network
    """
    # Force region if specified (for testing)
    if force_region == 'cn':
        return [s for s in all_sources if s.get('region') == 'cn' and s.get('enabled', True)]
    elif force_region == 'global':
        return [s for s in all_sources if s.get('enabled', True)]

    # Auto-detect network
    can_access_global = check_global_access()

    if can_access_global:
        # Network is good - use all sources
        return [s for s in all_sources if s.get('enabled', True)]
    else:
        # Network is restricted - use only China sources
        return [s for s in all_sources if s.get('region') == 'cn' and s.get('enabled', True)]


if __name__ == "__main__":
    # Test network detection
    print("Testing network connectivity...")
    print()

    # Test without cache
    start = time.time()
    result = check_global_access(use_cache=False)
    elapsed = (time.time() - start) * 1000

    if result:
        print(f"✓ Global sources accessible ({elapsed:.0f}ms)")
        print("  → Will use all 75 sources (cn + global)")
    else:
        print(f"✗ Global sources not accessible ({elapsed:.0f}ms)")
        print("  → Will use 18 China sources only")

    print()
    print("Testing with cache...")

    # Test with cache (should be instant)
    start = time.time()
    result2 = check_global_access(use_cache=True)
    elapsed2 = (time.time() - start) * 1000

    print(f"  Cache hit: {elapsed2:.2f}ms (vs {elapsed:.0f}ms without cache)")
    print(f"  Result consistent: {result == result2}")
