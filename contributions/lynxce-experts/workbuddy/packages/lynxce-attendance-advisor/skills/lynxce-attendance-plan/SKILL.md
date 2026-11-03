---
name: lynxce-attendance-plan
version: 1.0.1
description: Compute person-shift demand versus supply, fairness gaps, leave balances
  and reconciliation difference rates for a monthly roster.
display_name: 排班覆盖与假期余额核算
author: 灵策智算 LynxceAI
category: tools
---
# 排班覆盖与假期余额核算
用于在出班表前算清供需，在出台账和对账单前算清余额与差异，结果写回包根目录 references/workbook.md。人班指一个人上一个班次，人日指一个人一天。
覆盖：每日需求人班等于当天各班最低在岗人数之和，按工作日、休息日、节假日分别计数后相加得到月需求；月供给等于每人计划出勤天数之和减去已批假期天数。供给减需求为余量，余量为负直接报缺口，不压缩休息补足。备班需求为人数的一成向上取整后乘以天数，余量不够时列出无备班日期。
间隔：跨天班次换算成连续小时再算，前一班下班到后一班上班的小时数小于制度值即为冲突。
公平：同一统计窗口内按人数夜班、周末、节假日三项；最大值减最小值大于1即需调整。新增班次先给次数最少者，逐次加一并重算，直到差值不大于1或班次分完。
余额：期末等于期初加新增减使用，假期类别分开算，调休以小时为单位并写来源加班日期。期末小于零标红，只列可能原因，处理方式交HR按制度确认。
对账：差异率等于差异人日除以总人日。补录截止日按工作日顺延，不含休息日；遇法定节假日以公司公布的工作日历为准。
