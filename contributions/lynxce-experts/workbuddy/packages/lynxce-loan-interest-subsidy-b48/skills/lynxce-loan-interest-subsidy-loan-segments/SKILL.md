---
name: lynxce-loan-interest-subsidy-loan-segments
display_name: "本金利率分段"
display_name_en: "Loan Interest Subsidy Advisor"
description: "Turn actual project records and applicable policies into traceable application drafts and correction notes."
description_zh: "为企业财务拆分贷款本金、利率、天数与实际付息，核对贴息上限和重复支持，形成测算底稿及申请补正说明。"
description_en: "Turn actual project records and applicable policies into traceable application drafts and correction notes."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 贷款本金与计息区间
本能力接收借据、实际放款、还本、用途、重定价与政策支持期，生成互不重复的贴息分段底稿。合同授信额度不是实际放款，本金已还部分只在实际生效前区间存在；不把本金归还额当利息支出。每次放款、还本、利率或用途变化以及政策边界都作切点，记录日期来源和当天归哪段。首尾日如何计、360/365/实际年或按月规则以通知和银行资料为准，不凭常识猜。没有分母只列条件结果，不形成唯一贴息数。
分段先裁支持范围与项目用途，再判断年化贴息百分点、实际贷款年利率或实际利息比例的关系。明确规定贴息率不超过实际利率才作相应较低值处理，不能把所有地方政策都统一加这条。浮动利率在重定价日切段，年末闰年按来源口径处理，不先将全年天数凑成360。计算保留原数与精确分式，展示近似写约或≈；政策要求分段舍入时按原文，否则说明最终显示至分。
假设模拟L01按起含末不含、年分母360，第一段2026年1月1日至4月1日90天、本金2000000、实际年利率3%，政策率上限1.5%，理论7500；4月1日归本800000后1200000，第二段至7月1日91天、实际年利率1%，按明确孰低规则理论9100/3元≈3033.33。两段181天，4月1日只计第二段一次。该结果还须与模拟规则已付利息及项目上限核，不把理论额直接当到账。完成输出含全区间、事件来源、公式、未知与边界，不索取账户密码，不代向银行请求数据。
一笔借据部分用于支持范围以外用途时，先核对应资金流和政策分配规则，不把全部余额自动计入。重定价仅有口头说法时保留待核事件，分别列两种利率情境；不得倒推一个利率使结果正好吻合目标补助。
