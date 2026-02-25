#!/usr/bin/env python3
"""
HTTP utility functions for fetching web content
"""

import urllib.request
import urllib.error
import time
import sys

def fetch_url(url, timeout=10, max_retries=3, user_agent=None):
    """
    Fetch content from a URL with retries and error handling

    Args:
        url: URL to fetch
        timeout: Request timeout in seconds
        max_retries: Maximum number of retry attempts
        user_agent: Optional custom user agent string

    Returns:
        Response content as string, or None on failure
    """
    if user_agent is None:
        user_agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

    headers = {
        "User-Agent": user_agent,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7"
    }

    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as response:
                content = response.read()

                # Try different encodings
                for encoding in ['utf-8', 'gb2312', 'gbk', 'iso-8859-1']:
                    try:
                        return content.decode(encoding)
                    except UnicodeDecodeError:
                        continue

                # If all encodings fail, use utf-8 with error handling
                return content.decode('utf-8', errors='ignore')

        except urllib.error.HTTPError as e:
            print(f"HTTP Error {e.code} for {url}", file=sys.stderr)
            if e.code in [404, 403, 401]:  # Don't retry these
                return None
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)  # Exponential backoff

        except urllib.error.URLError as e:
            print(f"URL Error for {url}: {e.reason}", file=sys.stderr)
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)

        except Exception as e:
            print(f"Unexpected error fetching {url}: {e}", file=sys.stderr)
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)

    return None


def fetch_json(url, timeout=10):
    """
    Fetch and parse JSON from a URL

    Args:
        url: URL to fetch
        timeout: Request timeout in seconds

    Returns:
        Parsed JSON object, or None on failure
    """
    import json

    content = fetch_url(url, timeout=timeout)
    if content:
        try:
            return json.loads(content)
        except json.JSONDecodeError as e:
            print(f"JSON parse error for {url}: {e}", file=sys.stderr)

    return None
