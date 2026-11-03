---
name: lynxce-sales-dealer-trial-assortment-budget-b45
display_name: "首单起订量与预算组合求解"
display_name_en: "Dealer Trial Assortment Planner"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "按经销商预算、起订量与可供数量设计首单组合，交付产品配比、陈列分配和周度观察表，支持试销调整。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 首单起订量与预算组合求解

## 使用位置与输入
本模块服务“经销商首单试销组合方案”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
先算每款最小起订金额，再检查全部目标款最低覆盖是否超预算。数量使用用户定义的倍数规则，起订4每次加2只允许4、6、8等，不把任意整数视为可订。假设A40、B60、C100，最低4、2、1，共380元；预算1000仍有620可分，但不是必须花完。给两套组合并列采购件数、金额和未用余额，优先体现用户确认的测试目标。用户没有产品毛利数据时不能写利润最优，只有销量假设时不能把目标当需求承诺。库存上限逐款检查，某款只剩1件就不得安排2件。输出计算底稿和每套牺牲的目标，让主流程据此完成提案，不直接下单。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，以本轮完整结构化输入整表重算。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。

## 结构化脚本交接
把用户输入整理为脚本products、branches和designs。每个候选用唯一方案id，起订后增量与数量倍数必须区分；本脚本采用MOQ加整数个increment，不适用时保留待补，不擅自套用。availability在每个来源分支逐款齐全，未知null而非0；未确认有效来源时resolvedBranch:null。给定预算1000、价格40/60/100、起订4/2/1和增量2/2/1，输入覆盖A8B6C2与高档A4B4C5，直接运行脚本，返回880/120及900/100的商品投入/未动用余额。C有8与1两个来源时仍分别输出，不把任一来源默认当事实。修订整表重算，保留来源条件、约束错误和待补容量，传递计算JSON给陈列模块。

