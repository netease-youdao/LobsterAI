# 重复测量第六轮：原句绑定对象字段
原数值Fraction统计函数完整保留。python3 calculate.py 本轮输入.json --source-file 本轮真实原请求文件；加--format markdown取得同源完整成稿。真实WorkBuddy盲测传实际blind.md，程序仅截取“## 本轮用户请求”后、交付路径前的原请求段，避免把专家正文样例当本轮事实。不能把模型自建JSON或另编文字当原请求文件。sourceText、scope自由字段不作为来源，不渲染其事实断言。
objectContext仅objectType/measurementPosition/scenario/model。字段缺失或null输出未提供；声明对象须{value,sourceKind:original,quote}，quote必须逐字去空白后可指回原请求文件且value出现在quote中，否则对象值不采纳为原文。无source-file时仍完成原读数统计，对象声明保持未提供。sourceKind:assumption只进入显著独立设计建议区，不填充本轮对象事实。分组operator/gauge/method标签不是对象事实来源，不从制造行业推车间、零件、外径或型号。模板读取来源字段并生成scope，最终稿采用同次render，不自由添“原文给定”场景表。
# 重复测量描述统计第五轮
标准库入口：python3 calculate.py normal.json；加--format markdown生成同源连续完整表。
输入groups分条件组，各组id/operator/gauge/method/condition/conditionsComparable及readings。每行partId/trialId/value/unit/source；单位mm/cm/um/in，未知读数或单位null不变零。仅conditionsComparable=true且重复次数相同的有效样件才能合并平均极差；同样件同次多来源不同读数隔离整样件，不平均冲突。一个读数无重复极差，全部相同仅记录尺度极差零。references需value/unit/traceable=true/source才给偏差，不用样本均值当真值。tolerance给width或lower/upper与unit/source；宽非正或与上下限冲突暂停比例而保留逐件统计。
corrections用groupId/partId/trialId定位，必须confirmedReplacement=true及新value/unit/source；保留前后来源，不静默覆盖。plannedRepeatCount缺省3是设计假设待批准，复测表按轮次交错样件，只是拟顺序不是已随机实施。精确分数字段与六位显示分列，显示舍入用≈。未生成GRR、校准证书、阈值合格或设备操作。
