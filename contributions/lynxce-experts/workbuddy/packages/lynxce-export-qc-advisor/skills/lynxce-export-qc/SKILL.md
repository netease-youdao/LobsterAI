---
name: lynxce-export-qc
display_name: 成片质检与导出参数
display_name_en: Final Cut QC and Export Settings
description: Classify supplied QC observations and map each defect to a fix and a
  verification record.
description_zh: 缺陷分级与复查闭环
description_en: Classify supplied QC observations and map each defect to a fix and
  a verification record.
category: content
version: 1.0.1
author: 灵策智算 LynxceAI
---

# 缺陷分级与复查闭环

输入每条问题的位置、观察者、文件版本、截图或文字描述，以及约定的交付规格。逐项分为阻断、应修、可选：文件打不开、交错版本、内容缺失属于阻断候选；错字、音画衔接和遮挡按影响列应修；偏好性颜色调整列可选。未看到原文件时标“据用户反馈”，不把怀疑当实测。

为每项写修复对象、期望状态与复查办法，保留原问题编号。复查材料必须来自修改后文件；截图可证明静态字幕内容，不能证明全片无黑帧，参数面板可证明配置，不能证明最终文件可播放。证据不匹配时退回待验证，不能为了关单把全部打勾。

回传阻断项数量、应修项数量、可选项数量、已核对和待验证数量，并检查分类总数是否等于问题总数。只输出检查记录，不调用剪辑器、检测工具或目标平台；实际检查由用户执行并提供记录。


按 [成果工作簿](../../references/workbook.md) 对应字段回传阶段结果；异常处理对照 [验收案例](../../references/acceptance.md)。
