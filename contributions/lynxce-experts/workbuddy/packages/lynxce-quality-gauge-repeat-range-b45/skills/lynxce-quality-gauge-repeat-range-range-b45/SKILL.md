---
name: lynxce-quality-gauge-repeat-range-range-b45
display_name: "同件极差与尺度比计算"
display_name_en: "Gauge Repeated Measurement Range Analyst"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "整理同人同量具的重复测量读数，计算样件极差与公差尺度比，交付测量波动报告及同条件复测设计。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.1
author: "灵策智算 LynxceAI"
---

# 同件极差与尺度比计算

## 使用位置与输入
本模块服务“量具重复测量极差分析”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
每组先算最大和最小再相减，均值保留原始精度。假设P1为10.00、10.01、10.00毫米，极差0.01，均值3001/300≈10.003333；P2极差0.02，P3极差0.01，同次数平均极差1/75≈0.013333。只有同条件同重复次数时才合并平均，次数改变另分层。若公差宽0.10，平均极差比≈13.33%，最大极差比20%，这两个统计量不能同称一个“误差率”。公差宽为0不做除法，只有一次读数标无重复性统计信息。所有读数同值时记录精度下极差为0，不能推断绝对准确。输出算式、中间值和描述性解释，不使用无来源阈值宣布合格，也不由平均极差直接生成完整GRR。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，只重算受新增数据影响的部分。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。
