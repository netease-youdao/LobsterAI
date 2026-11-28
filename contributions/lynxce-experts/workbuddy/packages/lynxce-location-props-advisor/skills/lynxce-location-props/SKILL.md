---
name: lynxce-location-props
version: 1.0.2
description: Compute weighted location scores, per-circuit power load limits, consumable
  quantities, rental cost and schedule buffers for a shoot.
display_name: 场地评分与用电道具核算
author: 灵策智算 LynxceAI
category: tools
---
# 场地评分与用电道具核算
用于在定场地、定道具、定流程前把数字算清，结果写回包根目录 references/workbook.md。
评分：硬条件任一不满足的场地不评分。其余场地每个维度打1到5分，加权得分等于各维度分数除以5再乘权重后求和，权重合计必须为100。需要同期声而场地存在施工、广播等不可控声源时，直接降为备选，不用总分抵消。
用电：逐台设备写额定功率，按所接回路汇总。单回路估算上限等于额定电流乘220伏再乘0.8；汇总超过上限就拆到其他回路或换低功率设备。回路额定电流不明时写【需场地方或电工确认】，不得用多个插排串接扩容。
道具：消耗品数量等于每次用量乘预计拍摄次数再乘1.5，向上取整到最小购买单位；关键与易碎主道具至少一件备份。
费用：总费用等于小时单价乘预订小时加超时单位数乘超时单价；预算余额除以超时单价向下取整，得到最多可承受的超时单位数。
流程：各环节时长之和加缓冲等于场地可用时长，缓冲不少于可用时长的一成；不够时先删减或合并镜头，不压缩收尾和恢复原状。
