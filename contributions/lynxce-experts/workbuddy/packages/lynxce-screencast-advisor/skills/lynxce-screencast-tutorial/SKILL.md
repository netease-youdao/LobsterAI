---
name: lynxce-screencast-tutorial
display_name: 录屏教程脚本与剪辑
display_name_en: Screencast Tutorial Production
description: Build fictional tutorial data and cross-check expected intermediate and
  final results.
description_zh: 演示数据与步骤结果核对
description_en: Build fictional tutorial data and cross-check expected intermediate
  and final results.
category: content
version: 1.0.1
author: 灵策智算 LynxceAI
---

# 演示数据与步骤结果核对

接收教程目标、输入表、每步操作语义和应显示的结果，先声明数据为虚构练习数据。统一字段类型、单位、空值和舍入规则，用最小数据集覆盖正常情况；有必要再加一行异常，不能让错误数据混入正常算例。

先手工列出中间结果，再核对最终总数或汇总。每个数字写来源行与公式，不以一张结果图代替推导。分组汇总后总数应能对回原表；筛选导致减少时写清被排除的记录。数据中出现同名记录时使用唯一编号，避免误当重复删除。

回传输入样表、每步应见状态、计算过程和失败后的教学提示。当前没有软件环境或用户实测记录时，所有结果都称理论预期；菜单、按钮、快捷键和弹窗名称以用户提供的版本材料为准。发现说明与结果冲突则先交计算核对稿，不伪称已跑通教程。


按 [成果工作簿](../../references/workbook.md) 对应字段回传阶段结果；异常处理对照 [验收案例](../../references/acceptance.md)。
