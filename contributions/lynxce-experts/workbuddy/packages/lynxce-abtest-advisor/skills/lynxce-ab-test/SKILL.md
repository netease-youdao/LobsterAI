---
name: lynxce-ab-test
version: 1.0.1
description: Prepare auditable sample estimates and difference intervals for two independent
  binary groups.
display_name: 二项比例实验计算口径
author: 灵策智算 LynxceAI
category: tools
---
# 二项比例实验计算口径
仅用于独立用户、二项结果、固定样本且两组近似等量的粗估。输入基线概率、绝对最小可检测差值、双侧显著性和功效；百分数先转小数。示例设显著性为百分之五、功效为百分之八十，对应近似常数一又九六和零点八四，这些是示例假设，不替用户定参数。
每组粗估 n = ceil(2 × (1.96+0.84)^2 × p × (1-p) / delta^2)。结果分析另用未合并标准误 SE = sqrt(pA×(1-pA)/nA+pB×(1-pB)/nB)，区间为差值正负1.96×SE。分母是有效独立用户，不是曝光次数。
不用此近似处理小计数、集群分流、重复用户、收入长尾或序贯检验；输出适用性检查和所缺材料，复杂设计交由有对应方法的分析人员复核。样本量公式是规划近似，不能当严格功效证明。将计算输入、中间值、舍入方式填回包根目录 references/workbook.md。
