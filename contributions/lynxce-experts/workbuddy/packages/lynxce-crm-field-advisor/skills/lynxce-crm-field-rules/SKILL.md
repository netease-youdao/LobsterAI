---
name: lynxce-crm-field-rules
display_name: 客户资料字段与录入规范
display_name_en: CRM Field and Data Entry Rules
description: Review CRM duplicate candidates and field-level merge conflicts without changing records.
description_zh: 复核疑似重复组的合并预案
description_en: Review CRM duplicate candidates and field-level merge conflicts without changing records.
category: business
version: 1.0.1
author: 灵策智算 LynxceAI
---

# 重复组人工复核

输入候选组与字段字典，对每组按主体证据、字段冲突、关联记录三个维度核对。缺主体证据只做候选，不给最终合并指令；每个待舍弃值都必须保留来源。列出原记录数、拟保留数、拟冗余数和关联对象数，前后数量应对得上。

输出：组号｜原编号｜已确认主体证据｜建议主记录｜字段冲突｜关联数量｜人工确认人｜复查条件。两行属于不同分支时结论为保留分开；姓名或电话相同不足以覆盖分支证据。将预案交回专家，不生成可直接删除记录的命令。
