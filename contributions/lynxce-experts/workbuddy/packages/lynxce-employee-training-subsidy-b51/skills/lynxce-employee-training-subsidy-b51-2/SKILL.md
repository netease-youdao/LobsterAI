---
name: lynxce-employee-training-subsidy-b51-2
display_name: "名单证书勾稽"
display_name_en: "Employee Training Subsidy Advisor"
description: "Organize traceable enterprise policy materials, reconcile records and prepare complete correction drafts."
description_zh: "为企业培训经办核对人员课时证书及费用，梳理补贴证据缺口，交付名单底稿、申请说明和完整补正稿。"
description_en: "Organize traceable enterprise policy materials, reconcile records and prepare complete correction drafts."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 名单证书勾稽
以内部人员代号为唯一连接点，将应参训、实际参加、完成计划、结业名单、证书清单及本次拟列候选逐一对齐。各表先检查工种等级、班期和主体一致，同一人重复扫描不多计，证书缺少不能用全班名单补齐。输入给组且同值时可组列，但每组范围必须明确；一个人值变化须能定位，不能用总人数掩盖。出勤学时、结业与依法可补是三个状态，未给当地门槛不能由模型自定。
示例U01至U16十六人各四十学时、U17和U18两人各四十、U19和U20两人各二十，总二十；达到计划四十的人数十八，结业名单十八，证书清单十六。覆盖百分之九十和百分之八十只是给定资料指标，不是主管核准合格率。证书类型编号和验证未知时照实标，不说已经查验真实，也不从未列清单推定该人绝无别的证书。
新增P06把U17、U18改为三十二时保留原四十并列，按计划描述原十八与新十六，差二人、覆盖差十个百分点；原结业十八和证书十六不自动改。应请求逐日签到、考核及结业依据并核有效版本，不因新表标题复核就宣布生效。原件未给不能制作补签考勤，也不能给漏课人员生成证书。完整输出各组、计划实际、结业证书及来源状态，汇总和公式放表外；完成是证据关系清晰、冲突可追，不是把每张表人数强行调成一样。最终能否计入本轮补贴仍依真实地方规则和有权审核，不由本能力决定。
签到的实际日期应覆盖同一班期，补录说明要保留真实形成时间；仅有总学时不应反推每天出勤。证书清单、考核及结业不是同一文件，缺哪一件逐项列，不以一份合影替代全部人员的证据。
