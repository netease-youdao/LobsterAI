---
name: stock-explorer
description: >-
  A Yahoo Finance (yfinance) powered financial analysis tool.
  Get real-time quotes, generate technical indicator reports (RSI/MACD/Bollinger/VWAP/ATR),
  summarize fundamentals, and run a one-shot report that outputs a text summary.
official: true
---

# Stock Information Explorer

This skill fetches OHLCV data from Yahoo Finance via `yfinance` and computes technical indicators **locally** (no API key required).

## Dependencies

Python packages (install once):

```bash
pip install yfinance rich pandas plotille
```

## Commands

**IMPORTANT:** Always use the `$SKILLS_ROOT` environment variable to locate scripts.

### 1) Real-time Quotes (`price`)

```bash
python "$SKILLS_ROOT/stock-explorer/scripts/quote.py" price TSLA
# shorthand
python "$SKILLS_ROOT/stock-explorer/scripts/quote.py" TSLA
```

### 2) Fundamental Summary (`fundamentals`)

```bash
python "$SKILLS_ROOT/stock-explorer/scripts/quote.py" fundamentals NVDA
```

### 3) ASCII Trend (`history`)

```bash
python "$SKILLS_ROOT/stock-explorer/scripts/quote.py" history AAPL 6mo
```

### 4) Professional Analysis (`pro`)

输出详细的技术指标文本分析报告。

```bash
# 基础分析（价格区间）
python "$SKILLS_ROOT/stock-explorer/scripts/quote.py" pro 002368.SZ 6mo

# 带技术指标
export PYTHONIOENCODING=utf-8
python "$SKILLS_ROOT/stock-explorer/scripts/quote.py" pro 002368.SZ 6mo --rsi --macd --bb
```

#### 可用指标 (optional)

- `--rsi` : RSI(14) - 超买超卖指标
- `--macd`: MACD(12,26,9) - 趋势动量指标
- `--bb`  : Bollinger Bands(20,2) - 布林带
- `--vwap`: VWAP - 成交量加权均价
- `--atr` : ATR(14) - 平均真实波幅

### 5) One-shot Report (`report`)

输出综合分析报告（行情+基本面+技术信号）。

```bash
export PYTHONIOENCODING=utf-8
python "$SKILLS_ROOT/stock-explorer/scripts/quote.py" report 000660.KS 6mo
```

## Ticker Examples

- A-share: `600519.SS`, `000001.SZ`
- US stocks: `AAPL`, `NVDA`, `TSLA`
- HK stocks: `0700.HK`, `9988.HK`
- Crypto: `BTC-USD`, `ETH-KRW`
- Forex: `USDKRW=X`

## Notes / Limitations

- Indicators are **computed locally** from price data
- Data quality may vary by ticker/market
- 所有输出均为文本格式
- Windows 环境中文显示需设置 `export PYTHONIOENCODING=utf-8`
