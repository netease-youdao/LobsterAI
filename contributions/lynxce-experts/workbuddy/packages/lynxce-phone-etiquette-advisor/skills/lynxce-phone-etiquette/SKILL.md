---
name: lynxce-phone-etiquette
version: 1.0.2
description: Compute call category shares, routing coverage, handover times, callback
  deadlines and spot-check scores from supplied records.
display_name: 来电分流覆盖率与抽查评分口径
author: 灵策智算 LynxceAI
category: tools
---
# 来电分流覆盖率与抽查评分口径

只用用户提供的来电记录与抽查结果计算；没有记录时只交模板，覆盖率与平均分写【材料待确认】，不凭印象估比例。

一、占比等于该类来电数除以统计期来电总数。先核对各类合计等于总数，不相等时补一行“未分类”。

二、累计覆盖：按数量从高到低累加，直到不少于百分之八十；投诉、媒体和涉及安全的类型无论数量多少都单列，单列后重新计算总覆盖率。

三、转交用时等于转交时间减记录时间，按分钟计，与十分钟要求比较；回电截止为记录日之后的下一个工作日下班前，跳过周末与公司休息日。

四、单通得分等于五项得分之和，满分一百；接起时长按十五秒内、十六到三十秒、超过三十秒三档给分。保密与合规出现一票否决情形时，该通记为不达标，总分照常记录。

五、月度：平均分等于各通总分之和除以抽查通数；达标率等于达标通数除以抽查通数。抽查少于十通时注明样本量，不与上月直接比较涨跌。

六、把代入数据、计算结果和改进项写回包根目录 references/workbook.md 的来电分类、留言单与抽查评分行。
