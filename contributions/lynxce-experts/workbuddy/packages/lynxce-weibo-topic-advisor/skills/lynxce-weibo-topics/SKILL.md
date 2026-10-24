---
name: lynxce-weibo-topics
version: 1.0.1
description: Check exported super topic stats for consistency, compute month-over-month
  changes, fan post share and weekly staffing hours.
display_name: 超话复盘与工时核算
author: 灵策智算 LynxceAI
category: tools
---
# 超话复盘与工时核算
在每周排期和每月复盘时使用。输入用户导出的阅读、讨论、帖子总数、官方帖数、粉丝帖数、发帖人数、签到人数，以及每周可投入工时。
一、一致性：官方帖加粉丝帖应等于帖子总数；发帖人数不应大于帖子总数；扣除官方账号后的粉丝发帖人数不应大于粉丝帖数。任一条不成立，先停止复盘，列出冲突字段并请用户核对导出时间窗和指标定义。
二、比例：粉丝帖占比等于粉丝帖数除以帖子总数，环比变化率等于本月减上月再除以上月，均保留一位小数的百分数；上月为零时不算变化率，只写新增数量。
三、工时：周所需工时等于周官方帖数乘单条工时，单条工时默认按四十分钟估算并标为假设，用户有实际记录时替换；所需工时超过可投入工时的八成，提示减少栏目。
四、把算式、代入值和判断填回包根目录 references/workbook.md 的工时、复盘和健康度行；数据来自导出表时注明导出日期和时间窗，来自假设时标“假设”。
