import {
  HomeShowcaseCategoryId,
  type HomeShowcaseExample,
  type HomeShowcaseFilterOption,
  ShowcaseAccent,
  type ShowcaseOptionGroup,
  ShowcasePreviewKind,
} from '../constants';

const DOC_STYLE_GROUP: ShowcaseOptionGroup = {
  id: 'doc-style',
  label: { zh: '输出版式', en: 'Format' },
  defaultChoiceId: 'docx-polished',
  choices: [
    {
      id: 'docx-polished',
      label: { zh: '精排 Word (.docx)', en: 'Polished Word (.docx)' },
      promptFragment: {
        zh: '交付排版美观、层级清晰、含彩色表头与高亮结论框的可编辑 `.docx` 文件，可直接发送给他人查看。',
        en: 'Deliver a clean, editable `.docx` with clear heading hierarchy, styled tables, and callout boxes.',
      },
    },
    {
      id: 'one-pager',
      label: { zh: '简洁一页纸简报', en: 'Concise 1-Pager' },
      promptFragment: {
        zh: '内容高度精炼，控制在 1 页纸阅读量内，关键结论、表格与行动项前置，适合领导快速扫读。',
        en: 'Keep it tightly scoped to a scannable one-page brief with conclusions and actions upfront.',
      },
    },
    {
      id: 'chat-ready',
      label: { zh: '适合群内直接转发', en: 'Chat-Ready Copy' },
      promptFragment: {
        zh: '除保存文档外，在回复中同时给出一份结构清爽、带 Emoji 分隔、适合直接复制到微信/飞书/钉钉群的精简版本。',
        en: 'Alongside the document, include a clean copy-paste summary ready for Slack, Teams, or group chat.',
      },
    },
  ],
};

export const DOC_FILTERS: HomeShowcaseFilterOption[] = [
  { id: 'all', label: { zh: '全部', en: 'All' } },
  { id: 'office', label: { zh: '高频办公', en: 'Workplace' } },
  { id: 'personal', label: { zh: '生活与求职', en: 'Life & Career' } },
  { id: 'content', label: { zh: '阅读与创作', en: 'Reading & Writing' } },
];

const RAW_MEETING_NOTES = `【口语化会议速记 - 4月22日下午 新版会员改版评审】
参会：老周（产品）、小陈（设计）、大刘（研发）、阿敏（运营）
老周：今天主要拍一下五一前会员页改版。现在首月体验卡转化太低了，才 2.8%，老板要求五一档提到 4% 以上。
小陈：我出了两版图，A 版比较稳重，B 版首屏直接把“首月 9.9 元 + 送 3 次权益”放大了，感觉转化会高很多。
大刘：等等，B 版那个动态倒计时和老客差异化定价，后端接口来不及啊，五一前只有 6 个工作日了，除非砍掉老客千人千面。
阿敏：老客其实发券就行，不用改价格逻辑！但新客首月 9.9 元必须 4 月 28 日前上线，不然五一投放素材全废了。
老周：行，那就定 B 版视觉 + 砍掉老客动态定价（改走阿敏现有的领券通道）。大刘你评估下工作量，明天中午 12 点前给排期。小陈明天下午 5 点前把切图和标注交出来。
大刘：对了，苹果内购那边新价格档位要提审，万一被拒怎么办？这个得老板确认备选方案，要不要先只上安卓和网页端？
老周：好点！我今晚去找老板确认 iOS 审核兜底方案，周四上午 10 点咱们再过一次联调。`;

const RAW_WEEKLY_NOTES = `这周干的事（零散流水账）：
- 周一修了个导出 CSV 中文乱码的 bug，客服反馈了 5 个客户，修完大家都正常导出了
- 周二跟设计对齐了首页案例改版方案，开了 2 小时会，吵了半天最后定 3x2 卡片
- 周三帮销售出了个大客户方案初稿，客户反馈不错约了下周二二访
- 周四写了 6 个自动化测试，把发版前人工点检时间从 2 小时缩到 25 分钟
- 问题：测试环境第三方搜索接口这周老是超时，影响深度调研验证，需要运维帮忙提配额
- 下周：把首页新画廊上线、跟进那个大客户二访、把搜索超时问题彻底解决`;

const SAMPLE_RENTAL_CONTRACT = `房屋租赁合同（常见脱敏示例条款节选）
甲方（房东/二房东）：某房屋托管有限公司   乙方（租客）：李某
第一条 租期：2026年5月1日至2027年4月30日，月租金 5,200 元，押一付三。
第三条 押金条款：合同期满乙方退房时，甲方有权根据房屋“自然损耗及清洁情况”单方核定扣费金额；若乙方未提前 60 日书面通知续租，则押金不予退还。
第五条 维修责任：租赁期间房屋内一切家电、管道、墙面及门窗损坏，无论是否因设备老化引起，均由乙方自行承担全部维修与更换费用。
第七条 违约条款：乙方逾期支付租金满 2 日，甲方有权单方断水断电、更换门锁并清退房屋内物品，且已收租金及押金不予退还，乙方还需额外支付 2 个月租金作为违约金。
第九条 提前退租：甲方因自身原因需收回房屋的，提前 7 天通知乙方即可，无需承担违约责任；乙方提前退租则没收全部押金并赔付剩余租期 50% 租金。`;

const SAMPLE_RESUME_JD = `【我的旧简历摘要（示例）】
王林 | 3 年互联网运营经验 | 本科市场营销
工作经历：
1. 某生活服务公司（2023.06 - 至今）用户运营
- 负责公众号和社群日常发文，维护了几个微信群
- 配合团队做过几次双十一和暑期促销活动，参与整理活动数据
- 收集用户反馈并转给产品经理跟进

【目标岗位 JD：增长运营经理】
职责：
1. 负责核心拉新、促活与会员复购转化，对 DAU 与付费转化率负责；
2. 搭建用户分层触达体系，通过 A/B 实验持续优化活动 ROI；
3. 具备数据归因分析能力，能跨部门推动产品与设计落地增长项目。`;

