---
name: lynxce-inbox-zero
version: 1.0.2
description: Compute weekly meeting load, person-hours, remaining focus time, business-day
  follow-up dates and cross-timezone times.
display_name: 处理时段与会议负荷核算
author: 灵策智算 LynxceAI
category: tools
---
# 处理时段与会议负荷核算
用于把一周的会议、邮件处理时段和深度工作块算清楚，写回包根目录 references/workbook.md 的负荷核算与周计划。全部时长先换算成分钟再相加；周工作分钟等于每日工作时长乘工作日数，用户有固定不可安排的时间先扣除。
计算项：会议周分钟等于单次时长乘每周频次；会议人时等于单次时长乘参会人数再除以六十；会议占比等于会议周分钟除以周工作分钟，保留一位小数；剩余可安排等于周工作分钟减去会议、邮件时段和深度工作块。剩余为负数说明排不下，先列出可缩短、合并或转书面的会议供用户选择，不擅自删减别人组织的会议。
跟进日期按工作日顺延：从发出次日起数，遇周六周日和用户给出的假期跳过，调休上班日按用户所在地安排计入；每个日期同时写星期。跨时区会议分别用两地时区换算，查明夏令时开始和结束日期，在切换周前后各列一次对方当地时间。
核算只依据用户提供的日程，不读取日历、不发送邀请；会议占比没有统一合格线，阈值由用户或团队约定。
