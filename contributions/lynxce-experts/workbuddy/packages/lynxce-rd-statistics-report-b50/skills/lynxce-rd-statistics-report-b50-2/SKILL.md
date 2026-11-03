---
name: lynxce-rd-statistics-report-b50-2
display_name: "人员人月勾稽"
display_name_en: "R&D Statistics Reporting Advisor"
description: "Prepare traceable enterprise reporting materials, reconcile source records and produce complete correction drafts."
description_zh: "为企业统计与研发人员核对调查口径，勾稽项目人数、人月和经费，形成研发统计底稿及完整更正说明。"
description_en: "Prepare traceable enterprise reporting materials, reconcile source records and produce complete correction drafts."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 人员人月勾稽
本能力面向企业统计和研发管理，按唯一人员与项目把实际工作时间展开，解决项目人数重复、企业人数去重及跨项目工时超限。输入需有内部人员唯一编号、实际参与项目、报告期逐月时间、人员费用对应记录和项目形式；只给计划排班时不能认作实际。姓名重复而无编号关系不自动合并，不要求提供不必要个人敏感资料，可保留企业内部脱敏标识。项目人数、企业唯一人数、人月和全职分类四者分别处理。

先逐项目加人员时间，再逐人跨项目求和，最后检查项目总量与企业总量审核关系。完整自然年人月按已核规则每人不超过12，若人员中途加入还应结合实际可工作时间核，不把12当任何人都可填的额度。两个自主项目同一A均出现，在各项目人数可计参与，但企业人数A只计一次；不能把2加2写成企业4人，也不能把19人月叫19名人员。缺逐月记录时只指出无法核实分配，不能按工资比例反推一定工时。

虚构基线P1 A6、B3共9人月，P2 A4、C6共10，企业A、B、C3人；A共10、B3、C6，总19且不超过36。新增P1 A9使P1为12、总22，A9加4为13，虽22不超过36仍有单人超12问题。P3为适用2025表的委托形式31，人员字段免填，不参与补造零人月，也不拿受托机构人数填入本企业唯一人数。时间原件未确认前两版并列，不能把A随意减掉一个人月凑过。

交付包含全项目时间表、逐人汇总、重复参与与企业唯一人数说明、冲突核实稿；V2复列所有人员、项目期间、原值及新主张，不只回复一行超时。可编辑条目是“人员【】、项目【】、月份记录【】、实际时间【】、交叉项目【】、可用时间依据【】、冲突【】”。完成标准为逐行逐列独立复算、所有免填未知保持、单人约束与汇总关系均检查。全职人员还需实际时间占制度工作时间等对应证据，不能仅凭10或12人月就自动判全职；本能力不代造考勤、不代报、不声称统计审核接受。

