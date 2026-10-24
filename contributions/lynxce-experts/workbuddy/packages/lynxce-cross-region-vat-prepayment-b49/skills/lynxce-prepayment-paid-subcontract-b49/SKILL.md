---
name: lynxce-prepayment-paid-subcontract-b49
display_name: "分包支付核算"
display_name_en: "Cross Region Construction VAT Prepayment Advisor"
description: "Reconcile cross-region construction receipts, paid subcontract costs and actual VAT prepayments in project-level drafts."
description_zh: "为跨地区建筑企业财务核对项目地点、已付分包与预缴凭证，形成逐项目税款台账、抵减说明和冲突补正稿。"
description_en: "Reconcile cross-region construction receipts, paid subcontract costs and actual VAT prepayments in project-level drafts."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 分包支付核算
逐项目将当期全部含税价款或预收款、实际支付分包、对应合同发票和已扣范围勾稽，算一般计税建筑本期预缴。依据2026年第14号办法第五及第九条，扣除支付分包后的余额除一加适用税率或征收率再乘预征率；依第二十八条记录逐笔已付、已扣、票号、地点及项目。发票额和合同约定额不等于已支付，更不能同笔跨期重复扣。

假设A当期含税1090000元、实际付分包218000元、一般计税9%和2%预征，结果16000元；B预收545000元、实付109000元，同给定税率预征率结果8000元。分别计算，测算合计24000元不是实际完税。每张分包发票摘要含服务发生县和项目名，并有合同及付款，原件仍待核，不代改名称。若只给票不见支付，先交资料桥，不直接取票额扣除。

新增A分包汇总S1称已付327000元但原银行摘要218000元，差109000元。先保留两来源，查实际付款、是否本期本项目及此前扣除；不因新汇总或有票就承认全部付。原口径预缴16000元，确认327000均符合扣除才条件测14000元，差2000元不自动变成退款。B保留545000、109000、8000及未预缴；两项目测算24000或22000仍非已缴合计，不把A冲突扩展清空B。

扣后负余额按项目结转下期预缴继续扣，不输出负预缴自动退税，也不拿一项目负数冲另一项目正数。币种、含税或不含税口径不混，缺税率依据不默用9%，缺实际支付不填0。可复制核实稿：“【项目】当期价款【值】，原实付【值及来源】，新【票额或汇总】为【值】，差【值】待核；请给逐笔支付、票号、项目及已扣记录。条件测算【式】，实际预缴和更正结果另据凭证，不取有利版。”交完整表、逐项算式和正文，不只是计算器结果。完成标准是项目单算、支付票据对应、无重扣、公式及单位可复算，未定冲突不升级合法扣除。
