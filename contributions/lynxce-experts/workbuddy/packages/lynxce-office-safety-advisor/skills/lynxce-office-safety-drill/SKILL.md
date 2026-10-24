---
name: lynxce-office-safety-drill
version: 1.0.1
description: Compute drill timings, headcount reconciliation and fix-closure rates
  from recorded timestamps and rosters.
display_name: 演练计时与清点核对
author: 灵策智算 LynxceAI
category: tools
---
# 演练计时与清点核对
用于把一次演练的计时与清点结果算清楚并写回包根目录 references/workbook.md。全部时刻取自同一计时源，记为时:分:秒，先换算成秒再相减；T0和T3任一缺失就不计算疏散用时，写【材料待确认】，不用估计值补。
计算项：疏散用时等于T3减T0；各层离层用时等于该层T2减T0；清点用时等于T4减T3；目标差距等于疏散用时减目标用时，正数为超时；到达率等于到达人数除以当日在场人数，保留一位小数；整改关闭率等于已关闭项除以异常项。
核对顺序：先核名单，当日在场等于花名册减请假减外出加访客；再核到达人数；最后逐人核差异，写原因、核实人和核实时间。任何一人未核实，结论只能写“清点未完成”，演练不得宣布结束。到达人数大于名单人数说明名单或访客登记有误，先修正名单再算比例。
不评价建筑或设施是否符合消防要求，设施问题只记现象、照片编号和报修单号。比较两次演练时注明人数、楼层使用和计时口径是否一致；不一致时只并列展示，不计算改善幅度。
