---
name: lynxce-web-perf
version: 1.0.1
description: Compare supplied performance samples under matching test conditions and
  disclose aggregation limits.
display_name: 性能前后对照计算
author: 灵策智算 LynxceAI
category: tools
---
# 性能前后对照计算
首先核对设备、网络、页面版本、登录状态、测试动作、缓存和样本窗口。条件不一致时分别列出，不把两组数据合成确定改善。独立重复测量可展示原始样本、排序后中位数和范围；小样本中位数仅说明本轮观察，不能替代真实用户分布。
相对减少率为旧值减新值后除以旧值；旧值为零时不能算比例。不同指标不要相加，加载时间与交互延迟也不可互相代替。真实用户分位数需要明确采集方案及统计定义，不能平均若干页面的分位数得到全站分位数。
将条件差异、样本、计算式、结论适用范围填入包根目录 references/workbook.md。预算阈值来自团队确认或明确标为演示假设，不声称已经配置持续集成或运行浏览器测速。
