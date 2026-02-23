#!/usr/bin/env python3
"""
Deep Extract - 深度页面抓取 & 网盘链接提取
支持两种命令:
  search — 用 cloudscraper 搜索百度，返回搜索结果页面列表
  extract — 从 stdin 读取页面列表，深度抓取并提取网盘链接 (NDJSON)
"""

import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote, urlparse

try:
    import cloudscraper
except ImportError:
    json.dump({
        'success': False,
        'error': '缺少依赖: cloudscraper。请运行 pip install cloudscraper'
    }, sys.stdout, ensure_ascii=False)
    sys.exit(1)

# ============ 链接匹配模式 ============

PAN_PATTERNS = {
    'quark': re.compile(r'https?://pan\.quark\.cn/s/[a-zA-Z0-9]+'),
    'baidu': re.compile(r'https?://pan\.baidu\.com/s/[a-zA-Z0-9_-]+'),
    'aliyun': re.compile(r'https?://(?:www\.)?alipan\.com/s/[a-zA-Z0-9]+'),
    'uc': re.compile(r'https?://drive\.uc\.cn/s/[a-zA-Z0-9]+'),
}

MAGNET_PATTERN = re.compile(r'magnet:\?xt=urn:btih:[a-zA-Z0-9]+')

CODE_PATTERNS = [
    re.compile(r'(?:提取码|密码|提取密码)[：:\s]*([a-zA-Z0-9]{4,8})'),
    re.compile(r'(?:pwd|code)[=：:\s]*([a-zA-Z0-9]{4,8})', re.I),
]

QUALITY_PATTERNS = [
    (re.compile(r'4[kK]|2160[pP]|[uU][hH][dD]'), '4K'),
    (re.compile(r'1080[pP]|[fF][hH][dD]|[fF]ull\s*[hH][dD]'), '1080P'),
    (re.compile(r'720[pP]'), '720P'),
    (re.compile(r'480[pP]'), 'SD'),
]


# ============ 辅助函数 ============

def extract_title(html):
    """从 HTML 中提取页面标题"""
    m = re.search(r'<title[^>]*>([^<]+)</title>', html, re.I)
    if m:
        title = m.group(1).strip()
        # 清理常见后缀
        title = re.sub(r'\s*[-_|–—]\s*(首页|网站|资源|下载).*$', '', title)
        return title[:80]
    m = re.search(r'<h1[^>]*>([^<]+)</h1>', html, re.I)
    if m:
        return m.group(1).strip()[:80]
    return ''


def detect_quality(ctx):
    """检测画质标记"""
    for pattern, label in QUALITY_PATTERNS:
        if pattern.search(ctx):
            return label
    return ''


def find_extract_code(ctx):
    """查找提取码/密码"""
    for pattern in CODE_PATTERNS:
        m = pattern.search(ctx)
        if m:
            return m.group(1)
    return ''


def create_scraper():
    """创建 cloudscraper 实例"""
    return cloudscraper.create_scraper(
        browser={
            'browser': 'chrome',
            'platform': 'darwin',
            'mobile': False,
        }
    )


# ============ 搜索引擎 ============

# 百度搜索结果的 URL 是 baidu.com/link 跳转链接，不需要过滤
SEARCH_ENGINE_PAGE_PATTERNS = [
    re.compile(r'baidu\.com/s\?'),         # 百度搜索页
    re.compile(r'bing\.com/search\?'),      # Bing 搜索页
    re.compile(r'google\.com/search\?'),    # Google 搜索页
    re.compile(r'so\.com/s\?'),             # 360 搜索页
    re.compile(r'sogou\.com/web\?'),        # 搜狗搜索页
]


def _is_search_page_url(url):
    """判断 URL 是否是搜索引擎的搜索结果页面（非跳转链接）"""
    for pattern in SEARCH_ENGINE_PAGE_PATTERNS:
        if pattern.search(url):
            return True
    return False


def search_baidu(queries, max_results=10):
    """用 cloudscraper 搜索百度，解析 HTML 提取搜索结果 URL 和标题"""
    scraper = create_scraper()
    all_pages = []
    seen = set()

    for query in queries:
        try:
            url = f'https://www.baidu.com/s?wd={quote(query)}&rn={max_results}'
            r = scraper.get(url, timeout=15)

            if r.status_code != 200:
                continue

            # 百度结果: <h3 class="...t/c-title..."><a href="URL">title</a></h3>
            pattern = r'<h3[^>]*class="[^"]*(?:\bt\b|c-title)[^"]*"[^>]*>\s*<a[^>]+href="(https?://[^"]+)"[^>]*>([\s\S]*?)</a>'
            for m in re.finditer(pattern, r.text):
                page_url = m.group(1)
                title = re.sub(r'<[^>]+>', '', m.group(2)).strip()
                if page_url not in seen and not _is_search_page_url(page_url):
                    seen.add(page_url)
                    all_pages.append({'url': page_url, 'title': title})
        except Exception:
            continue

    return all_pages[:max_results * 2]


