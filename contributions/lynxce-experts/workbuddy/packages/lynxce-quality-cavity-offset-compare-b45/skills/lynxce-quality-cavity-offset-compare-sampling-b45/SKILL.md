---
name: lynxce-quality-cavity-offset-compare-sampling-b45
display_name: "多穴平衡取样安排与成稿"
display_name_en: "Mold Cavity Dimension Comparison Analyst"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "按模穴与测量轮次比较尺寸，计算均值偏移、极差和超限分布，交付分穴分析报告与下一轮取样安排。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.1
author: "灵策智算 LynxceAI"
---

# 多穴平衡取样安排与成稿

## 使用位置与输入
本模块服务“多模穴尺寸偏差对比分析”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
根据用户可用生产轮次安排各穴同次数取样，记录样件代号和测量方法版本，保持轮次内可比较。假设4穴、3轮次、每穴每轮3件，总样本4×3×3=36件；不能把每穴3件误报成总计12件后又声称覆盖3轮。每轮按同样表头回填，缺测明确写缺测，不用其他轮次替补而不备注。把取样计划写成用户可审议的安排，并将实际执行回执留空。报告正文先给样本事实，再给穴位与时间的待验证分支，最后给需用户提供的环境、方法或记录材料。不编工艺调整参数，不承诺通过取样即可证明整批无缺陷，成稿可直接用于内部质量讨论。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，以本轮完整输入整表重算。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。

## 结构化程序交接
以samplingPlan.rounds、perCavityPerRound和实际穴号调用脚本，生成完整samplingRows，每一行包含轮次、穴号、独立样件号、待填读数、上限来源、方法和记录人。四穴三轮各三件对应36行，normal和双版本abnormal都完整渲染36行，不能引用缺少新增版本列的旧表冒充新成品。生成Markdown后从实际数据行计数，按轮次与穴号交叉核对，不仅核4×3×3的计划数。正文使用同次总样本和条件超限数，未决来源持续写条件，取样仍标未执行。只留必要报告、整表和三个关键问题，省略重复自评口号，真实现场回执收到后再登记执行。

可复制报告由同次Markdown自动生成，直接保留资料性质和条件来源。逐件变化数、编号与取样实物行数皆取程序结果，不另写一套摘要。

