---
name: lynxce-b48-export-export-document-map
display_name: "出口单证匹配"
display_name_en: "Export Rebate Document Reconciliation Advisor"
description: "Match export and purchase documents, receipts and filing states under current rules without assuming a refund rate."
description_zh: "为外贸财务与单证人员勾稽报关、购进凭证及收汇记录，识别申报差异，交付准备说明、备案目录与补正稿。"
description_en: "Match export and purchase documents, receipts and filing states under current rules without assuming a refund rate."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 出口单证匹配
围绕一笔真实出口货物建立出口报关项号、购进凭证行、运输履约、销售记录和申报占用的对应关系。先确认实际企业模式、备案依据、货物类型与出口日期，不能把“外贸公司”四字当备案已完成；主例仅限确有依据的自营外贸免退货物，生产免抵退、加工及跨境服务另核。2026业务依财政部税务总局公告2026年第11号与税务总局公告2026年第5号，不再用原2012年第24号的已废止规定作现行依据。

第5号办法第十八条区分外贸各业务申报资料，第二十三条核报关与匹配购进凭证名称、单位。输入为真实原单据或脱敏摘要，缺原件与电子信息则明确待核。商品不同不能拿一类数量余量填另一类，单位从千克到件换算要有实际标准及适用说明，不偷偷改名改单位。出口日期和申报日期分列，未离境不假写已出口；申请材料形成、实际附入、申报受理和核准到账分开。

假设E1报关100件与I1购进100件，每件不含税500元，共50000、票载税6500；E2报关50件与I2购进50件，每件800元，共40000、税5200。两笔购进金额90000、税11700、价税101700，只是原票合计，不表示能退11700。出口FOB销售美元另记，不能与人民币成本求直接差额或要求购销金额相等。税率文库和真实代码时点未核，不把购进票13%当出口退税率。

E3出库单为48件而E2报关和I2为50件，差2件保留来源并列，不自动改为48或虚构合理损耗。可复制说明写“当前材料为【两值及来源】，是否同批、单位、分批发货或需更正待核，不擅改原件；已给其他业务【未变范围】继续保留”。完成交付为全量映射台账、实质准备说明、缺口与询证稿；每行有来源及申报占用，未确认问题不升级可申报，不接海关税务系统、不制造单证。
