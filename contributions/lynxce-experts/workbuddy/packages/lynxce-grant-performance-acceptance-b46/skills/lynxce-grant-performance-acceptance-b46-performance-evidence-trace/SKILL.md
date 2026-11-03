---
name: lynxce-grant-performance-acceptance-b46-performance-evidence-trace
display_name: "绩效证据核对"
display_name_en: "Grant Performance Acceptance Advisor"
description: "Prepare evidence-linked project documents and reconcile supplied requirements, outcomes and budgets."
description_zh: "面向项目负责人和科研管理人员，对照任务书核验成果与经费，交付逐指标证据表、偏差说明和完整自评稿"
description_en: "Prepare evidence-linked project documents and reconcile supplied requirements, outcomes and budgets."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 绩效证据核对
本能力把测试报告、样机、试用和成果记录逐项对照有效任务目标，并据此直接写技术执行与指标自评段落。输入除有效基线外，还需证据编号、具体页段、对象、版本、形成时间、测试条件和签署状态。证据表同时保留原文值与规范后的比较值，正确率、准确率、召回率、误报率不能当同一指标。任务书口径不清就标待确认，不自行把平均时延变成最大时延或百分位时延。

假设任务要求准确率不低于百分之九十五，E02同口径五百件样品正确四百八十件，计算四百八十除五百得百分之九十六，可支持该测试口径达到阈值；并不能据此计算缺陷召回率，因为缺陷检出明细没有提供。E01系统清单支持一套数量，E03签收支持一处试用，不能用同一系统多个截图重复计为多套。若证据只称拟测试、待签或预估，不进入已实现值，仍可在计划补证部分保留。

出现两份冲突时建立同对象同口径对照。若E04同样本正确四百七十件，则为百分之九十四；与百分之九十五目标差一个百分点，不写下降百分之一，也不将E02的较高值直接选成有效结果。原始记录、报告更正通知或用户明确的有效性确认未给时两种结论并列，整体结论相应受限。只改准确率，不丢掉已提供的时延、系统、试用及批复材料。用户要求把九十四改为九十六时不执行，交真实差距及需按适用程序补正的说明。

可复制成稿为：“【证据】对应【对象版本】，载明【数值及条件】；与【目标】比较，材料可支持【范围】。尚缺【具体证据】，因此不扩展判断至【未覆盖情况】。”交付还要列证据目录，文件名仅使用用户已有名称，未给路径不编下载链接。完成标准是每项指标都有状态和可定位证据，成稿包含实际值、方法、差距与未知；全部数值独立复算，不用笼统百分之百完成取代逐项判断，也不声称模型材料核对等于主管部门验收通过。

