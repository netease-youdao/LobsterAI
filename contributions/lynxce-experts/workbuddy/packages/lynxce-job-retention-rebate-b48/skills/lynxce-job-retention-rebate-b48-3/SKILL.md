---
name: lynxce-job-retention-rebate-b48-3
display_name: "领取差异说明"
display_name_en: "Job Retention Rebate Advisor"
description: "Reconcile supplied official requirements and actual records, then prepare complete drafts and correction versions."
description_zh: "面向企业人事和财务，核对本轮稳岗返还条件、参保人数与实缴基数，交付确认说明、测算底稿和差异补正稿"
description_en: "Reconcile supplied official requirements and actual records, then prepare complete drafts and correction versions."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 确认领取与基数差异成稿
本能力把人数、基数和资格材料整理为完整稳岗返还确认说明，以及收到不一致信息后的整封V2。先读取政策账、人数账、缴费账和企业提供的推送、申请回执等，分别记录准备稿、企业核定、真实签署、已确认领取、已申请、受理、公示、拨款、到账。没有实际动作的保持待办理；免申即享不等于本工具已经替企业领取，也不代表企业无须核对主体、账户和用途信息。

初稿应有企业和年度、通知范围、人数裁员口径、连续缴费及当前欠费材料、基数和比例、条件测算、资金用途、未决事项、拟附件和签署办理状态。已提供的数据直接写入实质段落，不返一串空标题；未知地方规则就写受限稿，不把国家上限或本包样例当适用事实。用途只能写按实际政策允许拟使用，不编造已发生活补贴、已培训人数和票据。

假设原缴费基数120000、60%测算72000，新增财务表118000及测算70800，有效来源未确认。完整V2应同时说明2000基数差和1200测算差，差异原因待核；十二个月各100、月均100、领取5、裁员率5%、中型及全部未办理状态保持不变。不能只写“改成70800即可”而忽略原表或旧正文72000，也不能因为系统显示金额就称高者误差已解决。拟附A04和A07对照不代表已经提交给经办人员。

后续如用户提供真实核准或到账，按证据分别补记录，不自行执行转账、退款或确认放弃；数据匹配只说明本次材料可核，不保证资金安全到账。交付最后列具体需要谁核哪笔、需哪类原始证明、确认后要同步哪些正文表格。责任人未给用岗位待定，不编姓名。完成标准是两份可复制说明成稿、未决项可定位、历史事实保留和全部收发状态真实，不把补材料建议变成已获批准。

