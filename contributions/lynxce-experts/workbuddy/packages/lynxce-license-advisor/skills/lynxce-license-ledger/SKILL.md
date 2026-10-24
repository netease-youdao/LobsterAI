---
name: lynxce-license-ledger
display_name: 证照日期与主体流转复核
display_name_en: License and Certificate Ledger
description: Validate license entities, date assumptions and continuity of custody
  records.
description_zh: 核对主体证号期限依据和借还记录的连续性
description_en: Validate license entities, date assumptions and continuity of custody
  records.
category: office
version: 1.0.1
author: 灵策智算 LynxceAI
---
# 证照日期与主体流转复核

先核主体、名称、证号及版本是否能对应同一证照对象；号码相同但主体不同仍需澄清，不按标题相似合并。规范化日期必须能追溯证面原文，倒排时只对确定日期计算；条件期限和空值单列，不能用零值挤入最紧急排名。

按阶段重算准备天数并检查窗口是否有依据。内部目标与外部截止分列，未给处理时长时不能声称赶得上审批。借还按流转号核对载体、数量、附页及主体，复制件、照片与原件各自核销。输出“台账号／字段／原材料值／计算或证据差异／需确认人”表，交回专家更新建议行，保留旧版记录和未执行状态。

复核前读取 `../../references/workbook.md` 中的输出模板、示例与静态案例；只返回差异和修订行，交回专家合并，不重复整份初稿。
