import {
  HomeShowcaseCategoryId,
  type HomeShowcaseExample,
  type HomeShowcaseFilterOption,
  ShowcaseAccent,
  type ShowcaseOptionGroup,
  ShowcasePreviewKind,
} from '../constants';

const RESEARCH_DELIVERABLE_GROUP: ShowcaseOptionGroup = {
  id: 'deliverable',
  label: { zh: '交付形式', en: 'Deliverable' },
  defaultChoiceId: 'report',
  choices: [
    {
      id: 'report',
      label: { zh: '交互研报', en: 'Interactive Report' },
      promptFragment: {
        zh: '交付形式（交互研报）：开篇给出核心结论与直接建议，正文用清晰章节、多维对比表与行内 [1][2] 信源角标呈现，客观列出优缺点与避坑点，文末附带真实查阅过的参考信源、链接与日期；内容较长时同步在工作区保存一份结构化 Markdown 或交互 HTML 研报，并在结尾给 2–3 个可继续深挖的下一步建议。',
        en: 'Deliverable (Structured Research Report): Lead with an executive summary and clear recommendations, use structured comparison tables and inline [1][2] citations, note trade-offs/pitfalls, and end with dated references and 2–3 follow-up next steps; save a clean Markdown or interactive HTML copy in the workspace when extensive.',
      },
    },
    {
      id: 'docx',
      label: { zh: 'Word 报告', en: 'Word Doc' },
      promptFragment: {
        zh: '交付形式（Word 报告）：将查证后的调研成果整理为排版规范、可直接分享的可编辑 Word (.docx) 深度研究报告（含核心结论摘要、多维对比表、行内 [1][2] 角标引用、风险与建议、带日期的参考信源清单），并在回复中总结核心结论与文件链接。',
        en: 'Deliverable (Word Report): Package the verified research into a polished, editable Word (.docx) report in the workspace (executive summary, comparison tables, inline [1][2] citations, recommendations, and dated references), and summarize key findings with the file link.',
      },
      extraSkillIds: ['docx'],
    },
    {
      id: 'pptx',
      label: { zh: '汇报 PPT', en: 'Slides Deck' },
      promptFragment: {
        zh: '交付形式（汇报 PPT）：基于查证后的信息在工作区生成可直接汇报的可编辑 PPT (.pptx)（每页清晰结论标题、对比图表/表格、页脚标注数据来源与日期、可落地建议），并在回复中概括核心发现与文件链接。',
        en: 'Deliverable (Slides Deck): Turn the verified findings into a presentation-ready editable .pptx deck in the workspace (clear action titles, comparison tables/visuals, cited sources with dates on slides, and actionable recommendations), and summarize takeaways with the file link.',
      },
      extraSkillIds: ['pptx'],
    },
  ],
};

const RESEARCH_SCOPE_GROUP: ShowcaseOptionGroup = {
  id: 'scope',
  label: { zh: '调研信源', en: 'Sources' },
  defaultChoiceId: 'web',
  choices: [
    {
      id: 'web',
      label: { zh: '全网多源查证', en: 'Multi-source Web' },
      promptFragment: {
        zh: '调研信源（全网多源查证）：将问题拆解为多个互补维度，交叉核验官方资料、权威媒体、第三方实测与真实用户口碑；遇到口径冲突、时效存疑或信息缺失时如实说明，严禁编造数据、链接或结论。',
        en: 'Sources (Multi-source Web): Cross-verify official specs, independent reviews, industry publications, and real user feedback across complementary angles; explicitly flag conflicting, outdated, or missing data and never fabricate numbers, quotes, or URLs.',
      },
    },
    {
      id: 'hybrid',
      label: { zh: '全网 + 我的本地文件', en: 'Web + My Local Files' },
      promptFragment: {
        zh: '调研信源（全网 + 本地资料混合）：优先读取我附加的文档或当前工作区相关资料，再结合全网最新多源信息交叉核验与补充，明确区分「本地已有信息」与「全网检索发现」；遇到口径冲突或信息缺失时如实说明，严禁编造数据或链接。',
        en: 'Sources (Web + My Local Files): Inspect attached files or relevant documents in my workspace first, then cross-reference against live multi-source web findings while clearly separating local facts from external discoveries; explicitly flag conflicts or gaps and never fabricate data or URLs.',
      },
    },
  ],
};

export const RESEARCH_FILTERS: HomeShowcaseFilterOption[] = [
  { id: 'all', label: { zh: '全部', en: 'All' } },
  { id: 'consumer', label: { zh: '消费与生活决策', en: 'Consumer & Life' } },
  { id: 'career', label: { zh: '职场与行业', en: 'Work & Industry' } },
  { id: 'study', label: { zh: '政策与学术', en: 'Policy & Study' } },
];

const LOCAL_PRODUCT_BRIEF_SAMPLE = `# 星云笔记（NebulaNote）2026 产品简介（内部示例资料）

## 产品定位
面向个人知识工作者与小团队的本地优先 AI 笔记工具，支持 Markdown、PDF 摘录与本地知识库问答。

## 当前核心能力
- 本地文件夹同步（无需强制上云），支持 Windows / macOS
- 内置文档摘要与双链关系图谱
- 个人专业版定价：￥128 / 年；团队版：￥360 / 人 / 年

## 当前面临的痛点与待验证问题
1. 移动端体验偏弱，很多用户反馈碎片采集不如 Flomo / Notion / Obsidian 顺手
2. AI 搜索与多文档综合分析成本偏高，不知竞品 2026 年主流定价与免费额度如何
3. 计划 Q3 推出「录音转纪要 + 知识库自动归档」，需调研主要竞品同类功能与用户高频吐槽点
`;