# ============ 核心抓取逻辑 ============

def fetch_and_extract(page, scraper):
    """访问单个页面，提取所有网盘链接"""
    url = page.get('url', '')
    page_title = page.get('title', '')

    if not url:
        return []

    try:
        r = scraper.get(url, timeout=8)
        if r.status_code != 200:
            sys.stderr.write(f'[extract] {url} -> HTTP {r.status_code}\n')
            return []
        html = r.text
    except Exception as e:
        sys.stderr.write(f'[extract] {url} -> 请求失败: {e}\n')
        return []

    # 如果页面内容太短，可能是反爬页面
    if len(html) < 500:
        sys.stderr.write(f'[extract] {url} -> 内容太短 ({len(html)} 字节)\n')
        return []

    title = extract_title(html) or page_title
    results = []
    seen_urls = set()

    # 1. 提取各类网盘直链
    for pan_type, pattern in PAN_PATTERNS.items():
        for m in pattern.finditer(html):
            pan_url = m.group(0)
            if pan_url in seen_urls:
                continue
            seen_urls.add(pan_url)

            # 提取链接上下文（前后字符）用于画质和提取码检测
            start = max(0, m.start() - 500)
            end = min(len(html), m.end() + 300)
            ctx = html[start:end]

            results.append({
                'title': title,
                'pan': pan_type,
                'url': pan_url,
                'quality': detect_quality(ctx),
                'extractCode': find_extract_code(ctx),
                'source': 'deep-search',
                'pageUrl': url,
            })

    # 2. 提取磁力链接
    for m in MAGNET_PATTERN.finditer(html):
        magnet_url = m.group(0)
        if magnet_url not in seen_urls:
            seen_urls.add(magnet_url)
            ctx = html[max(0, m.start() - 300):min(len(html), m.end() + 200)]
            results.append({
                'title': title,
                'pan': 'magnet',
                'url': magnet_url,
                'quality': detect_quality(ctx),
                'source': 'deep-search',
                'pageUrl': url,
            })

    sys.stderr.write(f'[extract] {url} -> {len(html)} 字节, 找到 {len(results)} 条链接\n')
    return results


def _worker(page):
    """线程工作函数（每个线程创建自己的 scraper 实例）"""
    scraper = create_scraper()
    return fetch_and_extract(page, scraper)


# ============ 主入口 ============

def run_extract(max_workers=4):
    """提取命令: 从 stdin 读取页面列表，深度抓取并提取网盘链接"""
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return
        pages = json.loads(raw)
    except (json.JSONDecodeError, Exception) as e:
        json.dump({'success': False, 'error': f'输入解析失败: {e}'}, sys.stdout, ensure_ascii=False)
        print(flush=True)
        return

    if not isinstance(pages, list) or len(pages) == 0:
        return

    max_workers = max(1, min(max_workers, 8))

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_worker, page): page for page in pages}
        for future in as_completed(futures, timeout=20):
            try:
                results = future.result()
                if results:
                    # NDJSON: 每完成一个页面，立即输出一行 JSON
                    print(json.dumps(results, ensure_ascii=False), flush=True)
            except Exception:
                # 单个页面失败不影响其他页面
                pass


def main():
    if len(sys.argv) < 2:
        # 向后兼容: 无命令时按旧模式从 stdin 读取
        max_workers = 4
        run_extract(max_workers)
        return

    command = sys.argv[1]

    if command == 'search':
        # 搜索命令: deep_extract.py search '["query1","query2"]' [max_results]
        if len(sys.argv) < 3:
            json.dump({'success': False, 'error': '用法: deep_extract.py search \'["query1"]\' [max_results]'},
                      sys.stdout, ensure_ascii=False)
            print(flush=True)
            return
        try:
            queries = json.loads(sys.argv[2])
        except json.JSONDecodeError:
            queries = [sys.argv[2]]
        max_results = int(sys.argv[3]) if len(sys.argv) > 3 else 10
        pages = search_baidu(queries, max_results)
        print(json.dumps(pages, ensure_ascii=False), flush=True)

    elif command == 'extract':
        # 提取命令: deep_extract.py extract [concurrency]
        max_workers = int(sys.argv[2]) if len(sys.argv) > 2 else 4
        run_extract(max_workers)

    else:
        # 向后兼容: 如果第一个参数是数字，按旧方式处理（并发数）
        try:
            max_workers = int(command)
            run_extract(max_workers)
        except ValueError:
            json.dump({'success': False, 'error': f'未知命令: {command}'},
                      sys.stdout, ensure_ascii=False)
            print(flush=True)


if __name__ == '__main__':
    main()
