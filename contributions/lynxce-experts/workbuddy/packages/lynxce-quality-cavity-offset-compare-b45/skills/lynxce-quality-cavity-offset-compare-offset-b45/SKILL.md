---
name: lynxce-quality-cavity-offset-compare-offset-b45
display_name: "穴间偏移与轮次分层复算"
display_name_en: "Mold Cavity Dimension Comparison Analyst"
description: "Create a ready-to-review plan and transparent calculations from supplied inputs."
description_zh: "按模穴与测量轮次比较尺寸，计算均值偏移、极差和超限分布，交付分穴分析报告与下一轮取样安排。"
description_en: "Create a ready-to-review plan and transparent calculations from supplied inputs."
category: office
version: 1.0.1
author: "灵策智算 LynxceAI"
---

# 穴间偏移与轮次分层复算

## 使用位置与输入
本模块服务“多模穴尺寸偏差对比分析”，接收主流程已经编号的输入，不另造一份数字。需要的对象、单位和时间范围写在模块结果首行；缺项保留待补，只暂停依赖该字段的输出。

## 专属处理方法
按穴和轮次求均值、极差与偏移，再横向比较同轮次穴均值跨度。假设A10.01、B10.06、C9.99、D10.10，跨度0.11毫米；四穴等样本数时整体均值10.04，不等样本数必须按全部读数加权。样本极差只描述该穴本次分布，不直接当长期过程波动；没有稳定过程数据不生成能力指数。下一轮各穴都升高时给共同条件变化候选，仅一穴持续较高时给穴位关联候选，但不跳过测量方法和时间因素。输出二维均值表与解释正文，让主流程能提出要验证的具体问题，而不是只有统计数字或直接要求修模。

## 交接与复核
交付时同时给可直接使用的中间成果、计算来源和未决项，传给主流程合并。不得把建议动作写成已经执行，也不得把另一模块尚未确认的假设改成事实。修订时保留本模块上版结果和变化理由，以本轮完整输入整表重算。核对每个数字的单位和每个判断所依赖的条件，发现冲突先列两个分支。完成标志是主流程可以据此继续编排最终方案，而不是只收到一张空检查表。

## 结构化程序交接
消费calculate.py同次生成的statistics、overallMean、meanSpan与outsideRatios。exact为精确有理数，display按声明位数舍入。超限1件/总12件的精确比例1/12和显示8.33%分列，不能声称有限小数等于循环分数；3/12的显示25.00%也保留分数列。四穴每穴三件时整体10.04；若D仅一件10.09，脚本按全部十件加权，不能平均四个穴均值。单轮不能写某穴持续偏高；多轮先分别运行、检查测量条件一致后再横纵比较。主报告直接引用脚本结果，不再另抄一套数字或添加没有样本支持的时间断言。

