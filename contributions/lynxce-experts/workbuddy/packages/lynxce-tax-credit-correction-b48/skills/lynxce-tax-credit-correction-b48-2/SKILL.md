---
name: lynxce-tax-credit-correction-b48-2
display_name: "纠正履行勾稽"
display_name_en: "Tax Credit Record Advisor"
description: "Reconcile supplied official requirements and actual records, then prepare complete drafts and correction versions."
description_zh: "面向企业财税人员，核对信用评价、申报与缴款证据，区分复评和修复，交付分类说明、履行台账及补正稿"
description_en: "Reconcile supplied official requirements and actual records, then prepare complete drafts and correction versions."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 真实缴款与纠正证据勾稽
本能力核对信用事项中的申报、缴款及其他履行证据，不核定应纳税额、不代算处罚。应缴税费、利息、滞纳金、罚款分别取自用户提供的实际文书，未知保留待补；一个项目文书明确无某项，不推广到全部业务。逐笔记录文书、税费种或事项、所属期、金额、支付或入库状态、凭证和能证明的范围；银行付款不能自动证明税务入库，申报接受也不等于税款已清。

同笔核对先确认对象与所属期，再算应缴、已匹配和差额，不按金额相同就匹配。补缴、冲销、退税及他所属期付款分别列示，重复凭证不得加两遍。应缴二万元，E02一万二千加E03八千都已明确本笔归属时，税款已匹配二万元、差额零；另滞纳一百二十有E04，与税款合计二万零一百二十，不能把滞纳凭证再加进二万元税款。利息及罚款本笔无额仅按已给文书记载。

若新增E05称E03八千属于另一所属期，与原文冲突，保留两情境：原归属成立则税款二万全匹配；E05成立则本笔仅一万二千，差八千。E04仍120同笔已缴，不抵税款差额。实际归属未确定时不写已缴清，也不说企业必然少缴或凭证造假，交所需入库所属期和正式更正材料。前一事项T1申报回执不因本次资金冲突被删去。

交付逐笔台账、双来源对照、精确合计与完整履行说明，并标“足额缴款证据”与“修复条件全部满足”并非同一判断。纠正时间档、附件六项目、其他义务不齐时不算恢复几分，不承诺按已缴比例必然加分。完成标准是每一笔归属和状态清楚、零与未知分开、两个数值情境完整、未决来源可补证；文稿不伪造票据、付款及承诺，不用账上调整代替真实法律义务履行。

