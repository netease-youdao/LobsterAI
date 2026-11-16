---
name: lynxce-pantry-supply
version: 1.0.2
description: Compute daily usage, safety stock, target stock, reorder points, order
  quantities and monthly cost splits for an office pantry.
display_name: 补货点与订货量计算口径
author: 灵策智算 LynxceAI
category: tools
---
# 补货点与订货量计算口径
用于固定下单日的茶水间补货计算。输入为两周以上的清点或领用记录、开放工作日数、下单周期、到货天数、箱规、存储容量、保质期与到货剩余天数；百分数先转小数。
1. 日均 d = 期内领用合计 ÷ 开放工作日；领用 = 期初 + 入库 − 期末。若记录的领用大于期初加入库，说明有漏记，停止计算并列出差额。活动等一次性消耗单列，不进入日均。
2. 覆盖天数 C = 下单周期 R + 到货天数 L，均按工作日。安全库存 SS = ceil(d × C × 0.3)；冷藏短保品 SS = d × 1。
3. 目标库存 S = d × C + SS；补货点 ROP = d × L + SS；订货量 Q = S − 在库 − 在途，小于零记为零，再按箱规向上取整。
4. 上限校正：S 不超过存储容量；短保品按“到货时剩余保质天数内的工作日 × d”封顶，超出部分不订。剩余天数 = 包装到期日 − 收货日。
5. 月度：人均成本 = 当月支出 ÷ 平均在岗人数；超支额拆为损耗、品类结构变化、价格变化三项，三项之和必须等于超支额；损耗率 = 报损金额 ÷ 当月支出。
每个结果写代入值和取整方式，填回包根目录 references/workbook.md；人员或季节变化时至少每季度重算一次，保留上一版参数与日期。
