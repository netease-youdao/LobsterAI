---
name: lynxce-employment-insurance-subsidy-b51-2
display_name: "单位三险对账"
display_name_en: "Employment Subsidy Materials Advisor"
description: "Organize traceable enterprise policy materials, reconcile records and prepare complete correction drafts."
description_zh: "为企业人事财务核对吸纳就业参保材料，拆分单位三险与个人缴费，交付人月底稿和完整申请补正说明。"
description_en: "Organize traceable enterprise policy materials, reconcile records and prepare complete correction drafts."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 单位三险对账
本能力按主体、人员、所属月份、险种和资金范围连接账簿。输入单位养老医疗失业分项、个人缴费、其他险种、支付日期及退补明细。先确认是实际缴费凭据、内部摘要还是计提数，工资表和会计计提不能冒充已缴。日期和所属期分开，退款须定位谁、哪月、哪险、单位还是个人；未知归属先并列，不直接从总表扣。地方比例封顶与基数范围缺失时只算给定支出，不将其称本次应领。
示例A三月每月六百养老、三百医疗、四十失业，单月九百四十、三月二千八百二十；B八百、三百、五十，单月一千一百五十、三月三千四百五十；单位合计六千二百七十。个人A各月三百、B四百，合计二千一百，不加进单位基数。工伤、生育和滞纳金未给则记未知，不记零。表中逐人逐月完整列，汇总和算式放表外，避免用一行合计掩盖漏月或重复。
J05主张B八月医疗退费一百时保留原一千一百五十，条件上若确有同月单位退费才为一千零五十，B三月三千三百五十，单位总六千一百七十；A全部月份及个人金额照实保留。差一百不等于已退到账，也不意味补贴必少一百，因为地方比例仍未知。须另核原始缴费、退费归属及当地净缴处理规则，不按有利或较晚表择值。交付每笔数据来源、范围和版本，真实款项发生状态与算术情境分开；单位三险可复算仅说明输入相符，不能证明资格、批准或拨款。
单位养老医疗失业的单项合计还应与同一月份汇总交叉检查，不能只核总额相等便忽略险种错列；退款可能尚在申请、已核准或实际退回，不同状态分列。若原件与摘要不符，先保留原话及实际收到版本，不编造成因。
