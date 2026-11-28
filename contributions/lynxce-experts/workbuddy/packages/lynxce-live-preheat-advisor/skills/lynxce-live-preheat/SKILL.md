---
name: lynxce-live-preheat
version: 1.0.1
description: Back-schedule promo dates with weekday checks, count reminder frequency
  and compute channel turnout rates after the stream.
display_name: 倒排日历与到场率核算
author: 灵策智算 LynxceAI
category: tools
---
# 倒排日历与到场率核算
本阶段只做日期、频次和到场率三类核算，结果填回包根目录 references/workbook.md。
一、倒排日期。以开播日期为T0，T-n等于T0减n个自然日，跨月按当月实际天数计算。每个节点写成“年月日（星期）时刻”，星期必须按日历逐一核对；预告画面、标题、主页简介三处时间相同才可进入发布清单。开播前一小时等于T0时刻减六十分钟，跨零点时日期同步前移。
二、提醒频次。按渠道逐日数提醒次数：同一粉丝群非开播日不超过一次，开播当天不超过两次；超出的删去或并到相邻节点。
三、到场率。某渠道到场率等于该渠道到场数除以该渠道预约数，保留一位小数；总体到场率用各渠道到场合计除以预约合计，不用各渠道比率直接平均。到场数只用平台数据或能区分渠道的记录，缺失时只报总量并标【材料待确认】。
四、去留判断。渠道到场率低于总体到场率的一半记一次“偏低”；连续两场偏低才建议下一场减少该渠道投入，单场只写观察。预约少于三十的渠道比率波动大，只报数字不做去留结论。
