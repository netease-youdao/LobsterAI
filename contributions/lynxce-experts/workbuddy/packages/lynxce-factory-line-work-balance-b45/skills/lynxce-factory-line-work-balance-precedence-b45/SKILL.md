---
name: lynxce-factory-line-work-balance-precedence-b45
display_name: "装配动作依赖与限制成表"
display_name_en: "Manual Assembly Work Balance Planner"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "根据装配动作工时与前后依赖编排工位，计算各站负荷与节拍差距，交付动作分配方案和试运行观察表。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 装配动作依赖与限制成表

## 使用位置与输入
本模块服务“手工装配工位平衡方案”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
把用户工艺摘要转成动作编号、秒数、前置编号和可移动限制。前置关系只取用户明确内容，不凭动作名字猜“应该先做”。检查每个前置编号存在、没有自指和闭环；若A需B、B又需A，应保留冲突而非随意删边。假设A在B/C前，B在D前，C在E前，给两条链A→B→D与A→C→E，说明D与C之间没有材料规定的依赖。用户要求固定同站或固定设备的动作另加限制列，不把依赖和同站混为一类。输出能直接用于分配的动作表和待确认环节，数字保留测时口径与样本期。模块不编新的现场作业动作，不把观察到的等待当可安全删除的步骤。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，以本轮完整结构化输入整表重算。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。

## 结构化脚本交接
把动作原始资料转换为唯一id、seconds、indivisible、originalStation、allowedStations及dependencies。动作命名不推断前后关系，脚本检查缺编号、自指和循环；只能把用户已明确的依赖写入。原AB/C/DE时A、B站1，C站2，D、E站3；许可同等技能移动也须留作输入条件。B30与B50分别成输入，condition保留记录表或视频摘要来源未定，不能自动裁决。等候或共享资源不明时放unmodeledConstraints或changes的未归属项，脚本不会假装已建模。向负荷模块交输入、原始出处与待补字段；循环或受限动作阻塞时先交依赖表，不自行删边。两站枚举以每动作一次且全部站非空为准，不用漏站统计证明最少站数。

