---
name: lynxce-b48-red-tax-accounting-handoff
display_name: "税额记账衔接"
display_name_en: "Red Letter Invoice Reconciliation Advisor"
description: "Reconcile invoice reversals, confirmation status and accounting handoffs with traceable draft and revision records."
description_zh: "为企业开票与财务人员核对退货折让、蓝红金额及双方确认状态，形成红冲准备说明、对账台账与完整修订稿。"
description_en: "Reconcile invoice reversals, confirmation status and accounting handoffs with traceable draft and revision records."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 税额记账衔接
围绕已抵扣蓝票红冲形成财务交接说明，区分确认单税额、实际红字、进项转出、账务记录与退款。输入为真实原票和已申报抵扣状态、有效确认单、实际红字和相关记账资料；尚未形成的拟确认单不能当法定已生成文件。根据公告2024年第11号第八条，已用于增值税申报抵扣的受票方，应暂依确认单所列增值税税额从当期进项转出，取得实际红字后与确认单一并作为记账凭证。具体时期和填报由企业依真实情形核，不凭工具假定已经转出。

假设A本次拟退20件，税额260元，但当前无有效确认单也没开红字，只交“据实际确认单与抵扣状态办理衔接”的待办，不写进项已经转出260。前次实际红字税130与本次候选260分别索引，避免本次将390再次全额转出。若本次数量冲突变为25件候选税325，两种条件并列，转出和记账内容随最终有效确认单核，不在原抵扣记录上悄悄修改。

服务票B本次拟税90且用户明确未申报抵扣，不能照搬A的已抵扣转出要求而称B已产生同一动作；后续有新申报记录再重核。B是否入账的冲突只影响相应分支和账务核实，不让本次1500/90/1590金额消失。实际退款1590或2260也须付款回单，发票金额不能证明银行已付；红字票下载与对方入账也不等于资金结清。

交接稿应有蓝红索引、有效确认单税额、已抵扣证据、拟核当期申报处理、实际执行回执、会计凭证索引和退款状态，所有未知默认为待核。用户收到对方答复后保留原稿与新证据，完整更新全表及说明，不只改一处金额。不能出审计鉴证、保证抵扣退税结果，不能把模板当已生成正式税务文件。完成标准为各笔不重复税额、实际与拟议全程分开、账票款三状态有独立证据、表格及正文同值；未登录或未实际办理不称已申报。
