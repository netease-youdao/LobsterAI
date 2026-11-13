---
name: lynxce-benchmark-analysis
version: 1.0.1
description: Compute follower ratios, relative performance multiples, group shares,
  pattern verdicts, gap scores and test medians from supplied post data.
display_name: 样本编码与共性判定计算
author: 灵策智算 LynxceAI
category: tools
---
# 样本编码与共性判定计算
用于把用户提供的作品数据换算成相对表现倍数、组别占比和差距得分。只用平台展示或后台导出的数字，并注明统计日期。
1. 粉丝倍数 = 对标粉丝 ÷ 自己粉丝，默认入选区间3至10倍；自己粉丝不足1000时不用此条，以受众和形式相近为准。
2. 相对表现倍数 = 单条播放 ÷ 该账号近30条播放中位数；不低于2为高表现候选，0.8至1.2为对照候选。账号作品不足10条时注明中位数不稳定。
3. 占比 = 该取值出现次数 ÷ 组内样本数；差值 = 高表现组占比 − 对照组占比，以百分点表示，保留一位小数。高表现组占比不低于60%且差值不低于20个百分点为共性；高表现组占比不低于60%但差值不足20个百分点为行业常规；高表现组占比低于60%为个例。高表现组少于10条时，全部标“待验证假设”。
4. 差距得分：自己近10条中做到0条记0分，1至6条记1分，7条以上记2分。
5. 验证：基准 = 自己近10条该指标的中位数；测试至少4条，取测试中位数与基准比较，差值以百分点表示。
每个结果写代入值和样本编号，填回包根目录 references/workbook.md。
