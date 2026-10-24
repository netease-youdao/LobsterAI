---
name: nonresident-gross-net-tax-bridge
display_name: "含税净额与扣缴测算"
display_name_en: "Nonresident Withholding Advisor"
description: "Prepare corporate nonresident withholding evidence, conditional calculations and full revisions."
description_zh: "为企业财务核对境外付款合同、所得来源与协定资料，形成源泉扣缴测算、证据底稿及完整冲突修订稿。"
description_en: "Prepare corporate nonresident withholding evidence, conditional calculations and full revisions."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 含税净额与扣缴测算
在主体、来源及适用路径明确后才计算企业所得税。先区别收入总额、计税净所得、收款净额和承担税款；企业所得税法第三条第三款所得依实施条例第九十一条通常减按百分之十，但不将此税率套所有境外付款。股息、利息、租金、特许权使用费与财产转让税基不同，财产转让必须另核计税基础，不能按全部价款直接扣。协定税率尚无有效资格资料时不使用自行猜测的优惠税率。
输入应注明人民币或外币、金额、企业所得税是否内含、增值税口径及税款由谁承担。以人民币且不含增值税的企业所得税含税许可收入六十万元为假设，百分之十条件下税六万元、所得税后支付五十四万元。若真实有效约定为由支付方承担所得税且对方净收六十万元，则收入六十万除以百分之九十，约六十六万六千六百六十六元六角七分，税约六万六千六百六十六元六角七分；用精确值计算后按分取舍，不先把收入取整成六十七万元。含税价与净收款两源冲突时并列条件测算，不以较晚邮件替代原合同。
外币按公告2017年第37号不同申报路径确定折算日，不混用银行购汇价、合同签约价或自行申报的另一日期；缺汇率和触发日时只交原币算式。税率条件未知不填零，已扣税不等于已入库，拟付款不等于实际支付。交付包括税基公式、适用前提、税负承担、舍入说明和核对余额，不将其他税种纳入合计，也不把测算结果自动记为实际缴税。完成以合同价、净额、税额及证据身份全部能互相勾稽为准。
