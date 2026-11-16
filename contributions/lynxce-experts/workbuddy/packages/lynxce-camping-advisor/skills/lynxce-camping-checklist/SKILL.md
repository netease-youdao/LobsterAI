---
name: lynxce-camping-checklist
version: 1.0.1
description: Pre-departure checks for camping trips covering estimated low temperature,
  sleeping bag margin, timeline back-calculation, water and stop conditions.
display_name: 出发前核对与撤退判断
author: 灵策智算 LynxceAI
category: tools
---
# 出发前核对与撤退判断
本技能只做出发前的数值核对与停止条件判定，结果填回包根目录 references/workbook.md，所有数值都是规划粗估，不替代官方预报与营地管理方指令。
1. 气温：有营地所在地预报时用营地值；只有城镇预报时，营地粗估 = 城镇夜间最低气温 − 0.6 × 海拔差（米）÷ 100，并标“粗估”和查询时间。
2. 温标：成人要求上限 = 采用最低气温 − 3，儿童、老人和怕冷者 = 采用最低气温 − 5；睡袋舒适温标高于上限即判不达标，列出替代保暖或取消，不用极限温标凑合。
3. 时间：搭建完成最晚 = 日落 − 2小时；最晚到达 = 搭建完成最晚 − 搭建时长；最晚出发 = 最晚到达 − 车程 × 1.2 − 途中停留。日期变化时写明日期与星期。
4. 用水：人数 × 天数 × 每人每天升数，再加约20%备用，向上取整。
5. 复核：出发前24小时与出发当天早上各一次，记录查询时间、信息来源和结论；两次结论不同以较新的一次为准。
6. 停止判定：逐条核对预警、阵风、营地公告、温标、现场雷电、水位、人员状态，任一项为“是”即输出“取消或撤离”，不做加权打分，不给冒险继续的变通方案；人员状态异常时写“立即就医或呼叫急救”，不给处置方法。
