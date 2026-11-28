---
name: lynxce-data-collect
display_name: 数据填报收集与汇总核对
display_name_en: Multi-Team Data Collection
description: Check component totals and weighted aggregate ratios in supplied reporting data.
description_zh: 复核分项合计与总体比率口径
description_en: Check component totals and weighted aggregate ratios in supplied reporting data.
category: data
version: 1.0.1
author: 灵策智算 LynxceAI
---

# 汇总算式复核

输入已通过单位与版本检查的明细，只承担加总与比率阶段。列出参与计算的行编号，注明分子和分母；总计复核到分项，发现差值保留原报数及计算数。占比、达成率必须先合计数量再相除，分母零时写不适用。

输出：指标｜参与行｜原报值｜复算式｜复算值｜差值｜待确认原因。未交单位只进入覆盖率分母，不编成零收入。若有金额币种或组织包含关系未解决，退回主专家列差异，不继续求总和。
