#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LobsterAI Stock Announcement Fetcher
Fetches A-share company announcements from Eastmoney via AkShare.

Dependencies: pip install akshare pandas requests PyPDF2
"""

import sys
import io
import re
import json
import argparse
from datetime import datetime, timedelta

import pandas as pd
import requests

# Ensure UTF-8 stdout on Windows
if sys.stdout.encoding != "utf-8":
    import codecs
    sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, "strict")
    sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, "strict")


def _log(msg: str):
    print(msg, file=sys.stderr)


# ---------------------------------------------------------------------------
# Data fetching
# ---------------------------------------------------------------------------

def query_announcements(code: str, days: int = 30) -> list:
    """Fetch announcements for *code* from Eastmoney via AkShare."""
    try:
        import akshare as ak
    except ImportError:
        _log("[错误] akshare 未安装，请运行: pip install akshare")
        return []

    # Normalise code - strip exchange suffix
    code = code.split(".")[0]
    end = datetime.now()
    start = end - timedelta(days=days)
    date_str = end.strftime("%Y%m%d")

    _log(f"[1/2] 从东方财富获取 {date_str} 全部公告 ...")
    try:
        df = ak.stock_notice_report(symbol="全部", date=date_str)
    except Exception as exc:
        _log(f"[错误] AkShare 调用失败: {exc}")
        return []

    if df is None or df.empty:
        _log("  → 当日无公告数据")
        return []

    cols = list(df.columns)
    _log(f"  → 获取 {len(df)} 条，筛选 {code} ...")

    matched = df[df[cols[0]] == code]
    if matched.empty:
        _log(f"  → 未找到 {code} 的公告")
        return []

    results = []
    for _, row in matched.iterrows():
        ann_date = str(row[cols[4]])
        if ann_date < start.strftime("%Y-%m-%d"):
            continue
        url = str(row[cols[5]])
        ann_id = url.rstrip("/").split("/")[-1].replace(".html", "")
        results.append({
            "date": ann_date,
            "title": str(row[cols[2]]),
            "type": str(row[cols[3]]),
            "url": url,
            "pdf_url": f"http://pdf.dfcfw.com/pdf/H2_{ann_id}_1.pdf",
            "code": str(row[cols[0]]),
            "name": str(row[cols[1]]),
        })

    _log(f"[2/2] 匹配到 {len(results)} 条公告\n")
    return results


# ---------------------------------------------------------------------------
# PDF extraction (optional --detail)
# ---------------------------------------------------------------------------

def extract_pdf_summary(pdf_url: str, title: str):
    """Download a PDF and return a short summary."""
    try:
        from PyPDF2 import PdfReader
    except ImportError:
        _log("[提示] PyPDF2 未安装，跳过 PDF 提取")
        return None

    try:
        _log(f"  下载 PDF ...")
        resp = requests.get(pdf_url, timeout=15)
        resp.raise_for_status()
        reader = PdfReader(io.BytesIO(resp.content))
        pages_text = []
        for page in reader.pages[:5]:
            txt = page.extract_text()
            if txt:
                pages_text.append(txt)
        body = re.sub(r"\s+", " ", " ".join(pages_text)).strip()
        if len(body) < 50:
            return None

        # Pick sentences containing keywords
        keywords = ("通知", "决定", "变更", "任命", "辞职", "增持", "减持",
                     "业绩", "利润", "营收", "净利", "合同", "投资", "收购",
                     "重组", "分红", "股东")
        sentences = re.split(r"[。！？\n]", body)
        picked = [s.strip() for s in sentences if 15 < len(s.strip()) < 200
                   and any(k in s for k in keywords)][:5]
        if picked:
            return "  ".join(f"({i+1}) {s}" for i, s in enumerate(picked))
        return body[:300] + " ..."
    except Exception as exc:
        _log(f"  PDF 提取失败: {exc}")
        return None


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def print_text(items: list, detail: bool = False):
    if not items:
        print("\n未找到匹配的公告。")
        return
    first = items[0]
    print(f"\n{'─'*60}")
    print(f"  {first.get('name', '')} ({first['code']})  共 {len(items)} 条公告")
    print(f"{'─'*60}\n")

    for i, a in enumerate(items, 1):
        print(f"  [{i}] {a['date']}  {a['title']}")
        if a.get("type"):
            print(f"      类型: {a['type']}")
        print(f"      链接: {a['url']}")
        if detail and a.get("summary"):
            print(f"      摘要: {a['summary']}")
        print()


def print_json(items: list):
    print(json.dumps(items, ensure_ascii=False, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="LobsterAI A股公告查询")
    ap.add_argument("stock_code", help="股票代码 (如 000858, 600519.SS)")
    ap.add_argument("--days", type=int, default=30, help="查询最近N天 (默认30)")
    ap.add_argument("--keyword", default=None, help="标题关键词筛选")
    ap.add_argument("--format", choices=["text", "json"], default="text")
    ap.add_argument("--detail", action="store_true", help="提取PDF内容摘要")
    args = ap.parse_args()

    items = query_announcements(args.stock_code, days=args.days)

    if args.keyword:
        items = [a for a in items if args.keyword in a["title"]]

    if args.detail:
        for a in items:
            s = extract_pdf_summary(a["pdf_url"], a["title"])
            if s:
                a["summary"] = s

    if args.format == "json":
        print_json(items)
    else:
        print_text(items, detail=args.detail)


if __name__ == "__main__":
    main()
