---
name: lynxce-legacy-function-refactor-b45-behavior-surface
display_name: "函数观察面与现有行为刻画"
display_name_en: "Legacy Function Refactoring Designer"
description: "Designs small legacy-function patches, behavior characterizations and rollback steps while preserving specified semantics."
description_zh: "依据现有源码和兼容要求拆分遗留函数，交付重构代码、前后行为对照、回归脚本与回退步骤，支持小步改造。"
description_en: "Designs small legacy-function patches, behavior characterizations and rollback steps while preserving specified semantics."
category: tools
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 函数观察面与现有行为刻画

## 何时调用与最低输入
输入原函数、调用样例和兼容条件，输出能够指导补丁的行为地图。
只围绕本项任务制作一个可以被上层专家直接引用的中间成品。用户没有给出的条件以待补标记；可先按写明的假设生成样稿，再提出不超过三个会改变结果的问题。给每次输入分配材料编号，同一编号在本轮中保持含义不变，不能把推测写成材料事实。

## 具体制作方法
按实际求值顺序追踪字段读取、条件短路、类型转换、返回和外部效果。正常结果之外必须列出异常类型、输入是否被改写、迭代次数和调用顺序。可见代码能推导的标静态推导，需要环境才能确认的标待运行。为每个观察点选一个最小输入，避免把十种问题揉进一个样例导致结果无法归因。

## 可复制的已填示例
已填观察点：“先读archived；若为真且默认不包含归档，跳过该行，因此即使缺kind也不报错。”最小输入为[{"archived": True}]，预期空字典。另一个输入[{"archived": False}]预期KeyError。地图模板为观察点／最小输入／已有行为／来源／是否必须保持／待确认条件。

## 修订与完成判据
补充调用样例时先检查是否推翻原范围，再更新地图。不能把设计者喜欢的行为写成旧行为。完成时每个后续提取点都有对应观察点，未知副作用单列，不凭缺乏材料断言不存在。
交付时同时给可直接使用的正文和一段使用说明，指出哪个条件变更会触发重做。引用本项成品时保留版本号和适用范围，不能只复制结论丢掉假设。遇到用户要求跳过必要输入，仍给可编辑草案，并把受影响位置显式标注，不扩展成未经授权的执行。完成意味着输入可以逐项映射到输出，示例能够手算或逐句核验，所有占位都已有用途说明；不把纸面设计写成已经获得现实反馈。