export const RESEARCH_EXAMPLES: HomeShowcaseExample[] = [
  {
    id: 'research-appliance-buy',
    categoryId: HomeShowcaseCategoryId.DeepResearch,
    filterTag: 'consumer',
    accent: ShowcaseAccent.Indigo,
    title: { zh: '高价家电 / 数码避坑横评', en: 'Smart Appliance Buying Guide' },
    subtitle: { zh: '参数 + 真实差评 + 耗材总账', en: 'Specs, complaints & 3-yr cost' },
    badge: { zh: '参考 28+ 信源', en: '28+ sources' },
    description: {
      zh: '买大件前多源核查实测口碑、高频差评与隐形耗材账单，按家庭场景给出直接选购结论。',
      en: 'Cross-checks lab tests, recurring buyer complaints, and hidden consumable costs to deliver a clear buying matrix.',
    },
    skillId: 'web-search',
    customSlot: {
      label: { zh: '我想调研选购的产品与预算', en: 'Product category & budget to compare' },
      placeholder: { zh: '例如：预算 3500 元左右，有猫有地毯，对比石头、追觅、科沃斯主流扫地机器人', en: 'e.g. Best cordless vacuum or robot mop under $600 for homes with pets' },
      demoValue: { zh: '2026 年 3000-5000 元主流旗舰扫地机器人（石头、追觅、科沃斯、云鲸）', en: '2026 flagship robot vacuums ($500-$900) for pet households' },
    },
    optionGroups: [RESEARCH_DELIVERABLE_GROUP, RESEARCH_SCOPE_GROUP],
    demoPrompt: {
      zh: '请深度调研「2026 年 3000–5000 元价位主流旗舰扫地机器人（石头、追觅、科沃斯、云鲸等）」的选购对比：\n1. 核心参数横向对比表（吸力、毛发防缠绕、基站自清洁、避障能力、机身高度、噪音）\n2. 真实用户与长期评测的高频差评/避坑点汇总（漏水、建图漂移、售后维修等）\n3. 3 年耗材与维护总成本测算（集尘袋、清洁液、拖布、滤网）\n4. 按不同家庭画像（养宠家庭、有门槛/地毯、小户型追求性价比、怕麻烦懒人）给出明确推荐型号与理由。',
      en: 'Run a deep comparison of flagship robot vacuums ($500–$900 in 2026, e.g., Roborock, Dreame, Ecovacs, Narwal):\n1. Side-by-side matrix (suction, anti-tangle, mop washing, obstacle avoidance, dock maintenance)\n2. Common long-term owner complaints and failure points\n3. 3-year total cost of ownership including consumables\n4. Clear top picks by household scenario (pets, carpets, tight budgets, low maintenance).',
    },
    customPromptTemplate: {
      zh: '请深度调研「{{input}}」的选购对比与避坑指南：\n1. 筛选当前最值得对比的 4–6 款主流型号，输出核心参数横向对比表\n2. 汇总真实用户与第三方长期实测中的高频槽点、翻车点与售后口碑\n3. 测算长期使用/耗材/维护的真实总成本\n4. 按不同使用场景与预算档位给出清晰推荐结论与购买时机建议。',
      en: 'Conduct a deep buying-decision comparison for "{{input}}":\n1. Shortlist 4–6 leading contenders in a structured specification matrix\n2. Synthesize recurring long-term complaints and reliability trade-offs from independent reviews\n3. Estimate multi-year total cost of ownership\n4. Provide decisive recommendations tailored to different user profiles.',
    },
    preview: {
      kind: ShowcasePreviewKind.ResearchReport,
      sourceCount: 28,
      kicker: { zh: '消费选购深度研报', en: 'BUYING DECISION BRIEF' },
      headline: { zh: '3000–5000 元旗舰扫地机横评与避坑结论', en: '2026 Flagship Robot Vacuum Comparison' },
      summary: {
        zh: '养宠与长发家庭优先看防缠绕与机械臂贴边；3 年耗材隐形成本差额最高可达 800+ 元。',
        en: 'Pet homes should prioritize anti-tangle rollers; 3-yr consumable costs vary by $150+ across docks.',
      },
      tableHeaders: [
        { zh: '机型梯队', en: 'Contender' },
        { zh: '避障/防缠', en: 'Anti-tangle' },
        { zh: '3年耗材', en: '3-Yr Cost' },
        { zh: '适合人群', en: 'Best For' },
      ],
      tableRows: [
        { cells: [{ zh: '综合均衡旗舰', en: 'All-Rounder' }, { zh: '9.4/10', en: '9.4/10' }, { zh: '中低', en: 'Low-Mid' }, { zh: '大户型/养宠', en: 'Pets & large' }], highlight: true },
        { cells: [{ zh: '边角清洁特化', en: 'Edge Specialist' }, { zh: '9.1/10', en: '9.1/10' }, { zh: '偏高', en: 'Higher' }, { zh: '重拖地需求', en: 'Heavy mopping' }] },
        { cells: [{ zh: '高性价比爆款', en: 'Value Pick' }, { zh: '8.5/10', en: '8.5/10' }, { zh: '低', en: 'Low' }, { zh: '预算 3K 档', en: 'Budget tier' }] },
      ],
      citations: [{ zh: '[1] 实测拆机', en: '[1] Lab tear-down' }, { zh: '[2] 长期口碑', en: '[2] Owner logs' }, { zh: '[3] 耗材价格', en: '[3] Parts pricing' }],
    },
  },
  {
    id: 'research-ev-compare',
    categoryId: HomeShowcaseCategoryId.DeepResearch,
    filterTag: 'consumer',
    accent: ShowcaseAccent.Blue,
    title: { zh: '新能源车选购与 5 年账单', en: 'EV & SUV 5-Year Comparison' },
    subtitle: { zh: '实测续航 + 智驾 + 保费保值', en: 'Real range, ADAS & 5-yr TCO' },
    badge: { zh: '含 5 年用车账', en: '5-yr TCO table' },
    description: {
      zh: '拆解官方标称与真实冬季续航差异、智驾体验口碑、保险与残值，帮家庭算清 5 年真实用车账。',
      en: 'Breaks down real-world winter range, driver-assist reliability, insurance, and resale value over 5 years.',
    },
    skillId: 'web-search',
    customSlot: {
      label: { zh: '我想对比的车型与用车场景', en: 'Car models & driving needs' },
      placeholder: { zh: '例如：预算 25 万，南方城市通勤+周末带娃，对比 Model Y、极氪 7X、小米 YU7、理想 L6', en: 'e.g. Compare Tesla Model Y vs Hyundai Ioniq 5 vs Rivian R2 for family commuting' },
      demoValue: { zh: '20–25 万热门家庭新能源 SUV（Model Y、极氪 7X、小鹏 G6、理想 L6）', en: 'Popular $35k–$48k family electric SUVs for daily commuting and road trips' },
    },
    optionGroups: [RESEARCH_DELIVERABLE_GROUP, RESEARCH_SCOPE_GROUP],
    demoPrompt: {
      zh: '请深度调研「20–25 万价位热门家庭新能源 SUV（特斯拉 Model Y、极氪 7X、小鹏 G6、理想 L6）」选购决策报告：\n1. 核心空间、补能效率、高速与冬季实测续航达成率对比表\n2. 辅助驾驶真实口碑与车机稳定性汇总\n3. 按每年行驶 1.5 万公里测算 5 年总持有成本（购车价、保费差异、电/油费、保养与预期残值）\n4. 按不同家庭场景（有家充桩 vs 无家充桩、纯电通勤 vs 长途自驾）给出明确试驾排序与避坑建议。',
      en: 'Research popular $35k–$48k family EV/hybrid SUVs:\n1. Space, charging speed, and real-world highway/winter range comparison\n2. Driver-assistance and infotainment reliability from long-term owners\n3. 5-year total cost of ownership (purchase, insurance, energy, depreciation)\n4. Test-drive shortlist tailored to home-charging vs road-trip households.',
    },
    customPromptTemplate: {
      zh: '请深度调研「{{input}}」的购车决策报告：\n1. 输出空间、续航实测达成率、补能效率与核心配置对比表\n2. 汇总真实车主关于智驾、舒适性、品控与售后的高频反馈\n3. 测算 5 年总持有成本（购置、保险、能耗、保养与保值率）\n4. 给出清晰的试驾重点清单与最终选购建议。',
      en: 'Create a deep car-buying report for "{{input}}":\n1. Structured comparison of space, real-world range, charging, and core features\n2. Owner reliability, ADAS, and service feedback\n3. 5-year total cost of ownership estimate\n4. Prioritized test-drive checklist and clear recommendation.',
    },
    preview: {
      kind: ShowcasePreviewKind.ResearchReport,
      sourceCount: 34,
      kicker: { zh: '大宗消费决策研报', en: 'AUTOMOTIVE TCO REPORT' },
      headline: { zh: '20–25 万家庭新能源 SUV 深度横评', en: 'Family EV SUV 5-Year Ownership Analysis' },
      summary: {
        zh: '无家充且高频跨省优先增程或 800V 超充；不同品牌首年保费差额可达 2,000–3,500 元。',
        en: '800V fast charging cuts road-trip stops by 35%; insurance deltas exceed $400/yr across trims.',
      },
      tableHeaders: [
        { zh: '维度', en: 'Metric' },
        { zh: '纯电标杆', en: 'EV Leader' },
        { zh: '空间增程', en: 'EREV Pick' },
        { zh: '智驾主打', en: 'ADAS Pick' },
      ],
      tableRows: [
        { cells: [{ zh: '冬季实测达成', en: 'Winter Range' }, { zh: '76%', en: '76%' }, { zh: '无焦虑', en: 'Hybrid' }, { zh: '74%', en: '74%' }] },
        { cells: [{ zh: '5年综合成本', en: '5-Yr TCO' }, { zh: '最优', en: 'Lowest' }, { zh: '中等', en: 'Medium' }, { zh: '较低', en: 'Low' }], highlight: true },
        { cells: [{ zh: '家庭舒适度', en: 'Comfort' }, { zh: '★★★★', en: '4/5' }, { zh: '★★★★★', en: '5/5' }, { zh: '★★★★', en: '4/5' }] },
      ],
      citations: [{ zh: '[1] 冬测数据', en: '[1] Winter tests' }, { zh: '[2] 保费调研', en: '[2] Insurance' }, { zh: '[3] 车主口碑', en: '[3] Owners' }],
    },
  },
  {
    id: 'research-company-interview',
    categoryId: HomeShowcaseCategoryId.DeepResearch,
    filterTag: 'career',
    accent: ShowcaseAccent.Violet,
    title: { zh: '目标公司与面试前深度尽调', en: 'Company & Interview Due Diligence' },
    subtitle: { zh: '业务现状 + 竞品 + 反问清单', en: 'Business, rivals & smart Qs' },
    badge: { zh: '职场求职必备', en: 'Career edge' },
    description: {
      zh: '面试或合作前快速摸清目标公司最新财报/融资、核心业务线、竞品态势、员工真实评价与高分反问。',
      en: 'Maps recent financials, core product bets, competitor threats, employee sentiment, and standout interview questions.',
    },
    skillId: 'web-search',
    acceptsUpload: true,
    uploadAccept: '.pdf,.docx,.txt,.md',
    uploadHint: { zh: '可选上传目标岗位 JD 或你的简历，自动结合生成针对性面试策略', en: 'Optional: upload the job description or your resume for tailored prep' },
    customSlot: {
      label: { zh: '目标公司名称与应聘岗位', en: 'Target company & role' },
      placeholder: { zh: '例如：字节跳动 / 某 AI 创业公司 — 产品经理（AI 应用方向）', en: 'e.g. Stripe / Notion — Senior Product Manager' },
      demoValue: { zh: '网易有道（Youdao）— AI 硬件与软件产品经理岗位面试前尽调', en: 'Notion — AI Product Manager pre-interview due diligence' },
    },
    optionGroups: [RESEARCH_DELIVERABLE_GROUP, RESEARCH_SCOPE_GROUP],
    demoPrompt: {
      zh: '请帮我做一份「网易有道（Youdao）— AI 硬件与教育软件产品经理」面试前深度尽调报告：\n1. 近 1 年核心业务进展、最新公开财报关键指标与战略重点\n2. 核心产品矩阵（词典笔、学习服务、AI 工具/Agent 等）及主要竞品对比\n3. 公开渠道的团队文化、业务挑战与近期行业变化\n4. 面试中大概率会被追问的 6 个业务难题，以及 4 个能体现业务洞察的高分反问面试官问题。',
      en: 'Prepare a pre-interview due diligence dossier for "Notion — AI Product Manager":\n1. Recent product launches, pricing shifts, and strategic priorities over the last 12 months\n2. Competitive landscape (Microsoft Loop, Confluence, Coda, AI workspaces)\n3. Publicly reported team culture, growth bottlenecks, and user pain points\n4. 6 likely product-sense questions and 4 sharp questions to ask the hiring manager.',
    },
    customPromptTemplate: {
      zh: '请为我做一份「{{input}}」的面试/合作前深度尽调报告：\n1. 梳理该公司近 1 年的核心业务进展、公开财务/融资动态与战略优先级\n2. 拆解其核心产品与 3 个主要竞品的优劣势对比表\n3. 汇总公开评价中的业务挑战、组织特点与风险提示\n4. 输出针对该岗位/合作的高频追问预演，以及 4 个能展现深度思考的反问清单。',
      en: 'Prepare a pre-interview / partnership due diligence report for "{{input}}":\n1. Recent business momentum, financials/funding, and strategic bets over the past year\n2. Product & competitive positioning matrix against top 3 rivals\n3. Key challenges, user feedback, and organizational signals\n4. Likely deep-dive questions plus 4 insightful questions to ask.',
    },
    preview: {
      kind: ShowcasePreviewKind.ResearchReport,
      sourceCount: 22,
      kicker: { zh: '面试前公司深度背调', en: 'INTERVIEW DOSSIER' },
      headline: { zh: '目标公司业务盘点、竞品格局与高分反问', en: 'Business Strategy, Rivals & Prep Brief' },
      summary: {
        zh: '梳理近 4 季度增长引擎、竞品核心差距及面试官最关心的 3 个业务增长抓手。',
        en: 'Synthesizes 4-quarter product strategy, competitor moats, and 4 high-signal manager questions.',
      },
      tableHeaders: [
        { zh: '板块', en: 'Dimension' },
        { zh: '核心发现', en: 'Key Signal' },
        { zh: '面试切入点', en: 'Angle' },
      ],
      tableRows: [
        { cells: [{ zh: '增长引擎', en: 'Growth' }, { zh: 'AI 订阅与硬件协同', en: 'AI attach rate' }, { zh: '留存与转化', en: 'Retention' }], highlight: true },
        { cells: [{ zh: '竞争压力', en: 'Rivals' }, { zh: '免费生态同质化', en: 'Bundled suites' }, { zh: '工作流壁垒', en: 'Workflow moat' }] },
        { cells: [{ zh: '高分反问', en: 'Ask Back' }, { zh: '未来 2 季度核心北极星', en: 'Next 2Q bets' }, { zh: '展现全局观', en: 'Strategic fit' }] },
      ],
      citations: [{ zh: '[1] 公开财报', en: '[1] Filings' }, { zh: '[2] 产品动态', en: '[2] Releases' }, { zh: '[3] 行业研报', en: '[3] Analysts' }],
    },
  },
  {
    id: 'research-travel-guide',
    categoryId: HomeShowcaseCategoryId.DeepResearch,
    filterTag: 'consumer',
    accent: ShowcaseAccent.Teal,
    title: { zh: '长假自由行深度避坑攻略', en: 'Deep Travel & Pitfall Planner' },
    subtitle: { zh: '交通精算 + 口碑验真 + 备选', en: 'Transit math, real reviews & Plan B' },
    badge: { zh: '大众高频刚需', en: 'Popular' },
    description: {
      zh: '交叉核查网红店真实评价、交通通票是否划算、预约门槛与雨天备选，不做拼凑式流水攻略。',
      en: 'Audits viral spots against real traveler feedback, verifies transit pass math, and plans rainy-day alternatives.',
    },
    skillId: 'web-search',
    customSlot: {
      label: { zh: '目的地、天数、出行人员与偏好', en: 'Destination, days, group & vibe' },
      placeholder: { zh: '例如：日本关西 7 天，两大一小亲子游，不想太赶，重点美食和交通省心', en: 'e.g. Kyoto & Osaka 7 days for 2 adults + 1 kid, relaxed pace, great food' },
      demoValue: { zh: '日本关西（大阪+京都+奈良）7 天自由行，2 位成年人，兼顾美食、人文与省心交通', en: 'Kyoto, Osaka & Nara 7-day itinerary for 2 adults focusing on food, culture, and smart transit' },
    },
    optionGroups: [RESEARCH_DELIVERABLE_GROUP, RESEARCH_SCOPE_GROUP],
    demoPrompt: {
      zh: '请为「日本关西（大阪 + 京都 + 奈良）7 天自由行（2 位成年人）」做一份深度避坑调研攻略：\n1. 住宿区域对比表（大阪难波/梅田 vs 京都四条河原町/京都站：交通便利度、晚间餐饮、预算区间）\n2. 交通卡/周游券精算（ICOCA、HARUKA、近铁等分别在什么行程下才划算，避免买亏）\n3. 每日顺路动线表（不走回头路），并核查热门餐厅/景点是否需要提前预约及真实避雷提醒\n4. 附人均预算明细与 2 套雨天室内替代方案。',
      en: 'Research a 7-day Kyoto + Osaka + Nara itinerary for 2 adults:\n1. Neighborhood stay comparison (Namba vs Umeda vs Kyoto Kawaramachi: transit, food, budget)\n2. Transit pass break-even math (ICOCA vs regional passes)\n3. Day-by-day low-backtrack routing with booking lead times and tourist-trap warnings\n4. Per-person budget breakdown plus rainy-day indoor alternatives.',
    },
    customPromptTemplate: {
      zh: '请为「{{input}}」做一份深度避坑自由行调研攻略：\n1. 住宿片区对比表（交通、周边体验、价位与避坑）\n2. 交通方案与通票/包车性价比精算\n3. 每日顺路动线安排，核查热门景点与餐厅的预约要求和近期真实差评避雷\n4. 附人均预算明细、行前必办清单与雨天备选方案。',
      en: 'Build a verified deep-research travel handbook for "{{input}}":\n1. Stay-area comparison table (access, vibe, price, caveats)\n2. Transit pass vs point-to-point cost comparison\n3. Efficient daily routing with reservation lead times and tourist-trap warnings\n4. Realistic budget breakdown, packing checklist, and rainy-day Plan B.',
    },
    preview: {
      kind: ShowcasePreviewKind.ResearchReport,
      sourceCount: 31,
      kicker: { zh: '出行避坑深度手册', en: 'VERIFIED TRAVEL BRIEF' },
      headline: { zh: '关西 7 日顺路动线、交通精算与预约提醒', en: '7-Day Kansai Routing, Transit Math & Traps' },
      summary: {
        zh: '多数游客买周游券反亏 20%；京都热门庭院与餐厅需提前 14–30 天预约，附 2 套雨天备选。',
        en: 'IC card beats regional passes on city-focused trips; key reservations open 14–30 days out.',
      },
      tableHeaders: [
        { zh: '日程', en: 'Days' },
        { zh: '区域主线', en: 'Focus' },
        { zh: '提前预约', en: 'Booking' },
        { zh: '雨天备选', en: 'Rain Plan' },
      ],
      tableRows: [
        { cells: [{ zh: 'D1–D3', en: 'D1–D3' }, { zh: '京都东山/岚山', en: 'Kyoto East' }, { zh: '提前 14 天', en: '14d ahead' }, { zh: '锦市场/美术馆', en: 'Museums' }], highlight: true },
        { cells: [{ zh: 'D4', en: 'D4' }, { zh: '奈良半日+宇治', en: 'Nara + Uji' }, { zh: '无需', en: 'Walk-in' }, { zh: '茶室体验', en: 'Tea house' }] },
        { cells: [{ zh: 'D5–D7', en: 'D5–D7' }, { zh: '大阪美食/环影', en: 'Osaka + USJ' }, { zh: '快通提前买', en: 'Express' }, { zh: '海游馆/商圈', en: 'Aquarium' }] },
      ],
      citations: [{ zh: '[1] 官网票价', en: '[1] Official fares' }, { zh: '[2] 近期游记', en: '[2] Recent trips' }],
    },
  },
  {
    id: 'research-hybrid-local',
    categoryId: HomeShowcaseCategoryId.DeepResearch,
    filterTag: 'career',
    accent: ShowcaseAccent.Emerald,
    title: { zh: '本地资料 + 全网交叉竞品分析', en: 'Local Files + Live Web Benchmark' },
    subtitle: { zh: '桌面端独占 · 内外信息对照', en: 'Desktop edge · Internal vs Web' },
    badge: { zh: '含示例内部文档', en: 'Includes sample doc' },
    description: {
      zh: '结合你本地的产品简介/方案 PDF 与全网最新竞品动态，输出直击差距的竞争力评估与改版建议。',
      en: 'Cross-references your local product brief against live market competitors to pinpoint pricing and feature gaps.',
    },
    skillId: 'web-search',
    acceptsUpload: true,
    uploadAccept: '.md,.txt,.pdf,.docx,.pptx',
    uploadHint: { zh: '拖入你的产品文档/方案/BP，或直接用自带的「星云笔记简介」示例体验混合调研', en: 'Upload your product doc or pitch deck, or test with the bundled sample brief' },
    customSlot: {
      label: { zh: '补充想重点对标的竞品或问题（可选）', en: 'Specific rivals or focus questions (optional)' },
      placeholder: { zh: '例如：重点对比定价策略、移动端采集体验和 AI 录音纪要功能的差异', en: 'e.g. Focus on pricing tiers, mobile capture, and AI voice-to-notes gaps' },
      demoValue: { zh: '基于附件《星云笔记产品简介》，联网对比 Notion、Obsidian、Flomo、印象笔记 2026 最新打法', en: 'Benchmark the attached sample brief against Notion, Obsidian, and Reflect in 2026' },
    },
    optionGroups: [
      RESEARCH_DELIVERABLE_GROUP,
      { ...RESEARCH_SCOPE_GROUP, defaultChoiceId: 'hybrid' },
    ],
    demoPrompt: {
      zh: '请先仔细阅读附件中的《星云笔记（NebulaNote）2026 产品简介》，再结合全网最新公开资料进行混合深度调研：\n1. 将附件中的定位、定价（￥128/年）与规划功能，与 Notion、Obsidian、Flomo、语雀/飞书文档等主流竞品做结构化对比表\n2. 针对附件提到的 3 个痛点（移动端采集、AI 搜索定价、录音转纪要），查证竞品最新方案与用户高频抱怨\n3. 明确区分「本地文档已有信息」与「全网检索发现」，给出 3 条最优先落地的差异化破局建议。',
      en: 'First read the attached sample product brief (nebula-note-brief.md), then run live web research:\n1. Compare its positioning, pricing, and planned voice-notes feature against Notion, Obsidian, and Reflect\n2. Investigate competitor pricing tiers and common user complaints on mobile capture and AI search\n3. Clearly separate internal document facts from web findings and recommend 3 high-leverage roadmap moves.',
    },
    customPromptTemplate: {
      zh: '请结合我提供的本地资料/工作区文档，围绕「{{input}}」开展「本地 + 全网混合深度调研」：\n1. 先提炼本地资料中的核心定位、现状数据与关键假设\n2. 联网检索 3–5 个核心竞品或行业标杆的最新动态、定价与用户评价，生成内外对照矩阵\n3. 明确区分本地事实与外部检索结论，给出可落地的差距分析与优先级建议。',
      en: 'Combine my local files/workspace documents with live web research on "{{input}}":\n1. Extract core positioning, metrics, and assumptions from my local materials\n2. Benchmark against 3–5 live competitors in a structured matrix\n3. Separate internal facts from external findings and recommend prioritized actions.',
    },
    sampleFiles: [
      {
        name: 'nebula-note-product-brief.md',
        mimeType: 'text/markdown',
        content: LOCAL_PRODUCT_BRIEF_SAMPLE,
        previewLines: [
          { zh: '产品定位：本地优先 AI 笔记工具（￥128/年）', en: 'Positioning: Local-first AI notes app ($18/yr)' },
          { zh: '待验证痛点：移动端采集弱、AI 成本高、拟做录音转纪要', en: 'Open questions: mobile capture, AI pricing, voice-to-notes' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.ResearchReport,
      sourceCount: 24,
      kicker: { zh: '本地 + 全网混合研报', en: 'HYBRID LOCAL + WEB BRIEF' },
      headline: { zh: '本地产品简介 vs 主流竞品差距与破局建议', en: 'Internal Brief vs Live Competitor Gaps' },
      summary: {
        zh: '已读取本地简介（￥128/年），对照 4 款竞品最新 AI 定价：差异化机会在于“离线本地+低成本语音速记”。',
        en: 'Cross-checked local brief against 4 live rivals: strongest wedge is offline privacy + zero-friction voice capture.',
      },
      tableHeaders: [
        { zh: '对比项', en: 'Factor' },
        { zh: '本地我方', en: 'Our Doc' },
        { zh: '竞品主流', en: 'Market' },
        { zh: '破局建议', en: 'Action' },
      ],
      tableRows: [
        { cells: [{ zh: '定价档位', en: 'Pricing' }, { zh: '￥128/年', en: '$18/yr' }, { zh: '￥300–700', en: '$96+/yr' }, { zh: '保持性价比', en: 'Keep edge' }], highlight: true },
        { cells: [{ zh: '移动端收集', en: 'Mobile' }, { zh: '偏弱', en: 'Weak' }, { zh: '微信/速记强', en: 'Fast capture' }, { zh: '补轻量化收集', en: 'Quick inbox' }] },
        { cells: [{ zh: '录音纪要', en: 'Voice AI' }, { zh: 'Q3 规划', en: 'Q3 plan' }, { zh: '多按分钟计费', en: 'Per-min fee' }, { zh: '结合本地归档', en: 'Auto-file' }] },
      ],
      citations: [{ zh: '[本地] 产品简介', en: '[Local] Brief' }, { zh: '[1] 竞品定价页', en: '[1] Pricing' }, { zh: '[2] 社区口碑', en: '[2] Reviews' }],
    },
  },
  {
    id: 'research-industry-landscape',
    categoryId: HomeShowcaseCategoryId.DeepResearch,
    filterTag: 'career',
    accent: ShowcaseAccent.Amber,
    title: { zh: '行业趋势与竞品全景分析', en: 'Industry & Market Landscape' },
    subtitle: { zh: '规模格局 + 打法拆解 + 机会', en: 'Market size, players & tailwinds' },
    badge: { zh: '汇报立项利器', en: 'Exec ready' },
    description: {
      zh: '系统梳理细分赛道的市场规模、头部玩家商业模式对比、产业链痛点与未来 1–2 年机会点。',
      en: 'Synthesizes market sizing, leading player business models, value-chain bottlenecks, and near-term opportunities.',
    },
    skillId: 'web-search',
    customSlot: {
      label: { zh: '我想调研的行业或细分赛道', en: 'Industry or market segment' },
      placeholder: { zh: '例如：AI 陪伴硬件 / 新茶饮出海东南亚 / 宠物智能用品市场', en: 'e.g. AI companion hardware / specialty coffee chains / pet tech market' },
      demoValue: { zh: '中国新茶饮品牌出海（东南亚与欧美市场）2025–2026 格局与打法分析', en: 'AI companion & wearable hardware market landscape in 2026' },
    },
    optionGroups: [RESEARCH_DELIVERABLE_GROUP, RESEARCH_SCOPE_GROUP],
    demoPrompt: {
      zh: '请深度调研「2025–2026 中国新茶饮品牌出海（蜜雪冰城、霸王茶姬、喜茶等）格局与打法」：\n1. 市场现状与核心区域（东南亚 vs 欧美）门店扩张特征\n2. 头部 4 家品牌的出海商业模式对比表（定位、客单价、供应链策略、本地化策略）\n3. 出海高频踩坑点（供应链合规、租金人力成本、口味本地化）\n4. 对新入局或相关配套服务商的 3 条可落地机会判断。',
      en: 'Research the 2026 AI wearable & companion hardware market landscape:\n1. Market momentum, shipments, and notable product categories\n2. Business model comparison matrix across 4–5 leading players\n3. Recurring retention, battery, and distribution pitfalls\n4. 3 actionable opportunities for new entrants.',
    },
    customPromptTemplate: {
      zh: '请深度调研「{{input}}」的行业全景分析报告：\n1. 行业现状、增长驱动力与公开市场规模口径梳理\n2. 头部 4–5 家核心玩家的商业模式、定价与核心壁垒对比表\n3. 当前行业的主要痛点与风险变量\n4. 面向未来 12–24 个月的可落地机会点与策略建议。',
      en: 'Produce an industry landscape report on "{{input}}":\n1. Current growth drivers and cited market sizing\n2. Comparison matrix of 4–5 leading players (positioning, monetization, moat)\n3. Structural headwinds and risks\n4. Actionable 12–24 month opportunities.',
    },
    preview: {
      kind: ShowcasePreviewKind.ResearchReport,
      sourceCount: 36,
      kicker: { zh: '行业全景研究报告', en: 'MARKET LANDSCAPE' },
      headline: { zh: '细分赛道格局、头部打法与增长机会矩阵', en: 'Competitive Landscape & Growth Vectors' },
      summary: {
        zh: '东南亚拼供应链规模与低价下沉，欧美拼品牌溢价与核心商圈直营；供应链本地化是分水岭。',
        en: 'Supply-chain localization and clear price-tier positioning separate profitable leaders from stalled entrants.',
      },
      tableHeaders: [
        { zh: '阵营', en: 'Tier' },
        { zh: '主打区域', en: 'Focus' },
        { zh: '核心壁垒', en: 'Moat' },
      ],
      tableRows: [
        { cells: [{ zh: '极致平价规模', en: 'Mass Scale' }, { zh: '东南亚下沉', en: 'SE Asia' }, { zh: '自建供应链', en: 'Supply chain' }], highlight: true },
        { cells: [{ zh: '东方茶饮溢价', en: 'Premium Brand' }, { zh: '核心商圈', en: 'Flagships' }, { zh: '标准化大单品', en: 'Hero SKUs' }] },
        { cells: [{ zh: '高端直营标杆', en: 'Lifestyle' }, { zh: '欧美澳', en: 'US / EU' }, { zh: '联名与体验', en: 'Brand equity' }] },
      ],
      citations: [{ zh: '[1] 招股书/年报', en: '[1] Filings' }, { zh: '[2] 行业白皮书', en: '[2] Reports' }],
    },
  },
  {
    id: 'research-policy-check',
    categoryId: HomeShowcaseCategoryId.DeepResearch,
    filterTag: 'study',
    accent: ShowcaseAccent.Rose,
    title: { zh: '购房 / 留学 / 医保政策核查', en: 'Policy & Regulation Fact-Check' },
    subtitle: { zh: '官方原文 + 条件表 + 办理流程', en: 'Official rules, eligibility & steps' },
    badge: { zh: '强官方信源标注', en: 'Official citations' },
    description: {
      zh: '核对官方最新发布的政策原文与生效日期，拆解适用条件、额度对比与常见误区，拒绝过时营销号信息。',
      en: 'Verifies current official rules and effective dates, breaking down eligibility criteria, timelines, and common pitfalls.',
    },
    skillId: 'web-search',
    customSlot: {
      label: { zh: '想核查的城市/国家与具体政策问题', en: 'City/country & policy question' },
      placeholder: { zh: '例如：北京/上海首套房公积金贷款额度、商转公条件及最新利率对比', en: 'e.g. UK vs Singapore Master’s student visa, work permit, and tuition policy 2026' },
      demoValue: { zh: '一线城市（北京/上海/深圳）最新首套房公积金贷款政策、最高额度与组合贷对比', en: 'Comparing 2026 graduate study visa, tuition, and post-study work rules across UK, Canada, and Singapore' },
    },
    optionGroups: [RESEARCH_DELIVERABLE_GROUP, RESEARCH_SCOPE_GROUP],
    demoPrompt: {
      zh: '请核查并整理「北京、上海、深圳最新首套房公积金贷款政策与组合贷办理要点」：\n1. 仅优先采信各地住建委、公积金管理中心等官方渠道，每条关键数字标注发布时间与来源链接\n2. 输出三地对比表（缴存年限要求、单人/家庭最高额度、多子女/绿色建筑上浮政策、首付比例与利率口径）\n3. 列出申请流程时间线与 5 个高频踩坑提醒（断缴影响、账户余额倍数限制等）\n4. 任何近期可能调整或因区而异的条款请显式提醒以官方最新窗口核实为准。',
      en: 'Fact-check 2026 graduate study visa and post-study work policies across the UK, Canada, and Singapore:\n1. Cite official government immigration portals with effective dates\n2. Build a side-by-side comparison table (visa fees, work hours, post-study permit length, financial proof)\n3. Outline key application timelines and common rejection pitfalls.',
    },
    customPromptTemplate: {
      zh: '请深度核查「{{input}}」的最新官方政策：\n1. 优先采信政府官网/权威机构原文，对关键条件、额度与时间节点标注生效日期与来源\n2. 输出清晰的资格条件与方案对比表\n3. 整理分步办理清单与高频避坑点；对可能随地区或时间变动的口径显式标注核实提醒。',
      en: 'Fact-check official policies for "{{input}}":\n1. Prioritize primary government/official sources with effective dates and citations\n2. Summarize eligibility, quotas, and options in a structured table\n3. List step-by-step actions, pitfalls, and any items requiring local confirmation.',
    },
    preview: {
      kind: ShowcasePreviewKind.ResearchReport,
      sourceCount: 19,
      kicker: { zh: '官方政策多源核查', en: 'OFFICIAL POLICY CHECK' },
      headline: { zh: '最新资格条件、额度上浮与办理避坑清单', en: 'Eligibility Matrix, Quotas & Timeline' },
      summary: {
        zh: '全部关键数字标注官方发布日期；重点提醒余额倍数限制与断缴补缴口径差异。',
        en: 'Every rule is tied to dated official portals with clear callouts on recent threshold changes.',
      },
      tableHeaders: [
        { zh: '城市/项', en: 'Region' },
        { zh: '关键额度', en: 'Cap / Rule' },
        { zh: '上浮条件', en: 'Bonus' },
      ],
      tableRows: [
        { cells: [{ zh: '方案 A', en: 'Region A' }, { zh: '家庭额度上浮', en: 'Higher cap' }, { zh: '多孩/绿建', en: 'Family/Green' }], highlight: true },
        { cells: [{ zh: '方案 B', en: 'Region B' }, { zh: '余额倍数约束', en: 'Balance cap' }, { zh: '人才认定', en: 'Talent tier' }] },
        { cells: [{ zh: '必查提醒', en: 'Check' }, { zh: '以网签当日为准', en: 'Filing date' }, { zh: '附官网直达', en: 'Official URL' }] },
      ],
      citations: [{ zh: '[1] 公积金官网', en: '[1] Gov portal' }, { zh: '[2] 实施细则', en: '[2] Notice' }],
    },
  },
  {
    id: 'research-academic-review',
    categoryId: HomeShowcaseCategoryId.DeepResearch,
    filterTag: 'study',
    accent: ShowcaseAccent.Slate,
    title: { zh: '专题学术文献与观点综述', en: 'Literature & Viewpoint Synthesis' },
    subtitle: { zh: '核心论文 + 学派分歧 + 参考文献', en: 'Key papers, debates & citations' },
    badge: { zh: '论文/开题常用', en: 'Research ready' },
    description: {
      zh: '快速梳理某领域近 3 年代表性论文、方法演进脉络、核心争议点与可拓展研究方向，严禁编造文献。',
      en: 'Maps recent landmark papers, method taxonomy, open debates, and research gaps with strictly verified citations.',
    },
    skillId: 'web-search',
    customSlot: {
      label: { zh: '研究主题、时间范围与关注重点', en: 'Research topic, timeframe & angle' },
      placeholder: { zh: '例如：大语言模型长期记忆机制（2024–2026），重点对比架构与评测基准', en: 'e.g. Long-term memory architectures for LLM Agents (2024–2026)' },
      demoValue: { zh: 'AI Agent 记忆机制与上下文管理（2024–2026 代表性论文与评测基准综述）', en: 'Memory and context management in LLM Agents (2024–2026 literature synthesis)' },
    },
    optionGroups: [RESEARCH_DELIVERABLE_GROUP, RESEARCH_SCOPE_GROUP],
    demoPrompt: {
      zh: '请撰写一份「AI Agent 记忆机制与上下文管理（2024–2026）」专题文献综述：\n1. 按技术范式分类梳理代表性工作（如分层记忆、反思压缩、图谱记忆、外置检索等）\n2. 输出代表论文对比表（年份、核心思路、评测数据集、主要局限）\n3. 归纳当前学术界与工程界的 3 个核心分歧点与尚未解决的开放问题\n4. 严格只列出真实检索并确认存在的论文标题、作者/年份与链接，严禁杜撰参考文献。',
      en: 'Synthesize recent literature on "Memory & Context Management in LLM Agents (2024–2026)":\n1. Group representative works by architectural paradigm\n2. Build a comparison table (year, method, benchmarks, limitations)\n3. Summarize 3 active debates and open research gaps\n4. Cite only real, verified papers with titles, authors/years, and links.',
    },
    customPromptTemplate: {
      zh: '请针对「{{input}}」撰写一份严谨的专题文献综述：\n1. 梳理核心概念演进与主要方法/流派分类框架\n2. 用对比表汇总代表性文献的核心贡献、实验/证据与局限性\n3. 提炼当前主流争议点与值得深入的后续研究切入点\n4. 严格只引用真实查证过的文献与来源，禁止编造论文或作者。',
      en: 'Write a rigorous literature synthesis on "{{input}}":\n1. Organize core paradigms and evolution\n2. Compare representative papers/studies in a structured table\n3. Highlight open debates and promising research directions\n4. Cite only real, verified publications—never fabricate references.',
    },
    preview: {
      kind: ShowcasePreviewKind.ResearchReport,
      sourceCount: 26,
      kicker: { zh: '专题文献综述', en: 'LITERATURE SYNTHESIS' },
      headline: { zh: '近 3 年核心方法分类、基准对比与研究空白', en: 'Method Taxonomy, Benchmarks & Open Gaps' },
      summary: {
        zh: '按 4 大技术路线归纳代表论文，显式校验文献出处并提炼 3 个可立项研究问题。',
        en: 'Groups verified papers across 4 paradigms and highlights 3 concrete research opportunities.',
      },
      tableHeaders: [
        { zh: '方法路线', en: 'Paradigm' },
        { zh: '核心机制', en: 'Mechanism' },
        { zh: '主要局限', en: 'Limit' },
      ],
      tableRows: [
        { cells: [{ zh: '分层上下文', en: 'Tiered Memory' }, { zh: '冷热换入换出', en: 'Paging / Evict' }, { zh: '召回漂移', en: 'Recall drift' }], highlight: true },
        { cells: [{ zh: '图谱记忆', en: 'Graph Memory' }, { zh: '实体关系维护', en: 'Entity graph' }, { zh: '构建成本高', en: 'Write cost' }] },
        { cells: [{ zh: '反思摘要', en: 'Reflection' }, { zh: '周期提炼经验', en: 'Consolidation' }, { zh: '细节丢失', en: 'Detail loss' }] },
      ],
      citations: [{ zh: '[1] arXiv 2025', en: '[1] arXiv 2025' }, { zh: '[2] ACL/ICLR', en: '[2] ACL/ICLR' }],
    },
  },
];
