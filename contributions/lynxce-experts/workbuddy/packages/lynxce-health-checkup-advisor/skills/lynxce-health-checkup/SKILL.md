---
name: lynxce-health-checkup
version: 1.0.1
description: Compute tier budgets, provider scores, daily caps, schedule dates and
  anonymous review rates for a welfare health checkup.
display_name: 预算比选与排期计算
author: 灵策智算 LynxceAI
category: tools
---
# 预算比选与排期计算
用于福利体检的预算、机构评分与排期计算。只使用分组人数、报价与机构接待能力，不接触任何个人健康信息。
1. 预算：各档小计 = 人数 × 单价；总额 = 各档小计之和；人均 = 总额 ÷ 总人数，保留两位小数；预算结余 = 人均预算 × 总人数 − 总额。
2. 评分：先过门槛再评分，门槛有一项不满足即不评分。报告时效以10个工作日内为满分20分，每超1个工作日扣1分，扣完为止；各项之和为总分，总分相同时比较项目同等分。
3. 排期：每日上限 = floor(机构日接待量 × 0.6)；所需天数 = ceil(参检人数 ÷ 每日上限)，另加1个补检日；部门跨天拆分时每天人数不超过上限。
4. 日期：须知发出日 = 首批日期往前数第5个工作日；改期截止 = 各批日期往前数第2个工作日；跳过用户提供的节假日与关键期。
5. 复盘：到检率 = 实检 ÷ 应检；改期率 = 改期人数 ÷ 应检；按实际到检结算额 = 总额 − Σ（各档未到检人数 × 该档单价）；报告按时率 = 按时送达份数 ÷ 实检人数。匿名汇总中任一分组少于10人时，与相邻组合并后再统计。
结果写代入值和取整方式，填回包根目录 references/workbook.md。
