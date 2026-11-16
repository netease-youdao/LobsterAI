---
name: lynxce-translation
display_name: "商务翻译与本地化"
display_name_en: "Business Translation"
description: "Use when the user needs Chinese-English translation of business content: emails, contracts, product copy, presentations, or wants Chinglish fixed and terminology unified."
description_zh: "做中英商务翻译并处理术语一致性、语气分寸与文化适配，避免直译式中式英语。"
description_en: "Translate business content between Chinese and English with consistent terminology, appropriate tone and cultural adaptation."
category: tools
version: 1.0.1
author: "灵策智算 LynxceAI"
---

# 双语对齐与忠实翻译

## 方法：对齐、译写、逆向校对
先以段落而非自然换行编号，句子有多个主体时拆成命题但不丢关联词。列出谁做什么、在什么条件下、期限是什么、例外是什么；正式条款保留限定，邮件在不改变信息的情况下调整客套，营销段落将改写送给本地化技能。确认译文读者与用途后记录策略，不用同一风格覆盖整份材料。对于表示可能与努力目标的原词，先标承诺力度再翻译，“力争”保留aim to，“拟”保留plan to，不用will直接代替；否定范围模糊先给两个解释，不猜用户意图。
翻译时保留编号、附件名、代码和占位符。原文省略主体且目标语言需要主体时，先在待确认表提出主体候选，不能凭常识补成供应商或买方。原文词序可改变，金额、条件和例外必须仍能逐项对回。句式顺畅不是省略义务的理由。译稿中事实无法核实的地方保持原文含义，译注说明来源局限；不添加法定解释，也不判断合同效力。
## 完整样例：交付通知
输入S01：“我们力争于2026年10月20日前交付120套样品。”S02：“总额人民币3.6万元，其中30%为预付款。”S03：“收到预付款后10日内开始生产。”目标为英语内部审阅稿，没有地区与工作日说明。输出S01：“We aim to deliver 120 sample sets by 20 October 2026.”S02：“The total amount is CNY 36,000, with a 30% advance payment.”S03：“Production will begin within 10 days after receipt of the advance payment.”
核对表记录120套→120 sample sets，3.6万元→36,000元，30%→30%，2026年10月20日→20 October 2026。预付款算式36,000×0.30=10,800，原文未给尾款安排不加入付款日期。S03中的10日保持days，缺失自然日/工作日口径；交付是发出还是签收也待确认。不能把“开始生产”改成交付完成，否则时间与责任全变。
## 英译中与冲突分支
输入“The team may release the update after approval.”候选“团队可在获批后发布更新”，不是“团队必须发布”，也不是“获批后会自动发布”。approval主体未给时在待确认项提出，不把某个部门名补进译文。两份原文分别写120套和150套时保持各段值，输出冲突表，阻塞最终一致版。用户批准120后标记确认记录，只重译受影响段落并查对应数量合计。
## 交付模板与交接
双语表含段落ID、完整源文、译文、策略、出处、状态；译注表含疑点、两种可能解释、影响、最少确认问题。交给术语账本技能核对数字、专名与承诺词；确认词表后再交本地化技能处理场景表达。状态区分已译待审、阻塞和用户已确认，不把内部草稿改名为认证译文。用户只有图片节选时说明可辨范围，不声称全文审核。
## 自检与不适用条件
逐段反查主体、否定、条件、期限和数量，确保每项都有目标语言对应；任何新增信息必须标作译注而非混进原文。比对占位符及条款编号是否一致。没有汇率不换币种，金额单位转换必须列乘数。不接受出具专业认证、法定效力结论或编造官方译名请求，提供可审校材料清单即可。样例为静态假设，不是模型实测或正式合同意见。
### 复核顺序
先核原文范围与段落ID，再核主体和条件，再核数字、术语与占位符，最后核渠道语气。争议词或期限留在正文状态中，不仅出现在附注。用户只批准某个词时批准范围限于该词，不能推成整篇已批准；需要全稿批准必须有单独记录。正式稿、内部稿与候选文案分别标状态，交接文件留出确认人和确认日期供用户填。

## 本领域材料模板
参照 `references/delivery-template.md` 的字段交付，不把空字段填成已核实。用户需确认的值标为待确认；未提供资料保留原始缺项。模板只用于本技能，不代替方法中的决策分支。


## 增补实例：语气调整不能放大保证
用户源文“我们会尽力协调，但不能保证周五之前完成。如延期，请先通知联系人。”目标为对外邮件，受众关系未明。忠实草稿“We will do our best to coordinate, but we cannot guarantee completion before Friday. If there is a delay, please notify the contact person first.”其中will do our best不能缩成will complete，否则目标变成必然结果；cannot guarantee不能删去；Friday缺具体日期，待确认项列出日期及时间区，而不是自行按当前日期换算。读起来更自然的版本可以把第一句改为“We will work to coordinate the process, but completion before Friday is not guaranteed.”，须确认主体和协调对象仍与原文相符。中文“请先通知”表示顺序要求，不能改成可选提醒。
英译中另一例“Payment is due within ten days of receipt of the invoice, unless otherwise agreed in writing.”草稿“除非另有书面约定，款项应在收到发票后十日内支付。”书面约定是例外条件，不能省略。收到的是发票而非货物，不能照搬上一份交付通知的起算事件。“十日”仍需日历口径，不能套用所谓行业标准。原文如果是“receipt”而未指明收到何物，则不补invoice，先请求上下文。
分批长文用段落边界拆分，保留上一批术语版本、未决事件和交叉引用。第二批提到“上述款项”时必须能查到用户提供的上文；没有上文应暂译并标引用未核。润色后另出改写差异，不把新表达覆盖源文留痕。核验可以逐项勾选，不仅给“译文正确”的总评；解释应指出具体遗漏、错误数量级或力度变化。交付时把含待确认问题的句子标为待审，最终版未完成不能仅通过删除备注伪装完成。

交付前另核附件称谓是否与用户实际材料一致，译文提到附件并不证明附件已经发送。收件人姓名没有正式英文拼写时保留用户提供形式并标待确认，不自行创造拼写或联系方式。正文与译注有清楚边界，用户能逐段追查修改。
