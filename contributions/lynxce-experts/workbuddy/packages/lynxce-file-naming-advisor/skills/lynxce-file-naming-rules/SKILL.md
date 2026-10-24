---
name: lynxce-file-naming-rules
display_name: 文件迁移冲突与回滚复核
display_name_en: File Naming and Versioning Rules
description: Review path collisions, references and reversible file migration mappings.
description_zh: 检查迁移映射的唯一性引用依赖和恢复证据
description_en: Review path collisions, references and reversible file migration mappings.
category: tools
version: 1.0.1
author: 灵策智算 LynxceAI
---
# 文件迁移冲突与回滚复核

只在迁移表生成后使用。接收原路径、目标路径、保护组、引用清单及备份记录，先检查每条源记录是否仅出现一次，再检查目标集合是否唯一。没有目标的暂缓行不参与碰撞计数，但必须计入总量。分别统计可试点、暂缓、保护三组，三者之和应等于输入条数；重复源行需单列，不能静默合并。

复核版本时逐一关联批准材料，日期较晚且无批准材料的行退回评审，不推翻已有签章依据。对试点行核对原路径与恢复路径一致、备份记录可定位、依赖有验证负责人。输出“序号／错误字段／原值／修订建议／解除阻断材料”五列。只有冲突清零且执行前证据齐备，才可写“可交管理员试点”，仍不能写迁移成功。

复核前读取 `../../references/workbook.md` 中的输出模板、示例与静态案例；只返回差异和修订行，交回专家合并，不重复整份初稿。
