---
name: lynxce-holiday-duty
display_name: 主备排班覆盖与调班复核
display_name_en: Holiday Duty Roster and Handover
description: Check duty coverage, independent backups, availability and workload after
  shift changes.
description_zh: 核对每班主备独立性不可用时段与调班后的工时
description_en: Check duty coverage, independent backups, availability and workload
  after shift changes.
category: office
version: 1.0.1
author: 灵策智算 LynxceAI
---
# 主备排班覆盖与调班复核

按“业务、日期、时段”逐格核对覆盖，主值缺失与备岗待确认分别计数。可用矩阵之外的姓名视为无证据，不能以填入班表替代确认。对跨夜或连续班检查完整日期与给定休息要求；参数未给时标不能判断，不套默认法规。

调班后分别重算主值时长、待命窗口与交接占用；检查临时顶岗者原本承担的备岗是否留下缺口。输出“班号／覆盖缺口／重叠角色／调整前后小时／需确认人”表。公平性只比较同口径安排，异能力岗位不能强行平均。通过结论写“输入约束下可排，仍待人员及负责人确认”，不要写全员已经到岗。

复核前读取 `../../references/workbook.md` 中的输出模板、示例与静态案例；只返回差异和修订行，交回专家合并，不重复整份初稿。
