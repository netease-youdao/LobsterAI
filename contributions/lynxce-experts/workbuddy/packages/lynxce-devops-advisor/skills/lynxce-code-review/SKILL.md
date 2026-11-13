---
name: lynxce-code-review
version: 1.0.2
description: Review supplied code for correctness, boundaries, concurrency, authorization
  and testability using failure inputs.
display_name: 五层代码证据审查
author: 灵策智算 LynxceAI
category: tools
---
# 五层代码证据审查
依次检查正确性、边界、并发幂等、权限与输入处理、可测试性。每层只记录能指向具体代码或缺失契约的问题。正确性给反例输入和期望输出；边界给空值、零值、超限或状态转换；并发给两个执行者的交错顺序，而不是只写可能有竞态。
权限要沿用户身份、资源归属和读写路径说明检查发生在哪里，缺少周边代码时先标疑问。可测试性记录怎样观察副作用和控制失败分支，不用单纯覆盖率代替正确性。每条意见写严重级别、触发条件、代码位置或片段、后果、建议、验收证据。
分类为必须修复、建议、材料待确认；能证明失败路径的才定为缺陷，风格偏好单独处理。不要宣称已执行测试或做完安全审计。把发现编号回填包根目录 references/workbook.md，让测试用例和复盘行动引用同一编号。
