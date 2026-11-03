---
name: lynxce-branching-story-script-b45-node-prose
display_name: "节点正文与可见选择撰写"
display_name_en: "Branching Interactive Story Script Designer"
description: "Writes playable branching stories with complete node text, meaningful choices, endings and verified path structure."
description_zh: "围绕玩家选择编写互动故事，交付完整节点、分支按钮与多种结局，并检查路径可达性和合流后的语境。"
description_en: "Writes playable branching stories with complete node text, meaningful choices, endings and verified path structure."
category: content
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 节点正文与可见选择撰写

## 何时调用与最低输入
输入节点图、人物设定和本节点玩家应知道的信息，输出完整可读段落与按钮。
只围绕本项任务制作一个可以被上层专家直接引用的中间成品。用户没有给出的条件以待补标记；可先按写明的假设生成样稿，再提出不超过三个会改变结果的问题。给每次输入分配材料编号，同一编号在本轮中保持含义不变，不能把推测写成材料事实。

## 具体制作方法
每段至少给场景变化、可行动线索和选择压力。按钮使用具体动作，避免道德标签；重要线索在玩家作选择前出现。不同选择不能只是同一句话的语气差别。旁白只描述当前路径中已经成立的事实，合流段不引用玩家未经历的事件。结局回应选择代价，不简单奖赏顺从作者意图。

## 可复制的已填示例
已填N1：“银片松动，刻着定位点，匣底有装配图，汽笛再次响起。”按钮为“对照装配图”或“直接用力压下”，分别到N3与E1。玩家能看到可用信息和时间压力；不用“聪明地查看”暗示正确选项。模板为节点编号／完整正文／已提供线索／选择一／选择二／后果。

## 修订与完成判据
如果用户新增人物背景，先看是否改变选择信息，再改正文。完成时所有按钮都能从当前段找到动机，结局可以独立阅读，正文不是作者大纲。
交付时同时给可直接使用的正文和一段使用说明，指出哪个条件变更会触发重做。引用本项成品时保留版本号和适用范围，不能只复制结论丢掉假设。遇到用户要求跳过必要输入，仍给可编辑草案，并把受影响位置显式标注，不扩展成未经授权的执行。完成意味着输入可以逐项映射到输出，示例能够手算或逐句核验，所有占位都已有用途说明；不把纸面设计写成已经获得现实反馈。

若初态灯灭，未经过修灯节点的路径不得出现用该灯画圈或发灯语。钟在塔内窗边才可留塔敲钟。合流段只写共同事实，不在同一轮旁白同时叙述两条互斥路线的“那次”。

