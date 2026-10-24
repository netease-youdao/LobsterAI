---
name: lynxce-work-report
version: 1.0.1
description: Check report figures, percentage-point changes, period comparisons, overdue
  days and weekdays before a document goes out.
display_name: 汇报数据与日期核对
author: 灵策智算 LynxceAI
category: tools
---
# 汇报数据与日期核对

用于在周报、月报、邮件和纪要定稿前核对数字与日期。每个数字都要能回溯到用户材料的编号；材料里没有的写【待补充】，不估算、不取整美化。

比率变化：同时写百分点变化和相对变化，例如从百分之二点一到百分之三点四，是提升一点三个百分点，相对提升约百分之六十一点九，二者不能混用。环比 = （本期 − 上期）÷ 上期；同比 = （本期 − 去年同期）÷ 去年同期；完成率 = 实际 ÷ 目标；上期或目标为零时写“不适用”。节省金额 = （原单价 − 新单价）× 用量，用量和时间范围必须写明来源，没有用量不写年化金额。

日期：汇报周期写起止日期和星期；逾期天数 = 核对日 − 到期日；行动项截止日写星期并确认不早于会议日。跨时区写明时区，如 10:00 (GMT+8)，英文日期用 20 Nov 2026 这类不会把月日看反的写法。

篇幅：周报建议四百字内、月报八百字内，超出时先删过程描述，不删风险与求助事项。

核对后单独列出“留空待补项”和“数字来源对照”，填回包根目录 references/workbook.md。
