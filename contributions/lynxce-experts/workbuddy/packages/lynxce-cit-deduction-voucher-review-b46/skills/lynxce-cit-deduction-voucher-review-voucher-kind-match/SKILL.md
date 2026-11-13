---
name: lynxce-cit-deduction-voucher-review-voucher-kind-match
display_name: "凭证分类匹配"
display_name_en: "CIT Deduction Voucher Review Advisor"
description: "Match actual expenses to deduction vouchers and produce correction letters, year routing notes and evidence registers."
description_zh: "帮助企业财务逐笔核对支出与扣除凭证，梳理补开换开和跨年处理，交付补证函、凭证台账与可追溯说明稿。"
description_en: "Match actual expenses to deduction vouchers and produce correction letters, year routing notes and evidence registers."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 凭证分类匹配
把一笔真实支出拆成交易主体、业务性质、实际发生额、凭证类别和相关证明资料，交付逐笔匹配结论及补开请求。输入至少包含支出年度、对方身份、境内外、业务内容、履约与付款、现有外部或内部凭证。先标记材料来自用户摘要还是实际提供全文；金额保留原口径，含税额与成本费用额不得混用。未知对方身份不能猜成小额零星个人，付款日期不能自动当业务发生日期。

依公告2018年第28号第四条核真实性、合法性和关联性，再按第九至十一条区分境内应税、境内非应税与境外采购。第九条小额零星路径的起征点依适用期核实，不能设一个永远通用的金额。一个交易可能既有发票又有验收与付款资料，应说明各自证明范围，不能因有合同和回单就忽略应当取得的发票。涉及分摊或租赁水电时转第十八、十九条核对，不把主业务发票规则机械套用。

交付表至少列编号、实际支出与来源、应有凭证依据、现有凭证及差异、相关资料、下一动作。表头后有GFM分隔行、表后留空行；公式和说明放表外。已填示例：假设2025年真实维修费用12000元，境内已登记供应商；合同A1、验收A2、银行回单A3齐，发票A4于2026年4月到；用户给的汇算结束日为2026年5月31日。初核写第九、十三条凭证条件具备，保留其他扣除条件另核，不能写税务机关已经准予。

可复制请求：“请核对我司【合同】项下【实际业务】的凭证，现有【具体缺陷】，请由真实交易主体依法补开或换开，保留实际业务日期与本次开具日期，不使用无关主体或倒签记录。”缺资料先给可用表和该请求，最多问三项关键资料。发现合同、验收、发票金额不同，保留冲突值和索引，不能任选一数。完成标准是每笔能追溯、应有凭证与实际业务相符、待补项准确；不是计算全部税额或完成申报。
