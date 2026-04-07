---
name: stock-analyzer
description: >-
  A comprehensive stock deep analysis tool that combines real-time quotes, fundamental metrics,
  technical indicators, and growth analysis into a single professional report.
  Supports A-share, US stocks, HK stocks. Generates detailed investment recommendations
  with risk assessment and actionable trading strategies.
official: true
---

# Stock Deep Analyzer

One-stop comprehensive stock analysis tool that generates professional-grade investment reports.

## Features

- **Real-time Market Data** — Current price, volume, market cap, beta
- **Value Investing Metrics** — P/E, P/B, ROE, ROA, dividend yield, payout ratio
- **Technical Indicators** — MA5/20/60, RSI, MACD, Bollinger Bands, VWAP
- **Growth Analysis** — Revenue growth, earnings growth, profit margins
- **Financial Health** — Asset/liability ratio, liquidity ratio
- **Investment Rating** — Multi-dimensional scoring (value 35% / technical 25% / growth 25% / financial 15%)
- **Trading Strategies** — Long-term hold, swing trade, short-term speculation
- **Risk Assessment** — Key risks and price levels

## Dependencies

Python packages (install once):

```bash
pip install yfinance pandas numpy
```

## Usage

**IMPORTANT:** Always use the `$SKILLS_ROOT` environment variable to locate scripts.

### Basic Analysis

```bash
export PYTHONIOENCODING=utf-8
python "$SKILLS_ROOT/stock-analyzer/scripts/analyze.py" 601288.SS
```

### Specify Analysis Period

```bash
export PYTHONIOENCODING=utf-8
python "$SKILLS_ROOT/stock-analyzer/scripts/analyze.py" 000001.SZ --period 1y
```

### US Stocks

```bash
export PYTHONIOENCODING=utf-8
python "$SKILLS_ROOT/stock-analyzer/scripts/analyze.py" AAPL
```

### Parameters

| Parameter | Description | Example | Default |
|-----------|-------------|---------|---------|
| `ticker` | Stock ticker symbol (required) | 601288.SS, AAPL | - |
| `--period` | Analysis period | 1mo, 3mo, 6mo, 1y, 2y | 6mo |
| `--output` | Output format | text, json | text |

## Stock Ticker Formats

- **A-share (Shanghai)**: `600519.SS`, `601288.SS`
- **A-share (Shenzhen)**: `000001.SZ`, `002594.SZ`
- **US stocks**: `AAPL`, `TSLA`, `NVDA`
- **HK stocks**: `0700.HK`, `9988.HK`

## Output Structure

The analysis report includes 8 sections:

1. Real-time Market Overview
2. Value Investing Indicators (Score /10)
3. Technical Analysis (Score /10)
4. Growth Indicators (Score /10)
5. Financial Health (Score /10)
6. Comprehensive Investment Rating (Overall /10)
7. Recommended Trading Strategies
8. Key Risk Warnings

## Workflow

When user requests stock analysis:

1. **Identify ticker symbol**
   - User may provide company name → use web-search to find ticker
   - A-share: Shanghai = `.SS`, Shenzhen = `.SZ`

2. **Execute analysis**
   ```bash
   export PYTHONIOENCODING=utf-8
   python "$SKILLS_ROOT/stock-analyzer/scripts/analyze.py" <ticker>
   ```

3. **Interpret results**
   - Extract overall rating and key findings
   - Highlight investment recommendation
   - Emphasize risk warnings
   - Provide actionable price levels

## Limitations

- Yahoo Finance data quality varies by market
- Some metrics may be N/A for loss-making companies
- Historical data limited for newly listed stocks
- Real-time quotes may have 15-min delay

## When to Use This Skill

- User requests "深度分析", "complete analysis", "comprehensive report"
- User wants multi-dimensional evaluation (value + growth + technical)
- User needs actionable trading strategies
- User asks for investment recommendations with risk assessment
