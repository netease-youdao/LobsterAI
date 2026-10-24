---
name: lynxce-waste-sorting
version: 1.0.1
description: Check walking distance to bin points, compute spot-check error rates,
  decide improvement actions and reconcile recycling logs.
display_name: 点位距离与错投率统计
author: 灵策智算 LynxceAI
category: tools
---
# 点位距离与错投率统计
用于点位定稿和每轮抽查后的统计阶段，只做距离、比例与对账计算，不判定处置是否合规。
点位距离：沿实际通行路线量取工位到最近点位的距离，不用直线距离。步行秒数 = 距离 ÷ 1.2米每秒；超过15秒（约18米）的工位区标“需加点位或移点位”。沿一条通道均匀布点时，点位数 = 向上取整（通道长度 ÷ 36米），点位放在各覆盖段的中点。
错投率：错投率 = 错投件数 ÷ 抽查件数，写成保留一位小数的百分数。抽查件数少于30件只报件数，不进入趋势判断。多周或多点位合计时用件数总和相除，不把各周百分数直接平均。
判定：某点位本轮错投率高于或等于上一轮，记“未下降”；连续两轮未下降，动作升级为调整点位；下降但仍高于目标值，继续改标识与桶型。目标值由行政与物业商定，没有目标值时只报趋势。
对账：季度台账合计与回收方凭证合计逐类比较，差异不为零时列出差异重量和涉及批次，暂不公示该类合计。
记录：结果写入包根目录 references/workbook.md 的抽查记录、改进判定与台账对账行，保留每轮原始件数。
