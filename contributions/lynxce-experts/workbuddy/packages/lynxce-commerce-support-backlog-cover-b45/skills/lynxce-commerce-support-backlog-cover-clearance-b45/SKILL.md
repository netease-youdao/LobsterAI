---
name: lynxce-commerce-support-backlog-cover-clearance-b45
display_name: "分时积压清偿情境比较"
display_name_en: "Support Peak Coverage Planner"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "按时段咨询量与处理时长测算客服负荷，生成岗位覆盖、积压清偿及借调对比方案，帮助主管安排高峰人力。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.1
author: "灵策智算 LynxceAI"
---

# 分时积压清偿情境比较

## 使用位置与输入
本模块服务“电商客服高峰覆盖与积压清偿方案”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
用期末=max(0,期初+新增−能力)逐时段递推，上一时段期末必须等于下一时段期初。先算不调整基线，再算每个借调情境，所有情境采用同一起点。假设期初120、每小时新增480、原能力150，两小时末780；各时段增加50能力后末680，收益是减少100分钟积压，不能报成每人降低100条等待。延后非紧急任务时记录从何处移到何处及承接窗口，全天工作量不变。窗口内清零后展示剩余能力，但不得把剩余分钟转换成实际等待时间承诺。交一张情境末余额对比表和主管可选动作，写清后续仍需多少分钟能力才能清完，数值没有需求预测时只能给条件式。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，只重算受新增数据影响的部分。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。
