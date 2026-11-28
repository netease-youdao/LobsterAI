---
name: lynxce-food-shooting
version: 1.0.1
description: Total segment durations, average shot length, slow-motion factors, shutter
  speeds and the steam shooting window for a food video.
display_name: 分镜时长与帧率核算
author: 灵策智算 LynxceAI
category: tools
---
# 分镜时长与帧率核算
在分镜定稿和开拍前使用。输入成片目标时长、各段时长与镜头数、拍摄帧率、时间线帧率、市电频率和出锅时间点。
一、时长：各段时长相加必须等于成片目标时长；超出时先删重复的过程镜头，保留成品、切开或淋汁、入口三类特写。平均镜头时长等于总时长除以镜头数，特写段宜在一到两秒之间。
二、慢放：慢放倍数等于拍摄帧率除以时间线帧率；五十帧放在二十五帧时间线上为两倍，一百二十帧放在三十帧时间线上为四倍。成片中慢动作时长等于实拍时长乘慢放倍数，需计入分段时长。
三、快门：快门速度约为帧率两倍的倒数，五十帧用一百分之一秒；五十赫兹市电下优先用二十五或五十帧，选六十帧时预览确认有无闪烁条纹。
四、热气时间窗：以出锅装盘为零秒，把刷汁、补光调整和热气逆光镜头排进三十秒内，超出则改为二次加热重拍或改用声音与拉丝表现热度。把算式、代入值和结果填回包根目录 references/workbook.md 的分镜、帧率与时间窗行，假设数据标“假设”。
