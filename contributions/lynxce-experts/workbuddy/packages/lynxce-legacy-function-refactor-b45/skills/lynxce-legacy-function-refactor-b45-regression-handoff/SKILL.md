---
name: lynxce-legacy-function-refactor-b45-regression-handoff
display_name: "最小回归脚本与回退说明"
display_name_en: "Legacy Function Refactoring Designer"
description: "Designs small legacy-function patches, behavior characterizations and rollback steps while preserving specified semantics."
description_zh: "依据现有源码和兼容要求拆分遗留函数，交付重构代码、前后行为对照、回归脚本与回退步骤，支持小步改造。"
description_en: "Designs small legacy-function patches, behavior characterizations and rollback steps while preserving specified semantics."
category: tools
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 最小回归脚本与回退说明

## 何时调用与最低输入
输入重构前后函数和行为地图，输出少而有用的对照脚本、运行记录模板和回退步骤。
只围绕本项任务制作一个可以被上层专家直接引用的中间成品。用户没有给出的条件以待补标记；可先按写明的假设生成样稿，再提出不超过三个会改变结果的问题。给每次输入分配材料编号，同一编号在本轮中保持含义不变，不能把推测写成材料事实。

## 具体制作方法
按观察面选样例：正常、空集合、过滤短路、缺字段、转换失败、输入不变。预期必须来自已确认契约或原函数静态推导，不能把新函数结果直接当标准。对比返回值时同时关注类型与顺序；对比异常时按契约决定是否还要比消息。脚本与实际运行记录分开，没有执行结果时只交待运行断言。

## 可复制的已填示例
已填返回对照：两行pen数量二和三得到五；包含归档book四时总量为九。副作用对照使用deepcopy保存原列表，调用后assert rows == before。已填回退：“撤销辅助函数与调用替换，恢复原循环；若另有校验规则补丁，先独立撤销该步。”记录模板为环境／命令／样例数量／实际结果／差异／确认人。

## 修订与完成判据
发现真实运行差异后保留失败输入，不通过修改预期掩盖问题。完成时断言覆盖关键观察面，脚本不接生产服务，运行状态明确，回退与源码版本对应。
交付时同时给可直接使用的正文和一段使用说明，指出哪个条件变更会触发重做。引用本项成品时保留版本号和适用范围，不能只复制结论丢掉假设。遇到用户要求跳过必要输入，仍给可编辑草案，并把受影响位置显式标注，不扩展成未经授权的执行。完成意味着输入可以逐项映射到输出，示例能够手算或逐句核验，所有占位都已有用途说明；不把纸面设计写成已经获得现实反馈。
