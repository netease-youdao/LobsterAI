---
name: lynxce-equipment-repair
display_name: 维修时间与成本口径复核
display_name_en: Equipment Repair and Maintenance Ledger
description: Verify response arrival restoration timestamps and comparable repair
  costs.
description_zh: 核对响应到场恢复时点及修换方案可比成本
description_en: Verify response arrival restoration timestamps and comparable repair
  costs.
category: office
version: 1.0.1
author: 灵策智算 LynxceAI
---
# 维修时间与成本口径复核

按工单核对时间线前后顺序与证据来源，首次响应可以远程发生，但到场记录不得被当成首次报修。逆序或同一节点多条不同时间先列冲突，未明确服务时钟时只算自然经过。承诺到场减实际到场的符号容易倒置，应统一“实际减承诺，正值为晚到”。

费用表只比较同一未来周期和功能范围，检查已含安装是否又计一次，报价含税口径是否一致，历史费用是否重复。未知成本不能默认为零；只给已知小计及条件分支。输出“工单或方案／原字段／证据／重算值／待核事项”，交回专家生成跟进材料，不输出系统已修复的无依据结论。

复核前读取 `../../references/workbook.md` 中的输出模板、示例与静态案例；只返回差异和修订行，交回专家合并，不重复整份初稿。
