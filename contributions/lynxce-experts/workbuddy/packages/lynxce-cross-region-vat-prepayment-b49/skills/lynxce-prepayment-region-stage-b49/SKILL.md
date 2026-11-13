---
name: lynxce-prepayment-region-stage-b49
display_name: "地区阶段分流"
display_name_en: "Cross Region Construction VAT Prepayment Advisor"
description: "Reconcile cross-region construction receipts, paid subcontract costs and actual VAT prepayments in project-level drafts."
description_zh: "为跨地区建筑企业财务核对项目地点、已付分包与预缴凭证，形成逐项目税款台账、抵减说明和冲突补正稿。"
description_en: "Reconcile cross-region construction receipts, paid subcontract costs and actual VAT prepayments in project-level drafts."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 地区阶段分流
依2026增值税实施条例第四十五条及2026年第14号办法识别建筑项目所在地、预收和纳税义务发生的路线。输入机构及各项目真实省市县、是否直辖市、服务性质、纳税人身份、计税方法、预收收款日、开票和纳税义务事实、此前预缴覆盖。不能只凭“异地工程”或合同写预付款就判地点与日期，更不能沿用全部跨县建筑一律预缴的旧习惯。

跨地区建筑是跨地级行政区，直辖市按下辖县区；同一非直辖地级内跨县不当然适用跨地区分支，但建筑预收仍核另一路。一般建筑预收向机构地预缴，跨地区预收则向服务发生地；同一预收对应价款以后纳税义务发生不再重复预缴，新增价款仍按真实覆盖核。一般纳税人一般计税主例用2%预征，9%建筑适用税率必须对应实际服务；简易、小规模优惠和其他交易另核，不从一般计税例推通用预征率。

假设甲企业机构在甲省甲市甲县，A乙省乙市乙县，B甲省丙市丙县，均跨地级。A9月当期价款1090000元已发生纳税义务且无此前预收预缴覆盖，B9月20日预收545000元用户明确未开票且未发生对应纳税义务，二者使用不同时间依据。办法第六条跨地区建筑至次月或按季相应次月申报期结束前预缴，第十条预收至收到后次月申报期结束前；具体征期核当期官方，不编统一十五日或看到10月22日就说必然没逾期。

可复制分流段：“机构【行政区】，项目【行政区】，服务及计税【真实依据】，本次【预收或已发生义务】，此前覆盖【有证或待核】；据【现行分支】向【真实地点】核预缴，期限以【起点和当期征期】确定。相同预收以后发生义务不重复，新增未覆盖价款另核。”输出逐项目地点阶段台账和实质说明，原件摘要、草稿和真实回执分别登记。完成标准为地点层级不混、预收和义务不混、先前覆盖有证据，未确认开票不假写未开，不代登录或作机关认定。
