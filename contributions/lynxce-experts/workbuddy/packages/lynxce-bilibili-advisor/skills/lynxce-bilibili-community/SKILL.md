---
name: lynxce-bilibili-community
version: 1.0.1
description: Compute per-thousand-view danmaku and comment rates, engagement rate
  and median baselines for a monthly Bilibili review.
display_name: 月度互动复盘计算口径
author: 灵策智算 LynxceAI
category: tools
---
# 月度互动复盘计算口径

只比较同一账号、同一统计时点的数据，例如每期都取发布后第七天的后台数值；累计值与七天值不能混用，统计时点不同的期次单列不比较。

千次弹幕 = 弹幕数 ÷ 播放 × 1000；千次评论 = 评论数 ÷ 播放 × 1000；互动率 = （点赞 + 投币 + 收藏 + 分享）÷ 播放。基线取近四到八期的中位数，期数为偶数时取中间两期的平均；不用平均数，避免一期爆款拉偏。变化幅度 =（本期值 − 基线）÷ 基线。

判断规则：可比期次少于四期只描述方向；单期高于基线百分之三十以上，标为"可复用候选"，连续两期以上都高于基线才写进固定做法；单期低于基线百分之三十以上，先查选题、时长和发布时间是否变化，再判断互动点。阈值是示例，可按账号波动调整。

播放为零或缺失的期次不计算；同一期两个来源数值不一致时，两值并列标冲突，不择一计算。一期之内同时改了选题和互动点，不能把变化只归因于互动点。把代入值、中间结果和舍入方式（保留一位小数）填回包根目录 references/workbook.md 的复盘表。
