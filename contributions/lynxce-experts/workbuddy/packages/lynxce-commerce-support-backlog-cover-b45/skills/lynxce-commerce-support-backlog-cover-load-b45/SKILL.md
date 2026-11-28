---
name: lynxce-commerce-support-backlog-cover-load-b45
display_name: "客服咨询分钟工作量归一"
display_name_en: "Support Peak Coverage Planner"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "按时段咨询量与处理时长测算客服负荷，生成岗位覆盖、积压清偿及借调对比方案，帮助主管安排高峰人力。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.1
author: "灵策智算 LynxceAI"
---

# 客服咨询分钟工作量归一

## 使用位置与输入
本模块服务“电商客服高峰覆盖与积压清偿方案”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
接收按小时的咨询条数与平均人工处理分钟，首先核对时长包含的动作。对聊天同时等待、人工查单、收尾记录分别说明是否占用人工，不能把会话持续时间不加区分当作处理时长。来自多个渠道的条数先去除用户已证明的重复工单；没有同一性证据不随意去重。假设新咨询120条、有效人工4分钟，新增480分钟；若期初30条平均剩余2分钟，则期初积压60分钟而非30×4。输出分技能池、分时段的新增与期初分钟账。用户只给条数时先交条数表和分钟待填位，不用行业平均数替代。把估计时长与实测时长分列，并将样本期和样本数量传给主流程，便于解释方案精度。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，只重算受新增数据影响的部分。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。
