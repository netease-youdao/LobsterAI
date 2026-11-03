---
name: lynxce-donation-limit-rollforward-b50
display_name: "限额结转分配"
display_name_en: "Corporate Donation Deduction Advisor"
description: "Reconcile qualifying corporate donations, annual profit limits and carryforwards into complete evidence and revision drafts."
description_zh: "为企业财务核对公益捐赠渠道、资格期间和票据，按年度利润与历史余额测算扣除，形成台账及完整补正稿。"
description_en: "Reconcile qualifying corporate donations, annual profit limits and carryforwards into complete evidence and revision drafts."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 年度限额与先旧后新
依企业所得税法第九条及财税〔2018〕15号，把当年和以前年度合格公益捐赠放入同一12%限额。基数为依国家统一会计制度计算的正年度会计利润，不是收入、应税所得或加回捐赠前利润。每笔保留发生年、原额、历年扣除、当前余额和次年起三年连续期；先核旧额使用，不将原来已扣的金额再列余额，年限不因换表或今年亏损重启。

假设2025利润100万元已含A12和B2费用，旧2023未扣5、2024未扣4均资料条件成立，共同限额12。先用旧5加4合9，余3给A，本年A超9可按条件向2026至2028结转，B2无规定渠道及特别依据不扣不结转；旧2023原期2024至2026、旧2024原期2025至2027，本次用尽各余0，不能再结转9。资格资料只有摘要仍须原件核，这里金额是条件准备数。

若新利润摘要80与100冲突，A12/B2和旧5/4完全保留。80分支限9.6，旧先用9后A扣0.6、余11.4；不能取较高100或较晚80直接作有效。两分支旧额到期和本年A原年限都不变，不能把利润差20当新增捐赠。原始费用与历史扣除分开：100分支当年费用调增9加2为11、旧额调减9、净增2；80分支调增11.4加2为13.4、调减9、净增4.4。所得桥分别102及84.4，只含本专项，不是税款或完整申报。

可复制分配段：“【年】会计利润【来源及值】含捐赠【本年额】，共限【值】；旧【逐年原余额及本用】优先，本年【候选额、本扣、剩额及期限】，不合格【真实理由】不冒充可结转。原申报【已知或待核】。”完成交付为逐年台账、明确算式及实质说明，未知余额不填0，负利润不取绝对值，临期旧额不以新额覆盖，不对未核主体资格作肯定，不计算未给条件的省税。
旧年度扣除顺序与具体到期年度还应回到原始申报及发生记录，不把平台当前余额截图当三年全部历史。

