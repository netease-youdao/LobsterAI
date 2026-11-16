---
name: lynxce-quiet-hours
version: 1.0.2
description: Compute per-person interruption rates, category shares and trial-period
  changes from interruption logs with consistent units.
display_name: 打断盘点与试行复盘核算
author: 灵策智算 LynxceAI
category: tools
---
# 打断盘点与试行复盘核算
在盘点周结束和试行复盘时使用。输入区域人数、记录人数、记录天数、每条打断的来源类型与持续分钟。
一、口径：记录人日等于记录人数乘记录天数；回收率等于记录人数除以区域人数，低于六成时只出描述统计，不排优先级。人均每天打断次数等于总次数除以记录人日，人均每天被打断分钟等于总分钟除以记录人日，平均单次时长等于总分钟除以总次数，均保留一位小数。
二、分类：先核对各类次数相加等于总次数、各类分钟相加等于总分钟，不相等时停算并列出差额。各类次数占比与分钟占比分别计算，两种排序都进前两位的类型列为先治对象。
三、复盘：变化率等于试行前减试行后，再除以试行前；用人均比率比较，不用总次数比较，因为两次记录人数可能不同。达到事先约定的成功线才写“达标”；变化不足一成写“无明显变化”。
四、分区距离按步速每秒一点二米粗估，二十秒约等于二十四米；用户提供实测步行时间时以实测为准。把算式、代入值和判断填回包根目录 references/workbook.md 的统计、分类与复盘行，假设数据标“假设”。
