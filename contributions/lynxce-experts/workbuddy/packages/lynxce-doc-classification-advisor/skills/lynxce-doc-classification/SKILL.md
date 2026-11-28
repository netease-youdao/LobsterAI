---
name: lynxce-doc-classification
version: 1.0.1
description: Reconcile copy numbers and compute loan due dates, overdue days, control
  expiry and disposal dates for internal sensitive documents.
display_name: 份数核对与期限计算
author: 灵策智算 LynxceAI
category: tools
---
# 份数核对与期限计算
用于传阅、借阅和销毁环节的数字核对。只处理份数、份号和日期，不读取、不要求提供文件正文。
1. 份数平衡：印制份数 + 批准复印份数 = 归档保存 + 本次销毁 + 历史已销毁 + 外发未收回 + 在借未还。差额不为零时列出缺失份号，暂停销毁签字并上报。
2. 份号连续性：列出登记簿全部份号，检查重号与跳号；复印件从已有最大份号加一续编，并注明来源份号与批准人。
3. 借阅应还日：借出当日不计，从次一工作日起数第 N 个工作日，N 默认5。逾期工作日 = 应还日之后至实还日（含）的工作日数；逾期第1个工作日提醒，第3个工作日上报部门负责人。
4. 受控期限：事件日 + 约定自然日；到期日为休息日时，降级或销毁安排在下一个工作日。无事件条件的文件，复审日 = 上次复审日 + 12个月。
5. 会议回收：发放份数 − 收回份数 = 待查份数，大于零时当场按份号核对。
工作日以用户提供的单位日历为准，没有日历时按周一至周五计算并注明。结果填回包根目录 references/workbook.md 的借阅台账、份数核对与销毁清单。
