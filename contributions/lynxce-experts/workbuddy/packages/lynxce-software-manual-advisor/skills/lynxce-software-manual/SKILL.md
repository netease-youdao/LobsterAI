---
name: lynxce-software-manual
version: 1.0.1
description: Plan screenshot annotations and version replacements from supplied images
  without inventing interface details.
display_name: 截图标注与版本维护
author: 灵策智算 LynxceAI
category: tools
---
# 截图标注与版本维护
只为用户提供且可辨认的截图建立索引。记录任务编号、步骤、文件名、界面版本、需保留区域、序号标注及替代文字。敏感数据使用测试值或标记脱敏要求；只交标注计划时必须写“待实际处理”，不能声称已打码或已经生成新图片。
一图可以解释多个连续且不易混淆的步骤，纯文字已足够时无需为每步强配图片。操作位置既用图号也用可见控件名称说明，避免只写左上角或红色按钮。截图中的文字与正文不同就登记冲突，不能自动猜新版本菜单。
版本升级后按受影响任务查找全部引用，替换截图时同时核对步骤、权限和完成标志。旧图保留适用版本标识，不混入当前指引。将索引填写在包根目录 references/workbook.md 的截图表；没有截图时交拍摄清单与文字草稿，不制造已见过界面的叙述。
