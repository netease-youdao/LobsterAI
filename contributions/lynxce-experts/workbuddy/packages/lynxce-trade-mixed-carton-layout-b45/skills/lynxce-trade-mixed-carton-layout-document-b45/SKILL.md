---
name: lynxce-trade-mixed-carton-layout-document-b45
display_name: "装箱单版本与跟单交接"
display_name_en: "Mixed Carton Packing List Planner"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "根据订单数量、箱容和混装要求编排逐箱清单，计算型号数量与净毛重汇总，并提供改箱后的装箱单。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.1
author: "灵策智算 LynxceAI"
---

# 装箱单版本与跟单交接

## 使用位置与输入
本模块服务“出口混箱装箱单编排”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
根据已通过数量和容量回代的逐箱组成，生成可复制装箱单，箱号、各型号数量、净重、包材重、毛重同表展示，实测栏保持空白待用户回传。合计行除件数和重量外再列各型号总量，防止总数一致掩盖型号错配。用户改箱规后用旧箱到新箱映射解释变化，不能直接覆盖旧单据；已经封箱的行标现场重编待决定。假设从5箱改为6箱，包材理论增加0.4公斤，即使商品净重不变，毛重也应随之变化。交跟单文字稿说明资料版本、称重待补和未填字段，不虚构收货人、海关编码或发运成功记录。没有外尺寸时体积列写待补，不填0。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，只重算受新增数据影响的部分。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。
