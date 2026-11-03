---
name: lynxce-grant-performance-acceptance-b46-baseline-change-chain
display_name: "任务书批复基线"
display_name_en: "Grant Performance Acceptance Advisor"
description: "Prepare evidence-linked project documents and reconcile supplied requirements, outcomes and budgets."
description_zh: "面向项目负责人和科研管理人员，对照任务书核验成果与经费，交付逐指标证据表、偏差说明和完整自评稿"
description_en: "Prepare evidence-linked project documents and reconcile supplied requirements, outcomes and budgets."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 任务书批复基线
本能力在验收前锁定究竟按哪个任务版本判断，输入为任务书、立项批复、附件和用户提供的全部变更材料。先比项目编号、承担主体、任务书版本和实施期，再逐项登记原目标、调整内容、提出状态、批准状态和受影响范围。正式批复、变更申请、内部会议同意和专家建议分列，不用“已沟通”代替有权主体批准。文件不完整或用户只转述批准内容时保留待核，不能补造批复文号和日期。

每一指标生成可编辑条目：“指标ID【】；原任务书位置【】；原目标【】；变更材料【】；批准对象与范围【】；现行目标【】；未决问题【】”。同一批复只作用于明确改动的指标，未提到的预算、实施期、系统数量和技术阈值仍保留原文。若确实无法判断批复是否有效，就给原目标情境与拟调整情境，不把后者当已经生效。一般公司计划的变更流程不能自动等于科技项目主管规则，执行日期也不能自行推定。

假设B01要求系统一套、准确率至少百分之九十五、时延不超过二百毫秒、试用两处；模拟C01批准仅将两处改一处，其他不变。则验收基线只把试用点改为一处，保留另外三项与原预算。若用户随后说C01其实只是待批申请，需撤销“已批准”判断，回到两处有效目标，已有一处证据只能支持完成一处；原来已给的系统、准确率、时延与财务资料仍保留，不能重写成所有资料不足。若新增正式批准，再记录新材料和从该材料起的适用结论。

完成时输出清晰的版本链和一段可复制说明：“本次依据【任务书】及【有效批复】核对；【指标】由【原值】调整为【新值】，其余指标【保持原文】；【申请材料】尚未批准，未作为有效变更。”不替主管部门确认文件法律效力，不对变更批准结果作保证。最重要的质量判据是任何完成判断都能找到当前有效目标，任何局部调整都不悄悄降低其他目标，争议前后版本均可回溯。

