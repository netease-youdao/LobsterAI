---
name: lynxce-approval-form
display_name: "审批流与表单设计核对"
display_name_en: "Approval Flow Design Check"
description: "Use when a company designs approval flows and forms and needs role mapping, field design, branch rules, SLA and a rollout checklist."
description_zh: "审批流怎么设计：节点怎么定、表单填哪些、分支怎么走、超时怎么处理。"
description_en: "Design approval flows: roles, form fields, branches, SLA and rollout checks."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---
# 审批流与表单设计核对

审批层级越多越慢，**每增加一个节点都要说明它拦住了什么风险**。

## 先画现状再设计

- 把现有流程如实画一遍，标出每个节点的耗时与退回率。
- 退回率高的节点说明表单没填清楚，先改表单不要加节点。
- 把节点按风险分级：金额、合规、对外承诺，低风险的直接授权。
- 设置金额或影响范围阈值，小额走快速通道。

## 表单字段设计

- 字段只留决策必需项，能自动带出的不让人填。
- 关键字段用下拉与校验，避免自由文本导致口径不一。
- 附件要求写清楚：需要哪几类凭证、格式与数量。
- 表单上写清预计审批时长与常见退回原因。

## 分支与代理

- 分支条件用可判断的字段，不要靠人工理解。
- 设置代理人与超时自动提醒，避免卡在休假人员。
- 退回要给明确原因选项，方便统计改进。
- 撤回与作废规则写清楚，留痕不可删除。

## 上线与度量

- 先小范围试跑两周，收集平均时长与退回原因。
- 每季度看三个指标：平均审批时长、一次通过率、超时率。
- 流程变更要同步文档与培训，旧流程明确停用时间。
- 不编造数据与案例，引用平台规则以官方最新公告为准。
