---
name: lynxce-price-compare
display_name: "搜商品·比价领券"
display_name_en: "Deal Links & Price Comparison"
description: "Use when the user wants to compare prices across e-commerce platforms, judge whether a discount is real, or compute the actual price after coupons and subsidies."
description_zh: "搜商品直接出券后价与领券链接，并把到手价算清楚：跨平台比价、历史价参考与凑单是否划算。"
description_en: "Works out the real final price: cross-platform comparison, post-coupon math, price history sanity checks and bundle-to-threshold analysis."
category: life
version: 1.0.2
author: "灵策智算 LynxceAI"
---
# 搜商品·比价领券

## 先给链接，再讲道理

用户问「想买××」的时候，要的是**能直接点开下单的优惠链接**，不是一段分析。
所以顺序固定：先搜出各平台券后价与领券链接，把链接原样给出去，再补一句为什么推荐这条。

- 链接原样发出，不改写、不缩短、不加参数——改了优惠就失效。
- 每条都标清楚平台、券后价与生效条件，让用户能直接比。
- 只拿到商品物料没拿到链接时，说明这条暂时只能自己搜，不要编一个链接出来。

## 把到手价算清楚

比价的关键不是找最低标价，而是**把「到手价」算清楚**——标价、券、补贴、运费、退货成本要放在同一个口径里比。

## 先统一口径

- 到手价 = 标价 − 店铺券 − 平台券 − 补贴 + 运费 + 附加服务费。
- 规格必须对齐：容量、件数、型号后缀、是否赠品装，不同规格不能直接比。
- 注意「凑单退货」的隐性成本：退货运费险、拆单后是否失去满减。

## 判断优惠是真是假

- 先涨后降：对照历史价区间，而不是只看「划线价」。
- 满减门槛：为了凑单多买的东西，如果本来不需要，就是多花钱不是省钱。
- 预售定金：定金不退的规则要算进风险，别只看「立减」金额。
- 限购与叠加规则：券是否与会员价、跨店满减同时生效，不确定就写成待确认。

## 给结论的方式

- 并排列出各渠道的到手价与生效条件，标明数据获取时间。
- 写清楚「这个价格什么时候会失效」（券有效期、活动结束时间）。
- 如果差价小于运费或时间成本，直接说不值得折腾。

## 红线

- 不使用「最低价」「全网最便宜」「一定省」等极限词与效果承诺。
- 价格与库存实时变动，所有结论都注明以下单页面为准。
- 不推荐来源不明的低价渠道，不建议为了优惠去做违反平台规则的操作。
