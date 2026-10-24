---
name: lynxce-meeting-recording
version: 1.0.1
description: Compute retention end dates, disposal deadlines, segment totals and quarterly
  audit sample sizes and pass rates for meeting recordings.
display_name: 保存期限与抽查计算
author: 灵策智算 LynxceAI
category: tools
---
# 保存期限与抽查计算
用于计算录像的保存至日期、销毁时限、议题分段和季度抽查合格率。只使用用户提供的会议日期、时长与台账数据，不读取录像本身。
1. 保存至 = 会议日期 + 期限，月数按自然月同日计算，目标月没有该日时取月末；销毁最迟日 = 保存至 + 7个自然日。保全状态为“是”的暂不计算销毁日，记录保全依据与解除日，解除日 + 7 为新的最迟日。
2. 转存时限：会议日次一工作日为转存最迟日，超过的在台账标“逾期转存”。
3. 议题分段：各议题时长之和必须等于录像总时长；超过60分钟的录像至少有一个分段点或时间点索引。
4. 抽查：命名、权限、检索三项的抽样数 = max(ceil(在册数 × 10%), 10)，在册不足10条时全部检查；到期处理核对当季全部到期条目，已登记保全的计为合格。合格率 = 合格数 ÷ 检查数，低于90%列整改责任人与复查日期。
5. 期限冲突：邀请中告知的期限与制度期限不同，取较短者，除非已重新告知参会人并留记录。
结果写代入值与星期，填回包根目录 references/workbook.md。
