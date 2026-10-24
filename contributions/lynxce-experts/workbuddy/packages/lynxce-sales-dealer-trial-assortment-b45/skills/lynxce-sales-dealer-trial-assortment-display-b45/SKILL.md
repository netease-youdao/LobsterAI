---
name: lynxce-sales-dealer-trial-assortment-display-b45
display_name: "试销陈列与提案成稿"
display_name_en: "Dealer Trial Assortment Planner"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "按经销商预算、起订量与可供数量设计首单组合，交付产品配比、陈列分配和周度观察表，支持试销调整。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 试销陈列与提案成稿

## 使用位置与输入
本模块服务“经销商首单试销组合方案”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
接收已可行的采购组合，把每款数量分成展示、备用和用户明确批准的演示消耗。三类之和不得超过采购数，演示样品是否可继续售卖必须由用户定义。假设A8分展示2备用6，B6分2和4，C2分1和1，合计仍为16件；不能额外赠出一套而不扣库存。写一页经销商可审阅正文，包括本轮只验证什么、为何覆盖这些款、投入和机动余额、观察四周以及每周要记录的客户原话。产品卖点只引用用户提供的属性，不编畅销或用户背书。陈列位置未知时给“同等可见度”原则与待选位，不装作知道门店格局。交付成稿和展示分配表，让经销商能直接审议组合。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，以本轮完整结构化输入整表重算。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。

## 结构化脚本交接
消费主流程同一次脚本JSON，不另手算展示或备用。allocation逐款传displayTarget、consumed与basis；假设A2/B2/C1展示及消耗0时，覆盖方案得到展示5、备用11、采购16。C1分支改为展示5、备用10、采购15。展示容量未知时在成品保留待补，分配只是条件草案。capToAvailable启用后的截量是建议，不能写库存已调整。提案复制脚本总表与逐款明细，通知保留来源条件和假设标签。补强变体引用精确parentId，比如相对高档A4B4C1变为A4B6C1，B金额增120、备用增2，不能对B已经6的覆盖方案这样描述。只在已列候选内比较余额；没有全量求解不能声称最大可留资金。

