---
name: lynxce-b48-red-business-blue-red-match
display_name: "蓝红业务勾稽"
display_name_en: "Red Letter Invoice Reconciliation Advisor"
description: "Reconcile invoice reversals, confirmation status and accounting handoffs with traceable draft and revision records."
description_zh: "为企业开票与财务人员核对退货折让、蓝红金额及双方确认状态，形成红冲准备说明、对账台账与完整修订稿。"
description_en: "Reconcile invoice reversals, confirmation status and accounting handoffs with traceable draft and revision records."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 蓝红业务勾稽
以一张原蓝票及其明细行为固定对象，把真实退货、折让或服务中止与历史实际红字、本次拟红及条件余额串起来。最低输入是蓝票不含税、税额和价税，数量单位单价及票载税率、红冲原因证据、历史实际红字号码及明细、本次业务范围。没有实际号码和证据只能写用户摘要，不把业务想退款当已经退货。折让不必减少数量，不能从金额自行编退件数；不同税率和项目分行，不把含税退款当不含税红冲额。

假设A蓝票100件、不含税单价100元，金额10000、税1300、价税11300；前次另退10件已开A0，绝对值1000/130/1130。本次另退20件拟2000/260/2260。当前历史后余额9000/1170/10170；只有本次真实执行后才条件累计30件、金额3000、税390、价税3390，余额70件、7000/910/7910。不能在准备稿写累计已红3000，也不能重复减掉历史10件。所有税额按原票给定口径演示，不替业务判断法定税率。

新增退25件与仓库20件冲突时，两情境并列：25件拟2500/325/2825，历史加本次条件合计35件，余65件、6500/845/7345；20件情境不变。未确认有效前不选较大金额，原100件和历史10件记录都保留。本次拟红合计以情境为单位，不能把两个候选相加成45件。超过真实可核余额、票面税与业务不一致先定位差额，不用负数掩盖错误。

交付表含蓝票ID、原票、历史实际、本次候选、条件余额、业务来源及状态，正文给完整说明与对方核对稿。表后所有算式独立留段，不吞入GFM数据行。完成标准是业务和票据可逐行追溯、价税合计相等、实际与拟议分列；退款是否发生、红字是否实际开具、重开票和记账另设状态，没有系统操作或用户证据不写完成。
