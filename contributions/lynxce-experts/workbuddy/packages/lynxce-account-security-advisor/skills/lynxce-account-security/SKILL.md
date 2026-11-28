---
name: lynxce-account-security
version: 1.0.2
description: Build an incident timeline, compute suspicious windows and stop-loss
  durations, and audit team permissions and overdue revocations.
display_name: 异常时间线与权限回收核对
author: 灵策智算 LynxceAI
category: tools
---
# 异常时间线与权限回收核对
用于把账号异常整理成可提交、可复查的时间线和权限核对结果，写回包根目录 references/workbook.md。只处理用户提供的截屏、导出记录和成员列表，不接收密码、验证码、证件号或证件照片。
时间线：每条记录写日期时刻、事件、来源证据编号、记录人。起点为最近一次本人确认正常的操作，终点为首次发现异常，二者之差即可疑窗口，写成小时和分钟。窗口内的陌生设备、新增授权、成员变更列为排查对象；早于窗口的新增授权也要列入，因为可能是入口。排查对象只写事实，不认定责任人。
止损用时等于最后一个止损动作完成时刻减发现时刻；陌生登录到发现的间隔单独记录，用于说明暴露时长。
权限：逐人列角色、实际工作需要、当前权限、处理方式（保留、降级、移除）和处理日期。离职或换岗人员的逾期天数等于核查日期减离职日期，大于零即为回收逾期。处理后重新统计各角色人数，管理员人数超过实际需要的必须写明理由。
跟进：平台告知的回复时限按工作日顺延计算跟进日；平台未告知时写【材料待确认】，不自行假设时效。同一事项只保留一个工单，补充材料追加到原工单。
