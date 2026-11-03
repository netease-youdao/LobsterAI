# 分支故事图与信息前置双重验证

从本轮故事正文建立clues定义和plans，每个节点须完整text/标题/scene或ending、providedClues/requiredClues及逐条正文引句绑定；每个按钮须实际text、target、选择后outcome、至少一条requiredClues和对应实际动作引句，动作后providedClues也要有outcome引句。初始线索须在入口正文有真实引句。

每条路径先检查节点进入所需，再合入节点提供，随后核按钮要求及动作后提供，不能由下游或别的路线倒借知识。非空要求、引句与已定义线索一致同时核；该元数据是作者静态检查，不是玩法状态变量。程序无法自动判断每句语义，因此须另逐路径全文读实质线索是否支持动作，不能空字段或无关引句冒充通过。

命令：python3 scripts/lynxce-branching-story-script-b45/round7/validate_story.py 本轮输入.json；加--format markdown从同次结果生成全部正文/按钮/选择后文字/节点表/路径/校验摘要。normal为8节点3结局；abnormal保留冲突4/6诊断，交完整条件A11节点6结局和条件B4节点2结局，未确认前均为候选。

入口未介绍节奏、未修灯路偷用灯、合流倒借地图、空前置、伪引句、错预算、环、根null等都应退出2。程序不实际试玩、不连接平台、不产生用户反馈。
