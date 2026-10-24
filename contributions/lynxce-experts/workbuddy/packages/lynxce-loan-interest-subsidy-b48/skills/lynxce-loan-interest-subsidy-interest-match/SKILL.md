---
name: lynxce-loan-interest-subsidy-interest-match
display_name: "付息与代付勾稽"
display_name_en: "Loan Interest Subsidy Advisor"
description: "Turn actual project records and applicable policies into traceable application drafts and correction notes."
description_zh: "为企业财务拆分贷款本金、利率、天数与实际付息，核对贴息上限和重复支持，形成测算底稿及申请补正说明。"
description_en: "Turn actual project records and applicable policies into traceable application drafts and correction notes."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 实际付息与既有贴息勾稽
本能力区分银行合同利息、本金、罚息手续费、企业净付与财政代付，避免把同一利息申请两次。最低输入是逐期扣息明细、所属借据与期间、已贴息或代付通知、还款组成、冲红和退款。只有一张扣款总额不能全计利息；未提供付息证明是未知，不是0。已付金额若大于或小于按合同算的应计额，先核期间与组成，不为凑一致改付款凭证。没有依据不称逾期或违法。
政策规定银行收息时代财政支付时，将应收利息、企业净支出、财政代付与历史申报分别列。企业只净付一部分不代表全部合规利息只有净付部分，也不能因财政代付已发生继续申请相同中央贴息。某本轮政策明确以该段已付实际利息为上限时，先弄清其定义及是否含已贴息，按原文处理；不得把此样例上限反套所有中央政策。现有政策未给细则就交询证稿，不假称银行审核确认。
模拟L01明确此前无贴息、仅以各段真实已付合规利息限额：第一段理论7500、已付9000，取7500；第二段理论约3033.33、已付3000，取3000。总已付12000不等于可贴息额10500；还本金800000、手续费500排除，不能先加到利息再乘补助率。新增第一段摘要6000与旧9000冲突时两者并存，第二段仍3000，补贴情境10500与9000。差额是1500而不是两张付息摘要差3000。交付完整付款匹配台账、金额解释与需要核原始组成的请求，不能把冲突自动写笔误，不能把文稿形成称实际结算。
扣息凭证若混有多借据或跨期金额，先要求逐笔组成及所属区间，不按有利比例摊给本项目。银行已代付财政金额与企业净付分别保留，支付总数不能在不明组成时被当作实际全部利息。
