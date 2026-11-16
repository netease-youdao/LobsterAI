#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LobsterAI Stock Deep Analyzer
Comprehensive multi-dimensional stock analysis using Yahoo Finance data.
Produces value, technical, growth, and financial health scores.

Dependencies: pip install yfinance pandas numpy
"""

import sys
import argparse
from datetime import datetime

import numpy as np
import pandas as pd
import yfinance as yf


# ---------------------------------------------------------------------------
# Technical helpers
# ---------------------------------------------------------------------------

def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    diff = series.diff()
    up = diff.clip(lower=0).rolling(period).mean()
    down = (-diff.clip(upper=0)).rolling(period).mean()
    return 100 - 100 / (1 + up / down.replace(0, np.nan))


def macd(series: pd.Series):
    fast = series.ewm(span=12).mean()
    slow = series.ewm(span=26).mean()
    line = fast - slow
    signal = line.ewm(span=9).mean()
    return line, signal, line - signal


def bollinger(series: pd.Series, window: int = 20, width: float = 2.0):
    mid = series.rolling(window).mean()
    std = series.rolling(window).std()
    return mid + width * std, mid, mid - width * std


def vwap(df: pd.DataFrame) -> pd.Series:
    tp = (df["High"] + df["Low"] + df["Close"]) / 3
    vol = df["Volume"].fillna(0)
    return (tp * vol).cumsum() / vol.cumsum().replace(0, np.nan)


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score_value(info: dict) -> tuple:
    pts = 0
    pe = info.get("trailingPE")
    pb = info.get("priceToBook")
    roe = info.get("returnOnEquity")
    dy = info.get("dividendYield")
    margin = info.get("profitMargins")

    if pe and pe < 15:
        pts += 2
    if pb and pb < 3:
        pts += 2
        if pb < 1:
            pts += 1
    if roe and roe > 0.10:
        pts += 2
    if dy and dy > 0.02:
        pts += 2
    if margin and margin > 0.10:
        pts += 1
    return min(pts, 10)


def score_technical(price: float, close: pd.Series, hist: pd.DataFrame) -> int:
    pts = 0
    ma5 = close.rolling(5).mean().iloc[-1]
    ma20 = close.rolling(20).mean().iloc[-1]

    if price > ma5 > ma20:
        pts += 2

    r = rsi(close).iloc[-1]
    if 30 < r < 70:
        pts += 2
    elif r <= 30:
        pts += 1

    ml, ms, _ = macd(close)
    if ml.iloc[-1] > ms.iloc[-1]:
        pts += 2

    upper, _, lower = bollinger(close)
    if lower.iloc[-1] < price < upper.iloc[-1]:
        pts += 2

    v = vwap(hist).iloc[-1]
    if price > v:
        pts += 2

    return min(pts, 10)


def score_growth(info: dict) -> int:
    pts = 0
    rg = info.get("revenueGrowth")
    eg = info.get("earningsGrowth")
    margin = info.get("profitMargins")

    if rg and rg > 0.05:
        pts += 2
        if rg > 0.10:
            pts += 1
    if eg and eg > 0.10:
        pts += 3
        if eg > 0.20:
            pts += 2
    if margin and margin > 0.15:
        pts += 2
    return min(pts, 10)


def score_financial(info: dict) -> int:
    pts = 5  # base
    de = info.get("debtToEquity")
    cr = info.get("currentRatio")
    if de is not None and de < 100:
        pts += 2
    if cr and cr > 1.5:
        pts += 2
        if cr > 2.0:
            pts += 1
    return min(pts, 10)


# ---------------------------------------------------------------------------
# Risk scan
# ---------------------------------------------------------------------------

def scan_risks(info: dict, price: float, close: pd.Series) -> list:
    risks = []
    pe = info.get("trailingPE")
    pb = info.get("priceToBook")
    roe = info.get("returnOnEquity")
    de = info.get("debtToEquity")
    rg = info.get("revenueGrowth")

    if pe and pe > 30:
        risks.append(f"高估值 (P/E={pe:.1f})")
    if pb and pb > 5:
        risks.append(f"市净率偏高 (P/B={pb:.1f})")
    if roe and roe < 0:
        risks.append("ROE 为负，公司亏损")
    r = rsi(close).iloc[-1]
    if r > 70:
        risks.append(f"技术面超买 (RSI={r:.1f})")
    upper, _, _ = bollinger(close)
    if price > upper.iloc[-1]:
        risks.append("价格突破布林带上轨")
    if de is not None and de > 200:
        risks.append(f"高负债 (D/E={de:.0f}%)")
    if rg and rg < 0:
        risks.append("营收负增长")
    return risks


# ---------------------------------------------------------------------------
# Report renderer
# ---------------------------------------------------------------------------

SEP = "─" * 56


def _fmt(label: str, key: str, info: dict, is_pct: bool = False):
    val = info.get(key)
    if val is not None:
        display = f"{val*100:.2f}%" if is_pct else f"{val:.2f}"
        print(f"  {label}: {display}")
    else:
        print(f"  {label}: N/A")


def render_report(ticker_symbol: str, period: str):
    stock = yf.Ticker(ticker_symbol)
    info = stock.info
    hist = stock.history(period=period)

    if hist.empty:
        print(f"[错误] 无法获取 {ticker_symbol} 的历史数据")
        return None

    close = hist["Close"]
    cur = info.get("currentPrice") or close.iloc[-1]
    chg = info.get("regularMarketChange", 0)
    chg_pct = info.get("regularMarketChangePercent", 0)
    name = info.get("longName", ticker_symbol)
    currency = info.get("currency", "")

    # Header
    print(f"\n{SEP}")
    print(f"  {name} ({ticker_symbol}) 深度分析报告")
    print(SEP)

    # 1 - Market overview
    print(f"\n▸ 实时行情")
    print(f"  价格  {cur:,.2f} {currency}  ({chg:+.2f}, {chg_pct:+.2f}%)")
    mcap = info.get("marketCap")
    if mcap:
        print(f"  市值  {mcap/1e8:,.0f} 亿{currency}")
    lo52 = info.get("fiftyTwoWeekLow", "–")
    hi52 = info.get("fiftyTwoWeekHigh", "–")
    print(f"  52周  {lo52} – {hi52}")
    vol = info.get("volume")
    if vol:
        print(f"  成交量 {vol:,}")

    # 2 - Value
    vs = score_value(info)
    print(f"\n▸ 价值评估  {vs}/10")
    _fmt("P/E", "trailingPE", info)
    _fmt("P/B", "priceToBook", info)
    _fmt("ROE", "returnOnEquity", info, True)
    _fmt("ROA", "returnOnAssets", info, True)
    _fmt("EPS", "trailingEps", info)
    _fmt("股息率", "dividendYield", info, True)

    # 3 - Technical
    ts = score_technical(cur, close, hist)
    print(f"\n▸ 技术分析  {ts}/10")
    ma5 = close.rolling(5).mean().iloc[-1]
    ma20 = close.rolling(20).mean().iloc[-1]
    ma60 = close.rolling(60).mean().iloc[-1] if len(close) >= 60 else float("nan")
    print(f"  MA5={ma5:.2f}  MA20={ma20:.2f}  MA60={'%.2f' % ma60 if not np.isnan(ma60) else 'N/A'}")
    r = rsi(close).iloc[-1]
    ml, ms, mh = macd(close)
    print(f"  RSI(14)={r:.1f}  MACD={ml.iloc[-1]:.4f}  信号={ms.iloc[-1]:.4f}")
    upper, mid, lower = bollinger(close)
    bb_pos = (cur - lower.iloc[-1]) / (upper.iloc[-1] - lower.iloc[-1]) * 100
    print(f"  布林带  上={upper.iloc[-1]:.2f}  中={mid.iloc[-1]:.2f}  下={lower.iloc[-1]:.2f}  位置={bb_pos:.0f}%")

    # 4 - Growth
    gs = score_growth(info)
    print(f"\n▸ 成长性  {gs}/10")
    _fmt("营收增长", "revenueGrowth", info, True)
    _fmt("利润增长", "earningsGrowth", info, True)
    _fmt("利润率", "profitMargins", info, True)

    # 5 - Financial health
    fs = score_financial(info)
    print(f"\n▸ 财务健康  {fs}/10")
    _fmt("资产负债率", "debtToEquity", info)
    _fmt("流动比率", "currentRatio", info)

    # 6 - Overall
    overall = vs * 0.35 + ts * 0.25 + gs * 0.25 + fs * 0.15
    label = (
        "强烈推荐" if overall >= 8 else
        "推荐买入" if overall >= 6.5 else
        "持有观望" if overall >= 5 else
        "谨慎操作" if overall >= 3 else
        "建议回避"
    )
    print(f"\n{SEP}")
    print(f"  综合评分  {overall:.1f}/10  【{label}】")
    print(f"  (价值{vs} × 35% + 技术{ts} × 25% + 成长{gs} × 25% + 财务{fs} × 15%)")
    print(SEP)

    # 7 - Strategies
    print(f"\n▸ 操作建议")
    bv = info.get("bookValue")
    if vs >= 7 and overall >= 6:
        target = bv * 1.1 if bv else cur * 1.2
        print(f"  长线  仓位20-30%  目标 {target:.2f}  周期1-3年")

    if ts >= 5:
        print(f"  波段  买入区 {lower.iloc[-1]:.2f}–{mid.iloc[-1]:.2f}  止盈区 {mid.iloc[-1]:.2f}–{upper.iloc[-1]:.2f}")
        print(f"        止损 {lower.iloc[-1]*0.95:.2f}")

    if r < 30:
        print(f"  短线  超卖反弹机会  目标 +5%  止损 -3%")
    elif r > 70:
        print(f"  短线  超买区域，回避追高")

    # 8 - Risks
    risks = scan_risks(info, cur, close)
    print(f"\n▸ 风险提示")
    if risks:
        for rk in risks:
            print(f"  ⚠ {rk}")
    else:
        print("  未发现重大风险信号")

    print(f"\n{SEP}")
    print(f"  报告时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(SEP)

    return {
        "ticker": ticker_symbol, "overall": round(overall, 1),
        "value": vs, "technical": ts, "growth": gs, "financial": fs,
        "rating": label, "price": cur, "risks": risks,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="LobsterAI Stock Deep Analyzer")
    ap.add_argument("ticker", help="股票代码 (如 601288.SS, AAPL)")
    ap.add_argument("--period", default="6mo", help="分析周期 (1mo/3mo/6mo/1y/2y)")
    ap.add_argument("--output", default="text", choices=["text", "json"])
    args = ap.parse_args()

    result = render_report(args.ticker, args.period)
    if args.output == "json" and result:
        import json
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
