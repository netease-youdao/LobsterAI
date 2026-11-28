---
name: lynxce-audio-capture
version: 1.0.1
description: Compute gain changes in dB, mic spacing for multi-person setups and true-peak
  headroom before loudness normalization.
display_name: 电平与响度增益核算
author: 灵策智算 LynxceAI
category: tools
---
# 电平与响度增益核算
本阶段只做四类核算，结果填回包根目录 references/workbook.md，参数是起点值，以复听为准。
一、录音电平。需调整的增益等于目标峰值减当前峰值，单位dB；负值表示降低增益。幅度倍数等于10的（调整dB÷20）次方，降低6 dB约为原幅度的一半。目标峰值取负十二到负六dBFS之间的一个值，不取区间外。
二、多人间距。两支麦之间的距离不少于每支麦到嘴距离的三倍；两人距嘴不同时取较大的那个计算。达不到时改用更近的摆位或更强指向的麦，并分轨录。
三、哼声频率。电源哼声按本地电网频率判断，中国大陆为50赫兹，倍频依次为100、150、200赫兹；只在实际出现的频点做窄带陷波，不整段大幅削低频。
四、响度提升前核算。需调整的增益等于目标综合响度减当前综合响度；调整后真峰值等于当前真峰值加该增益。若结果高于负一dBTP，超出部分需先由压缩或真峰值限制器吸收，并写明需要压低的分贝数；不能直接拉增益交付。综合响度与真峰值读数由用户在剪辑软件的响度表中取得，未提供时标【材料待确认】，不估算。
