---
name: lynxce-prepayment-receipt-credit-b49
display_name: "完税抵减修订"
display_name_en: "Cross Region Construction VAT Prepayment Advisor"
description: "Reconcile cross-region construction receipts, paid subcontract costs and actual VAT prepayments in project-level drafts."
description_zh: "为跨地区建筑企业财务核对项目地点、已付分包与预缴凭证，形成逐项目税款台账、抵减说明和冲突补正稿。"
description_en: "Reconcile cross-region construction receipts, paid subcontract costs and actual VAT prepayments in project-level drafts."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 完税抵减修订
把预缴测算、实际完税、机构抵减和结转分成四个状态，并用真实凭证衔接。2026年第14号办法第二十七条允许实际预缴凭完税凭证抵减当期应纳增值税，抵不完结转下期；它不是期末进项留抵退税，也不是一份测算表就可提前抵税。输入原完整项目台账、完税凭证及所属、机构抵减前应纳额、期初待抵及其他抵减、新证据和真实申报状态。

假设A测算16000元且P1摘要证明实际预缴16000元，B测算8000元但尚未预缴，机构给定抵减前30000元且无期初其他预缴。仅按A凭证有效可用条件演示抵后14000元，不能把B尚未实缴8000提前抵后写6000。若B后来真实预缴且同期待抵条件成立，24000全额抵后的6000才是条件数，不称已确认或已缴；若机构税不够，余款按真实凭证结转而非自动退。

新增A分包支付冲突可能使预缴测算从16000变条件14000，但P1原已缴事实仍16000。不能根据新内部计算把完税凭证改为14000，也不能把2000差额直接挪给B。先核实际预缴申报、更正和差额处理及真实回执；未有变更前机构桥只在P1现有有效可用条件下说明，后续凭证及可抵资格变化须同步核。B预收545000、实付109000、测算8000和未缴状态、机构30000及其他余额事实均全量保留。

可复制V2段：“本版新增【支付冲突来源】，原【价款、分包及测算】与新条件【值】并列；原完税【编号金额】保持实际事实。差额【值】待核正式更正及处理，不称已退抵。其他项目【全量值状态】不变，机构【给定应纳及真实可抵】仅条件演示，未给提交和核准不能补成已完成。拟材料实际附入及签署待核。”交全量项目表、机构桥、实质修订说明及询证，不制造回执或承诺退款。完成标准为测算与缴款分清、同笔不重缴不重抵、余款和负分包余额不同、所有未变对象和状态忠实。
