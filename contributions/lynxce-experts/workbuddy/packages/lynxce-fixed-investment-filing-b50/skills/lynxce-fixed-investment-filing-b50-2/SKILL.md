---
name: lynxce-fixed-investment-filing-b50-2
display_name: "投资结构复核"
display_name_en: "Fixed Investment Filing Advisor"
description: "Prepare traceable enterprise reporting materials, reconcile source records and produce complete correction drafts."
description_zh: "为企业投资经办人梳理备案要素，复核总投资与资金结构，交付项目摘要、资料底稿和完整变化说明。"
description_en: "Prepare traceable enterprise reporting materials, reconcile source records and produce complete correction drafts."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 投资结构复核
本能力分别复核建设方案分项总额和资金来源计划，交给项目及财务负责人一份可以直接讨论的双账底稿。输入需含每项投资名称、金额、币种、税口径、是否包含安装配套、统计范围与来源计划。先把元和万元统一，含税与未税不混加，不默认增值税税率倒算。没有明细的其他费用保留该主张并标明待核，不能把差额塞进该项凑平。只有合同或预算确实说明设备价已含安装时才检查重复，不能只因名字相似擅自删除。

投资分项加总、声明总额和融资计划合计三者独立展示。自筹计划不等于资金已到位，拟贷款不等于银行已审批，更不等于已放款；预算不是实际已支付。用户只有计划资料就全表保留计划状态，不计算投资完成率。不同主体资金、不同项目预算和不同币种缺换算依据时不直接合计，先明确应归属的范围。实际金额为零必须有输入事实，未知付款不能用零填空。

虚构样例建筑300、设备400、安装100、其他100万元，合计900；自筹500与拟贷款400合计900。此时两账差额为零，只说明算术一致。新增设备450但声明总额仍900时，分项总额为950，超出声明50，资金计划900相对950缺50。不能把差额直接改成新增贷款，更不能写该贷款已经获批。若企业最终选择旧设备预算，仍需有版本确认，较晚文件本身不是有效替代证明。

输出全项目投资来源表和完整解释段落，逐项金额带原资料位置，所有分项与来源均保留，汇总与公式在表外。需要调整时给原情境和新增情境，不只写“差50”。完成判据是同口径运算正确，声明值与推算值明确区分，融资和付款状态忠实，所有未受影响项目数值完整保留。没有审批证据的资金安排只能写拟筹措，交企业确认后再形成定稿，不能通过底稿替代资金真实性核验或工程投资评估。

