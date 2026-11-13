---
name: lynxce-b48-export-filing-change-version
display_name: "申报差异修订"
display_name_en: "Export Rebate Document Reconciliation Advisor"
description: "Match export and purchase documents, receipts and filing states under current rules without assuming a refund rate."
description_zh: "为外贸财务与单证人员勾稽报关、购进凭证及收汇记录，识别申报差异，交付准备说明、备案目录与补正稿。"
description_en: "Match export and purchase documents, receipts and filing states under current rules without assuming a refund rate."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 申报差异修订
处理出口资料矛盾、受理核准变化、折让退回和凭证状态更新，交完整V2而非只改一条待办。输入为原全量台账、原申报资料及真实状态、新证据和影响对象；先锁版本及单证占用，保留旧值与来源，未变业务完整留存。新的内部表不当然比原件有效，较有利结果不自动选用；电子回执只证明它明确显示的阶段，受理不等于核准或到账。

现行第5号办法第二十七条对申报有误区分尚未核准可以申请撤回与已核准用负数冲减；第二十八条自愿不再申报有不同后果，相关凭证不得重新用于退免申报，不能把它当通用纠错按钮。第二十九、三十条对已办理后退回折让等及负数处理另有要求，是否缴回、抵减要根据实际办法和应退额情况核，不能从业务退款猜税款。拟写申请不等于税务已撤回，负数草稿不等于已冲减。

假设E1原未申报，新增E4摘要显示已受理尚未核准，仅E1状态更新，不能再当新业务重复用同一I1提交；未发现错误不自动申请撤回。E2新增出库48与原报关购进50冲突，差2件，原票40000/5200/45200及美元销售5000、收4500不因数量疑点被强行覆盖，差500美元也不推成2件折让。全表原购进90000、税11700及美元15000/14500仍列原单据合计，非可退依据。

V2需要完整重写申报准备说明、数量金额和收汇台账、阶段清单、拟附件与询证稿，另列原值、新证据和仍待核的原因。表后公式及说明留空行分离。2025年及以前业务不追套2026新36个月视同内销后果，当前期限需看真实类型及过渡。完成标准是历史和新状态可回溯、不重复申报、错误申请与自愿放弃分清、未知核准/到账不填已完成；不代登录，不伪造回执、不出鉴证或保证退税。
