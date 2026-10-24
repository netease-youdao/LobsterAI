---
name: lynxce-legacy-function-refactor-b45-patch-stages
display_name: "提取职责与分步补丁编排"
display_name_en: "Legacy Function Refactoring Designer"
description: "Designs small legacy-function patches, behavior characterizations and rollback steps while preserving specified semantics."
description_zh: "依据现有源码和兼容要求拆分遗留函数，交付重构代码、前后行为对照、回归脚本与回退步骤，支持小步改造。"
description_en: "Designs small legacy-function patches, behavior characterizations and rollback steps while preserving specified semantics."
category: tools
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 提取职责与分步补丁编排

## 何时调用与最低输入
输入行为地图、可见代码和希望改善的可读性问题，输出连续可实施的小步补丁。
只围绕本项任务制作一个可以被上层专家直接引用的中间成品。用户没有给出的条件以待补标记；可先按写明的假设生成样稿，再提出不超过三个会改变结果的问题。给每次输入分配材料编号，同一编号在本轮中保持含义不变，不能把推测写成材料事实。

## 具体制作方法
优先提取没有外部效果且输入输出清楚的表达式，保持原求值点和异常时机。每步写新增辅助函数、替换位置、保持项和独立验收方法。结构调整不同时改变默认参数、返回类型与校验规则。遇到用户同时要求新规则，拆为结构补丁和行为补丁，说明二者的依赖顺序。不要以大段伪代码代替可复制实现。

## 可复制的已填示例
已填补丁一：把row["kind"].strip().lower()提取为normalized_kind(value)，原循环仍在过滤之后调用。补丁二：提取add_units，原接口total_units不变。若要拒绝布尔数量，设补丁三并明确旧int(True)等于一而新逻辑将报错。补丁说明模板为序号／代码／保留行为／有意变化／验收输入／单步回退。

## 修订与完成判据
只要一步引入不可解释的行为差异，就缩小补丁或分离修错。完成时各步顺序可实施、删除新增函数即可回退结构提取，业务规则变动不会被藏在改名中。
交付时同时给可直接使用的正文和一段使用说明，指出哪个条件变更会触发重做。引用本项成品时保留版本号和适用范围，不能只复制结论丢掉假设。遇到用户要求跳过必要输入，仍给可编辑草案，并把受影响位置显式标注，不扩展成未经授权的执行。完成意味着输入可以逐项映射到输出，示例能够手算或逐句核验，所有占位都已有用途说明；不把纸面设计写成已经获得现实反馈。
