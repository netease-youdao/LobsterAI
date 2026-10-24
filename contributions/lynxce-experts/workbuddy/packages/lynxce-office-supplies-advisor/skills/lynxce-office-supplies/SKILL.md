---
name: lynxce-office-supplies
display_name: 耗材单位与补货数量复核
display_name_en: Office Supplies Requisition and Stock
description: Validate stock units, inventory position, reorder thresholds and pack
  rounding.
description_zh: 核对基础单位库存位置补货点及整包装取整
description_en: Validate stock units, inventory position, reorder thresholds and pack
  rounding.
category: office
version: 1.0.1
author: 灵策智算 LynxceAI
---
# 耗材单位与补货数量复核

只核对表格计算，不重写采购管理制度。先检查品项、单位、期间三者一致；逐笔动作的正负方向按库存增减核对，预留只作用于库存位置，不再次扣账面。每个品项验算期末平衡，实盘差异必须有独立调整记录才能进入已确认现货。

检查补货点与目标量区别，目标量须包含复核周期；包装向上取整只能在净需求为正时使用，净需为零不为凑整包额外建议购买。交期、安全量或分母缺失就输出条件公式及缺口。输出“品项／算式／输入单位／计算值／差异／修订建议”，特别标注在途假设、过期风险和采购余量，交回专家合并申购提案。

复核前读取 `../../references/workbook.md` 中的输出模板、示例与静态案例；只返回差异和修订行，交回专家合并，不重复整份初稿。
