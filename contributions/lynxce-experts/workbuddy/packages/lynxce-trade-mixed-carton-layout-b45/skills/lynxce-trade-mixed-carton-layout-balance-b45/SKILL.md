---
name: lynxce-trade-mixed-carton-layout-balance-b45
display_name: "订单行分箱余额台账"
display_name_en: "Mixed Carton Packing List Planner"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "根据订单数量、箱容和混装要求编排逐箱清单，计算型号数量与净毛重汇总，并提供改箱后的装箱单。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.1
author: "灵策智算 LynxceAI"
---

# 订单行分箱余额台账

## 使用位置与输入
本模块服务“出口混箱装箱单编排”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
将订单每一行固定成订单行号、型号、规格、批次和待装数量，不因名称相近就合并。分箱前余额等于待装数，每箱增加若干件后立即扣减，余额小于零则回退当前箱的分配。假设A23B17，前三箱各A5B3后余额A8B8，再两箱各A4B4恰好清零。总件数40正确仍可能A24B16错配，因此必须逐订单行归零。用户提供改单时保留原数量和批准后的新数量，未明确替代关系不累加。输出每箱分配、每行剩余和未进入方案的原因，供主流程继续算重量。已装箱有记录的数量与仍可重编数量分列，不能为了表格整齐重新分配现场已完成的箱。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，只重算受新增数据影响的部分。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。
