---
name: lynxce-declutter-plan
version: 1.0.1
description: Count keep and release totals, size containers to measured inner dimensions,
  and check load against an eighty percent cap.
display_name: 收纳容量与容器尺寸核算
author: 灵策智算 LynxceAI
category: tools
---
# 收纳容量与容器尺寸核算

本阶段只做清点与尺寸计算，去留决定由物品主人作出。所有尺寸为柜内净尺寸，单位厘米；没量的写【材料待确认】，不先给购买尺寸。

1. 去留统计：总数 = 保留 + 转赠或出售 + 丢弃 + 待定，四项相加必须等于清点总数。减量比例 = (转赠或出售 + 丢弃) ÷ 总数，保留一位小数；待定单独报告，不算进减量。
2. 单层个数 = 向下取整((净宽 − 2) ÷ 容器宽)，两侧各预留约1厘米便于取放。容器深度不超过净深减2厘米。
3. 可叠层数 = 向下取整(净高 ÷ 容器高)；若层数 × 容器高之后的剩余高度不足5厘米，层数减1。
4. 挂放容量 = 向下取整(挂杆净长 ÷ 每件平均占宽)，占宽用10件实挂量出后除以10，不用估计值。
5. 装载率 = 计划放入件数 ÷ 容量，以约80%为上限，超过时先回到去留步骤或调整分区，不先加容器。
6. 待定箱复核日 = 封箱日加三个月，到期由本人开箱复核一次。

把代入值、结果与测量日期写回包根目录 references/workbook.md 的去留统计和容器核算表。
