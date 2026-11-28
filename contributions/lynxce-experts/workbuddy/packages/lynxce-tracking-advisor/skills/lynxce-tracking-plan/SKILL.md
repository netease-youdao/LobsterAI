---
name: lynxce-tracking-plan
version: 1.0.1
description: Reconcile event counts across raw, deduplicated and eligible records
  using supplied aggregates.
display_name: 事件计数对账
author: 灵策智算 LynxceAI
category: tools
---
# 事件计数对账
先确定比较单位与日期边界，再按固定顺序记录原始条数、重试重复、测试数据、窗口外记录、有效记录。后一步排除必须作用于前一步剩余集合；没有互斥证据时不能直接相减，应列重叠数量待确认。字段缺失与业务失败分开统计，失败事件仍可能是有效事件。
对账等式为原始总数减逐层互斥排除数等于有效数。若比较业务订单与事件，先把事件收敛到订单主键，说明一笔订单多次状态变化如何保留最终状态。给每个差异项附材料编号和责任角色，不把尚未解释的差额塞入“其他”。留存去重前后的数量与规则版本，才能辨别是流量下降还是规则变更。
将核对结果填入包根目录 references/workbook.md 的对账表。此技能只按用户提供的样本与汇总推演，不查询数据库、不安装采集代码、不恢复未采集的历史事件。
