---
name: lynxce-task-followup
display_name: 督办台账与催办
display_name_en: Action Item Tracking Ledger
description: Review closure evidence and reconcile opening and closing action counts.
description_zh: 核对销号证据与台账守恒
description_en: Review closure evidence and reconcile opening and closing action counts.
category: tools
version: 1.0.3
author: 灵策智算 LynxceAI
---

# 销号及快照核对

接收两期台账与验收材料，只核对结项和数量。逐编号匹配产物版本、完成标准和验收人确认；仅有上传记录不能算通过验收。拒收或待修订意见存在时，保留待验收状态并记录原因。

核对期初未销号＋新增−本期销号−本期批准取消＝期末未销号。若数量不平，先查重复编号、节点重复计数和跨期销号，不手工填平。输出差异表：编号｜原状态｜证据状态｜建议状态｜确认角色｜对统计的影响；不向任何人发送结果。
