import {
  HomeShowcaseCategoryId,
  type HomeShowcaseExample,
  type HomeShowcaseFilterOption,
  ShowcaseAccent,
  type ShowcaseOptionGroup,
  ShowcasePreviewKind,
} from '../constants';

const WEB_STYLE_GROUP: ShowcaseOptionGroup = {
  id: 'web-style',
  label: { zh: '视觉调性', en: 'Aesthetic' },
  defaultChoiceId: 'editorial',
  choices: [
    {
      id: 'editorial',
      label: { zh: '杂志极简（推荐）', en: 'Editorial Minimal' },
      promptFragment: {
        zh: '视觉采用高质感杂志极简风（温暖留白、精致排版层级、细腻边框与微交互，严禁廉价渐变蓝紫“AI 味”）。',
        en: 'Use an editorial minimal aesthetic with generous whitespace, crisp typography, tactile cards, and subtle motion—avoid generic neon AI gradients.',
      },
    },
    {
      id: 'warm-craft',
      label: { zh: '温暖手作感', en: 'Warm & Tactile' },
      promptFragment: {
        zh: '视觉采用暖米白、陶土与深咖配色，圆润卡片和亲切排版，氛围温暖舒适。',
        en: 'Use a warm ivory, terracotta, and espresso palette with inviting cards and tactile typography.',
      },
    },
    {
      id: 'dark-modern',
      label: { zh: '暗夜高级感', en: 'Sleek Dark' },
      promptFragment: {
        zh: '视觉采用深邃炭黑与细腻微光高对比配色，现代科技感与仪式感兼具。',
        en: 'Use a refined obsidian dark canvas with high-contrast typography and crisp glass accents.',
      },
    },
  ],
};

const WEB_DEVICE_GROUP: ShowcaseOptionGroup = {
  id: 'web-device',
  label: { zh: '适配重点', en: 'Viewport' },
  defaultChoiceId: 'responsive',
  choices: [
    {
      id: 'responsive',
      label: { zh: '电脑 + 手机自适应', en: 'Desktop + Mobile' },
      promptFragment: {
        zh: '生成单文件可独立运行的响应式 HTML 页面，同时完美适配桌面端与手机端浏览器，并支持直接预览与发布分享。',
        en: 'Deliver a self-contained responsive HTML page that looks crisp on both desktop and mobile and is ready to preview/publish.',
      },
    },
    {
      id: 'mobile-first',
      label: { zh: '手机转发优先', en: 'Mobile-First Share' },
      promptFragment: {
        zh: '优先打磨手机竖屏单手滑动与微信转发阅读体验（大字号、清晰卡片、顺滑触控交互），桌面端居中精致展示。',
        en: 'Optimize primarily for mobile thumb scrolling and messaging shares, with a centered frame on desktop.',
      },
    },
  ],
};

export const WEBSITE_FILTERS: HomeShowcaseFilterOption[] = [
  { id: 'all', label: { zh: '全部', en: 'All' } },
  { id: 'personal', label: { zh: '个人与社交', en: 'Personal & Social' } },
  { id: 'tools', label: { zh: '实用小工具', en: 'Mini Tools' } },
  { id: 'business', label: { zh: '门店与活动', en: 'Shop & Events' } },
];

