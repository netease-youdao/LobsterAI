---
name: lynxce-quality-cavity-offset-compare-mapping-b45
display_name: "分穴样件与逐件规格比较"
display_name_en: "Mold Cavity Dimension Comparison Analyst"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "按模穴与测量轮次比较尺寸，计算均值偏移、极差和超限分布，交付分穴分析报告与下一轮取样安排。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.1
author: "灵策智算 LynxceAI"
---

# 分穴样件与逐件规格比较

## 使用位置与输入
本模块服务“多模穴尺寸偏差对比分析”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
把每条尺寸绑定样件、穴号、轮次和图纸版本，优先检查样件号重复与穴号缺失。重复抄录保留映射但不重复计n，不能因数值一样就删掉独立样件。逐件按用户确认的上下限比较，等于上限是否范围内必须明确。假设上限10.10含等于，10.09和10.10在界内，10.11超上限；不能先把均值10.10判范围内就放弃逐件检查。图纸适用版未知时同时列两个条件结果，不自动采用宽松版。输出逐件索引和超限位置，给主流程汇总，不签产品合格或出货决定。穴号缺失留未归属，避免用尺寸大小反向猜穴位而制造偏差。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，以本轮完整输入整表重算。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。

## 结构化程序交接
运行随包脚本前整理groups，每个穴号唯一，readings是已核样件编号的独立实物读数。缺穴号单列，重复抄录先按原始编号核实而非按相同数值去重。nominal、lower、各版本upper都用同单位，inclusive沿用已确认边界，未知先待补。每个来源单列versions，适用性未确定时resolvedVersion:null。脚本生成逐件索引以及两版超限判定，D10.10在上限10.10含等于时范围内，在10.08时超限。所有件数从实际readings计数，不能在标题放大总样本。把原始输入、来源条件与同次JSON交给统计模块，单件与均值结论保持分列。

版本对比使用同次versionComparisons逐件比较结果，不能把新版本某穴超限数当作变化数。传递changedVerdictCount及changedIDs原样，不在通知或报告重新口算。

