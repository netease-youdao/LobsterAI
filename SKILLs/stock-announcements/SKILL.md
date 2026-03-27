---
name: stock-announcements
description: >-
  获取A股上市公司公告信息（真实数据）。基于AkShare从东方财富网获取当日全部公告，支持按股票代码筛选、关键词过滤。
  适用于监控重大事件、业绩快报、股东变动、重组公告等投资决策关键信息。数据源：东方财富网（稳定可靠）。
official: true
---

# Stock Announcement Fetcher

获取A股上市公司的官方公告信息（真实数据），帮助投资者及时掌握重要信息披露。

## 真实数据保证

- **数据来源：** 东方财富网（通过AkShare开源库）
- **更新频率：** 实时（当日公告）
- **覆盖范围：** 全部A股上市公司
- **数据质量：** 官方权威数据

## Dependencies

Python packages (install once):

```bash
pip install akshare pandas requests PyPDF2
```

## When to Use This Skill

触发条件（用户提及以下任一场景时激活）：

1. **查询特定公司公告** — "查看五粮液最近的公告"、"002368有什么新公告？"
2. **监控特定事件** — "哪些公司今天发布了业绩预告？"
3. **投资决策辅助** — "公司有利好消息吗？"

## Usage

**IMPORTANT:** Always use the `$SKILLS_ROOT` environment variable to locate scripts.

### 基础查询

```bash
export PYTHONIOENCODING=utf-8
python "$SKILLS_ROOT/stock-announcements/scripts/announcements.py" 000858
```

### 查询最近7天

```bash
export PYTHONIOENCODING=utf-8
python "$SKILLS_ROOT/stock-announcements/scripts/announcements.py" 600519 --days 7
```

### 关键词筛选

```bash
export PYTHONIOENCODING=utf-8
python "$SKILLS_ROOT/stock-announcements/scripts/announcements.py" 600519 --keyword 业绩
```

### JSON格式输出

```bash
export PYTHONIOENCODING=utf-8
python "$SKILLS_ROOT/stock-announcements/scripts/announcements.py" 000858 --format json
```

### 提取PDF内容并总结

```bash
export PYTHONIOENCODING=utf-8
python "$SKILLS_ROOT/stock-announcements/scripts/announcements.py" 000858 --detail
```

## Parameters

| 参数 | 说明 | 示例 | 默认值 |
|------|------|------|--------|
| `stock_code` | 股票代码（必填） | 000001, 600000.SS | - |
| `--days` | 最近N天 | 7 | 30 |
| `--format` | 输出格式 | json/text | text |
| `--keyword` | 标题关键词筛选 | 业绩 | None |
| `--detail` | 提取PDF内容并总结 | — | false |

## Workflow

### Step 1: 识别股票代码

用户可能提供以下任一格式：
- 公司名称："五粮液" → 先用 web-search 查询股票代码
- Yahoo Finance格式："000858.SZ" → 提取纯数字代码
- 纯代码："000858" → 直接传递

### Step 2: 执行查询

```bash
export PYTHONIOENCODING=utf-8
python "$SKILLS_ROOT/stock-announcements/scripts/announcements.py" <股票代码> [参数]
```

### Step 3: 解读结果

Agent 应该：
1. 提取关键信息（标题、类型、日期）
2. 分类汇总（业绩类、股东类、重大合同等）
3. 标注重要性（🔴高/🟡中/⚪低）
4. 提供简洁解读

## Limitations

1. **只能查询当日公告** — AkShare 的 `stock_notice_report` 接口只返回指定日期的全部公告
2. **查询速度约7-10秒** — 需遍历1000+条公告
3. **中文显示乱码** — Windows PowerShell GBK编码问题，使用 `--format json` 可规避
