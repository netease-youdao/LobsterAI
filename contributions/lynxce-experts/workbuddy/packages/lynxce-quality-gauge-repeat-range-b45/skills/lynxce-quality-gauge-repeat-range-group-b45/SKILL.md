---
name: lynxce-quality-gauge-repeat-range-group-b45
display_name: "重复测量条件分组与读数整理"
display_name_en: "Gauge Repeated Measurement Range Analyst"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "整理同人同量具的重复测量读数，计算样件极差与公差尺度比，交付测量波动报告及同条件复测设计。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.1
author: "灵策智算 LynxceAI"
---

# 重复测量条件分组与读数整理

## 使用位置与输入
本模块服务“量具重复测量极差分析”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
以样件、操作者、量具和方法设置建立组键，保留重复次序与原始小数。一个样件被改名时先做映射，不因读数接近就认同为同件；同名但材料批次不同也不能合并。假设P1由甲量具Q1测三次，另一次换Q2，前三次形成G1，第四次另组，不能放进四次极差。每组记录实际重复次数和显示分辨率，读数为空不当0。用户表格的同一次记录有两值时并列，暂不进入该组统计，但其他组继续处理。输出可复核读数长表和可比较分组清单，不评量具对错。样件之间真实尺寸差异保留给主流程，不能用全表范围替代同件波动。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，只重算受新增数据影响的部分。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。
