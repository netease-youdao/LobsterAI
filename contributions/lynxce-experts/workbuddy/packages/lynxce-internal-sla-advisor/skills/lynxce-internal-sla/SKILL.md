---
name: lynxce-internal-sla
display_name: 内部服务请求与响应时限规范
display_name_en: Internal Service Requests and Response SLAs
description: Check working-time service clocks, pause evidence and SLA reporting denominators.
description_zh: 核对服务工作分钟与统计分母
description_en: Check working-time service clocks, pause evidence and SLA reporting denominators.
category: office
version: 1.0.1
author: 灵策智算 LynxceAI
---

# 服务计时与分母核对

输入时间线、工作时段、目标和暂停记录。先把跨日区间拆为每天的有效服务段，再求交集时长，最后扣除已确认且不重叠的允许暂停段；负时长视为事件冲突，不调换时间掩盖问题。

输出：请求号｜原始服务分钟｜允许暂停分钟｜有效分钟｜目标｜是否按时｜计算段。月报另查目标已到但仍未解决的记录是否进入分母；行政关闭和用户确认解决分开。缺日历或起始时间时给待确认行，不假装完成时长计算。
