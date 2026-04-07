#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LobsterAI Stock Explorer
Quick stock quotes, fundamentals, technical indicators via Yahoo Finance.

Dependencies: pip install yfinance pandas rich plotille
"""

import sys
import argparse

# Ensure UTF-8 on Windows
if sys.stdout.encoding != "utf-8":
    import codecs
    sys.stdout = codecs.getwriter("utf-8")(sys.stdout.buffer, "strict")
    sys.stderr = codecs.getwriter("utf-8")(sys.stderr.buffer, "strict")

import yfinance as yf
import pandas as pd
import plotille
from rich.console import Console
from rich.table import Table
from rich.panel import Panel

console = Console()

# ---------------------------------------------------------------------------
# Technical indicator helpers
# ---------------------------------------------------------------------------

def _rsi(close, w=14):
    d = close.diff()
    g = d.clip(lower=0).ewm(alpha=1/w, adjust=False, min_periods=w).mean()
    l = (-d.clip(upper=0)).ewm(alpha=1/w, adjust=False, min_periods=w).mean()
    return 100 - 100 / (1 + g / l.replace(0, pd.NA))


def _macd(close):
    f = close.ewm(span=12, adjust=False, min_periods=12).mean()
    s = close.ewm(span=26, adjust=False, min_periods=26).mean()
    line = f - s
    sig = line.ewm(span=9, adjust=False, min_periods=9).mean()
    return line, sig, line - sig


def _bbands(close, w=20, n=2.0):
    ma = close.rolling(w, min_periods=w).mean()
    sd = close.rolling(w, min_periods=w).std(ddof=0)
    return ma + n * sd, ma, ma - n * sd


def _vwap(df):
    tp = (df["High"] + df["Low"] + df["Close"]) / 3
    v = df["Volume"].fillna(0)
    return (tp * v).cumsum() / v.cumsum().replace(0, pd.NA)


def _atr(df, w=14):
    h, l, c = df["High"], df["Low"], df["Close"]
    pc = c.shift(1)
    tr = pd.concat([(h - l), (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1/w, adjust=False, min_periods=w).mean()


# ---------------------------------------------------------------------------
# Fetch helper
# ---------------------------------------------------------------------------

def _get_ticker(symbol):
    t = yf.Ticker(symbol)
    try:
        info = t.info
        if not info or (not info.get("regularMarketPrice") and not info.get("currentPrice")):
            if not info.get("symbol"):
                return None, None
        return t, info
    except Exception:
        return None, None


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_price(symbol, ticker, info):
    cur = info.get("regularMarketPrice") or info.get("currentPrice")
    prev = info.get("regularMarketPreviousClose") or info.get("previousClose")
    if cur is None:
        return
    chg = cur - prev
    pct = chg / prev * 100
    color = "green" if chg >= 0 else "red"
    sign = "+" if chg >= 0 else ""

    tbl = Table(title=f"{info.get('longName', symbol)}")
    tbl.add_column("指标", style="cyan")
    tbl.add_column("值", style="magenta")
    tbl.add_row("代码", symbol)
    tbl.add_row("价格", f"{cur:,.2f} {info.get('currency', '')}")
    tbl.add_row("涨跌", f"[{color}]{sign}{chg:,.2f} ({sign}{pct:.2f}%)[/{color}]")
    console.print(tbl)


def cmd_fundamentals(symbol, ticker, info):
    tbl = Table(title=f"{info.get('longName', symbol)} 基本面")
    tbl.add_column("指标", style="cyan")
    tbl.add_column("值", style="magenta")
    for label, key in [("市值", "marketCap"), ("市盈率", "forwardPE"),
                        ("EPS", "trailingEps"), ("ROE", "returnOnEquity")]:
        tbl.add_row(label, str(info.get(key, "N/A")))
    console.print(tbl)


def cmd_history(symbol, ticker, period):
    hist = ticker.history(period=period)
    if hist.empty:
        print("无历史数据")
        return
    chart = plotille.plot(hist.index, hist["Close"], height=15, width=60)
    console.print(Panel(chart, title=f"{symbol} 走势", border_style="green"))


def cmd_pro(symbol, ticker, period, indicators):
    hist = ticker.history(period=period)
    if hist.empty:
        print("无历史数据")
        return

    close = hist["Close"]
    cur = close.iloc[-1]
    hi = hist["High"].max()
    lo = hist["Low"].min()
    start_price = close.iloc[0]
    change_pct = (cur - start_price) / start_price * 100

    lines = []
    lines.append(f"\n{'─'*56}")
    lines.append(f"  {symbol} 技术分析 ({period})")
    lines.append(f"{'─'*56}")
    lines.append(f"\n  当前 {cur:.2f}  区间 {lo:.2f}–{hi:.2f}  涨幅 {change_pct:+.1f}%")

    if indicators.get("rsi"):
        val = _rsi(close).iloc[-1]
        tag = "超买" if val > 70 else ("超卖" if val < 30 else "中性")
        lines.append(f"\n  RSI(14): {val:.1f}  [{tag}]")

    if indicators.get("macd"):
        ml, ms, mh = _macd(close)
        tag = "多头" if ml.iloc[-1] > ms.iloc[-1] else "空头"
        lines.append(f"\n  MACD: {ml.iloc[-1]:.3f}  信号: {ms.iloc[-1]:.3f}  [{tag}]")

    if indicators.get("bb"):
        u, m, l = _bbands(close)
        pos = (cur - l.iloc[-1]) / (u.iloc[-1] - l.iloc[-1]) * 100
        tag = "上轨" if pos > 80 else ("下轨" if pos < 20 else "中轨")
        lines.append(f"\n  布林带  上={u.iloc[-1]:.2f}  中={m.iloc[-1]:.2f}  下={l.iloc[-1]:.2f}  位置={pos:.0f}%  [{tag}]")

    if indicators.get("vwap"):
        val = _vwap(hist).iloc[-1]
        tag = "高于" if cur > val else "低于"
        lines.append(f"\n  VWAP: {val:.2f}  价格{tag}VWAP")

    if indicators.get("atr"):
        val = _atr(hist).iloc[-1]
        lines.append(f"\n  ATR(14): {val:.2f}  ({val/cur*100:.2f}%)")

    lines.append(f"\n{'─'*56}")
    print("\n".join(lines))


def cmd_report(symbol, ticker, info, period):
    cur = info.get("regularMarketPrice") or info.get("currentPrice")
    prev = info.get("regularMarketPreviousClose") or info.get("previousClose")
    chg = cur - prev if cur and prev else 0
    pct = chg / prev * 100 if prev else 0
    sign = "+" if chg >= 0 else ""

    hist = ticker.history(period=period)
    if hist.empty:
        print("无历史数据")
        return

    close = hist["Close"]
    r = _rsi(close).iloc[-1]
    u, m, l = _bbands(close)
    bb_pos = (close.iloc[-1] - l.iloc[-1]) / (u.iloc[-1] - l.iloc[-1]) * 100
    ml, ms, _ = _macd(close)

    r_tag = "超买" if r > 70 else ("超卖" if r < 30 else "中性")
    bb_tag = "上轨" if bb_pos > 80 else ("下轨" if bb_pos < 20 else "中轨")
    m_tag = "多头" if ml.iloc[-1] > ms.iloc[-1] else "空头"

    mcap = info.get("marketCap", 0)
    pe = info.get("forwardPE", "N/A")

    print(f"\n{'─'*56}")
    print(f"  {info.get('longName', symbol)} 综合报告")
    print(f"{'─'*56}")
    print(f"\n  价格 {cur:,.2f}  {sign}{chg:,.2f} ({sign}{pct:.2f}%)")
    print(f"  市值 {mcap/1e8:,.0f}亿  PE {pe}")
    print(f"\n  RSI(14) {r:.1f} [{r_tag}]  布林位置 {bb_pos:.0f}% [{bb_tag}]  MACD [{m_tag}]")
    print(f"{'─'*56}")

    # Also print detailed indicators
    cmd_pro(symbol, ticker, period, {"rsi": True, "macd": True, "bb": True})


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="LobsterAI Stock Explorer")
    ap.add_argument("cmd", nargs="?", default="price",
                    choices=["price", "fundamentals", "history", "pro", "report"])
    ap.add_argument("symbol", help="股票代码")
    ap.add_argument("period", nargs="?", default="3mo")
    ap.add_argument("--rsi", action="store_true")
    ap.add_argument("--macd", action="store_true")
    ap.add_argument("--bb", action="store_true")
    ap.add_argument("--vwap", action="store_true")
    ap.add_argument("--atr", action="store_true")

    argv = sys.argv[1:]
    if argv and argv[0] not in ("price", "fundamentals", "history", "pro", "report"):
        argv.insert(0, "price")

    args = ap.parse_args(argv)
    indicators = {k: getattr(args, k) for k in ("rsi", "macd", "bb", "vwap", "atr")}

    ticker, info = _get_ticker(args.symbol)
    if not ticker:
        print(f"[错误] 无法获取 {args.symbol} 的数据", file=sys.stderr)
        sys.exit(1)

    if args.cmd == "price":
        cmd_price(args.symbol, ticker, info)
    elif args.cmd == "fundamentals":
        cmd_fundamentals(args.symbol, ticker, info)
    elif args.cmd == "history":
        cmd_history(args.symbol, ticker, args.period)
    elif args.cmd == "pro":
        cmd_pro(args.symbol, ticker, args.period, indicators)
    elif args.cmd == "report":
        cmd_report(args.symbol, ticker, info, args.period)


if __name__ == "__main__":
    main()
