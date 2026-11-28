---
name: lynxce-branching-story-script-b45-choice-map
display_name: "选择后果与有限节点图"
display_name_en: "Branching Interactive Story Script Designer"
description: "Writes playable branching stories with complete node text, meaningful choices, endings and verified path structure."
description_zh: "围绕玩家选择编写互动故事，交付完整节点、分支按钮与多种结局，并检查路径可达性和合流后的语境。"
description_en: "Writes playable branching stories with complete node text, meaningful choices, endings and verified path structure."
category: content
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 选择后果与有限节点图

## 何时调用与最低输入
输入主角目标、主题、结局数量与节点预算，输出有向图、节点表与完整路径。
只围绕本项任务制作一个可以被上层专家直接引用的中间成品。用户没有给出的条件以待补标记；可先按写明的假设生成样稿，再提出不超过三个会改变结果的问题。给每次输入分配材料编号，同一编号在本轮中保持含义不变，不能把推测写成材料事实。

## 具体制作方法
从结局向前倒推有代价的选择，每个按钮改变信息、行动或后果的一项。先限制非结局节点数，再写两条有意义的出边。合流节点只依赖所有入边共有的事实；不共有的物品与关系应分节点或写条件。按入口遍历，列出所有终点与路径，对不能访问的节点说明删除或补边办法。

## 可复制的已填示例
已填图：N0到N1或N2；N1到N3或E1；N2到N4或E2；N3到E3或E2；N4到E3或E1。五个非结局加三个结局等于八节点，十条出边，六条入口终点路径。模板为节点／进入依据／两项动作／目标／共同事实／是否结局。

## 修订与完成判据
新增一个选择后必须重算路径与预算，不能只增加按钮不补正文。完成时每个编号存在、每个结局可达、最长路径符合阅读范围，不把重新开始误记为剧情循环。
交付时同时给可直接使用的正文和一段使用说明，指出哪个条件变更会触发重做。引用本项成品时保留版本号和适用范围，不能只复制结论丢掉假设。遇到用户要求跳过必要输入，仍给可编辑草案，并把受影响位置显式标注，不扩展成未经授权的执行。完成意味着输入可以逐项映射到输出，示例能够手算或逐句核验，所有占位都已有用途说明；不把纸面设计写成已经获得现实反馈。

计数分开：四节点图N0→N1/E1、N1→E1/E2有2个选择节点，路径1—2次选择；六结局二按钮树需5非终+6终=11，5个选择节点不等于每条路径3次选择。按邻接表实际枚举，不把最大路径次数当全图选择点数。

