---
name: lynxce-service-manufacturing-2
display_name: "合同收入与履约勾稽"
display_name_en: "Service Oriented Manufacturing Advisor"
description: "Prepare manufacturing service scenarios, reconcile contracts and revenue, and deliver complete evidence-based revisions."
description_zh: "为制造企业服务业务经办梳理客户需求、履约收入及场景证据，交付融合场景说明、财务底稿和完整补正稿。"
description_en: "Prepare manufacturing service scenarios, reconcile contracts and revenue, and deliver complete evidence-based revisions."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

先统一同一法人、同一期间、不含税金额和服务边界，将产品销售、服务合同、确认收入、收款及未履约分别登记。服务业务可能依附产品，但不代表所有产品收入都能算服务收入；设备售价包含的服务需要企业提供真实可核拆分依据，未知时不能按有利比例估。合同总额不是会计确认收入，收款也可能含预收，只有输入明确属于同一已确认收入范围时，才可用确认收入减已收款算应收。
示例为2025不含税口径：R01远程运维合同120万元、确认收入90万元、已收72万元；输入明确其收款均冲减本期已确认收入且无其他调整，才得到应收18万元、未履约30万元。R02定制调试合同80、收入60、已收50，同行条件下应收10、未履约20。两单合同200、收入150、已收122、应收28、未履约50，不把合同加收入凑350，也不把28写成已到账。产品销售800另列，若企业资料明确总营业收入950由800加150构成，服务收入占比150除950约15.79%，只是内部描述，不是官方统一资格线。
收到R02新确认收入摘要40万元时，不能自动覆盖旧60，也不能据此认定50收款中多出的10一定是预收或退款。低收入分支中需核销差异10，未履约40；两单收入130、产品800使候选总收入930，服务占比约13.98%。原总收入950仍保留旧源，不能在唯一事实表同时写低收入130与已确认总收入950。输出逐合同全账及双分支解释，金额分类和来源一一对应，所有公式放表外。完成标准是未知不填零、负数差异不擅自解释经济性质、份额不冒充政策门槛。
服务量和客户数量也需单独去重核实，同一客户多个合同不自动等于多家客户；跨年合同只列对应期间真实履约，历史累计不得混入当年收入。原票、收入依据和银行流水分别核查，任何一项齐全都不代替另外两项。
