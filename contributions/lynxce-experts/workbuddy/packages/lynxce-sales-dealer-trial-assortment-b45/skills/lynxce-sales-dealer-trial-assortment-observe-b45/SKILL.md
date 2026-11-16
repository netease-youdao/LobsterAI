---
name: lynxce-sales-dealer-trial-assortment-observe-b45
display_name: "周度试销反馈与补货动作"
display_name_en: "Dealer Trial Assortment Planner"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "按经销商预算、起订量与可供数量设计首单组合，交付产品配比、陈列分配和周度观察表，支持试销调整。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 周度试销反馈与补货动作

## 使用位置与输入
本模块服务“经销商首单试销组合方案”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
按款型记录周初、补入、售出、赠样、损坏与周末，先守恒再解释。假设A8售3无其他流出，周末5；B6售1剩5；C2售0剩2。询问次数与售出分列，赠给经销商的数量不当终端销量。若C0售出但一周未上架，下一动作是完成展示观察而不是降价清货。用户给补货阈值后才算补货数量；没有阈值就交维持组合与少量追加两种条件建议。首周变价或换位置要保留时间点，不拿变更前后少量差异证明产品优劣。输出下周动作、责任角色和希望新增的资料，保持已采购与拟采购状态分开，真实执行由用户回传记录。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，以本轮完整结构化输入整表重算。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。

## 结构化脚本交接
周度观察仍按试销原目标，区分到店、上架、售出、赠样、损坏五类数量与询问原话。给脚本weekly写opening、incoming、sold、given、damaged、transferOut及basis，未知流水用null，脚本返回closing:null及缺失字段，不因首周就假定没有补入。已确认或显式假设的8+0−3−0−0−0才可得到5，所有0的依据留在basis。根据是否展示、是否缺样解释零售出，并交下一周观察或陈列动作，不能由零售出直接判产品失败。补货只使用用户阈值；无阈值时交要补的条件与待决数据，不凭脚本的首单MOQ拼成默认补货指令。变更采购量时回传预算模块整表复算，观察反馈不冒充已经下单。

