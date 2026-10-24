---
name: lynxce-foreign-limit-carry-b49
display_name: "限额年限核算"
display_name_en: "Corporate Foreign Tax Credit Advisor"
description: "Reconcile resident enterprise foreign income, qualifying tax, credit limits and carryforwards with evidence-based revisions."
description_zh: "为居民企业财务核对境外所得、已缴税款和抵免年限，形成分国限额底稿、证据说明与保留退税冲突的修订稿。"
description_en: "Reconcile resident enterprise foreign income, qualifying tax, credit limits and carryforwards with evidence-based revisions."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 限额年限核算
先核企业真实选择的分国不分项或不分国不分项方法，再算当期可抵与历史余额，不把两种方法混算。财税〔2017〕84号规定选择后五年不得改变，变更方法也不能重启旧余额的剩余抵补年限；实施条例第七十九条所称超限额五年则从超限额当年次年连续计算，两类五年不同。没有方法选择历史先交条件底稿，不为了较高抵免临时择优。

假设居民企业2023明确选分国，2025仍不得任意改为汇总；境内应税所得400万元、A200万元、B100万元，均已按中国税法调整分摊，给定一般25%且无其他减免，全球所得700万元、抵免前175万元。A限额175乘200除700为50万元，B限额为25万元。当期合格A60、B10，则A先抵50而超10，B抵10余限15；分国下B的15不能抵A，未用限额也不是税款结转。

A当年2025超10的抵补连续期为2026至2030；A2023旧超8至今未用，其期为2024至2028。A当前限额50被本年税用尽，旧8不能再抵；合计18要保留两年度来源和各自到期，不统一改新五年。即使汇总方法在别的合法情形可能结果不同，本企业也不能无视五年约束自动转换，不能将仅供比较的计算写为已选方法。

若后来确认同笔2025税被返还12，A当期合格48，先抵48后余限2可抵旧8中的2，旧额余6，2025无新超额；A总抵仍50，与原分支同额但余额结构完全不同。B仍10，合计抵60，抵免后175减60为115；中国预缴未知就不算应补。可复制限额段为“按【真实方法】及【税法所得来源】，当期限额【式】，本年合格【额】先抵【额】，剩余限额【额】抵【旧年度】余额【额】，剩余及到期【逐年值】”。完整输出逐国逐年台账和正文，完成标准为方法、年度、单位及限额顺序可复算，不跨国乱用，不将无法准确计算税款登记成可抵结转。
