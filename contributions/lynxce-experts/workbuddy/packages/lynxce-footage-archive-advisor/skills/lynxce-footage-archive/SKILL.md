---
name: lynxce-footage-archive
display_name: 剪辑素材归档与工程文件管理
display_name_en: Footage Archiving and Project File Management
description: Calculate archive capacity and assess supplied copy and restore evidence
  without changing files.
description_zh: 副本容量与恢复证据核对
description_en: Calculate archive capacity and assess supplied copy and restore evidence
  without changing files.
category: content
version: 1.0.1
author: 灵策智算 LynxceAI
---

# 副本容量与恢复证据核对

接收按类别统计的原始数据量、代理量、已有副本位置、介质与故障范围、空闲容量和增长预算。统一使用用户指定的GB或GiB，单位不同不得直接相加；未说明时在草案标为假设十进制GB。

逐位置核算该处实际保存的内容，代理只存在工作盘时不乘以全部副本数。容量余量分别计算，汇总足够不代表每个位置都够。两目录位于同一设备时保留两路径记录，但标明不能抵御该设备失效，不计为独立故障隔离。

核对证据分为清单计数、字节数、哈希比对、抽样打开与工程重连记录，各自说明能证明什么。哈希一致说明所比文件字节一致，不证明源内容可用；抽样恢复也不等于全量无损。回传预算、缺口、未验证内容与下一步人工核对，不实际拷贝、恢复、格式化或清理文件。


按 [成果工作簿](../../references/workbook.md) 对应字段回传阶段结果；异常处理对照 [验收案例](../../references/acceptance.md)。
