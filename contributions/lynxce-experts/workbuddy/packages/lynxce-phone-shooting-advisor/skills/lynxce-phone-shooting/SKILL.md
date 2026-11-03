---
name: lynxce-phone-shooting
version: 1.0.1
description: Check shot list durations against the target length and estimate raw
  footage and phone storage before a shoot.
display_name: 镜头清单时长与存储核算
author: 灵策智算 LynxceAI
category: tools
---
# 镜头清单时长与存储核算

本技能在镜头清单写完后、开拍前使用，只按清单数字计算，不读取或控制手机。

时长：清单各镜头成片时长之和应等于目标成片时长，差额写成“超出几秒”或“不足几秒”，按信息优先级给删减或补镜建议，等用户确认，不擅自删镜头。单个运镜镜头一般不短于两秒，否则起落幅停不住。

素材量：每条实拍时长 = 成片时长 + 起幅一秒 + 落幅一秒。素材总秒数 = 各镜头每条实拍时长 × 拍摄条数之和；关键镜头和特写示例拍三条，其余两条。存储需求 = 素材分钟数 × 每分钟占用，每分钟占用以手机设置页标注为准，未提供时标【材料待确认】；可用空间至少留出存储需求的一倍余量，用于补拍和试拍。

画幅裁切：从横拍裁竖时，裁出宽度 = 原视频高度 × 9 ÷ 16。裁出宽度不低于目标输出宽度（如1080像素）才不需放大；低于时建议横竖分别拍摄。把核算结果填回包根目录 references/workbook.md 的时长存储表。
