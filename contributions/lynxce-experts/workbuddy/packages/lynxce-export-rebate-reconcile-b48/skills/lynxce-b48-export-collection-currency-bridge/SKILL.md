---
name: lynxce-b48-export-collection-currency-bridge
display_name: "收汇币种勾稽"
display_name_en: "Export Rebate Document Reconciliation Advisor"
description: "Match export and purchase documents, receipts and filing states under current rules without assuming a refund rate."
description_zh: "为外贸财务与单证人员勾稽报关、购进凭证及收汇记录，识别申报差异，交付准备说明、备案目录与补正稿。"
description_en: "Match export and purchase documents, receipts and filing states under current rules without assuming a refund rate."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 收汇币种勾稽
将出口销售、实际银行收款、业务分配和未解释差额按同币种独立核对。最低输入为销售金额及币种、FOB或其他贸易口径、报关出口日期、合同最终收款日、银行真实回单、付款人及业务分配。结汇人民币不等于原外币收汇额，未给汇率与成本费用不自动换算；手续费、折让、佣金、退款等原因必须有相应原始证据，不凭差额大小猜原因。银行一笔款只能按可追溯分配使用，不复用两笔业务。

假设E1销售10000美元、R1匹配收10000；E2销售5000美元、R2匹配4500。合计销售15000、收14500、待解释500美元，不能与购进90000人民币混减。当前2026年10月22日，E2为2026年9月一般报关出口，但合同收款期限未给，不能就500差额说已逾期或永久丧失退税。也不能因为R1足额就将全部收款均标齐备，E2差额继续保留。

2026年第11号公告九（一）4的一般报关出口分支与第5号办法第四十八至五十一条共同核期限、材料报送和视同收汇；通常一般货物次年4月30日前收汇，符合清单情形或合同延后须看具体前提和最晚限制。申报时某些情况无需报送收汇材料，不等于无需收汇或无需留证；管理类别、申报时间及其他特别情况影响报送义务。非报关、特殊区域、视同出口、易货和跨境服务不能机械套同一日期。

可复制询证：“本笔【编号】销售【币种金额】，已匹配收款【金额】，差额【金额】；请提供合同最终收款日、真实收款或清单要求的举证及准确分配。当前原因待核，不将差额先写手续费或视同收汇。”输出收汇表、差异桥和完整说明段，零和未知分开。完成标准是同币种可复算、有真实分配来源、期限分支有依据、待核收款不变成已收，未给现行政策依据不承诺能退。
