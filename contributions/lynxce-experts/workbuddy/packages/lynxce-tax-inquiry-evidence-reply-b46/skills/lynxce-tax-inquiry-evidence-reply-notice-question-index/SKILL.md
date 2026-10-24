---
name: lynxce-tax-inquiry-evidence-reply-notice-question-index
display_name: "问询逐项拆解"
display_name_en: "Tax Inquiry Evidence Reply Advisor"
description: "Turn actual tax notices and evidence into itemized factual replies, reconciliation bridges and revision records."
description_zh: "帮助企业财务拆解税务通知，逐项勾稽事实与证据、说明金额差异，形成可核对的回复稿、附件目录及补正版本。"
description_en: "Turn actual tax notices and evidence into itemized factual replies, reconciliation bridges and revision records."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 问询逐项拆解
以用户实际提供的税务通知或问题清单为唯一任务范围，生成问题索引、事实底稿和可发送的范围确认请求。最低输入是原文、发文主体、所涉税种与期间、要求的材料、反馈时间渠道以及实际收到情况；缺项不能从同类样本补入。截屏不完整时标明仅覆盖已提供页，已读清的问题仍先处理，不假定附件不存在。文号、机关、送达日期、联系人等不猜写，口头转述仅标用户转述。

逐问保留短原文与Q编号，再列需要解释的事实、证据、差异及当前可答范围。原文“请核实”不等于确定违法，税务机关疑问不等于企业承认差异，纳税人想问“是不是借款”不等于借款真实存在。涉及多个年度或多主体时按对应对象拆分，不能把甲公司事实放到乙公司。正文中的企业别名要能回指用户保管原件，公开对话不收账号密码与验证码。

时间分两列：原文要求和已核实程序依据。假设通知明确2026年10月28日前反馈，就照录来源；若只写尽快，则无法算出统一法定日。60日不是全部涉税问询期限，公告2018年第28号第十五条需具体触发条件；反馈延期请求不等于获准延长。内部建议何日收集资料须标“建议、待责任人确认”，不能虚构机关批准。税收征收管理法第八条所述了解程序、陈述申辩等权利不直接提供未知文书的具体天数。

可复制确认请求：“关于【实际通知】第【Q】项，现有原文可确认的范围为【原文事实】，其中【材料范围或期限】尚不明确。请确认【精准问题】。企业已就已明确部分整理【实际材料】，未将待核信息写为完成。”输出还要给带空缺的回复骨架，让用户能推进已知部分。完成标准是每题有编号、没有遗漏原文要求、未知不升级事实、期限与渠道各有出处；不替企业提交，不把收到风险提示直接等同稽查或处罚程序。
