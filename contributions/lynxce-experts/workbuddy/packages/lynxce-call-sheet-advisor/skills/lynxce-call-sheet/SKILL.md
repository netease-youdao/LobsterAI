---
name: lynxce-call-sheet
display_name: 拍摄通告单与日程表
display_name_en: Shoot Call Sheet and Schedule
description: Check a proposed shoot schedule for hard-window, shared-resource and
  travel conflicts.
description_zh: 时间与资源冲突检查
description_en: Check a proposed shoot schedule for hard-window, shared-resource and
  travel conflicts.
category: business
version: 1.0.1
author: 灵策智算 LynxceAI
---

# 时间与资源冲突检查

接收主专家的场次表、人员可用时段、地点窗口、准备时长和转场时长，先统一日期、时区与分钟单位。逐场计算准备开始、拍摄开始、拍摄结束、撤场结束，不能只核对镜头录制部分。

同一摄影或收音人员不能被安排到相互重叠的场次；同一场地也不能同时承载两个互斥布景。接续场次之间至少留出用户提供的转场与重新准备时间，未知时长标材料待确认。自然光和天气没有资料时属于条件约束，不能写成已经确认。

冲突表按硬窗口超出、人员冲突、准备不足、器材不可用四类列出。每项给换顺序、减非必拍、延时或补拍的备选，写清牺牲的镜头。只有经过重新加总和资源复核的方案才回传“纸面无已知冲突”，现场可行性仍待负责人确认。返回总时长、缓冲余额与未解决项，不替人发通告或预订资源。


按 [成果工作簿](../../references/workbook.md) 对应字段回传阶段结果；异常处理对照 [验收案例](../../references/acceptance.md)。
