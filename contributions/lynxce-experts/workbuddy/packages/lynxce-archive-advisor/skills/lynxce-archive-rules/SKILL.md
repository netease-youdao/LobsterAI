---
name: lynxce-archive-rules
display_name: 档案账实与处置条件复核
display_name_en: Document Archiving Rules
description: Reconcile archive locations and verify evidence required before retention
  review.
description_zh: 按唯一编号核对实物借出缺失状态及评审条件
description_en: Reconcile archive locations and verify evidence required before retention
  review.
category: office
version: 1.0.1
author: 灵策智算 LynxceAI
---
# 档案账实与处置条件复核

接收已编目录和同一冻结时点的流转表，只核对账实及处置条件。先按档案唯一编号归并载体，核对每个有效借出单是否有批准范围和未结数量；部分归还不能整件计为已还。发现编号重复、在库与借出双重登记时返回冲突清单，暂停计算可定位率，避免重复分子掩盖缺失。

对待评审行逐一检查制度版本、条款、起算凭证、暂停标记和责任人；任一缺失即改为“材料待确认”。输出“档案号／差异类型／目录值／证据值／建议状态／需补凭证”六列。复核通过仅意味着目录与所给材料一致，不能证明实物完好或处置合法；是否执行由档案责任人依据完整材料决定。

复核前读取 `../../references/workbook.md` 中的输出模板、示例与静态案例；只返回差异和修订行，交回专家合并，不重复整份初稿。
