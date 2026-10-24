---
name: lynxce-deferred-tax-bases-b50
display_name: "税基差异识别"
display_name_en: "Deferred Income Tax Evidence Advisor"
description: "Reconcile book and tax bases, reversal schedules and recoverability evidence into deferred tax schedules and revision notes."
description_zh: "为企业财务核对账面价值、计税基础和转回证据，区分永久与暂时差异，形成递延税底稿和可回收性修订说明。"
description_en: "Reconcile book and tax bases, reversal schedules and recoverability evidence into deferred tax schedules and revision notes."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 资产负债计税基础
从报告期末账面、真实税法基础和未来收回清偿方式判断差异，不把税前调整表直接当递延税表。输入企业会计制度、主体及报告期、资产负债明细、原交易、税法口径和已扣记录、预计转回。企业会计准则第18号第五条资产基础为未来可抵扣额，第六条负债基础为账面减未来可扣，不能所有负债填0；差异方向看未来应税额影响，资产与负债不能用同一个正负号口诀。

假设A存货税基100万元，计提40后账面60，税法本期不扣准备，未来2026可抵40；B设备账面50、税基40，因本年税法多扣折旧10形成2026应纳差10。必须有计提、折旧和原成本税务资料支持，不从账面差反造税基。C行政罚款2万元永久不能扣，本年调增不意味着未来可扣，所以不形成递延资产。本技能整理差异证据，不替代资产损失是否可在申报扣除的专业材料判断。

区分永久差、暂时差、计税基础未知和初始确认例外。商誉、投资、合并及权益来源另核；对解释16规定的初始等额单项交易不能沿2006旧豁免一概不认，租赁要分别评估相关资产和负债，而不是净为零跳过。小企业会计准则适用者不能只因有所得税就套企业会计准则全部处理；报告期及现行解释需明确。

可复制底稿段：“【对象】期末账面【值及来源】，计税基础【值及具体税务依据】，差【值】在【未来方式及期间】形成【应纳或可抵】；原交易去向【损益/权益/待核】，当前【永久、暂时或资料不足】。计税基础未知不当0，本年调增不直接认资产。”交付全量差异表及实质说明，原件和用户摘要分清；确认方向、原税基已用和未来扣除不重复。完成标准为税法基础真实、方向和期间有据、例外已分流，不修改原始数据凑税率、不将本稿称审计或税务鉴证。
