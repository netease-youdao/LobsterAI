---
name: lynxce-room-booking
display_name: 会议资源时段与口径复核
display_name_en: Meeting Room and Shared Resource Booking
description: Check buffered booking intervals and the denominators of room usage metrics.
description_zh: 检查含缓冲占用区间及预约使用指标分母
description_en: Check buffered booking intervals and the denominators of room usage
  metrics.
category: office
version: 1.0.1
author: 灵策智算 LynxceAI
---
# 会议资源时段与口径复核

接收资源表和具体预约实例，按资源号排序占用起点，检查重叠时同时核对房间和移动设备；不同资源相同时段不是冲突。缓冲不能为负，跨时区先统一到用户指定时区，转换依据不足就保留待确认。周期预约必须先展开指定日期范围，不能只检查第一场就称全部通过。

指标复核先去掉已取消实例，再对有效预约求并集，实际占用也按同一资源及期间去重；无预约使用单列。输出“资源／实例／冲突区间／分钟数／口径缺口／修订行”。分母为零或记录期间不一致时停止给百分比。通过仅代表输入快照下规则一致，不代表此刻房间仍可预约。

复核前读取 `../../references/workbook.md` 中的输出模板、示例与静态案例；只返回差异和修订行，交回专家合并，不重复整份初稿。
