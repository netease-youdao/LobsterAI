---
name: lynxce-db-schema
version: 1.0.1
description: Review staged schema migration prerequisites and recovery limits without
  executing database commands.
display_name: 表结构迁移阶段审查
author: 灵策智算 LynxceAI
category: tools
---
# 表结构迁移阶段审查
按扩展、回填、核对、切换、观察、清理分阶段列前置证据。扩展阶段先确认引擎版本和语法能力；回填阶段明确唯一游标、批量边界和重复执行规则，不将偏移分页当作必然可靠游标。新旧并存时写清哪份数据权威、写入失败怎样对账。
每阶段给进入条件、完成证据、中止条件和恢复方向。删列、数据截断等不可逆步骤不能仅靠反向建表语句恢复原数据；应写可用备份、恢复演练材料与停留观察期。锁行为、日志增长、复制延迟和磁盘余量均以团队材料确认。未知时不输出带确定承诺的生产命令。
把审查结论填回包根目录 references/workbook.md。这里只产出变更评审底稿，不能声称已建索引、已迁移或已验证无锁。
