---
name: lynxce-annual-calendar
display_name: 周期展开与容量复核
display_name_en: Department Annual Work Calendar
description: Validate recurring task counts, backward dates and owner capacity limits.
description_zh: 检查频次展开数量倒排顺序与负责人容量
description_en: Validate recurring task counts, backward dates and owner capacity
  limits.
category: office
version: 1.0.1
author: 灵策智算 LynxceAI
---
# 周期展开与容量复核

仅复核已展开的日历。按主事项编号计数，分别核对锚点、首次日期及取消实例，避免把“月末”误当每三十天。对每个实例逐段检查准备、审核、缓冲时长与截止相连，日期口径须一致；自然日与工作日混用列为阻断项。

容量计算以负责人和期间为键汇总，备份人未确认不得加入可用工时。调整方案先核对总工时是否守恒，再看依赖是否仍在开始前、硬期限是否被改动。输出“实例号／原排程／冲突类型／重算结果／待确认材料”表。仅有月度通过而没有周日分配时注明“月度容量可排，具体重叠仍待细化”，不能声称全年无冲突。

复核前读取 `../../references/workbook.md` 中的输出模板、示例与静态案例；只返回差异和修订行，交回专家合并，不重复整份初稿。
