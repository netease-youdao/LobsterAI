# 混箱装箱单第七轮
标准库入口python3 calculate.py normal.json；加--format markdown直接生成完整连续表、逐订单行余额、重量汇总及复制稿。lines每行id/quantity/unitNetKg/source/model/specification/mixGroup；数量非负整数，重量公斤，null保持未知。rules给maxPieces/maxNetKg/tareKg/allowMix；allowMix=false逐行分箱，true时mixGroup是不可跨越硬组。其它箱规字段受控待核，不静默忽略；同色等已确认禁止混装应先展开mixGroup，不支持的配比先补结构。尺寸可给dimensions{length,width,height,unit:m/cm/mm}只算外体积，不证明三维装得下。
算法先件数/已知净重下界，再从该箱数起尝试均衡数量分配、剩余逐件放入已给约束允许的较轻箱；这是可行编排，只有达到各硬组下界才称已知约束下箱数最少，不宣称一般全局最优。单件超限独立列阻断，其它行继续；缺单重或包材只生成数量草案及可算项，不杜撰毛重。
fixedBoxes仅用户明确sealed、id/contents/source的实际记录，锁定构成先扣余额；实际毛重另actualGrossKg，实测减理论分列。新数量低于已封箱保留记录并暂停该分支，请用户决定拆箱，不静默拆。quantityScenarios每份给完整逐行quantities/label/source，分别重算差异不相加不自动替代。previousPlan给source/boxes以便旧新共享订单行关联索引，不假称实物逐箱移动；新箱数变化后包材重新乘箱数，理论与现场反馈分离。

完整最终成品直接使用同次--format markdown，不再自由追加容量/数量/重量/敏感性结论。净重余量与毛重约束分字段：maxNetKg只比商品净重；本接口无毛重上限，若用户给maxGrossKg等额外约束将受控待核。comparisonScenarios可选[{label,source,overrides:{tareKg:"0.5"}}]仅改包材，并列同量各箱净重/毛重差、完整重算表与复制稿；不代替基线。其它敏感性变化必须另建完整输入真实重算，不推测“任何变化都超限”。未知包材为null时毛重与差值也保持未知。所有表格前后空行，管道/换行安全转义。
