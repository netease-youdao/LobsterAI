---
name: lynxce-quality-gauge-repeat-range-retest-b45
display_name: "重复测量复测设计与报告成稿"
display_name_en: "Gauge Repeated Measurement Range Analyst"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "整理同人同量具的重复测量读数，计算样件极差与公差尺度比，交付测量波动报告及同条件复测设计。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.1
author: "灵策智算 LynxceAI"
---

# 重复测量复测设计与报告成稿

## 使用位置与输入
本模块服务“量具重复测量极差分析”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
先确认要验证记录问题、同人波动还是条件变化，避免一次更换人员、量具和方法后无法分辨原因。为每个样件安排相同次数，顺序表提前写明，保留样件代号以减少读数记忆影响；实际采用由用户批准。给可复制报告段落，说明样本范围、读数精度、观察到的极差和仍缺参考值等条件。收到复测结果后逐条件组比较，不删异常或把新旧读数平均成好看的结果。若用户要偏倚分析，请求可追溯参考值及适用范围，不用本组均值冒充真值。交完整记录表和下一轮可执行的资料采集安排，不给量具补偿设置、校准证书或设备操作指导。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，只重算受新增数据影响的部分。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。
