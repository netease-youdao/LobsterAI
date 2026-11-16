---
name: lynxce-policy-revision
version: 1.0.1
description: Check a change table for type, numbering and value differences, then
  compute acknowledgement rates and key dates.
display_name: 新旧对照与已读率核算
author: 灵策智算 LynxceAI
category: tools
---
# 新旧对照与已读率核算

本技能在对照表初稿完成后和已读确认截止前各用一次，只核对用户提供的条款文本与人数，不发送通知、不接入任何办公系统。

对照表核对：每一行必须是新增、修改、删除、仅编号调整四类之一。旧条款数 - 删除数 + 新增数 = 新条款数，不相等说明有遗漏。数值类变化写旧值、新值、差额和变化比例，变化比例 = 差额 ÷ 旧值。删除条款必须写替代做法或“不再要求”；仅编号调整要列出全部旧号与新号的对应关系。

日期核对：发布日早于生效日，二者间隔要够宣贯；已读确认截止日早于生效日；影响清单中每项完成日期不晚于确认截止日；过渡期起止写明适用事项；复盘日 = 生效日加一个月。任一日期顺序颠倒即标冲突。

已读率：应确认人数 = 部门在册人数 - 截止前无法确认的长期休假人数，休假人员单列返岗后补确认。完成率 = 已确认 ÷ 应确认。已确认大于应确认时标数据冲突，不计算。把核对结果填回包根目录 references/workbook.md 的对照表与确认统计表。
