---
name: lynxce-decision-memo
display_name: 决策备忘录与方案对比
display_name_en: Decision Memo and Option Comparison
description: Recalculate weighted option scores and compare alternative weighting scenarios.
description_zh: 复核权重与敏感性计算
description_en: Recalculate weighted option scores and compare alternative weighting scenarios.
category: office
version: 1.0.2
author: 灵策智算 LynxceAI
---

# 权重敏感性复核

接收主专家已经定义的标准、量表和评分依据。检查每组权重合计一百，评分在一到五之间；排除已不满足硬约束的方案。逐方案展开乘法及总和，然后仅改变权重，保持评分不变，避免同时换多种假设而无法归因。

输出：情景｜权重｜各方案总分｜排序｜是否翻转｜决定性维度。若存在未知评分，展示区间或待补材料，不将中间分当成证据。只校验计算和排序，把业务取舍交回主专家，不重复撰写备忘全文。
