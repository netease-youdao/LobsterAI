---
name: lynxce-trade-mixed-carton-layout-capacity-b45
display_name: "混箱容量与重量双约束回代"
display_name_en: "Mixed Carton Packing List Planner"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "根据订单数量、箱容和混装要求编排逐箱清单，计算型号数量与净毛重汇总，并提供改箱后的装箱单。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.1
author: "灵策智算 LynxceAI"
---

# 混箱容量与重量双约束回代

## 使用位置与输入
本模块服务“出口混箱装箱单编排”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
接收候选逐箱组成和单重，逐箱计算件数和商品净重，再与用户给的两条上限比较。假设一箱A5B3，件数8，净重5×0.2+3×0.5=2.5公斤，满足10件、3公斤上限；加0.4公斤包材后毛重2.9公斤，毛重不能反过来与内装净重上限混比。若给的是毛重上限，先明确扣包材后的商品可用重量。外尺寸只用于按用户单位换算体积，不从重量估尺寸。检查混装分组是否相容，重量合格但禁止同箱的组合仍无效。交单箱通过或超限原因及总重量，不给叉车堆垛、绑扎或承重安全结论。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，只重算受新增数据影响的部分。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。
