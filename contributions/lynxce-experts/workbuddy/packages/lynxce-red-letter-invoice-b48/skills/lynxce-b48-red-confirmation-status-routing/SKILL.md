---
name: lynxce-b48-red-confirmation-status-routing
display_name: "红冲状态分流"
display_name_en: "Red Letter Invoice Reconciliation Advisor"
description: "Reconcile invoice reversals, confirmation status and accounting handoffs with traceable draft and revision records."
description_zh: "为企业开票与财务人员核对退货折让、蓝红金额及双方确认状态，形成红冲准备说明、对账台账与完整修订稿。"
description_en: "Reconcile invoice reversals, confirmation status and accounting handoffs with traceable draft and revision records."
category: office
version: 1.0.0
author: "灵策智算 LynxceAI"
---

# 红冲状态分流
按用户实际票种与双方记录选择红字准备路线，重点分别登记用途确认、入账确认、申报抵扣和出口退税使用，不能合并成一个“已认证”字段。现行基线为税务总局公告2024年第11号第八条一般数电票规则：用途和入账两者均未确认，开票方发起并直接开红字；任一已确认，通常双方任一方发起、经对方确认后由开票方实际开具。受票方能发起不等于能代开；未申报抵扣也不表示未入账或未作其他用途确认。

假设A已入账且已抵扣，本次尚无有效确认单，拟双方确认路线；B未用途确认且未入账，拟开票方直接路线。B若新账簿称已入账，与旧摘要冲突，给两条件：旧状态有效且用途未确认则直接；新入账有效则双方确认。不根据更晚资料自动变状态，需实际记录支持。确认单发起后72小时未经确认自动作废是该确认单状态，不是蓝票消失，更不证明退款已办；未给起算记录不算具体届满时刻。

农产品收购、报废产品收购、光伏收购等特殊分支按公告核，不能强迫其套普通双方确认。蓝票已用于出口退税勾选确认，先核进货凭证信息回退并确认通过，再由开票方发起直接开红字，不能用普通对方同意代替回退。旧税控、客票、机动车等需另核相应规则，不以本通用数电例子覆盖所有票种。

可复制核实：“请确认【蓝票及时间】的用途、入账、已申报抵扣、出口退税使用、当前确认单和实际红字状态，各给来源；本次只是准备稿，未称已发起、已确认或已开具。”输出在稿内列拟分支与待核状态，而不是正文先写完成、末尾再免责声明。完成标准是每个分支有事实前提，未知不填未做；确认单生成、对方确认和红字实际号码分别留证，不代登录，不索密码验证码，也不伪造系统状态。
