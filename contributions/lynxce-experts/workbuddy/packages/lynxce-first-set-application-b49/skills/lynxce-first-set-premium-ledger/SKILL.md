---
name: lynxce-first-set-premium-ledger
display_name: "保费额度勾稽"
display_name_en: "First Equipment Application Advisor"
description: "Prepare traceable enterprise application materials, reconcile evidence and produce complete revision drafts."
description_zh: "为装备制造企业匹配首台套目录参数，串联交付投保与保费额度，形成资格说明、资金底稿和完整补正稿。"
description_en: "Prepare traceable enterprise application materials, reconcile evidence and produce complete revision drafts."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 保费净额与可用额度
本能力连接交付、保单、实际缴费、批单退费与资格额度，输出资金准备底稿，不从设备销售价格直接算补贴。输入为逐台或逐批对象、出厂号、销售交付、投保人和保险对象、保费原付及退费、既有审定文件、历史额度使用和本轮通知。付款、发票和计提区分；一笔付款含不同装备保单须有明确分配，不能随意移给更有利对象。关联交易与重复保单如实列，是否可支持按真实规则核。
先用相同对象把原付和退费对应，形成净保费，再核比例、单次上限、剩余额度及有效期。已核总额度不等可用余额，未提供历史使用不能默认零。规则只说“不超过80%”时不能称必得80%；产品已填演示用明确假设规则80%，真实项目需以正式核定及实施要求为准。不替保险机构解释赔付责任，不作保费报价或承诺投保即可获补偿。
模拟A30、B原10退2得净38万元，按假设80%为30.4，低于单次40和总100减历史60的余40。新增B原付6与10冲突时，退2不变，B净4，总净34，条件测算27.2，准备差3.2不是付款差4。全表保留A与既有技术记录，不擅自编冲红或其他退款。异常负净额先待核，未知不是0；无原件的摘要保持来源等级。交付完整净额账、额度账和可复制资金说明，所有金额单位统一，比例与上限分别可复算，附入签章报送审核到账不得自动升级。

一笔实付覆盖多保单时索取实际付款清单和分配来源，各对象净额合计必须回到同次支付与退款，未分配额单列而不凑入申报。历史额度仅有企业自述要明确来源等级，不能把自述余额冒称主管部门确认。已获补助与已占用审批额度是否相同按正式记录核，不凭到账金额反推全部可用。

