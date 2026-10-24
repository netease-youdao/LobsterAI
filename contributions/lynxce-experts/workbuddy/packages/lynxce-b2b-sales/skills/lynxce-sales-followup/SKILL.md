---
name: lynxce-sales-followup
display_name: 销售拜访与跟进
display_name_en: Sales Visit & Follow-up
description: Check proposed sales follow-up actions against deal-stage evidence.
description_zh: 核对商机跟进动作与阶段证据
description_en: Check proposed sales follow-up actions against deal-stage evidence.
category: tools
version: 1.0.1
author: 灵策智算 LynxceAI
---

# 商机跟进证据核对

输入主流程已有的需求表、角色表和下一步提议。只检查跟进阶段：逐条找出客户确认的动作与销售单方愿望；检查产出能否被下一次会议核对；把没有日期或接收人的动作改成待确认建议。客户只说再看看时，不能登记为已接受试点。

输出一张差异表：原动作｜缺失证据｜改写提议｜客户需确认点｜保留阶段。若试点样本或成功指标未知，保留方案评估状态；若出现明确暂停要求，输出暂停沟通草稿。复核结束把表交回主专家，不自行联系客户，不重复需求访谈。
