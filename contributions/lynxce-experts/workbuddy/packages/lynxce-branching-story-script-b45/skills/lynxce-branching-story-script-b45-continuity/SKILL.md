---
name: lynxce-branching-story-script-b45-continuity
display_name: "分支连续性与试玩修订"
display_name_en: "Branching Interactive Story Script Designer"
description: "Writes playable branching stories with complete node text, meaningful choices, endings and verified path structure."
description_zh: "围绕玩家选择编写互动故事，交付完整节点、分支按钮与多种结局，并检查路径可达性和合流后的语境。"
description_en: "Writes playable branching stories with complete node text, meaningful choices, endings and verified path structure."
category: content
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 分支连续性与试玩修订

## 何时调用与最低输入
输入全部节点正文与跳转表，输出逐路径走读记录和修订后的具体段落。
只围绕本项任务制作一个可以被上层专家直接引用的中间成品。用户没有给出的条件以待补标记；可先按写明的假设生成样稿，再提出不超过三个会改变结果的问题。给每次输入分配材料编号，同一编号在本轮中保持含义不变，不能把推测写成材料事实。

## 具体制作方法
逐条入口路径追踪地点、时间、物品、知识和关系。节点合流时取共同事实集合，发现只有某一路成立的事实就标出原句并改写。区分结构缺陷与文风问题，先修死路、无效跳转与不可能信息，再调整节奏。无实际玩家反馈时只记录纸面走读，不虚构试玩评价或完成率。

## 可复制的已填示例
已填发现：“再次展开你修好灯时拿到的地图”不适用于从平台路径进入的玩家。修订为“你把手里已经确定的信息说清楚”，不强依赖地图或灯。走读表为路径／进入事实／可见线索／冲突原句／替换正文／是否重算。E3合流正文可同时容纳灯光引导与居民协作。

## 修订与完成判据
更改上游事实后检查所有下游合流，不只改一处句子。完成时每条路径能从头读到结局，物品与知识不凭空产生，所有未实际试玩项有状态说明。
交付时同时给可直接使用的正文和一段使用说明，指出哪个条件变更会触发重做。引用本项成品时保留版本号和适用范围，不能只复制结论丢掉假设。遇到用户要求跳过必要输入，仍给可编辑草案，并把受影响位置显式标注，不扩展成未经授权的执行。完成意味着输入可以逐项映射到输出，示例能够手算或逐句核验，所有占位都已有用途说明；不把纸面设计写成已经获得现实反馈。

逐路径列地点、灯可用、地图获得、钟位置、已知线索。验证图结构后另读每段，代码可达不等于事实可用。未修灯N0→N2→结局应保持灯灭；两路合流中性写“本轮没形成清楚引导”，不可把看图与敲钟都写成已发生。

