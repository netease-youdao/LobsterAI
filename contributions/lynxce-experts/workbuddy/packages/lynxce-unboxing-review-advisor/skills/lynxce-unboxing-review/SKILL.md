---
name: lynxce-unboxing-review
version: 1.0.1
description: Check repeated test runs with medians and ranges, validate noise readings
  against background and decide how strongly differences may be worded.
display_name: 测评数据复核
author: 灵策智算 LynxceAI
category: tools
---
# 测评数据复核
在测试结束、写结论之前使用。输入每个维度每次的读数、单位、环境底噪、撒放或基准量，以及本品与竞品的测试条件和版本。
一、条件一致：本品与竞品的房间、地面、模式、版本和日期逐项比对，有一项不同就在结论旁注明，不能直接比较的写“条件不同，不比较”。
二、中位数与极差：每项至少三次，取中位数；极差等于最大值减最小值，极差占中位数超过一成时提示补测或说明原因。比例类指标用中位数除以基准量，例如回收克数除以撒放克数，保留一位小数的百分数。
三、有效性：噪音读数比环境底噪高十分贝以上才有效；只测一次的项目标“单次结果”，不写优劣结论。
四、措辞强度：两款中位数之差小于其中任一款的极差时，只能写“接近”；差值同时大于两款极差时，才可写具体差多少，仍不用最、第一、绝对等用语。把读数、算式和措辞判断填回包根目录 references/workbook.md 的测试记录和有效性行，假设数据标“假设”。
