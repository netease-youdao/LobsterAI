---
name: lynxce-tech-upgrade-grant-machine-chain
display_name: "设备投资穿透"
display_name_en: "Technical Upgrade Grant Advisor"
description: "Turn actual project records and applicable policies into traceable application drafts and correction notes."
description_zh: "为制造企业核对设备投资、票款和改造成效，对照本轮技改通知，完成投资台账、申报说明与冲突补正稿。"
description_en: "Turn actual project records and applicable policies into traceable application drafts and correction notes."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 逐设备投资证据链
本能力围绕每台设备、独立软件或安装工程建立可回溯清单，输入是本轮技改通知、设备用途、合同、发票未税额、付款覆盖、验收、退款冲红与资产编号。先锁定企业与项目主体及统计期间，再给对象编号，防止总合同与分票重复。一个设备多张票或多次付款应归同一链，票款不匹配时保留差异，不能用另一设备多付款自动填平。缺税额不默认13%，摘要没有查验结果不写已验证发票真伪。
按通知逐项识别支出类型：生产设备、软件、安装、材料、土建、二手设备等是否允许，不能拿全国城市试点的框架代替地方企业细则。确认依据是合同额、已验收、已付票款或其他口径应原样记录；只有通知明确按已支付可关联未税金额计算时，才把该证据覆盖范围计入，支付比例门槛另核。发票金额120、付款120和验收齐并不自动证明用途期间合规，重复财政支持的项目/设备/支出范围也须另检。
假设模拟T01下A120、B30全额已付、C发票10但已付未税覆盖6、D材料20不支持，合同180、已付176，有效基数156。排除项是材料20和安装未付4，共24，不把合同额180全部乘比例。新A票摘要110与原120冲突，保留合同和已付120不变，低口径基数146，差10为票款关联待核而不是自动退款。输出全对象台账、争议来源与一段可复制投资说明，未改变B、C、D继续保留。完成标准是每个基数能回到对象、类别、期间、发票和支付来源，所有未定状态明确，不出专项审计或主管认定结论。
对一笔支付覆盖多个设备的情形，先核付款用途及经办人提供的分摊依据，分摊合计须回到原支付金额；依据缺失时保留未分配余额，不为达到门槛按比例自行摊入。
