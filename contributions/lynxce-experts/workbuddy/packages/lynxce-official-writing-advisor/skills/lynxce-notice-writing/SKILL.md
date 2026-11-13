---
name: lynxce-notice-writing
display_name: 通知事实与多版本一致性复核
display_name_en: Notices and Official Document Format
description: Check notice dates, counts, attachments and consistency across full and
  short versions.
description_zh: 校验日期时段人数附件与短讯之间的一致性
description_en: Check notice dates, counts, attachments and consistency across full
  and short versions.
category: office
version: 1.0.2
author: 灵策智算 LynxceAI
---
# 通知事实与多版本一致性复核

逐条抽取正文、短讯、附件中的对象、日期时段、地点、数量、截止、动作与版本，建立一份事实对照表。检查数字是否同口径，活动总时长是否等于各段之和，分组人数是否分别满足对应容量。星期若未核对不添加，不能为了格式完整而猜。

把修改分类为文字润色和事实变更；事实变更必须指向输入来源，无法找到来源就退回待确认。短讯字数按实际字符数核对且保留必需例外。输出“原句／问题类型／拟改句／依据／是否需负责人确认”，最后列尚未解除的发布阻断，不以修辞通顺代替事实核实。

复核前读取 `../../references/workbook.md` 中的输出模板、示例与静态案例；只返回差异和修订行，交回专家合并，不重复整份初稿。
