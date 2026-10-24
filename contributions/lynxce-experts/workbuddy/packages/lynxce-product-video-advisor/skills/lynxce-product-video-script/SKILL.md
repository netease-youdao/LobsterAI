---
name: lynxce-product-video-script
display_name: 商品展示短视频脚本
display_name_en: Product Showcase Video Script
description: Pair supplied product claims with evidence and narrow unsupported wording
  before scripting.
description_zh: 卖点证据配对与表述收缩
description_en: Pair supplied product claims with evidence and narrow unsupported
  wording before scripting.
category: content
version: 1.0.1
author: 灵策智算 LynxceAI
---

# 卖点证据配对与表述收缩

接收商品型号、材料编号、候选宣传语和计划展示方式。把每句拆成可观察结构、尺寸或数量、使用体验、性能主张四类；记录支持它的具体材料及适用条件。型号不同、时间不同或只给口头印象的材料不能直接支撑参数结论。

外观可见的分隔只描述结构；一件物品放进去只证明该示例可放入，不能推成“适合所有型号”。性能、功效、等级或认证未知时标材料待确认，暂停相关表述，保留其他已支持卖点。改掉夸张词并不自动得到可发布结论，要看改后是否仍暗示没有依据的效果。

每项回传原句、可用改写、对应镜头、条件说明和缺失材料，不实际测试或生成证明。用户要求的演示若可能损坏商品，改成已有材料介绍或普通使用展示；不把演示方案写成已测得结果。此技能是内容证据整理，不给法律或平台审核保证。


按 [成果工作簿](../../references/workbook.md) 对应字段回传阶段结果；异常处理对照 [验收案例](../../references/acceptance.md)。
