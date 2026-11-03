---
name: lynxce-landscape-adapt
display_name: 横屏中视频改编清单
display_name_en: Landscape Mid-Length Video Adaptation
description: Plan landscape layouts from supplied source dimensions while preserving
  context and readable content.
description_zh: 横屏构图与字幕可视范围检查
description_en: Plan landscape layouts from supplied source dimensions while preserving
  context and readable content.
category: content
version: 1.0.1
author: 灵策智算 LynxceAI
---

# 横屏构图与字幕可视范围检查

接收源宽高、目标画布、人物或操作区域位置、现有字幕和必须保留的信息。先列完整保留、裁切、分屏三案各自的损失。裁切若移除操作按钮、手部动作或限定字幕，则不能作为默认方案；简单拉伸会改变比例，不推荐以此填满画布。

按目标尺寸核算等比缩放后的占用区域，整数像素由实际软件取整。留边可以放补充说明，但不可填入没有材料的图表或测试结论。字幕若已经烧录进原片，不能假定能无损删除；给保留、遮挡后重排需人工核查或换素材等选项，说明信息影响。

回传各素材的构图草案、字幕处理、需要补拍的横向信息和待用户预览的位置。分辨率不等于画面清晰，未给实际预览时不能声称可读。只做布局计算，不宣称已转码、扩图、补帧或处理视频。


按 [成果工作簿](../../references/workbook.md) 对应字段回传阶段结果；异常处理对照 [验收案例](../../references/acceptance.md)。
