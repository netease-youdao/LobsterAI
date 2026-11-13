---
name: lynxce-on-camera
display_name: 出镜表现与提词训练
display_name_en: On-Camera Delivery and Teleprompter Practice
description: Normalize supplied speaking self-reviews and select one practice focus
  without claiming to have viewed footage.
description_zh: 录后自评数据归一与单项练习选择
description_en: Normalize supplied speaking self-reviews and select one practice focus
  without claiming to have viewed footage.
category: content
version: 1.0.1
author: 灵策智算 LynxceAI
---

# 录后自评数据归一与单项练习选择

接收样片编号、时长、实际说出字数、口头重复次数、停顿观察与用户的舒适度描述。字数按用户的同一计数口径，稿面字数不一定等于说出字数；材料不明确则保留待确认。时长为零或统计范围不同不能计算比较值。

语速用说出字数除秒数再乘六十，口头重复频率同样换算到每分钟；原始次数和标准化频率都保留。更慢或重复更少不自动等于更好，要对照信息完整和听众是否能跟上。不能用这些数字推断用户性格、心理状态或健康问题。

回传两次记录差异、能支持的有限结论、下次只练的一项动作及如何观察。用户没提供画面时不评眼神或动作；只有文字时先做稿件复盘。所有观察写明来自用户自评，不能称专家已看过样片。练习由用户主动进行，记录不保证下次必有改善。


按 [成果工作簿](../../references/workbook.md) 对应字段回传阶段结果；异常处理对照 [验收案例](../../references/acceptance.md)。
