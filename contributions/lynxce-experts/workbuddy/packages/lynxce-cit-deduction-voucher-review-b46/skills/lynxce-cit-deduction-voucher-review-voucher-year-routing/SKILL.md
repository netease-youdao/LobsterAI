---
name: lynxce-cit-deduction-voucher-review-voucher-year-routing
display_name: "跨年度路线核对"
display_name_en: "CIT Deduction Voucher Review Advisor"
description: "Match actual expenses to deduction vouchers and produce correction letters, year routing notes and evidence registers."
description_zh: "帮助企业财务逐笔核对支出与扣除凭证，梳理补开换开和跨年处理，交付补证函、凭证台账与可追溯说明稿。"
description_en: "Match actual expenses to deduction vouchers and produce correction letters, year routing notes and evidence registers."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 跨年度路线核对
接收已发生支出的原年申报扣除状态、后续取得凭证日期、汇算结束信息以及是否收到税务机关针对该笔事项的告知，交付按年度的处理备忘、变更台账与仍需核实的问题。先把业务发生年、账务记录年、发票开具年和原申报年分别列出；原年是否已经扣除必须来自原表或明确用户说明，不能从账上有费用推定税前也扣了。未提供原表就标待核，不因想追补而默认从未扣除。

按公告2018年第28号第十三至十七条分流：汇算结束前补开换开属于第十三条思路；特殊原因资料核第十四条；汇算结束后税务机关发现并告知才核第十五条的60日要求；未在规定期限补齐且未按第十四条证实真实，参照第十六条记录后果。告知日、送达方式及具体期限未核准时，不能以今天加60天制造截止日。资料问询与具体告知是否一致要看原文，不凭标题猜。

第十七条不是通用更正期限：须排除第十五条情形、属于以前年度应取得而未取得外部凭证且相应支出原年没有税前扣除，后续才取得符合规定的凭证或按第十四条提供证明资料；满足适用条件时追补至支出发生年度，年限不超过五年。原年已扣或机关已告知时不能套这个结论，追补扣除、退税申请、税收追征和亏损结转也不是同一问题。

已填示例：假设2024年服务18000元，原表B4记已调增未扣；2026年9月取得真实合规补票B5，未收到机关针对该事项的告知。拟稿写“按第十七条前提核实追补至2024年”，不是并入2026年费用或按金额直接算退税。V2若补入告知原文，则保留B4、B5及旧路线历史，改为复核第十五条触发与时限，不静默沿用追补。完成标准为每笔有发生年、已扣状态、凭证年和通知状态，局部更新后全表与年度合计同步，未经用户办理不称已更正。
