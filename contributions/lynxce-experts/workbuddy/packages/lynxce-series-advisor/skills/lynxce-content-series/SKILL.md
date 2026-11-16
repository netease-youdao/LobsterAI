---
name: lynxce-content-series
display_name: 系列栏目策划与排期
display_name_en: Content Series Planning
description: Review four episodes using comparable inputs and propose one controlled
  format change.
description_zh: 四期数据复盘与下一轮选题调整
description_en: Review four episodes using comparable inputs and propose one controlled
  format change.
category: content
version: 1.0.3
author: 灵策智算 LynxceAI
---

# 四期数据复盘与下一轮选题调整

输入期号、内容格式、时长、发布后的观察窗口、曝光或起播口径、完播数、互动与制作工时。先检查分母与窗口；有的只有播放量、有的只有曝光时不能混算。缺失值留空，零次起播的比例记不可计算，不写零完播率。

用总完播数除总起播数计算整体完播比例，同时保留每期数值，不能平均几个比例代替加权结果。互动若统计的是点赞评论次数，就称事件数，不能当独立人数；没有净增关注数据不倒推出涨粉。

决定下一轮时同时看内容证据和制作成本。四期结果只用于提出一个待验证调整，不足以宣称栏目一定有效或失败。写不变项、唯一主要变量、预期观察及停止条件；当材料明显不可比，输出口径补齐表而非强行排名。把重排建议交还主专家，保留人工触发和回填步骤。


按 [成果工作簿](../../references/workbook.md) 对应字段回传阶段结果；异常处理对照 [验收案例](../../references/acceptance.md)。