const SAMPLE_POLICY_EXCERPT = `# 2026 办公与数据安全合规白皮书（节选示例）
1. 本地优先原则：涉及财务明细、人事考勤、客户清单等敏感文档时，优先在受控本地工作区处理，避免明文上传至无审计记录的公共云端工具。
2. AI 辅助审批红线：AI 可用于起草、校对、汇总与风险初筛，但对外合同签署、资金付款与正式法律意见必须经过人工复核确认。
3. 权限最小化：自动化工具默认应运行在受限工作目录写权限下，高风险系统命令须显式审批并留存日志。
4. 季度自查清单：每季度核查一次第三方插件授权、已失效员工账号及公开分享链接的有效期与访问密码。`;

const SAMPLE_STIFF_EMAIL = `【原始直白草稿】
张总：
上次说的那个方案到现在你们那边还没给反馈，已经拖了快一周了，我们研发都在等你们定下来才能开工。如果这周五前还不确认，后面上线肯定延期，到时候责任不在我们这边。还有预算单里有两个数字写错了，麻烦赶紧改了发回来。
小李`;

export const DOC_EXAMPLES: HomeShowcaseExample[] = [
  {
    id: 'doc-meeting-minutes',
    categoryId: HomeShowcaseCategoryId.DocWriting,
    filterTag: 'office',
    accent: ShowcaseAccent.Violet,
    title: { zh: '杂乱会议记录 → 规范纪要与待办', en: 'Messy Notes → Actionable Minutes' },
    subtitle: { zh: '提炼结论 + 负责人/DDL 彩色表', en: 'Decisions + Owner/DDL table' },
    badge: { zh: '含 600 字速记示例', en: 'Sample transcript' },
    description: {
      zh: '把口语化语音转写或微信零散速记，一键整理为结论前置、分歧清晰、待办明确到人与截止时间的规范纪要。',
      en: 'Turns raw transcripts or scattered meeting notes into crisp minutes with decisions, risks, and owner deadlines.',
    },
    skillId: 'docx',
    acceptsUpload: true,
    uploadAccept: '.txt,.md,.docx,.pdf',
    uploadHint: { zh: '支持粘贴文字或上传录音转写 .txt / Word 文件', en: 'Paste notes or upload transcript .txt / .docx' },
    customSlot: {
      label: { zh: '直接粘贴你的会议记录、语音转写或零散要点', en: 'Paste your meeting transcript or rough notes' },
      placeholder: { zh: '把录音转写或随手记的几段话粘在这里即可，无需事先整理格式…', en: 'Paste rough notes or transcript snippets here—no formatting needed…' },
      demoValue: { zh: '把自带的《新版会员改版评审》口语化速记整理成规范会议纪要 Word', en: 'Turn the bundled raw product review transcript into structured Word minutes' },
      multiline: true,
    },
    optionGroups: [DOC_STYLE_GROUP],
    demoPrompt: {
      zh: '请读取附件中的《口语化会议速记（meeting-raw-notes-sample.txt）》，整理成一份排版精致、可直接发给全员确认的会议纪要 Word 文档：\n1. 顶部信息栏：会议主题、时间、参会人与一句话核心决议\n2. 按议题归纳已拍板结论与被否决/延后项（说明取舍原因）\n3. 用醒目表格列出所有待办事项（事项 / 负责人 / 截止时间 / 依赖说明）\n4. 单独用警示高亮框标出需要上级拍板的风险事项（如 iOS 审核兜底方案）。',
      en: 'Read the attached raw meeting transcript (meeting-raw-notes-sample.txt) and generate polished Word meeting minutes:\n1. Header metadata & 1-sentence executive decision\n2. Decisions made and scope cuts with rationale\n3. Action-item table (Task / Owner / Due Date / Notes)\n4. Highlighted escalation callout for leadership risks.',
    },
    customPromptTemplate: {
      zh: '请根据我提供的会议记录/附件，整理一份结构清晰、可直接发送确认的规范会议纪要文档：\n1. 提炼会议主题、参会人（如有）与核心拍板结论\n2. 用表格明确待办清单（事项、负责人、截止时间；原文未提及的标注“待补充”，绝不编造）\n3. 单独高亮需跨部门协调或上级决策的风险项\n\n原始记录：\n{{input}}',
      en: 'Turn my meeting notes/attachments into structured, ready-to-send meeting minutes:\n1. Key decisions and agreed scope\n2. Action-item table (Task, Owner, Deadline; mark missing owners/dates as TBD without inventing)\n3. Highlighted risks and escalations\n\nNotes:\n{{input}}',
    },
    sampleFiles: [
      {
        name: 'meeting-raw-notes-sample.txt',
        mimeType: 'text/plain',
        content: RAW_MEETING_NOTES,
        previewLines: [
          { zh: '老周：首月体验卡转化才 2.8%，五一档必须提到 4% 以上…', en: 'PM: Trial conversion is 2.8%; needs to hit 4%+ before holiday…' },
          { zh: '大刘：后端来不及，除非砍掉老客千人千面；苹果内购审核有风险…', en: 'Eng: Backend cannot fit custom pricing; iOS IAP review is a risk…' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DocumentTransform,
      docTypeBadge: { zh: 'DOCX 会议纪要', en: 'DOCX MINUTES' },
      docTitle: { zh: '新版会员页改版评审会议纪要', en: 'Membership Revamp Review Minutes' },
      sections: [
        {
          heading: { zh: '核心拍板结论', en: 'Agreed Decisions' },
          items: [
            { zh: '采用 B 版首屏方案，新客首月 9.9 元于 4/28 前上线', en: 'Ship Design B; launch $9.9 trial by Apr 28' },
            { zh: '砍掉老客动态定价，改由运营现有领券通道承接', en: 'Cut dynamic pricing; reuse coupon channel' },
          ],
          tone: 'success',
        },
        {
          heading: { zh: '待办清单（Owner + DDL）', en: 'Action Items' },
          items: [
            { zh: '大刘 · 明日 12:00 · 输出研发排期与联调节点', en: 'Eng · Tomorrow 12:00 · Delivery schedule' },
            { zh: '小陈 · 明日 17:00 · 交付 B 版切图与设计标注', en: 'Design · Tomorrow 17:00 · Final specs' },
          ],
        },
        {
          heading: { zh: '升级风险提示', en: 'Escalation Risk' },
          items: [
            { zh: '老周今晚找老板确认 iOS 提审被拒时的兜底上线方案', en: 'Confirm iOS IAP fallback with leadership tonight' },
          ],
          tone: 'warning',
        },
      ],
      rawInputExcerpt: {
        zh: '老周：今天拍一下五一前会员页改版，现在转化才 2.8%… 小陈：我出了两版图… 大刘：等等，动态倒计时后端来不及啊，苹果审核万一被拒怎么办…',
        en: 'PM: Need to finalize the membership revamp before the holiday, conversion is 2.8%... Eng: Too tight for dynamic pricing, what if App Store rejects IAP...',
      },
    },
  },
  {
    id: 'doc-contract-review',
    categoryId: HomeShowcaseCategoryId.DocWriting,
    filterTag: 'personal',
    accent: ShowcaseAccent.Rose,
    title: { zh: '租房 / 合作合同风险体检批注', en: 'Lease & Contract Risk Audit' },
    subtitle: { zh: '标红霸王条款 + 给出修改话术', en: 'Flag traps & suggest redlines' },
    badge: { zh: '含脱敏租房合同', en: 'Sample lease included' },
    description: {
      zh: '签租房、兼职、外包或商铺合同时，快速揪出押金陷阱、不平等违约与维修转嫁条款，附可直接发给对方的修改建议。',
      en: 'Spots unfair deposit forfeitures, one-sided penalties, and hidden repair obligations—with polite negotiation redlines.',
    },
    skillId: 'docx',
    acceptsUpload: true,
    uploadAccept: '.docx,.pdf,.txt,.md',
    uploadHint: { zh: '上传你的租房/劳务/合作合同 Word 或 PDF（本地审阅，保护隐私）', en: 'Upload your lease, freelance, or service contract (reviewed locally)' },
    customSlot: {
      label: { zh: '你的身份立场与最担心的点（可选）', en: 'Your role & biggest concern (optional)' },
      placeholder: { zh: '例如：我是承租方（租客），特别担心押金扣款、中途提前退租和家电维修责任', en: 'e.g. I am the tenant—focus on deposit return, early termination, and appliance repairs' },
      demoValue: { zh: '以租客立场体检自带的《房屋租赁合同示例》，标红 4 处高危霸王条款并给出修改稿', en: 'Audit the bundled sample rental lease from a tenant’s perspective and propose redlines' },
    },
    optionGroups: [DOC_STYLE_GROUP],
    demoPrompt: {
      zh: '请读取附件中的《房屋租赁合同示例（rental-contract-sample.txt）》，以「承租方（租客）」立场输出一份风险体检与修订建议 Word 文档：\n1. 按风险等级（高危/中危）逐条列出陷阱条款、原文摘录与潜在损失\n2. 为每一条高危条款直接写好「平等合理的替代修订措辞」以及「和房东/中介沟通的得体话术」\n3. 补充签约前必查的 5 项现场验房与凭证留存清单（显式标注本报告为实用风险参考，重大金额请咨询专业律师）。',
      en: 'Audit the attached sample rental contract (rental-contract-sample.txt) from the tenant’s perspective and deliver a polished Word review:\n1. Rank high/medium risk clauses with quoted text and downside impact\n2. Provide balanced redline replacements and polite negotiation wording\n3. Include a pre-signing move-in checklist (with a clear non-legal-advice disclaimer).',
    },
    customPromptTemplate: {
      zh: '请审阅我上传的合同/协议文档，输出一份清晰的风险体检与修改建议文档：\n1. 明确站在我的立场识别不对等条款、隐形违约责任、模糊付款/退出条件\n2. 按高/中/低风险分级汇总表格，并为每处问题提供可直接替换的修改措辞与沟通建议\n3. 我的立场与关注点：{{input}}（注：请明确标注为风险辅助参考，不替代执业律师法律意见）',
      en: 'Review my attached contract and deliver a structured risk audit & redline document:\n1. Flag one-sided clauses, hidden penalties, and vague payment/exit terms from my perspective\n2. Summarize risks in a severity table with concrete replacement wording\n3. My role & focus: {{input}} (include a clear informational disclaimer).',
    },
    sampleFiles: [
      {
        name: 'rental-contract-sample.txt',
        mimeType: 'text/plain',
        content: SAMPLE_RENTAL_CONTRACT,
        previewLines: [
          { zh: '第三条：未提前 60 日通知续租则押金不予退还…', en: 'Clause 3: Deposit forfeited unless renewal notice sent 60d ahead…' },
          { zh: '第五条：设备自然老化维修均由乙方承担…', en: 'Clause 5: Tenant pays for all appliance wear-and-tear repairs…' },
          { zh: '第七条：逾期 2 日甲方有权单方断水断电换锁…', en: 'Clause 7: Landlord may cut utilities & change locks after 2 days…' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DocumentTransform,
      docTypeBadge: { zh: 'DOCX 合同体检', en: 'CONTRACT AUDIT' },
      docTitle: { zh: '房屋租赁合同风险体检与修订建议', en: 'Lease Risk Audit & Redline Sheet' },
      sections: [
        {
          heading: { zh: '发现 4 处高危条款（建议签约前必改）', en: '4 High-Risk Clauses Flagged' },
          items: [
            { zh: '高危 · 押金单方核定扣费 + 提前 60 天通知霸王条件', en: 'High · Unilateral deposit deductions & 60-day trap' },
            { zh: '高危 · 逾期 2 日断水断电换锁（涉嫌侵权）', en: 'High · Lockout & utility shutoff after 2-day delay' },
          ],
          tone: 'warning',
        },
        {
          heading: { zh: '推荐修改措辞与沟通话术', en: 'Suggested Redlines' },
          items: [
            { zh: '明确自然老化维修由甲方承担，退房后 7 日内原路退押金', en: 'Assign normal wear to landlord; refund deposit in 7d' },
            { zh: '双方提前解约违约金对等设置为 1 个月租金', en: 'Make early-exit penalty symmetric (1 month rent)' },
          ],
          tone: 'success',
        },
      ],
      rawInputExcerpt: {
        zh: '第三条：甲方有权根据房屋“自然损耗”单方核定扣费… 第五条：无论是否老化损坏均由乙方维修… 第七条：逾期 2 日有权断水断电换锁清退…',
        en: 'Clause 3: Landlord unilaterally determines deductions... Clause 5: Tenant pays all repairs regardless of age... Clause 7: Lockout after 2-day delay...',
      },
    },
  },
  {
    id: 'doc-weekly-report',
    categoryId: HomeShowcaseCategoryId.DocWriting,
    filterTag: 'office',
    accent: ShowcaseAccent.Emerald,
    title: { zh: '碎片流水账 → 亮点周报 / 述职', en: 'Work Bullets → Impact Weekly' },
    subtitle: { zh: '把“干了啥”升级成“拿了啥结果”', en: 'Reframe tasks into outcomes' },
    badge: { zh: '打工人每周必用', en: 'Weekly staple' },
    description: {
      zh: '每周五把零散的备忘录和聊天记录丢进去，自动按业务价值归类，突出结果与量化亮点，让主管一眼看到产出。',
      en: 'Transforms rough Friday bullet points into an outcome-oriented report managers can scan in 30 seconds.',
    },
    skillId: 'docx',
    acceptsUpload: true,
    uploadAccept: '.txt,.md,.docx',
    uploadHint: { zh: '粘贴本周琐碎记录或拖入日常工作备忘文件', en: 'Paste your rough weekly log or drop a notes file' },
    customSlot: {
      label: { zh: '粘贴你本周零散的工作要点（不用讲究文采）', en: 'Paste your rough work items for the week' },
      placeholder: { zh: '例如：修了个登录 bug、跟客户开了 2 次会、写了下月排期、测试环境挂了一下午…', en: 'e.g. Fixed login bug, met with 2 clients, drafted next month roadmap, blocked by staging outage…' },
      demoValue: { zh: '把自带的 6 条碎片流水账改写成拿得出手的向上汇报周报 Word', en: 'Rewrite the bundled 6 casual bullets into an executive-ready weekly update' },
      multiline: true,
    },
    optionGroups: [DOC_STYLE_GROUP],
    demoPrompt: {
      zh: '请读取附件中的《本周零散流水账示例（weekly-raw-notes-sample.txt）》，帮我改写成一份专业、有结果导向的周报 Word 文档：\n1. 按「核心业务交付 / 效率与质量提升 / 风险与所需协调 / 下周优先级计划」重新组织，拒绝按周一到周五记流水账\n2. 严守原事实，把“写了 6 个测试”“帮销售出方案”提炼为清晰的结果与影响力表达（绝不编造不存在的数据）\n3. 把测试环境搜索超时问题写成“现状 + 影响 + 明确诉求（请运维协助提配额）”，方便主管直接批示。',
      en: 'Read the attached rough weekly notes (weekly-raw-notes-sample.txt) and rewrite into a sharp executive weekly report:\n1. Regroup by Business Delivery, Quality/Efficiency Impact, Blockers & Asks, and Next Week Priorities\n2. Keep 100% factual accuracy while elevating outcomes over busywork\n3. Frame the staging timeout blocker with clear impact and a concrete ask.',
    },
    customPromptTemplate: {
      zh: '请把我提供的本周零散工作要点整理成一份结果导向的专业周报文档：\n1. 按项目/价值维度归类，突出可量化结果，避免周一到周五流水账\n2. 严守我提供的事实，绝不凭空编造业绩数字\n3. 将卡点转化为清晰的「风险 + 影响 + 所需支持」\n\n我的原始记录：\n{{input}}',
      en: 'Turn my rough weekly notes into an outcome-focused weekly report:\n1. Group by impact and initiatives rather than day-by-day chores\n2. Strictly stick to my facts—do not invent numbers\n3. Frame blockers with impact and explicit asks\n\nMy notes:\n{{input}}',
    },
    sampleFiles: [
      {
        name: 'weekly-raw-notes-sample.txt',
        mimeType: 'text/plain',
        content: RAW_WEEKLY_NOTES,
        previewLines: [
          { zh: '周一修了个导出 CSV 乱码 bug，客服反馈了 5 个客户…', en: 'Mon: fixed CSV export encoding bug reported by 5 customers…' },
          { zh: '周四写了 6 个自动化测试，发版点检从 2 小时缩到 25 分钟…', en: 'Thu: added 6 automated tests, cutting release QA from 2h to 25m…' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DocumentTransform,
      docTypeBadge: { zh: 'DOCX 亮点周报', en: 'WEEKLY REPORT' },
      docTitle: { zh: '本周工作进展与下周重点计划', en: 'Weekly Impact & Priorities' },
      sections: [
        {
          heading: { zh: '本周核心成果（结果前置）', en: 'Key Outcomes' },
          items: [
            { zh: '发布效率提升 79%：新增 6 项自动化校验，点检耗时 2h → 25m', en: 'QA speed +79%: 6 automated checks cut release QA 2h → 25m' },
            { zh: '客户推进与止损：修复 5 客户 CSV 乱码，大客户初稿获认可并约二访', en: 'Resolved 5-customer export bug; secured enterprise 2nd meeting' },
          ],
          tone: 'success',
        },
        {
          heading: { zh: '卡点与协调诉求', en: 'Blocker & Ask' },
          items: [
            { zh: '测试环境搜索接口频发超时 → 申请运维本周协助提升测试配额', en: 'Staging search timeouts → requesting Ops quota bump' },
          ],
          tone: 'warning',
        },
      ],
      rawInputExcerpt: {
        zh: '周一修了个导出乱码 bug… 周二开了 2 小时会吵了半天… 周四写了 6 个测试缩到 25 分钟… 测试环境老超时…',
        en: 'Mon fixed CSV bug... Tue argued in a 2h meeting... Thu wrote 6 tests saving time... staging keeps timing out...',
      },
    },
  },
  {
    id: 'doc-resume-polish',
    categoryId: HomeShowcaseCategoryId.DocWriting,
    filterTag: 'personal',
    accent: ShowcaseAccent.Blue,
    title: { zh: '求职简历诊断与岗位定制改写', en: 'Resume Diagnosis & JD Tailoring' },
    subtitle: { zh: 'STAR 法则升级 + 关键词对齐', en: 'STAR rewrite & JD keyword fit' },
    badge: { zh: '含示例简历 + JD', en: 'Sample resume + JD' },
    description: {
      zh: '告别“负责日常维护”的平淡简历！对照目标岗位 JD 做差距诊断，按 STAR 法则重写精排一页纸 Word 简历。',
      en: 'Audits your resume against a target job description, upgrades vague duties into STAR impact bullets, and formats a crisp 1-page Word file.',
    },
    skillId: 'docx',
    acceptsUpload: true,
    uploadAccept: '.docx,.pdf,.txt,.md',
    uploadHint: { zh: '上传你的现有简历 Word/PDF，并在下方粘贴目标岗位 JD', en: 'Upload your current resume and paste the target job description below' },
    customSlot: {
      label: { zh: '粘贴目标岗位 JD（以及想突出的经历要点）', en: 'Paste target Job Description (and key achievements)' },
      placeholder: { zh: '粘贴你想投递的岗位要求，我会逐项对齐关键词并指出缺哪些量化数据…', en: 'Paste the target JD here—I will align keywords and flag places to add metrics…' },
      demoValue: { zh: '对照自带《增长运营经理 JD》，深度诊断并重写示例简历为高匹配度精排 Word', en: 'Diagnose and tailor the bundled sample resume to the target Growth Manager JD' },
      multiline: true,
    },
    optionGroups: [DOC_STYLE_GROUP],
    demoPrompt: {
      zh: '请读取附件中的《示例旧简历与目标 JD（resume-and-jd-sample.txt）》，完成简历诊断与定制改写：\n1. 先输出「岗位匹配度诊断表」：逐条拆解 JD 要求，指出原简历缺失或表达过弱的地方\n2. 严格不虚构经历与虚假数字：用 STAR 法则重构工作描述，需要补充真实数据的地方用 `[请填入你的实际数据，如：提升 XX%]` 明确占位提示\n3. 交付一份排版克制高级的一页纸可编辑 Word 简历 + 修改对比说明。',
      en: 'Review the attached sample resume & target JD (resume-and-jd-sample.txt):\n1. Output a JD alignment gap table showing weak or missing signals\n2. Rewrite bullets using STAR framing without inventing fake metrics (use clear `[add your metric]` prompts where needed)\n3. Deliver a clean, single-page editable Word resume plus before/after notes.',
    },
    customPromptTemplate: {
      zh: '请结合我上传的简历和以下目标岗位 JD，完成深度诊断与定制改写：\n1. 对照 JD 提炼核心关键词与匹配差距\n2. 按 STAR 法则升级表达，严禁编造经历或虚假数据（缺数据处用醒目占位符提示我补填）\n3. 交付精排一页纸可编辑 Word 简历\n\n目标岗位信息：\n{{input}}',
      en: 'Audit and tailor my uploaded resume against this target role:\n1. Map JD keywords and highlight gaps\n2. Upgrade bullets with STAR framing without fabricating numbers (mark metric placeholders clearly)\n3. Output a clean 1-page editable Word resume\n\nTarget role:\n{{input}}',
    },
    sampleFiles: [
      {
        name: 'resume-and-jd-sample.txt',
        mimeType: 'text/plain',
        content: SAMPLE_RESUME_JD,
        previewLines: [
          { zh: '原简历：负责公众号和社群日常发文，维护了几个微信群…', en: 'Before: Handled daily social posts and maintained user groups…' },
          { zh: '目标 JD：增长运营经理（拉新促活、用户分层、A/B 实验 ROI）', en: 'Target JD: Growth Ops Manager (acquisition, lifecycle, A/B ROI)' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DocumentTransform,
      docTypeBadge: { zh: 'DOCX 精排简历', en: 'TAILORED RESUME' },
      docTitle: { zh: '增长运营简历 STAR 重构与诊断', en: 'STAR Resume Upgrade & Gap Map' },
      sections: [
        {
          heading: { zh: '改写前后对比示范', en: 'Before → After Upgrade' },
          items: [
            { zh: '改写前：维护了几个微信群，配合做过几次促销活动', en: 'Before: Maintained user groups and helped with promos' },
            { zh: '改写后：搭建私域分层促活路径，主导大促节点转化（附指标补填位）', en: 'After: Built segmented lifecycle campaigns for promo peaks [add %]' },
          ],
          tone: 'success',
        },
        {
          heading: { zh: '待补充高价值数据提示', en: 'Metrics to Fill In' },
          items: [
            { zh: '建议补充：社群规模、活动 ROI 与复购提升比例（严禁虚构）', en: 'Add real group size, campaign ROI, and repeat lift' },
          ],
          tone: 'warning',
        },
      ],
      rawInputExcerpt: {
        zh: '负责公众号和社群日常发文，维护了几个微信群；配合团队做过几次双十一活动，参与整理活动数据…',
        en: 'Posted to social channels, ran a few community groups, assisted with seasonal promos and basic data entry...',
      },
    },
  },
  {
    id: 'doc-proposal',
    categoryId: HomeShowcaseCategoryId.DocWriting,
    filterTag: 'office',
    accent: ShowcaseAccent.Indigo,
    title: { zh: '活动策划 / 项目立项完整方案', en: 'Project & Event Proposal' },
    subtitle: { zh: '目标 + 甘特表 + 预算 + 风险预案', en: 'Goals, timeline, budget & risks' },
    badge: { zh: '立项评审直出', en: 'Proposal ready' },
    description: {
      zh: '给几句核心想法，直接生成包含背景、目标、执行路径、甘特里程碑表、预算估算与风险预案的正式立项方案。',
      en: 'Turns a brief concept into a full proposal with objectives, milestone schedule table, budget breakdown, and contingencies.',
    },
    skillId: 'docx',
    acceptsUpload: true,
    uploadAccept: '.txt,.md,.docx,.pdf,.xlsx',
    uploadHint: { zh: '可选上传历史方案或预算参考表', en: 'Optional: attach past proposals or budget notes' },
    customSlot: {
      label: { zh: '一句话讲清你想立项的项目或活动（含大概预算与时间）', en: 'Describe your project or event (with rough budget & date)' },
      placeholder: { zh: '例如：6 月中旬办一场 150 人线下客户开放日，预算 8 万元，目标是签单转化与老客口碑传播', en: 'e.g. 150-person customer open house in mid-June, $15k budget, focused on demos and referrals' },
      demoValue: { zh: '公司 5 周年「120 人城市创意快闪与客户答谢日」完整策划与预算方案（预算 6 万元）', en: '120-Person Brand Pop-Up & Customer Appreciation Day Proposal ($10k budget)' },
      multiline: true,
    },
    optionGroups: [DOC_STYLE_GROUP],
    demoPrompt: {
      zh: '请为「公司 5 周年 · 120 人城市创意快闪与客户答谢日（预算 6 万元，筹备周期 4 周）」撰写一份可直接提报评审的完整策划方案 Word 文档：\n1. 活动定位、核心主题与可量化目标（到场率、互动打卡、线索/传播目标）\n2. 现场动线与 3 个高传播互动体验环节设计\n3. 4 周筹备里程碑与分工甘特表\n4. 6 万元详细预算拆分表（场地/搭建/茶歇/伴手礼/传播/应急预留 10%）与 4 项现场应急预案。',
      en: 'Write a review-ready Word proposal for a "120-Person Brand Pop-Up & Customer Appreciation Day ($10k budget, 4-week prep)":\n1. Concept, positioning, and measurable KPIs\n2. Venue flow and 3 shareable interactive stations\n3. 4-week prep timeline & ownership table\n4. Line-item $10k budget (with 10% contingency) and risk playbook.',
    },
    customPromptTemplate: {
      zh: '请围绕以下需求撰写一份逻辑严密、可直接提交评审的完整方案 Word 文档：\n1. 背景痛点与清晰可量化的项目目标\n2. 核心方案设计与分阶段执行路径\n3. 里程碑排期与分工表、预算/资源估算表\n4. 主要风险点与应急预案\n\n项目想法：\n{{input}}',
      en: 'Draft a comprehensive, management-ready Word proposal covering goals, solution design, milestone table, budget/resources, and risk mitigation for:\n\n{{input}}',
    },
    preview: {
      kind: ShowcasePreviewKind.DocumentTransform,
      docTypeBadge: { zh: 'DOCX 立项方案', en: 'PROPOSAL DOCX' },
      docTitle: { zh: '120 人品牌快闪与客户答谢策划案', en: 'Brand Pop-Up & Event Proposal' },
      sections: [
        {
          heading: { zh: '结构化核心模块', en: 'Included Sections' },
          items: [
            { zh: '量化目标 · 动线与 3 大互动打卡区 · 传播转化路径', en: 'KPIs · Venue flow · 3 interactive zones' },
            { zh: '4 周筹备甘特表（按周明确市场/设计/行政交付物）', en: '4-week milestone & owner schedule table' },
          ],
          tone: 'success',
        },
        {
          heading: { zh: '6 万元预算明细与 10% 应急池', en: 'Budget & Risk Plan' },
          items: [
            { zh: '场地搭建 45% · 茶歇伴手礼 28% · 拍摄物料 17% · 备用 10%', en: 'Venue 45% · Catering 28% · Media 17% · Buffer 10%' },
          ],
        },
      ],
      rawInputExcerpt: {
        zh: '老板说下个月办个 120 人的 5 周年答谢活动，预算 6 万，想有创意别太老套，下周一要看完整方案和预算表…',
        en: 'Need a fresh 120-person anniversary event next month on a $10k budget—leadership wants full plan and budget table by Monday...',
      },
    },
  },
  {
    id: 'doc-pdf-digest',
    categoryId: HomeShowcaseCategoryId.DocWriting,
    filterTag: 'content',
    accent: ShowcaseAccent.Teal,
    title: { zh: '长报告 / 政策文件 → 精读清单', en: 'Long Report → Executive Digest' },
    subtitle: { zh: '一页摘要 + 要点表 + 自查清单', en: '1-page brief & action checklist' },
    badge: { zh: '含白皮书节选', en: 'Sample PDF brief' },
    description: {
      zh: '几十页的行业白皮书、规章制度或专业资料没时间逐字读？自动提炼核心观点、红线条款与可勾选的落地自查清单。',
      en: 'Distills dense whitepapers, manuals, or policy docs into a 1-page executive summary, rules table, and team checklist.',
    },
    skillId: 'docx',
    acceptsUpload: true,
    uploadAccept: '.pdf,.docx,.txt,.md',
    uploadHint: { zh: '上传长 PDF、制度文件或论文，立刻提炼精读笔记', en: 'Upload long PDFs, policy docs, or papers to digest' },
    customSlot: {
      label: { zh: '你的阅读视角或想快速确认的问题（可选）', en: 'Your reading angle or specific questions (optional)' },
      placeholder: { zh: '例如：我是业务负责人，重点帮我提炼必须遵守的红线和本季度要做的检查项', en: 'e.g. As a team lead, pull out mandatory compliance rules and quarterly checklist items' },
      demoValue: { zh: '精读自带《2026 办公与数据安全合规白皮书节选》，生成团队一页纸规范与季度自查表', en: 'Distill the bundled Data Safety Whitepaper excerpt into a team policy & quarterly checklist' },
    },
    optionGroups: [DOC_STYLE_GROUP],
    demoPrompt: {
      zh: '请精读附件中的《2026 办公与数据安全合规白皮书（节选）（compliance-brief-sample.md）》，整理一份团队可直接落地的精读笔记与行动清单 Word 文档：\n1. 用 3 句话概括全篇核心原则\n2. 将文字规范转为「场景 / 允许做法 / 严禁红线 / 审批要求」四列对照表\n3. 生成一份带勾选框 `[ ]` 的季度自查行动清单，方便发给全员执行。',
      en: 'Digest the attached compliance whitepaper excerpt (compliance-brief-sample.md) into an actionable Word brief:\n1. 3-sentence executive summary\n2. 4-column rules matrix (Scenario / Allowed / Red Line / Approval)\n3. Printable quarterly self-audit checklist.',
    },
    customPromptTemplate: {
      zh: '请精读我上传的文档/资料，提炼为结构化精读笔记与落地行动清单：\n1. 核心观点一页摘要（保留关键数字与原文出处位置）\n2. 关键规则/对比信息整理为易读表格\n3. 输出可勾选的执行/学习检查清单；重点视角：{{input}}',
      en: 'Digest my attached document into an executive brief and actionable checklist:\n1. One-page synthesis preserving key facts and references\n2. Comparison/rules table for rapid scanning\n3. Actionable checklist tailored to: {{input}}',
    },
    sampleFiles: [
      {
        name: 'compliance-brief-sample.md',
        mimeType: 'text/markdown',
        content: SAMPLE_POLICY_EXCERPT,
        previewLines: [
          { zh: '本地优先原则：敏感财务/人事清单优先在受控本地处理…', en: 'Local-first rule: keep sensitive HR/finance files local…' },
          { zh: 'AI 审批红线 + 最小权限 + 季度分享链接自查…', en: 'Human sign-off red lines + least privilege + quarterly audit…' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DocumentTransform,
      docTypeBadge: { zh: 'DOCX 精读清单', en: 'POLICY DIGEST' },
      docTitle: { zh: '团队办公数据安全一页纸规范与自查表', en: 'Data Safety 1-Pager & Audit Checklist' },
      sections: [
        {
          heading: { zh: '红线与规范对照表', en: 'Rules Matrix' },
          items: [
            { zh: '财务/客户清单 → 仅限本地受控目录处理，禁明文外传', en: 'Finance/HR files → Local workspace only' },
            { zh: '合同签署/付款 → AI 可初筛，必须人工复核签字', en: 'Contracts & payouts → AI assist, human sign-off' },
          ],
          tone: 'warning',
        },
        {
          heading: { zh: '季度自查清单', en: 'Quarterly Checklist' },
          items: [
            { zh: '☐ 清理失效账号与过期外部插件授权', en: '☐ Revoke stale accounts & plugin tokens' },
            { zh: '☐ 检查历史公开分享链接密码与有效期', en: '☐ Audit public share link expiry & passwords' },
          ],
          tone: 'success',
        },
      ],
      rawInputExcerpt: {
        zh: '1. 本地优先原则：涉及财务明细、人事考勤等敏感文档时… 2. AI 辅助审批红线… 3. 权限最小化… 4. 季度自查…',
        en: '1. Local-first principle for finance and HR records... 2. Human sign-off red lines... 3. Least-privilege defaults...',
      },
    },
  },
  {
    id: 'doc-article-writer',
    categoryId: HomeShowcaseCategoryId.DocWriting,
    filterTag: 'content',
    accent: ShowcaseAccent.Amber,
    title: { zh: '公众号 / 小红书深度图文成稿', en: 'Long-Form Article & Social Post' },
    subtitle: { zh: '爆款标题备选 + 金句框 + 配图建议', en: 'Hook titles, pull-quotes & visuals' },
    badge: { zh: '自媒体创作', en: 'Creator flow' },
    description: {
      zh: '围绕你的真实观点或生活经验，拒绝空洞“AI 八股文”，产出有节奏、有案例、带备选标题和配图指令的完整成稿。',
      en: 'Crafts authentic, rhythmic articles without generic AI clichés—complete with headline variants, pull-quotes, and image prompts.',
    },
    skillId: 'docx',
    acceptsUpload: true,
    uploadAccept: '.txt,.md,.docx,.pdf',
    uploadHint: { zh: '可上传你的口述笔记、素材摘录或历史风格样文', en: 'Optional: attach raw voice notes or a sample of your writing voice' },
    customSlot: {
      label: { zh: '你想写的主题、核心观点与发布平台', en: 'Topic, core angle & target platform' },
      placeholder: { zh: '例如：公众号长文《普通人如何用周末 2 小时理清一年账单》，语气真诚接地气，不要爹味说教', en: 'e.g. Substack/Medium essay on a 2-hour weekend financial reset—warm, practical, zero lecturing' },
      demoValue: { zh: '公众号深度实用文：《为什么越忙越没有成果？普通职场人的 3 个减法习惯》（真诚克制口吻）', en: 'Practical essay: "Why Busy Weeks Leave Nothing Done: 3 Subtraction Habits That Actually Stick"' },
      multiline: true,
    },
    optionGroups: [DOC_STYLE_GROUP],
    demoPrompt: {
      zh: '请撰写一篇适合公众号发布的实用深度长文《为什么越忙越没有成果？普通职场人的 3 个减法习惯》（约 1800 字）：\n1. 先提供 5 个不同风格的备选标题（悬念型/痛点型/反常识型）\n2. 正文避免“总而言之/值得注意的是/不仅如此”等 AI 腔，用具体职场小场景切入，拆解 3 个当天就能试的微习惯\n3. 为每个小节配 1 句适合做金句卡片的短句，并在文末给 3 条配图建议与评论区互动引导语。',
      en: 'Write an authentic ~1,200-word article titled "Why Busy Weeks Leave Nothing Done: 3 Subtraction Habits That Actually Stick":\n1. Propose 5 headline options across curiosity, relatable-pain, and contrarian angles\n2. Avoid stiff AI clichés; open with a vivid everyday workday scene and walk through 3 concrete habits\n3. Include 3 pull-quote callouts, visual suggestions, and a reader discussion prompt.',
    },
    customPromptTemplate: {
      zh: '请围绕以下选题撰写一篇自然真诚、拒绝套话与“AI 腔”的深度图文成稿：\n1. 提供 5 个高点击备选标题\n2. 正文结构节奏分明，多用具体细节与可落地方法，附金句高亮与配图建议\n\n我的选题与要求：\n{{input}}',
      en: 'Write an authentic, engaging article free of generic AI filler:\n1. Include 5 headline variants\n2. Use crisp pacing, concrete examples, pull-quotes, and visual ideas\n\nTopic & voice:\n{{input}}',
    },
    preview: {
      kind: ShowcasePreviewKind.DocumentTransform,
      docTypeBadge: { zh: '深度图文成稿', en: 'EDITORIAL DRAFT' },
      docTitle: { zh: '为什么越忙越没成果？3 个职场减法习惯', en: '3 Subtraction Habits for Busy Weeks' },
      sections: [
        {
          heading: { zh: '5 组爆款标题备选 + 节奏骨架', en: '5 Headline Variants & Arc' },
          items: [
            { zh: '痛点切入 → 反常识拆解 → 3 个当天可试微习惯', en: 'Vivid scene → Counter-intuitive insight → 3 habits' },
            { zh: '去 AI 八股文约束：口语自然、短句呼吸感、有具体细节', en: 'Zero clichés · natural cadence · concrete details' },
          ],
          tone: 'success',
        },
        {
          heading: { zh: '配套发布物料', en: 'Publishing Kit' },
          items: [
            { zh: '3 句分享金句卡片文案 + 3 条配图生图指令 + 互动提问', en: '3 pull-quotes + visual cues + reader prompt' },
          ],
        },
      ],
      rawInputExcerpt: {
        zh: '想写一篇关于职场不要假装努力、要做减法的文章，面向普通打工人，不要说教，最好带几个好标题和配图想法…',
        en: 'Want a grounded essay on cutting busywork for normal office workers—no lecturing, plus title options and visual ideas...',
      },
    },
  },
  {
    id: 'doc-polish-email',
    categoryId: HomeShowcaseCategoryId.DocWriting,
    filterTag: 'office',
    accent: ShowcaseAccent.Slate,
    title: { zh: '高情商职场邮件与通知润色', en: 'High-EQ Email & Notice Polisher' },
    subtitle: { zh: '直白草稿 → 3 种得体语气对照', en: 'Blunt draft → 3 diplomatic tones' },
    badge: { zh: '含生硬催促示例', en: 'Before/After demo' },
    description: {
      zh: '催进度怕太冲、拒需求怕伤人、发公告怕漏要素？把直白草稿一键改写成「温和协作 / 专业坚定 / 简洁群发」三版。',
      en: 'Turns blunt drafts for chasing delays, declining requests, or team notices into 3 polished tone options.',
    },
    skillId: 'docx',
    acceptsUpload: true,
    uploadAccept: '.txt,.md,.docx',
    uploadHint: { zh: '直接粘贴你写好的草稿即可', en: 'Paste your rough email or announcement draft below' },
    customSlot: {
      label: { zh: '粘贴你的直白草稿（并说明发给谁：客户 / 老板 / 跨部门）', en: 'Paste your rough draft (and who it is for)' },
      placeholder: { zh: '直接按心里想的写就行，例如：对方拖了一周不给反馈，我想催一下但不想撕破脸…', en: 'Write what you really want to say—e.g. client delayed feedback a week, need to nudge firmly but politely…' },
      demoValue: { zh: '把自带的《生硬催反馈邮件草稿》润色成 3 种高情商版本，并指出易引发误解的措辞', en: 'Rewrite the bundled blunt client-follow-up draft into 3 diplomatic versions' },
      multiline: true,
    },
    optionGroups: [DOC_STYLE_GROUP],
    demoPrompt: {
      zh: '请读取附件中的《生硬催进度草稿（stiff-email-sample.txt）》，完成高情商商务润色：\n1. 点出原草稿中 3 处容易引发防御或对抗心理的表述（如“拖了快一周”“责任不在我们”）\n2. 输出 3 个可直接发送的版本：版本 A（温和协作，适合长期客户）、版本 B（专业坚定，明确底线与延期影响）、版本 C（微信/飞书短消息速发版）\n3. 检查是否遗漏关键要素（明确截止时间、预算错误页码/截图附件提醒）。',
      en: 'Polish the attached blunt follow-up draft (stiff-email-sample.txt):\n1. Identify 3 phrases likely to trigger defensiveness\n2. Deliver 3 ready-to-send versions: Warm Collaborative, Firm Professional (clear deadline/impact), and Short Chat Message\n3. Flag any missing details to attach before sending.',
    },
    customPromptTemplate: {
      zh: '请帮我润色以下邮件/通知草稿：\n1. 保留核心诉求和底线，消除生硬或容易引发误解的措辞\n2. 提供「温和协作版 / 专业坚定版 / 简洁速发版」3 种语气供我挑选\n3. 若缺少时间、对象或明确行动要求，提醒我补充\n\n我的原始草稿：\n{{input}}',
      en: 'Polish my email or notice draft while keeping my core message and boundaries intact:\n1. Remove harsh or ambiguous phrasing\n2. Provide 3 tones: Warm Collaborative, Firm Professional, and Concise Chat\n3. Remind me if dates, recipients, or next steps are missing\n\nDraft:\n{{input}}',
    },
    sampleFiles: [
      {
        name: 'stiff-email-sample.txt',
        mimeType: 'text/plain',
        content: SAMPLE_STIFF_EMAIL,
        previewLines: [
          { zh: '原草稿：“已经拖了快一周了…延期责任不在我们这边…预算写错了赶紧改”', en: 'Draft: "You delayed a week... not our fault if it slips... fix the wrong numbers ASAP"' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DocumentTransform,
      docTypeBadge: { zh: '高情商三版对照', en: '3-TONE POLISH' },
      docTitle: { zh: '项目进度催促与预算更正沟通稿', en: 'Client Timeline & Budget Follow-Up' },
      sections: [
        {
          heading: { zh: '专业坚定版（推荐）', en: 'Firm & Diplomatic (Recommended)' },
          items: [
            { zh: '“为保障原定上线节点，烦请于本周五 17:00 前确认方案，以便研发周一准时启动”', en: '"To protect our target launch date, could we confirm by Fri 5 PM so engineering kicks off Monday?"' },
            { zh: '“另附预算表第 2 项核对标注，方便您一并复核”', en: '"I also flagged 2 figures in the budget sheet for quick confirmation."' },
          ],
          tone: 'success',
        },
        {
          heading: { zh: '避雷修改点', en: 'Friction Removed' },
          items: [
            { zh: '删去“拖了快一周”“责任不在我们”等指责字眼，改用“共同保障节点”框架', en: 'Replaced blame phrasing with shared timeline framing' },
          ],
          tone: 'warning',
        },
      ],
      rawInputExcerpt: {
        zh: '张总：方案拖了快一周还没反馈，周五前不定下来上线延期责任不在我们，还有预算写错了赶紧改发回来…',
        en: 'Hi Zhang, you delayed feedback for a week. If not confirmed by Friday, delays are not on us. Also fix the budget mistakes ASAP...',
      },
    },
  },
];
