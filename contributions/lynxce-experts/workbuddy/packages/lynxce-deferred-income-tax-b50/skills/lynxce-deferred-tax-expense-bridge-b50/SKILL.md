---
name: lynxce-deferred-tax-expense-bridge-b50
display_name: "税费修订说明"
display_name_en: "Deferred Income Tax Evidence Advisor"
description: "Reconcile book and tax bases, reversal schedules and recoverability evidence into deferred tax schedules and revision notes."
description_zh: "为企业财务核对账面价值、计税基础和转回证据，区分永久与暂时差异，形成递延税底稿和可回收性修订说明。"
description_en: "Reconcile book and tax bases, reversal schedules and recoverability evidence into deferred tax schedules and revision notes."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 当前税、递延税与全量V2
将当期所得税测算和递延资产负债变动桥接到所得税费用，避免税费、应缴与实际现金相混。输入会计利润、当期调整、适用税率、期初及期末递延、原交易去向、预缴和真实记账状态。当前所得未知项不能填0，期初未给不能假定0；损益、权益或合并来源各按实际准则分流，不能把所有递延变动都直接算利润表。

假设2025年末甲利润200万元，A跌价40调增、B税法多扣10调减、C罚款2永久调增，无其他差异优惠，当期所得232税58；期初递延资产负债明确0且全为本期损益，A资产7.5/B负债2.5，递延净收益5，税费53。反核利润25%为50，加罚款0.5和未确认差10的2.5也是53；预缴未知，不能把53或58叫应补或已缴。资产负债分别列，抵销还须具体列报条件，不自动净列。

R2未来独立所得8与R1的20冲突，须完整V2保留2025年12月31日、同主体机关、税率25%、利润200、A账面60/税基100差40、B50/40差10及2026转回、C2、期初0和全部未知状态。R1条件资产7.5、未确认2.5、负债2.5、税费53；R2条件资产4.5、未确认5.5、负债2.5、递延净收益2、税费56，当期所得232税58不变。不能把未来所得差12当本年所得调减，也不能用一句其余不变省掉整份稿。

可复制段：“本版【具体年度主体】原预测【来源额】与新【来源额】并存，覆盖和递延【分支完整值】，当期所得税【完整式】，未确认【差及税额】，预缴实际记账批准申报【真实状态】；请核证据口径、批准与原期末存在性，未核前不作唯一数或已过账结论。”交付全量税费表、可复制财务说明及询证，不只给一行差额。拒绝编未来利润、隐瞒减记或代签鉴证，保持原件摘要、拟目录附入及申报真实状态。