export const WEBSITE_EXAMPLES: HomeShowcaseExample[] = [
  {
    id: 'web-interactive-resume',
    categoryId: HomeShowcaseCategoryId.Website,
    filterTag: 'personal',
    accent: ShowcaseAccent.Blue,
    title: { zh: '高颜值互动在线简历 & 作品集', en: 'Editorial Portfolio & Resume' },
    subtitle: { zh: '上传 PDF 简历一键变主页', en: 'Turn PDF resume into a live site' },
    badge: { zh: '可一键发布分享', en: 'Shareable link' },
    description: {
      zh: '上传现有简历或填几句简介，生成带项目案例筛选、打印/导出按钮和联系方式的杂志感个人主页，直接发链接给面试官。',
      en: 'Turns your resume PDF or bio into a refined portfolio site with filterable case studies and print-ready layout.',
    },
    skillId: 'frontend-design',
    acceptsUpload: true,
    uploadAccept: '.pdf,.docx,.txt,.md',
    uploadHint: { zh: '直接上传你的旧简历 PDF / Word，自动提取内容生成在线主页', en: 'Upload your existing resume PDF/Word to populate the page' },
    customSlot: {
      label: { zh: '你的姓名、职位方向与 2–3 个代表经历', en: 'Your name, role & 2–3 signature highlights' },
      placeholder: { zh: '例如：林知夏 · 产品设计师（5年）· 主导过学习 App 改版和设计系统，风格要清爽高级', en: 'e.g. Maya Chen · Product Designer (5 yrs) · Led mobile redesign & design system' },
      demoValue: { zh: '林知夏 · 高级产品经理（5 年 AI 与效率工具经验）个人在线简历与作品集', en: 'Maya Lin · Senior Product Manager (5 yrs in Productivity & AI) Interactive Portfolio' },
      multiline: true,
    },
    optionGroups: [WEB_STYLE_GROUP, WEB_DEVICE_GROUP],
    demoPrompt: {
      zh: '请制作一个杂志感高颜值单页互动个人简历与作品集 HTML 网页（示例人物：林知夏 · 高级产品经理，5 年效率工具经验）：\n- 左侧/顶部清晰身份卡（简介、求职意向、一键复制邮箱按钮、打印简历按钮）\n- 核心代表项目区：支持按标签筛选（产品增长 / AI 工具 / 0→1 孵化），点击项目卡片可展开背景、策略与量化成果\n- 工作履历时间轴 + 技能矩阵 + 教育背景，细节克制高级，零占位假按钮。',
      en: 'Build a self-contained, editorial-grade interactive resume & portfolio HTML page (sample persona: Maya Lin, Senior PM):\n- Clean identity header with one-click copy email and print-friendly stylesheet\n- Filterable project showcase cards that expand into structured case studies\n- Career timeline, core skills, and polished desktop/mobile typography.',
    },
    customPromptTemplate: {
      zh: '请根据我的信息（及上传的简历附件）制作一个高颜值、可直接发布分享的单页互动个人简历与作品集 HTML 网页：\n- 包含核心定位简介、一键复制联系方式、可展开查看详情的代表项目卡片、工作履历时间轴与打印友好样式\n- 严禁编造我的履历；我的资料：\n{{input}}',
      en: 'Build an editorial interactive portfolio & resume HTML page from my details (and attached resume if provided):\n- Include bio header, copy-email button, expandable project case studies, timeline, and print-ready CSS\n- Never fabricate experience; my details:\n{{input}}',
    },
    preview: {
      kind: ShowcasePreviewKind.WebsiteLive,
      layout: 'resume',
      urlSlug: 'linzhixia.site/portfolio',
      heroTitle: { zh: '林知夏 · 产品经理', en: 'Maya Lin · Senior PM' },
      heroSubtitle: { zh: '专注效率工具与 AI 工作流体验 · 5 年从 0 到 1 交付经验', en: 'Productivity & AI workflows · 5 yrs 0-to-1 launches' },
      ctaLabel: { zh: '复制邮箱 / 打印简历', en: 'Copy Email · Print' },
      cards: [
        { title: { zh: '智能文档工作台改版', en: 'AI Workspace Redesign' }, meta: { zh: '次留 +14% · 点击展开', en: '+14% retention · Open' } },
        { title: { zh: '多端协同模板生态', en: 'Cross-Device Templates' }, meta: { zh: '月活 42W · 点击展开', en: '420k MAU · Open' } },
      ],
      publishable: true,
    },
  },
  {
    id: 'web-family-trip',
    categoryId: HomeShowcaseCategoryId.Website,
    filterTag: 'personal',
    accent: ShowcaseAccent.Teal,
    title: { zh: '可交互家庭旅行攻略与预算页', en: 'Interactive Trip Itinerary & Budget' },
    subtitle: { zh: '每日动线 + 预算算账 + 打包清单', en: 'Daily plan, budget & packing list' },
    badge: { zh: '手机发亲友超实用', en: 'Great on mobile' },
    description: {
      zh: '把旅行计划做成一个手机打开就能点选的精致网页：切换每日行程、实时算人均花费、打勾行李清单并本地记住勾选。',
      en: 'A mobile-ready trip hub for friends & family with day tabs, live per-person budget calculator, and checkable packing list.',
    },
    skillId: 'frontend-design',
    customSlot: {
      label: { zh: '目的地、天数、同行人数与想去的几个点', en: 'Destination, days, travelers & must-sees' },
      placeholder: { zh: '例如：成都 + 都江堰 4 天 3 晚，4 位好友美食松弛游，人均预算 2500 元', en: 'e.g. Lisbon 4 days for 3 friends, great food, relaxed pace, $900/person budget' },
      demoValue: { zh: '成都 + 都江堰 4 天 3 晚好友美食松弛游（4 人同行，人均预算 2,600 元）', en: 'Kyoto & Uji 4-Day Relaxed Food & Culture Trip (3 travelers, $1,100/person)' },
      multiline: true,
    },
    optionGroups: [
      { ...WEB_STYLE_GROUP, defaultChoiceId: 'warm-craft' },
      { ...WEB_DEVICE_GROUP, defaultChoiceId: 'mobile-first' },
    ],
    demoPrompt: {
      zh: '请制作一个温暖精致的可交互旅行攻略单页 HTML 网页：《成都 + 都江堰 4 天 3 晚松弛美食游》：\n- 顶部氛围卡展示天数、人数、天气穿着提醒与总预算概览\n- 可点击切换的 Day 1–Day 4 行程时间轴（含上午/午饭/下午/晚饭亮点、交通耗时与备选雨天方案）\n- 内置「实时人均预算计算器」（可改住宿/餐饮/门票/交通金额自动重算人均与总计）\n- 内置「行前打包勾选清单」（用 localStorage 记住勾选进度条）。',
      en: 'Build a warm, mobile-first interactive travel planner HTML page for "Kyoto & Uji 4-Day Food & Culture Trip":\n- Trip summary hero with days, travelers, and key reminders\n- Interactive Day 1–4 tabs with routing times, food picks, and rainy-day Plan B\n- Live per-person budget calculator and persistent checkable packing list (localStorage).',
    },
    customPromptTemplate: {
      zh: '请为以下旅行计划制作一个手机端超好用的可交互单页旅行攻略 HTML 网页：\n- 包含可切换的每日行程卡片、避坑贴士、实时人均预算计算器与可勾选保存的打包清单\n- 行程需求：\n{{input}}',
      en: 'Create a mobile-friendly interactive trip itinerary HTML page with day tabs, live per-person budget calculator, local tips, and persistent packing checklist for:\n\n{{input}}',
    },
    preview: {
      kind: ShowcasePreviewKind.WebsiteLive,
      layout: 'travel',
      urlSlug: 'trip.site/chengdu-4d',
      heroTitle: { zh: '成都 · 4 天松弛美食手账', en: 'Kyoto · 4-Day Trip Hub' },
      heroSubtitle: { zh: '4 人同行 · 人均 ￥2,600 · 含实时算账与打包清单', en: '3 travelers · $1,100/ea · Live budget & checklist' },
      ctaLabel: { zh: 'Day 1 · Day 2 · 预算 · 清单', en: 'Days · Budget · Packing' },
      cards: [
        { title: { zh: 'Day 1 · 玉林路漫步与火锅', en: 'Day 1 · Higashiyama Walk' }, meta: { zh: '4 站顺路 · 地铁直达', en: '4 stops · Zero backtrack' } },
        { title: { zh: '行前打包清单 6/10 已勾选', en: 'Packing List · 6/10 Ready' }, meta: { zh: '充电宝 / 晴雨伞 / 身份证', en: 'Adapter / IC Card / Umbrella' } },
      ],
      publishable: true,
    },
  },
  {
    id: 'web-life-calculator',
    categoryId: HomeShowcaseCategoryId.Website,
    filterTag: 'tools',
    accent: ShowcaseAccent.Emerald,
    title: { zh: '互动生活计算器（房贷 / 攒钱）', en: 'Mortgage & Savings Simulator' },
    subtitle: { zh: '拖动滑块实时看省息曲线', en: 'Live sliders & payoff chart' },
    badge: { zh: '零代码做专属工具', en: 'Interactive tool' },
    description: {
      zh: '不用写一行代码给自己做实用小工具！拖动贷款额、利率与提前还款滑块，实时对比等额本息/本金和省息总额。',
      en: 'Interactive financial tool with live sliders comparing payment schedules, extra principal payoff, and total interest saved.',
    },
    skillId: 'frontend-design',
    customSlot: {
      label: { zh: '想做的生活计算器/实用小工具想法', en: 'Interactive calculator or personal mini-tool idea' },
      placeholder: { zh: '例如：买车全款 vs 分期成本对比器 / 每月定投复利计算器 / 健身热量与蛋白计算器', en: 'e.g. Rent vs Buy calculator, monthly compound-savings simulator, or calorie planner' },
      demoValue: { zh: '房贷月供与「提前还贷省息」实时对比计算器（支持商贷/公积金组合与图表）', en: 'Mortgage & Early-Payoff Savings Calculator with live sliders and payoff curve' },
    },
    optionGroups: [WEB_STYLE_GROUP, WEB_DEVICE_GROUP],
    demoPrompt: {
      zh: '请制作一个清爽精准的「房贷月供与提前还贷省息对比计算器」单页互动 HTML 应用：\n- 支持滑块与数字输入：贷款总额（万）、年限（10–30年）、商贷利率（%）、一次性提前还款金额与还款年份\n- 实时切换并并排对比「等额本息 vs 等额本金」，以及提前还贷选「缩短年限 vs 减少月供」分别能省多少利息\n- 内置纯前端 SVG/Canvas 剩余本金与利息曲线图，以及前 12 期明细表，手机电脑都顺手。',
      en: 'Build a clean, interactive "Mortgage & Extra-Payment Savings Calculator" single-file HTML app:\n- Live sliders for loan amount, term (10–30 yrs), interest rate, and optional extra payment\n- Instant comparison cards showing monthly payment, total interest, and time/money saved\n- Interactive SVG/Canvas payoff chart plus an expandable amortization table.',
    },
    customPromptTemplate: {
      zh: '请为我制作一个高颜值、打开浏览器就能直接用的单页互动小工具 HTML 应用：\n- 提供顺手的滑块/开关实时重算，核心结果用大数字卡片与可视化图表呈现，附清晰公式说明\n- 工具需求：{{input}}',
      en: 'Build a polished, self-contained interactive mini-tool HTML app with instant slider/input updates, big metric cards, and a crisp live chart for:\n\n{{input}}',
    },
    preview: {
      kind: ShowcasePreviewKind.WebsiteLive,
      layout: 'calculator',
      urlSlug: 'tools.site/mortgage-calc',
      heroTitle: { zh: '房贷与提前还贷省息计算器', en: 'Mortgage & Payoff Simulator' },
      heroSubtitle: { zh: '拖动滑块实时对比：缩短年限 vs 减少月供', en: 'Compare monthly payment & interest saved live' },
      ctaLabel: { zh: '提前还 20 万 · 省息 ￥18.4 万', en: '+$30k extra · Save $54k interest' },
      cards: [
        { title: { zh: '每月月供 ￥6,842', en: 'Monthly $2,140' }, meta: { zh: '等额本息 · 利率 3.2%', en: '30-yr fixed · 5.4%' } },
        { title: { zh: '缩短年限省息最高', en: 'Shorten Term Wins' }, meta: { zh: '比降月供多省 ￥6.2 万', en: 'Saves 4.5 yrs off loan' } },
      ],
      publishable: true,
    },
  },
  {
    id: 'web-event-invite',
    categoryId: HomeShowcaseCategoryId.Website,
    filterTag: 'business',
    accent: ShowcaseAccent.Indigo,
    title: { zh: '婚礼 / 年会 / 生日电子请柬', en: 'Ceremony Event Invitation' },
    subtitle: { zh: '倒计时 + 流程轴 + 在线回执', en: 'Countdown, schedule & RSVP' },
    badge: { zh: '手机端高仪式感', en: 'Ceremony vibe' },
    description: {
      zh: '告别千篇一律的影楼 H5！带优雅入场动效、实时倒计时、活动时间轴、着装色卡与一键回执确认的专属邀请页。',
      en: 'An elevated mobile-first invitation with live countdown, event timeline, dress-code palette, venue map, and RSVP.',
    },
    skillId: 'frontend-design',
    customSlot: {
      label: { zh: '活动主题、时间、地点与着装/流程要点', en: 'Event title, date, venue & highlights' },
      placeholder: { zh: '例如：林晨 & 苏念婚礼晚宴 · 2026年10月18日 · 杭州西湖畔草坪，香槟金与森系白配色', en: 'e.g. Company 2026 Annual Gala · Dec 18 · Grand Ballroom, black-tie optional' },
      demoValue: { zh: '「星光之夜 · 2026 年度盛典与答谢晚宴」电子邀请函（含倒计时、流程轴与 RSVP 回执）', en: '"Starlight Night 2026 Annual Gala" Invitation (countdown, timeline, dress palette & RSVP)' },
      multiline: true,
    },
    optionGroups: [
      { ...WEB_STYLE_GROUP, defaultChoiceId: 'dark-modern' },
      { ...WEB_DEVICE_GROUP, defaultChoiceId: 'mobile-first' },
    ],
    demoPrompt: {
      zh: '请制作一个极具仪式感与电影质感的手机优先电子邀请函单页 HTML 网页：《星光之夜 · 2026 年度答谢晚宴》：\n- 深蓝夜空与香槟金克制高级视觉，带细腻星尘微动效与距离开场的实时倒计时\n- 清晰活动流程时间轴（签到合影、主旨分享、颁奖抽奖、晚宴音乐）+ 着装建议色卡\n- 交通停车指引卡片 + 可交互 RSVP 确认表单（选择出席人数、饮食禁忌，提交后展示电子入场凭证卡）。',
      en: 'Design an elevated, mobile-first invitation HTML page for "Starlight Night 2026 Annual Gala":\n- Deep midnight & champagne gold aesthetic with subtle starlight motion and live countdown\n- Event timeline, dress-code color swatches, venue directions, and interactive RSVP generating a digital pass.',
    },
    customPromptTemplate: {
      zh: '请为以下活动制作一份高仪式感、适合手机转发的单页电子邀请函 HTML 网页：\n- 包含实时倒计时、流程时间轴、着装配色板、地址交通指引与可交互 RSVP 确认回执（提交后显示专属入场凭证）\n- 活动信息：\n{{input}}',
      en: 'Build a mobile-first ceremony invitation HTML page with live countdown, schedule timeline, dress palette, directions, and interactive RSVP pass for:\n\n{{input}}',
    },
    preview: {
      kind: ShowcasePreviewKind.WebsiteLive,
      layout: 'invitation',
      urlSlug: 'invite.site/starlight-2026',
      heroTitle: { zh: '星光之夜 · 2026 年度盛典', en: 'Starlight Night · 2026 Gala' },
      heroSubtitle: { zh: '2026.12.18 18:30 · 城市之光三层宴会厅', en: 'Dec 18, 6:30 PM · Grand Ballroom' },
      ctaLabel: { zh: '确认出席 · 生成电子入场券', en: 'RSVP · Get Digital Pass' },
      cards: [
        { title: { zh: '距离开场 24 天 06 时', en: '24 Days · 06 Hours Left' }, meta: { zh: '18:30 签到 · 19:15 晚宴', en: '6:30 Check-in · 7:15 Dinner' } },
        { title: { zh: '着装色卡 · 深蓝 / 香槟金', en: 'Dress Palette · Navy & Gold' }, meta: { zh: '附停车与地铁指引', en: 'Parking & transit included' } },
      ],
      publishable: true,
    },
  },
  {
    id: 'web-local-shop',
    categoryId: HomeShowcaseCategoryId.Website,
    filterTag: 'business',
    accent: ShowcaseAccent.Amber,
    title: { zh: '咖啡馆 / 工作室数字菜单名片', en: 'Cafe & Studio Digital Menu' },
    subtitle: { zh: '分类筛选菜单 + 营业信息', en: 'Filterable menu & store card' },
    badge: { zh: '小微商户刚需', en: 'Small biz hit' },
    description: {
      zh: '替代模糊压缩的微信菜单长图！打造温暖杂志感门店展示页，顾客可按品类筛选招牌单品、查看营业时间与预约电话。',
      en: 'Replaces blurry menu screenshots with a tactile, filterable menu, signature items, reviews, and store hours.',
    },
    skillId: 'frontend-design',
    customSlot: {
      label: { zh: '店铺/工作室名称、主营品类与特色卖点', en: 'Shop/studio name, menu highlights & vibe' },
      placeholder: { zh: '例如：「木棉手作烘焙」社区低糖欧包与手冲咖啡，主打当日现烤，营业时间 8:00–20:00', en: 'e.g. "Oak & Crumb Bakery" — daily sourdough, pour-over coffee, open 7am–6pm' },
      demoValue: { zh: '「麦田手作烘焙与咖啡工作室」温暖文艺数字菜单与门店展示页', en: '"Wheatfield Bakery & Coffee" Warm Artisan Menu & Storefront' },
      multiline: true,
    },
    optionGroups: [
      { ...WEB_STYLE_GROUP, defaultChoiceId: 'warm-craft' },
      WEB_DEVICE_GROUP,
    ],
    demoPrompt: {
      zh: '请为「麦田手作烘焙 · Wheatfield Bakery」制作一个温暖高级的实体小店展示与数字菜单 HTML 网页：\n- 奶油米白与烘烤深咖配色，首屏展示品牌理念、今日新鲜出炉时段与“浏览菜单”锚点\n- 可交互分类菜单（全部 / 手作欧包 / 精品咖啡 / 伴手礼盒），含价格、风味标签、甜度/过敏原提示与招牌推荐角标\n- 品牌手作故事 + 3 条真实感顾客口碑 + 营业时间、地址交通与一键复制电话/微信号按钮。',
      en: 'Create a warm artisan digital storefront & menu HTML page for "Wheatfield Bakery & Coffee":\n- Cream and roasted-espresso aesthetic with daily bake schedule hero\n- Interactive category tabs (All / Breads / Coffee / Gift Boxes) with prices, tasting notes, and house-favorite badges\n- Story section, guest reviews, hours, address, and one-tap copy contact.',
    },
    customPromptTemplate: {
      zh: '请为以下小店/工作室制作一个温暖有质感的展示主页与可筛选数字菜单 HTML 网页：\n- 包含品牌首屏、按分类筛选的招牌产品与价格卡、品牌故事、顾客评价及营业时间/联系方式\n- 店铺信息：\n{{input}}',
      en: 'Build a warm digital menu & storefront HTML page with interactive category filters, pricing cards, story, reviews, and hours for:\n\n{{input}}',
    },
    preview: {
      kind: ShowcasePreviewKind.WebsiteLive,
      layout: 'shop',
      urlSlug: 'shop.site/wheatfield-bakery',
      heroTitle: { zh: '麦田手作 · 每日新鲜现烤', en: 'Wheatfield · Baked Daily' },
      heroSubtitle: { zh: '低糖欧包 · 单品手冲 · 每日 08:00 / 14:30 两轮出炉', en: 'Sourdough & Pour-Over · Fresh bakes 8 AM & 2 PM' },
      ctaLabel: { zh: '全部 · 欧包 · 咖啡 · 礼盒', en: 'All · Breads · Coffee · Gifts' },
      cards: [
        { title: { zh: '海盐黄油可颂 · ￥16', en: 'Sea Salt Croissant · $5' }, meta: { zh: '招牌必点 · 发酵 18 小时', en: 'House favorite · 18h ferment' } },
        { title: { zh: '埃塞水洗手冲 · ￥28', en: 'Ethiopia Pour-Over · $6' }, meta: { zh: '柑橘白花香 · 轻烘焙', en: 'Citrus & jasmine · Light' } },
      ],
      publishable: true,
    },
  },
  {
    id: 'web-interactive-explainer',
    categoryId: HomeShowcaseCategoryId.Website,
    filterTag: 'tools',
    accent: ShowcaseAccent.Violet,
    title: { zh: '可视化科普 / 知识互动图解', en: 'Interactive Visual Explainer' },
    subtitle: { zh: '点哪里讲哪里，一看就懂', en: 'Click-to-explore visual learning' },
    badge: { zh: '惊艳交互体验', en: 'Wow factor' },
    description: {
      zh: '把抽象知识做成能亲手点、能调参数的可视化网页（如咖啡风味轮、太阳系轨道、人体营养搭配、复利原理），教学分享超吸睛。',
      en: 'Turns complex topics into clickable, playful visual explainers (coffee flavor wheel, solar system, nutrition, compound growth).',
    },
    skillId: 'frontend-design',
    customSlot: {
      label: { zh: '想做成互动图解的科普/教学主题', en: 'Topic to turn into an interactive visual explainer' },
      placeholder: { zh: '例如：太阳系八大行星比例与公转互动图 / 中国茶叶六大茶类风味图谱 / 咖啡冲煮参数实验室', en: 'e.g. Interactive Solar System explorer, Six Tea Families flavor map, or Coffee Brew Lab' },
      demoValue: { zh: '「手冲咖啡风味轮与冲煮参数实验室」互动科普网页（点击风味区间看产区与冲煮建议）', en: '"Interactive Coffee Flavor Wheel & Brew Lab" Visual Explainer' },
    },
    optionGroups: [WEB_STYLE_GROUP, WEB_DEVICE_GROUP],
    demoPrompt: {
      zh: '请制作一个让人眼前一亮的互动科普单页 HTML 网页：《手冲咖啡风味轮与冲煮实验室》：\n- 交互式 SVG 风味轮（果酸花香 / 坚果可可 / 焦糖甜感 / 草本香料），点击任意扇区联动右侧展示代表产区、烘焙度与品鉴笔记\n- 内置「手冲粉水比与萃取模拟器」：拖动粉量、水温、研磨度滑块，实时提示风味偏向（偏酸/均衡/偏苦）并给出推荐注水时间轴\n- 视觉精致有质感，零外部依赖，打开即玩。',
      en: 'Build a tactile interactive visual explainer HTML page: "Coffee Flavor Wheel & Pour-Over Brew Lab":\n- Clickable SVG flavor wheel (floral/fruity, nutty/cocoa, caramel, spice) linked to origin & roast cards\n- Interactive brew simulator (dose, water temp, grind size sliders) showing live extraction balance & pour timeline\n- Zero external dependencies, crisp typography.',
    },
    customPromptTemplate: {
      zh: '请围绕以下主题制作一个高审美、可点击探索的互动知识图解 HTML 网页：\n- 核心概念用可点击 SVG 图示或可调参数交互实验来解释，拒绝大段枯燥文字堆砌\n- 主题：{{input}}',
      en: 'Create a clickable, interactive visual explainer HTML page using custom SVG diagrams and hands-on controls (no walls of text) for:\n\n{{input}}',
    },
    preview: {
      kind: ShowcasePreviewKind.WebsiteLive,
      layout: 'science',
      urlSlug: 'learn.site/coffee-flavor-lab',
      heroTitle: { zh: '咖啡风味轮与手冲实验室', en: 'Coffee Flavor Wheel & Brew Lab' },
      heroSubtitle: { zh: '点击风味扇区探索产区 · 调节水温与研磨度看萃取变化', en: 'Click tasting notes · Simulate temp & grind extraction' },
      ctaLabel: { zh: '果香花调 · 焦糖坚果 · 冲煮模拟', en: 'Floral · Cocoa · Brew Sim' },
      cards: [
        { title: { zh: '埃塞俄比亚 · 柑橘茉莉', en: 'Ethiopia · Citrus & Floral' }, meta: { zh: '浅烘 · 92°C · 1:15 粉水比', en: 'Light · 92°C · 1:15 ratio' } },
        { title: { zh: '当前萃取：甜感均衡 ✓', en: 'Extraction: Sweet & Balanced' }, meta: { zh: '2 分 15 秒完成三段注水', en: '2:15 three-stage pour' } },
      ],
      publishable: true,
    },
  },
  {
    id: 'web-product-launch',
    categoryId: HomeShowcaseCategoryId.Website,
    filterTag: 'business',
    accent: ShowcaseAccent.Rose,
    title: { zh: '新品发布 / 公开课报名落地页', en: 'Product & Course Launch Page' },
    subtitle: { zh: '首屏亮点 + Bento 卖点 + 报名表', en: 'Hero, Bento grid, FAQ & signup' },
    badge: { zh: '转化率导向', en: 'Conversion ready' },
    description: {
      zh: '快速给你的新产品、开源工具、社群或公开课做出堪比一线科技官网的落地页，带亮点 Bento 网格、价格对比与折叠 FAQ。',
      en: 'Launches your product, course, or community with an Apple/Linear-inspired Bento grid, pricing comparison, FAQ, and signup.',
    },
    skillId: 'frontend-design',
    customSlot: {
      label: { zh: '产品或课程名称、一句话卖点与核心亮点', en: 'Product or course name, tagline & key benefits' },
      placeholder: { zh: '例如：《零基础 AI 办公提效 7 天实战营》，面向职场人，含 6 节直播 + 模板库，早鸟价 199 元', en: 'e.g. "7-Day Practical AI Productivity Bootcamp" — 6 live workshops + templates, $49 early bird' },
      demoValue: { zh: '《普通人的 AI 效率工作流 7 天实战公开课》高转化活动报名落地页', en: '"7-Day Practical AI Workflow Bootcamp" High-Conversion Launch Page' },
      multiline: true,
    },
    optionGroups: [WEB_STYLE_GROUP, WEB_DEVICE_GROUP],
    demoPrompt: {
      zh: '请制作一个一线产品官网质感的活动/课程发布落地页 HTML：《7 天 AI 办公提效实战营》：\n- 克制有力的首屏 Hero（一句话价值主张 + 立即预约按钮 + 关键数据背书条）\n- 4 格 Bento Grid 拆解核心收获（PPT 模板 / 数据分析 / 文档精排 / 深度调研）\n- 7 天课程大纲折叠手风琴 + 学员真实感评价 + 清晰双档位对比与可交互预约报名弹窗。',
      en: 'Design a flagship-grade launch landing page HTML for "7-Day Practical AI Workflow Bootcamp":\n- Crisp Hero with clear value proposition, CTA, and social proof strip\n- 4-tile Bento grid highlighting deliverables, interactive curriculum accordion, testimonials, and signup modal.',
    },
    customPromptTemplate: {
      zh: '请为以下产品/课程/活动制作一个高审美、高转化的单页发布落地页 HTML：\n- 包含清晰首屏 Hero、Bento 卖点网格、价格或安排对比、可展开 FAQ 与交互报名表单\n- 介绍信息：\n{{input}}',
      en: 'Build a conversion-focused launch landing page HTML with a crisp hero, Bento feature grid, schedule/pricing comparison, FAQ accordion, and signup form for:\n\n{{input}}',
    },
    preview: {
      kind: ShowcasePreviewKind.WebsiteLive,
      layout: 'launch',
      urlSlug: 'launch.site/ai-workflow-camp',
      heroTitle: { zh: '7 天掌握高质感 AI 办公流', en: 'Master Practical AI in 7 Days' },
      heroSubtitle: { zh: '告别低效问答 · 直接交付 PPT、看板、文档与调研报告', en: 'Ship real slides, dashboards, docs, and research briefs' },
      ctaLabel: { zh: '预约早鸟席位 →', en: 'Reserve Early Seat →' },
      cards: [
        { title: { zh: '6 节实战 + 40 套模板', en: '6 Workshops + 40 Kits' }, meta: { zh: '学完当天用进日常工作', en: 'Apply on day one' } },
        { title: { zh: '常见问题 FAQ', en: 'Interactive FAQ' }, meta: { zh: '零代码基础能否跟上？', en: 'Zero coding needed' } },
      ],
      publishable: true,
    },
  },
  {
    id: 'web-annual-gallery',
    categoryId: HomeShowcaseCategoryId.Website,
    filterTag: 'personal',
    accent: ShowcaseAccent.Slate,
    title: { zh: '年度书影音清单 / 个人数字展厅', en: 'Annual Media & Photo Shelf' },
    subtitle: { zh: '按分类筛选 + 评分短评墙', en: 'Filterable shelf & star notes' },
    badge: { zh: '发朋友圈超吸睛', en: 'Social favorite' },
    description: {
      zh: '把你这一年读过的书、看过的电影、走过的城市或摄影作品，做成一个可以筛选和点开看短评的精致个人数字展厅。',
      en: 'Curate your favorite books, films, cafes, or photos into a filterable gallery wall with ratings and personal notes.',
    },
    skillId: 'frontend-design',
    acceptsUpload: true,
    uploadAccept: '.csv,.txt,.md,.xlsx',
    uploadHint: { zh: '可选上传你的豆瓣书影音清单或文字记录', en: 'Optional: upload your book/film CSV or notes list' },
    customSlot: {
      label: { zh: '展厅主题与你想收录的几部代表作品/条目', en: 'Gallery theme & sample items to feature' },
      placeholder: { zh: '例如：我的 2026 年度最爱书单与电影（含评分、一句短评、按“书籍/电影/播客”筛选）', en: 'e.g. My 2026 Top Books, Films & Podcasts with star ratings and 1-line takeaways' },
      demoValue: { zh: '「2026 我的年度书影音私藏清单」可筛选数字展厅（含统计概览、分类筛选与短评弹窗）', en: '"2026 My Favorite Books, Films & Podcasts" Filterable Digital Shelf' },
      multiline: true,
    },
    optionGroups: [WEB_STYLE_GROUP, WEB_DEVICE_GROUP],
    demoPrompt: {
      zh: '请制作一个文艺高级的个人数字展厅单页 HTML 网页：《2026 我的年度书影音私藏清单》：\n- 顶部年度阅读/观影数据概览卡（共收录 12 部代表作、五星推荐数、年度关键词）\n- 支持按「全部 / 书籍 / 电影 / 播客」与「仅看五星」实时筛选卡片墙，卡片展示复古配色封面卡、星级与一句走心短评\n- 点击任意条目弹出详情阅读卡，并附“新增一条我的收藏”交互小表单（本地保存）。',
      en: 'Build a curated personal digital shelf HTML page: "2026 My Favorite Books, Films & Podcasts":\n- Annual stats header (items logged, 5-star picks, theme tags)\n- Live filter chips (All / Books / Films / Podcasts / 5-Star Only) with editorial cover cards and concise reviews\n- Click-to-read modal plus a local "Add my own pick" form.',
    },
    customPromptTemplate: {
      zh: '请根据我的清单内容，制作一个高审美、可筛选浏览的个人数字展厅单页 HTML 网页：\n- 包含顶部统计概览、分类筛选标签、精致卡片墙与点击展开短评详情\n- 我的内容：\n{{input}}',
      en: 'Build a filterable personal digital gallery HTML page with summary stats, category chips, visual cards, and detail modals for:\n\n{{input}}',
    },
    preview: {
      kind: ShowcasePreviewKind.WebsiteLive,
      layout: 'gallery',
      urlSlug: 'shelf.site/2026-picks',
      heroTitle: { zh: '2026 我的书影音私藏展厅', en: '2026 Curated Media Shelf' },
      heroSubtitle: { zh: '12 部年度挚爱 · 按书籍 / 电影 / 播客自由筛选', en: '12 favorites · Filter by Books, Films & Podcasts' },
      ctaLabel: { zh: '全部 · 书籍 · 电影 · ★5星', en: 'All · Books · Films · ★5' },
      cards: [
        { title: { zh: '《设计心理学》★★★★★', en: 'Design of Everyday Things ★5' }, meta: { zh: '书籍 · “好设计从不怪用户”', en: 'Book · "Good design never blames"' } },
        { title: { zh: '《完美的日子》★★★★★', en: 'Perfect Days ★★★★★' }, meta: { zh: '电影 · “把日常活成光影诗”', en: 'Film · "Poetry in small routines"' } },
      ],
      publishable: true,
    },
  },
];
