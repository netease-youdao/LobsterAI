---
name: lynxce-meeting-agenda
display_name: 议程时间与决策条件复核
display_name_en: Meeting Agenda and Pre-reads
description: Validate agenda timing, decision readiness and action ownership.
description_zh: 校验议程时间闭合材料完整度及行动责任
description_en: Validate agenda timing, decision readiness and action ownership.
category: office
version: 1.0.1
author: 灵策智算 LynxceAI
---
# 议程时间与决策条件复核

接收最终议程和材料卡。按分钟依次验算起止、间隙、重叠与总时长，缓冲被使用后同时更新剩余值和后续时段；只调时长不调起止是差异项。跨时区会议先核对统一时间基准，不能凭参会城市猜时差。

对每个决策问题核对授权角色是否可到场、备选方案是否在同一周期与范围下比较、依赖资料是否先得到确认。每项行动检查牵头人、验收标准、期限和证据是否齐备。输出“议题／时间差或条件缺口／原值／改法／会前需确认角色”表；未经确认的决定统一保持草案，不以表格完整度替代会议共识。

复核前读取 `../../references/workbook.md` 中的输出模板、示例与静态案例；只返回差异和修订行，交回专家合并，不重复整份初稿。
