---
name: lynxce-innovation-voucher-ledger
display_name: "合同券额对账"
display_name_en: "Innovation Voucher Advisor"
description: "Prepare traceable enterprise application materials, reconcile evidence and produce complete revision drafts."
description_zh: "为科技企业核对创新券类别、科研服务与实际合同额，梳理领券用券和兑现材料，完成额度底稿与补正稿。"
description_en: "Prepare traceable enterprise application materials, reconcile evidence and produce complete revision drafts."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 实际服务、年度额度与券余
本能力把科研服务合同、实际履约、券领取占用和兑现配合金额串成可复算底稿。输入需有逐项目合同、目录服务、履约成果或算力计量、结算、付款退款、领取有效记录、年度历史及其他占用。合同总额不等实际发生额，年度政策上限不等账户余额，领到券不代表财政已经兑付。普通与算力若规则独立，不将一边余额挪到另一边；规则未给则待核不推定。
先按合规实际服务范围和本轮比例算准备上限，再核年度余额、有效已领余额和其他项目占用。每张券的领取、科研活动登记、到期及合同届期分别记录，按月的期限不能随便改为固定天数。未知领取或付款不是0，不凭服务报告称企业已自付。实际发生额摘要冲突时保留两者，不把较小数自动解释退费；退款只有凭证能支持才列。
模拟P1实际12万元按50%得6，普通年度余及券余6覆盖；P2实际8按25%得2，年度余5券余3覆盖。准备8、实际20未覆盖12只是结构，不能称已支付12。新P2实际6有效时算1.5，总准备7.5、实际18未覆盖10.5，合同20不变，差因待核；准备差0.5不是实际额差2，不报应退补贴。交付全项目券额表、逐笔式和实际状态说明，不只一个合计。完成标准为单位、券种、历史与占用完整，所有金额可追溯到明确规则与证据，约数有标记，实际附入与登记兑现另记，不虚构实时可用额度。

服务实际额由结算和履约证据支持，发票日期、收款日期与服务完成时间不是同一字段。若合同包含不支持项目，先按本轮规则与真实组成拆明，缺依据不把全部金额乘上限。每次新增占用要保留旧状态和时间，不能拿后来可用截图证明过去办理时同样有额。

