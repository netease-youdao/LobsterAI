---
name: lynxce-commerce-support-backlog-cover-coverage-b45
display_name: "客服可用能力与覆盖编排"
display_name_en: "Support Peak Coverage Planner"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "按时段咨询量与处理时长测算客服负荷，生成岗位覆盖、积压清偿及借调对比方案，帮助主管安排高峰人力。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.1
author: "灵策智算 LynxceAI"
---

# 客服可用能力与覆盖编排

## 使用位置与输入
本模块服务“电商客服高峰覆盖与积压清偿方案”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
把每位客服每个时段的有效服务分钟填入角色矩阵，培训、休息和固定任务占用分别保留。同一个人可做两个技能池时，先按用户确认比例拆分钟，不能两个池都记满50分钟。假设甲50分钟给售前，乙30售前20售后，售前能力80、售后20，总量100与个人总量一致。按用户已确认的最小在岗条件给候选覆盖安排，不能以总分钟够就取消某个必须保留岗位。缺口方案必须点名角色代号、调入窗口和原岗位受到的影响；没有替补授权时使用条件建议。将完成的角色分钟矩阵交积压递推模块，附不可跨技能的限制和借调待确认项，不自行生成加班时段或承诺人员愿意接受排班。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，只重算受新增数据影响的部分。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。
