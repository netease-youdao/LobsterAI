import {
  HomeShowcaseCategoryId,
  type HomeShowcaseExample,
  type HomeShowcaseFilterOption,
  ShowcaseAccent,
  type ShowcaseOptionGroup,
  ShowcasePreviewKind,
} from '../constants';

const DATA_OUTPUT_GROUP: ShowcaseOptionGroup = {
  id: 'output',
  label: { zh: '交付形态', en: 'Output' },
  defaultChoiceId: 'dashboard-excel',
  choices: [
    {
      id: 'dashboard-excel',
      label: { zh: '交互看板 + 整理表', en: 'Dashboard + Excel' },
      promptFragment: {
        zh: '输出整理后的规范 Excel（含汇总公式与图表），并生成一份可视化 HTML 交互分析看板，直观呈现核心结论。',
        en: 'Deliver a cleaned Excel workbook (with formulas & charts) plus an interactive HTML visual dashboard.',
      },
    },
    {
      id: 'excel-only',
      label: { zh: '规范 Excel（带图表）', en: 'Excel with Charts' },
      promptFragment: {
        zh: '重点交付结构清晰、带动态公式（SUM/AVERAGE/占比）与原生图表的可编辑 `.xlsx` 文件。',
        en: 'Deliver a clean `.xlsx` workbook with verified formulas and native charts.',
      },
    },
    {
      id: 'word-brief',
      label: { zh: '分析简报 Word', en: 'Word Report' },
      promptFragment: {
        zh: '基于数据结论生成一份带高清统计图表与可执行建议的 `.docx` 专业分析简报。',
        en: 'Generate a management-ready `.docx` analytics brief with embedded charts and recommendations.',
      },
    },
  ],
};

export const DATA_FILTERS: HomeShowcaseFilterOption[] = [
  { id: 'all', label: { zh: '全部', en: 'All' } },
  { id: 'life', label: { zh: '生活与理财', en: 'Personal & Finance' } },
  { id: 'work', label: { zh: '职场与经营', en: 'Work & Ops' } },
  { id: 'utility', label: { zh: '表格效率', en: 'Sheet Automation' } },
];

const PERSONAL_BILL_CSV = `日期,商户/项目,一级分类,二级分类,支付方式,金额(元),备注
2026-01-03,全家便利店,餐饮,早餐咖啡,微信支付,26.5,拿铁+三明治
2026-01-05,某视频平台连续包月,订阅服务,影音会员,支付宝,25.0,自动扣费
2026-01-08,盒马鲜生,居家日用,买菜生鲜,支付宝,186.4,周末采购
2026-01-12,滴滴出行,交通出行,网约车,微信支付,48.0,加班打车
2026-01-15,云盘空间自动续费,订阅服务,工具软件,支付宝,30.0,半年未用
2026-01-20,海底捞火锅,餐饮,聚餐社交,微信支付,368.0,朋友聚会
2026-02-02,瑞幸咖啡,餐饮,奶茶咖啡,微信支付,19.9,生椰拿铁
2026-02-05,某视频平台连续包月,订阅服务,影音会员,支付宝,25.0,自动扣费
2026-02-11,京东自营,购物消费,数码配件,支付宝,299.0,蓝牙耳机
2026-02-14,西餐厅,餐饮,聚餐社交,信用卡,520.0,节日聚餐
2026-02-15,云盘空间自动续费,订阅服务,工具软件,支付宝,30.0,自动扣费
2026-02-21,健身房次卡,健康运动,健身,微信支付,180.0,周卡
2026-03-04,美团外卖,餐饮,外卖正餐,微信支付,42.5,工作日午餐
2026-03-05,某视频平台连续包月,订阅服务,影音会员,支付宝,25.0,自动扣费
2026-03-09,优衣库,购物消费,服饰鞋包,支付宝,398.0,春装外套
2026-03-15,云盘空间自动续费,订阅服务,工具软件,支付宝,30.0,自动扣费
2026-03-18,滴滴出行,交通出行,网约车,微信支付,62.0,雨天通勤
2026-03-24,山姆会员店,居家日用,商超囤货,信用卡,615.0,日用品与零食
2026-03-29,音乐会员自动续费,订阅服务,影音会员,微信支付,18.0,自动扣费
2026-04-06,星巴克,餐饮,奶茶咖啡,微信支付,38.0,下午茶
2026-04-12,铁路12306,旅行休闲,高铁票,支付宝,462.0,周末短途游
2026-04-15,云盘空间自动续费,订阅服务,工具软件,支付宝,30.0,自动扣费
2026-04-22,美团外卖,餐饮,外卖正餐,微信支付,46.0,加班晚餐
2026-04-28,某书店,学习成长,图书课程,支付宝,128.0,专业书籍`;

const CAFE_SALES_CSV = `日期,时段,门店,品类,商品名称,销量,单价(元),销售额(元),成本(元)
2026-04-01,早高峰(8-10),国贸店,咖啡,生椰拿铁,86,18,1548,473
2026-04-01,早高峰(8-10),国贸店,咖啡,冰美式,74,15,1110,259
2026-04-01,早高峰(8-10),国贸店,烘焙,牛角可颂,52,14,728,286
2026-04-01,午间(11-14),国贸店,茶饮,羽衣甘蓝果蔬茶,41,22,902,328
2026-04-01,下午(14-17),国贸店,烘焙,巴斯克蛋糕,28,26,728,280
2026-04-01,下午(14-17),国贸店,特调,桂花燕麦拿铁,11,26,286,121
2026-04-02,早高峰(8-10),国贸店,咖啡,生椰拿铁,92,18,1656,506
2026-04-02,早高峰(8-10),国贸店,咖啡,冰美式,81,15,1215,283.5
2026-04-02,午间(11-14),望京店,茶饮,羽衣甘蓝果蔬茶,56,22,1232,448
2026-04-02,午间(11-14),望京店,咖啡,生椰拿铁,68,18,1224,374
2026-04-02,下午(14-17),望京店,烘焙,巴斯克蛋糕,35,26,910,350
2026-04-02,晚间(17-21),望京店,特调,桂花燕麦拿铁,6,26,156,66
2026-04-03,早高峰(8-10),国贸店,咖啡,生椰拿铁,98,18,1764,539
2026-04-03,早高峰(8-10),国贸店,烘焙,牛角可颂,61,14,854,335.5
2026-04-03,下午(14-17),望京店,茶饮,杨枝甘露轻乳茶,49,21,1029,392
2026-04-03,晚间(17-21),国贸店,特调,抹茶拿铁,9,24,216,94.5`;

const MERGE_JAN_CSV = `报销日期,申请人,部门,费用类别,金额,备注
2026-01-08,林晓,产品部,交通费,128.5,见客户打车
2026-01-12,陈默,市场部,餐饮招待,640.0,合作方午餐
2026-01-18,林晓,产品部,办公软件,99.0,设计素材包
2026-01-22,周瑶,研发部,差旅住宿,890.0,上海出差2晚`;

const MERGE_FEB_CSV = `提交时间,员工姓名,所属团队,支出科目,报销金额(RMB),说明
2026/02/03,林晓,产品部,交通费,128.5,见客户打车
2026/02/05,周瑶,研发部,交通费,215.0,机场往返
2026/02/14,吴帆,市场部,活动物料,1580.0,线下沙龙易拉宝
2026/02/19,陈默,市场部,餐饮招待,520.0,渠道沟通`;

const RENT_COMPARE_CSV = `房源名称,片区,月租金(元),面积(㎡),通勤时间(分钟),距地铁(米),朝向楼层,采光评分(1-10),缺点备注
阳光雅苑3栋,望京,5400,52,24,380,南向/12层,9,厨房略小
地铁公馆B座,望京,5800,48,18,150,东南/18层,8,临主干道略吵
林荫花园2期,酒仙桥,4600,58,36,820,南北通透/6层,9,步行到地铁较远
青年loft公寓,来广营,4200,44,42,650,西向/9层,6,商水商电冬季偏冷
锦绣华庭1号,太阳宫,6300,55,15,260,南向/15层,9,超出预算上限
科创里小区,北苑,4900,60,31,450,南向/8层,8,老小区无电梯`;

const SOCIAL_CONTENT_CSV = `发布日期,发布时段,标题主题,内容类型,曝光量,点赞,收藏,评论,新增粉丝
2026-03-01,20:30,打工人下班15分钟快手晚餐清单,合集清单,68200,2410,4120,186,612
2026-03-04,12:15,我用30天改掉了熬夜刷手机,个人故事,19400,620,410,94,108
2026-03-07,21:00,租房5年踩过的8个隐形坑避雷,避坑指南,112500,4380,6890,412,1240
2026-03-10,09:00,周末去公园散步随拍,日常Vlog,5400,145,62,21,18
2026-03-13,20:00,3000元小卧室极简改造前后对比,前后对比,94800,3890,5420,305,980
2026-03-16,18:30,5个免费好用的桌面效率小工具,工具测评,76300,2190,4850,164,735
2026-03-19,14:00,今天做了一杯手冲咖啡,日常图文,4100,98,35,14,9
2026-03-22,20:30,月薪1万怎么分配攒钱最快（附表）,干货模板,138000,5120,9240,488,1620`;

const STUDENT_SCORES_CSV = `考试批次,语文,数学,英语,物理,化学,总分,班级排名
9月月考,112,96,124,72,78,482,21
10月月考,115,104,126,69,81,495,16
11月期中,114,112,128,74,84,512,12
12月期末,118,119,131,71,86,525,9`;

const PORTFOLIO_CSV = `日期,标的类别,标的名称,投入本金(元),当前市值(元),近1年最大回撤(%),年度股息/分红(元)
2026-04-30,宽基指数,沪深300ETF,40000,43600,-9.8,1120
2026-04-30,宽基指数,纳斯达克100ETF,30000,35400,-14.2,240
2026-04-30,红利低波,中证红利ETF,25000,27100,-5.4,1350
2026-04-30,债券稳健,短债基金,35000,36120,-0.6,0
2026-04-30,行业主题,科技成长基金,20000,17800,-24.6,0`;

export const DATA_EXAMPLES: HomeShowcaseExample[] = [
  {
    id: 'data-personal-bill',
    categoryId: HomeShowcaseCategoryId.DataAnalysis,
    filterTag: 'life',
    accent: ShowcaseAccent.Emerald,
    title: { zh: '个人 / 家庭账单体检与省钱诊断', en: 'Personal Spending Health Check' },
    subtitle: { zh: '消费占比 + 隐形自动续费预警', en: 'Category split & hidden subscriptions' },
    badge: { zh: '含示例账单 CSV', en: 'Sample CSV included' },
    description: {
      zh: '上传微信/支付宝导出的账单，自动分类汇总、揪出长期忘关的自动续费与“拿铁因子”，给出可执行省钱方案。',
      en: 'Categorizes raw bank or wallet statements, flags forgotten recurring subscriptions, and highlights easy monthly savings.',
    },
    skillId: 'xlsx',
    acceptsUpload: true,
    uploadAccept: '.csv,.xlsx,.xls',
    uploadHint: { zh: '支持微信/支付宝/银行导出的 CSV 或 Excel 账单（本地处理，不上传外部）', en: 'Upload bank/wallet CSV or Excel statements (processed locally)' },
    customSlot: {
      label: { zh: '补充你的预算目标或重点想查的开销（可选）', en: 'Your monthly budget goal or focus (optional)' },
      placeholder: { zh: '例如：我想把月均支出压到 5000 元以内，重点帮我查餐饮外卖和自动续费', en: 'e.g. Target under $2,500/mo, audit food delivery and recurring subscriptions' },
      demoValue: { zh: '分析自带的 4 个月脱敏个人账单，揪出隐形续费并给出省钱建议', en: 'Audit the bundled 4-month sample spending CSV and spot hidden subscriptions' },
    },
    optionGroups: [DATA_OUTPUT_GROUP],
    demoPrompt: {
      zh: '请读取附件中的《个人脱敏账单示例（personal-spending-sample.csv）》，帮我做一次完整的消费体检：\n1. 按一级/二级分类汇总总支出、占比及月度趋势\n2. 自动识别所有「重复/自动续费」项目并计算年化隐形支出\n3. 标出高频小额支出（咖啡/外卖/打车）与大额单笔异常消费\n4. 给出 3 条具体、不降低生活质量的省钱建议，输出带图表 Excel 与直观可视化看板。',
      en: 'Analyze the attached sample spending file (personal-spending-sample.csv):\n1. Summarize total spend by category and monthly trend\n2. Flag all recurring/auto-renew subscriptions and calculate annual hidden cost\n3. Highlight frequent small purchases and top outlier transactions\n4. Recommend 3 practical savings actions alongside charts and a cleaned workbook.',
    },
    customPromptTemplate: {
      zh: '请读取我上传的个人/家庭账单数据，完成一次全面的消费体检：\n1. 按消费分类与月份汇总统计并计算占比\n2. 自动排查重复扣费、自动续费与异常大额支出\n3. 结合我的目标给出可执行预算分配与省钱建议：{{input}}',
      en: 'Analyze my uploaded personal/household spending data:\n1. Summarize spend by category and month with share breakdown\n2. Detect recurring subscriptions and outlier transactions\n3. Provide tailored budget and savings recommendations for: {{input}}',
    },
    sampleFiles: [
      {
        name: 'personal-spending-sample.csv',
        mimeType: 'text/csv',
        content: PERSONAL_BILL_CSV,
        previewLines: [
          { zh: '2026-01-03 · 全家便利店 · 餐饮 · ￥26.5', en: '2026-01-03 · Convenience Store · Food · $26.5' },
          { zh: '2026-01-15 · 云盘空间自动续费 · 订阅 · ￥30.0（半年未用）', en: '2026-01-15 · Cloud Storage Auto-Renew · $30.0 (unused)' },
          { zh: '2026-03-24 · 山姆会员店 · 商超囤货 · ￥615.0', en: '2026-03-24 · Wholesale Club · Groceries · $615.0' },
          { zh: '共 24 条 1–4 月脱敏消费记录（含隐形续费与大额消费）', en: '24 sample transactions across Jan–Apr with hidden renewals' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DataDashboard,
      kicker: { zh: '个人消费健康看板', en: 'SPENDING HEALTH BOARD' },
      metrics: [
        { label: { zh: '总支出', en: 'Total Spend' }, value: '￥3,721', delta: '4 个月示例' },
        { label: { zh: '隐形续费/年', en: 'Hidden Subs/yr' }, value: '￥876', delta: '3 项待关' },
        { label: { zh: '餐饮占比', en: 'Food Share' }, value: '31.4%', delta: 'TOP 1' },
      ],
      bars: [
        { label: { zh: '餐饮聚餐与外卖', en: 'Dining & Delivery' }, percent: 82, valueText: '31.4%' },
        { label: { zh: '居家商超囤货', en: 'Groceries' }, percent: 56, valueText: '21.5%' },
        { label: { zh: '购物与服饰', en: 'Shopping' }, percent: 48, valueText: '18.7%' },
        { label: { zh: '自动续费订阅', en: 'Auto-Renewals' }, percent: 26, valueText: '7.5%' },
      ],
      insight: {
        zh: '发现 1 项连续 4 个月扣费但未使用的云盘订阅，关闭与缩减外卖每年可省约 ￥2,400。',
        en: 'Detected unused recurring cloud storage renewals; trimming renewals & delivery saves ~$420/yr.',
      },
    },
  },
  {
    id: 'data-store-sales',
    categoryId: HomeShowcaseCategoryId.DataAnalysis,
    filterTag: 'work',
    accent: ShowcaseAccent.Amber,
    title: { zh: '小店 / 电商销售与爆品复盘', en: 'Store & E-Commerce Sales Review' },
    subtitle: { zh: '时段热力 + 爆品/滞销品矩阵', en: 'Peak hours & SKU profit matrix' },
    badge: { zh: '含门店订单 CSV', en: 'Sample orders CSV' },
    description: {
      zh: '快速算出各 SKU 真实毛利、黄金营业时段与滞销拖累项，帮店主、运营和电商卖家一眼看清哪里最赚钱。',
      en: 'Calculates true SKU margins, peak-hour demand, and slow movers so operators spot profit drivers instantly.',
    },
    skillId: 'xlsx',
    acceptsUpload: true,
    uploadAccept: '.csv,.xlsx,.xls',
    uploadHint: { zh: '支持 POS 订单导出表、淘宝/抖音/拼多多销售明细表', en: 'Upload POS or e-commerce order exports (.csv / .xlsx)' },
    customSlot: {
      label: { zh: '想重点诊断的经营问题（可选）', en: 'Business question to focus on (optional)' },
      placeholder: { zh: '例如：帮我找出毛利最高的前 3 款产品，以及下午茶时段怎么拉升营收', en: 'e.g. Find top 3 margin drivers and how to boost afternoon sales' },
      demoValue: { zh: '复盘示例咖啡轻食门店订单数据，找出爆品、滞销品与排班优化建议', en: 'Review the sample cafe order dataset for hero SKUs, margins, and staffing' },
    },
    optionGroups: [DATA_OUTPUT_GROUP],
    demoPrompt: {
      zh: '请读取附件中的《门店销售订单示例（cafe-sales-sample.csv）》，完成一份经营复盘分析：\n1. 计算各商品与品类的总销售额、总毛利、毛利率，并排名前 3 爆品与后 2 滞销品\n2. 对比不同门店（国贸店 vs 望京店）与各时段（早高峰/午间/下午/晚间）的营收贡献\n3. 输出可落地的菜单精简、套餐搭配与排班备货建议，生成带公式 Excel 与可视化看板。',
      en: 'Analyze the attached store sales sample (cafe-sales-sample.csv):\n1. Compute revenue, gross profit, and margin per SKU; rank top 3 winners and bottom 2 laggards\n2. Compare store locations and dayparts (morning rush, lunch, afternoon, evening)\n3. Recommend menu pruning, bundles, and prep adjustments with charts and a workbook.',
    },
    customPromptTemplate: {
      zh: '请读取我上传的销售/订单数据，完成经营与爆品复盘：\n1. 按商品/品类统计销量、营收与毛利贡献（如无成本列则聚焦销量与客单价）\n2. 识别高峰时段、渠道/门店差异与异常波动\n3. 结合我的重点问题输出行动建议：{{input}}',
      en: 'Analyze my uploaded sales/order dataset:\n1. Rank SKU/category revenue, volume, and profit margins\n2. Break down peak hours, channels/locations, and anomalies\n3. Provide actionable merchandising recommendations for: {{input}}',
    },
    sampleFiles: [
      {
        name: 'cafe-sales-sample.csv',
        mimeType: 'text/csv',
        content: CAFE_SALES_CSV,
        previewLines: [
          { zh: '国贸店 · 早高峰 · 生椰拿铁 · 销量 86 · 销售额 ￥1,548', en: 'CBD Store · Morning · Coconut Latte · 86 sold · $1,548' },
          { zh: '望京店 · 午间 · 羽衣甘蓝果蔬茶 · 销量 56 · 销售额 ￥1,232', en: 'Tech Park · Lunch · Kale Tea · 56 sold · $1,232' },
          { zh: '晚间 · 桂花燕麦拿铁 · 销量 6 · 毛利率偏低', en: 'Evening · Osmanthus Oat Latte · 6 sold · low margin' },
          { zh: '共 16 条跨门店、跨时段示例订单汇总记录', en: '16 cross-store, multi-daypart order records' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DataDashboard,
      kicker: { zh: '门店经营复盘看板', en: 'RETAIL OPS DASHBOARD' },
      metrics: [
        { label: { zh: '样本营收', en: 'Revenue' }, value: '￥14,913', delta: '2 门店' },
        { label: { zh: '平均毛利率', en: 'Avg Margin' }, value: '67.2%', delta: '咖啡最高' },
        { label: { zh: '早高峰占比', en: 'Morning Share' }, value: '59%', delta: '核心时段' },
      ],
      bars: [
        { label: { zh: '生椰拿铁（TOP1）', en: 'Coconut Latte' }, percent: 94, valueText: '￥6,192' },
        { label: { zh: '冰美式（高毛利）', en: 'Iced Americano' }, percent: 58, valueText: '76.7% 毛利' },
        { label: { zh: '果蔬轻乳茶', en: 'Fruit & Tea' }, percent: 52, valueText: '￥3,163' },
        { label: { zh: '晚间特调（待淘汰）', en: 'Late Specials' }, percent: 15, valueText: '￥658' },
      ],
      insight: {
        zh: '早高峰贡献近 60% 流水；冰美式毛利高达 76.7%，建议淘汰晚间低动销特调并推“咖啡+可颂”组合。',
        en: 'Morning rush drives 59% of sales; iced espresso carries 76.7% margin—bundle pastries and prune slow evening SKUs.',
      },
    },
  },
  {
    id: 'data-multi-merge',
    categoryId: HomeShowcaseCategoryId.DataAnalysis,
    filterTag: 'utility',
    accent: ShowcaseAccent.Violet,
    title: { zh: '多份杂乱表格自动合并对账', en: 'Multi-Sheet Merge & Deduplicate' },
    subtitle: { zh: '不同表头智能对齐 + 去重标红', en: 'Align headers, deduplicate & flag' },
    badge: { zh: '含 2 份不同表头表', en: '2 mismatched CSVs' },
    description: {
      zh: '部门交上来的表列名五花八门、日期格式混乱还有重复提交？自动智能对齐合并、去重并标注每条数据来源。',
      en: 'Reconciles files with inconsistent column headers and date formats, strips duplicates, and adds a source-file column.',
    },
    skillId: 'xlsx',
    acceptsUpload: true,
    uploadAccept: '.csv,.xlsx,.xls',
    uploadHint: { zh: '支持一次选中上传多份 Excel / CSV 文件合并整理', en: 'Select multiple .xlsx or .csv files to merge & reconcile' },
    customSlot: {
      label: { zh: '补充合并规则或去重字段（可选）', en: 'Merge rules or duplicate key (optional)' },
      placeholder: { zh: '例如：按“姓名+日期+金额”判重，统一金额保留两位小数并按部门汇总', en: 'e.g. Deduplicate by person + date + amount, then summarize totals by department' },
      demoValue: { zh: '合并自带的 1 月与 2 月表头不统一的报销表，揪出重复报销并按部门汇总', en: 'Merge the bundled mismatched Jan & Feb expense sheets, flag duplicates, and sum by team' },
    },
    optionGroups: [DATA_OUTPUT_GROUP],
    demoPrompt: {
      zh: '请合并附件中的 2 份表头格式不一致的月度报销表（expenses-jan-sample.csv 与 expenses-feb-sample.csv）：\n1. 自动将“报销日期/提交时间”“申请人/员工姓名”“部门/所属团队”“费用类别/支出科目”“金额/报销金额(RMB)”等不同列名智能映射统一，日期标准化为 YYYY-MM-DD\n2. 排查并单独标注疑似重复提交记录（注意跨月相同申请人/金额/备注）\n3. 新增“数据来源文件”列，另建「部门与费用类别汇总」Sheet（带 SUMIF 公式）并输出整理报告。',
      en: 'Merge the two attached expense sheets with mismatched headers (expenses-jan-sample.csv and expenses-feb-sample.csv):\n1. Map mismatched columns and normalize dates to YYYY-MM-DD\n2. Flag suspected duplicate claims in a dedicated review tab\n3. Add a source-file column plus a department summary sheet with formulas.',
    },
    customPromptTemplate: {
      zh: '请合并并清洗我上传的多份表格文件：\n1. 自动对齐含义相同但写法不同的列名，统一日期与数值格式\n2. 识别并标出重复行、缺失值与格式异常\n3. 增加「来源文件」列并附汇总统计页；补充要求：{{input}}',
      en: 'Merge and clean my uploaded spreadsheets:\n1. Align semantically matching columns and standardize dates/numbers\n2. Highlight duplicate rows, blanks, and anomalies\n3. Add a source-file column and summary sheet; notes: {{input}}',
    },
    sampleFiles: [
      {
        name: 'expenses-jan-sample.csv',
        mimeType: 'text/csv',
        content: MERGE_JAN_CSV,
        previewLines: [
          { zh: '表1表头：报销日期 | 申请人 | 部门 | 费用类别 | 金额', en: 'Sheet 1 headers: Date | Applicant | Dept | Category | Amount' },
          { zh: '表2表头：提交时间 | 员工姓名 | 所属团队 | 支出科目 | 报销金额(RMB)', en: 'Sheet 2 headers: Submitted | Employee | Team | Expense | RMB' },
          { zh: '内含跨表格式差异（- vs /）与 1 条疑似重复报销项', en: 'Contains mismatched date formats and 1 suspected duplicate claim' },
        ],
      },
      {
        name: 'expenses-feb-sample.csv',
        mimeType: 'text/csv',
        content: MERGE_FEB_CSV,
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DataDashboard,
      kicker: { zh: '多表清洗与对账结果', en: 'RECONCILIATION SUMMARY' },
      metrics: [
        { label: { zh: '合并文件', en: 'Files Merged' }, value: '2 份', delta: '6 列对齐' },
        { label: { zh: '疑似重复', en: 'Duplicates' }, value: '1 条', delta: '已标红复核' },
        { label: { zh: '有效总额', en: 'Clean Total' }, value: '￥4,073', delta: '3 个部门' },
      ],
      bars: [
        { label: { zh: '市场部（3 笔）', en: 'Marketing (3)' }, percent: 88, valueText: '￥2,740' },
        { label: { zh: '研发部（2 笔）', en: 'Engineering (2)' }, percent: 44, valueText: '￥1,105' },
        { label: { zh: '产品部（去重后 2 笔）', en: 'Product (2)' }, percent: 18, valueText: '￥228' },
      ],
      insight: {
        zh: '自动对齐 5 组异名表头并标准化日期，同时揪出 1 条跨月重复的 ￥128.5 交通费报销待确认。',
        en: 'Aligned 5 mismatched header pairs, normalized dates, and caught 1 suspected duplicate $128.5 claim.',
      },
    },
  },
  {
    id: 'data-image-to-excel',
    categoryId: HomeShowcaseCategoryId.DataAnalysis,
    filterTag: 'utility',
    accent: ShowcaseAccent.Blue,
    title: { zh: '截图 / 纸质单据一键转 Excel', en: 'Screenshot & Photo to Excel' },
    subtitle: { zh: '识别表格 + 纠错 + 自动带公式', en: 'OCR extract, clean & add formulas' },
    badge: { zh: '职场高频救命', en: 'Time saver' },
    description: {
      zh: '微信群里的统计截图、纸质发票清单、体检报告或纸质成绩单，丢进来一键识别成规范可算公式的 Excel。',
      en: 'Turn chat screenshots, paper receipts, lab results, or printed tables into clean, formula-checked Excel sheets.',
    },
    skillId: 'xlsx',
    acceptsUpload: true,
    uploadAccept: 'image/png,image/jpeg,image/webp,.pdf',
    uploadHint: { zh: '上传包含表格的截图、照片或扫描 PDF（也支持多张合并）', en: 'Upload screenshots, photos, or scanned PDFs containing tables' },
    customSlot: {
      label: { zh: '需要额外计算的汇总项或格式要求（可选）', en: 'Extra summary formulas or formatting notes (optional)' },
      placeholder: { zh: '例如：提取全部明细行后，在底部自动加求和公式，并核对总金额是否与截图一致', en: 'e.g. Extract every row, add SUM formulas at the bottom, and verify against the printed total' },
      demoValue: { zh: '把杂乱的非结构化单据文本/扫描件解析为规范带公式的采购对账 Excel', en: 'Parse a messy receipt/invoice extract into a formula-verified Excel sheet' },
    },
    optionGroups: [DATA_OUTPUT_GROUP],
    demoPrompt: {
      zh: '请读取附件中的《模拟拍照识别原始杂乱采购单（ocr-raw-receipt-sample.txt）》，示范「单据识别整理为规范 Excel」完整流程：\n1. 从错位、缺单位的原始识别文本中准确提取序号、品名、规格、数量、单价与小计\n2. 用 Excel 公式重新验算每一行 `数量 * 单价` 与总计，标出原单据中存在的 1 处算术误差\n3. 输出排版清爽、可直接归档报销的 `.xlsx` 文件与验算说明。',
      en: 'Read the attached simulated messy OCR receipt extract (ocr-raw-receipt-sample.txt) and turn it into a clean Excel workbook:\n1. Parse misaligned rows into Item, Spec, Qty, Unit Price, and Subtotal\n2. Recompute every row and total with live Excel formulas, flagging the arithmetic mismatch in the raw receipt\n3. Output a polished `.xlsx` file plus a short audit note.',
    },
    customPromptTemplate: {
      zh: '请识别我上传的图片/PDF 中的所有表格数据并转为规范 Excel：\n1. 完整提取表头与所有行列数据，自动修复断行与识别错字\n2. 对小计、总计、占比等列写入真实 Excel 公式并交叉核对原图合计数\n3. 补充要求：{{input}}',
      en: 'Extract all tables from my uploaded image/PDF into a clean Excel file:\n1. Preserve all rows/columns and fix OCR line breaks or typos\n2. Replace totals and ratios with live Excel formulas and check against the source image\n3. Extra notes: {{input}}',
    },
    sampleFiles: [
      {
        name: 'ocr-raw-receipt-sample.txt',
        mimeType: 'text/plain',
        content: `【模拟手机拍照 OCR 原始识别结果 - 办公物料采购单】
日期: 2026年04月18日   门店: 晨光文具配送中心
1 A4打印纸70g 5箱 118元/箱 小计590
2 中性笔0.5mm黑 24盒  12.5元  300
3 便利贴四色装 30本 6.8  204
4 文件夹A4透明 40个 3.5元 小计150  <-- 原手写小计疑算错
5 白板笔套装 10盒 18元 180
原单据手写合计：1424元`,
        previewLines: [
          { zh: '1 A4打印纸70g 5箱 118元/箱 小计590', en: '1 A4 Paper 5 boxes @ 118 = 590' },
          { zh: '4 文件夹A4透明 40个 3.5元 小计150（待验算！）', en: '4 Folders 40 pcs @ 3.5 = 150 (check math!)' },
          { zh: '提取错位文本 → 规范带公式 Excel 并自动抓出错账', en: 'Unstructured OCR → formula-verified Excel flagging error' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DataDashboard,
      kicker: { zh: 'OCR 提取与公式验算', en: 'OCR EXTRACTION & AUDIT' },
      metrics: [
        { label: { zh: '提取明细', en: 'Rows Parsed' }, value: '5 项', delta: '6 列规范化' },
        { label: { zh: '原单错账', en: 'Math Error' }, value: '1 处', delta: '多算 ￥10' },
        { label: { zh: '验算实付', en: 'Verified Sum' }, value: '￥1,414', delta: '已含公式' },
      ],
      bars: [
        { label: { zh: 'A4 打印纸（5 箱）', en: 'A4 Paper (5)' }, percent: 90, valueText: '￥590' },
        { label: { zh: '中性笔（24 盒）', en: 'Gel Pens (24)' }, percent: 48, valueText: '￥300' },
        { label: { zh: '便利贴与白板笔', en: 'Notes & Markers' }, percent: 60, valueText: '￥384' },
        { label: { zh: '文件夹（已纠偏 ￥140）', en: 'Folders (Fixed)' }, percent: 24, valueText: '￥140' },
      ],
      insight: {
        zh: '不仅完成表格还原，公式验算自动抓出第 4 行 40×3.5 应为 ￥140（原手写误计 ￥150）。',
        en: 'Formula audit caught a $10 overcharge on row 4 (40 × 3.5 = 140, not 150).',
      },
    },
  },
  {
    id: 'data-decision-matrix',
    categoryId: HomeShowcaseCategoryId.DataAnalysis,
    filterTag: 'life',
    accent: ShowcaseAccent.Teal,
    title: { zh: '租房 / 买车 / 家电加权比价表', en: 'Weighted Rent / Purchase Scorer' },
    subtitle: { zh: '自定义权重打分 + 性价比排行', en: 'Custom weights & value ranking' },
    badge: { zh: '含 6 套租房示例', en: '6 listings CSV' },
    description: {
      zh: '看了一堆备选房源、车型或装修报价选花眼？按你最在乎的权重自动量化打分，画出性价比象限一眼选定。',
      en: 'Scores shortlisted apartments, cars, or quotes using your personal priorities and maps price vs quality.',
    },
    skillId: 'xlsx',
    acceptsUpload: true,
    uploadAccept: '.csv,.xlsx,.txt,.md',
    uploadHint: { zh: '可上传你自己记的备选房源/车型/报价清单', en: 'Upload your shortlist spreadsheet or notes' },
    customSlot: {
      label: { zh: '你最看重的权重偏好（例如：通勤 40%、租金 35%、采光 25%）', en: 'Your priority weights (e.g. Commute 40%, Rent 35%, Light 25%)' },
      placeholder: { zh: '例如：预算不超过 5500 元，通勤时间最重要（40%），其次采光（30%）和租金（30%）', en: 'e.g. Budget max $2,200, commute 40%, natural light 30%, rent 30%' },
      demoValue: { zh: '按通勤 35% + 租金 30% + 采光 20% + 面积 15%，给自带 6 套备选房源量化打分排行', en: 'Score the 6 bundled apartment listings using weighted commute, rent, light, and size' },
    },
    optionGroups: [DATA_OUTPUT_GROUP],
    demoPrompt: {
      zh: '请读取附件中的《备选租房清单（rent-options-sample.csv）》，构建一套量化决策模型：\n1. 按权重「通勤时间 35% + 月租金 30% + 采光评分 20% + 实用面积 15%」对 6 套房源标准化打分（预算红线 5,600 元以上标黄提醒）\n2. 计算每套房源的每平米单价与“每省 10 分钟通勤多付多少租金”\n3. 输出带可调权重公式的 Excel 与性价比散点可视化看板，明确推荐前 2 套复看房源与砍价要点。',
      en: 'Build a weighted scoring model for the attached rental shortlist (rent-options-sample.csv):\n1. Score all 6 apartments using Commute 35%, Rent 30%, Natural Light 20%, Area 15% (flagging options over budget)\n2. Compute price-per-sqm and commute-time trade-offs\n3. Deliver a formula-driven Excel sheet and visual shortlist ranking with top 2 picks.',
    },
    customPromptTemplate: {
      zh: '请基于我提供的备选清单建立量化加权打分与性价比对比分析：\n1. 按我的偏好权重对所有备选项做归一化打分并排名：{{input}}\n2. 标出超预算红线与硬伤项\n3. 输出可动态调整权重的 Excel 表格与清晰推荐结论。',
      en: 'Build a weighted comparison and ranking from my uploaded shortlist:\n1. Normalize and score all options based on my priorities: {{input}}\n2. Flag budget violations or deal-breakers\n3. Deliver an editable formula Excel sheet and clear top-2 recommendation.',
    },
    sampleFiles: [
      {
        name: 'rent-options-sample.csv',
        mimeType: 'text/csv',
        content: RENT_COMPARE_CSV,
        previewLines: [
          { zh: '阳光雅苑3栋 · 望京 · ￥5400 · 通勤24分 · 采光9分', en: 'Sunny Court #3 · $5,400 · 24 min commute · Light 9/10' },
          { zh: '林荫花园2期 · 酒仙桥 · ￥4600 · 通勤36分 · 南北通透', en: 'Green Garden · $4,600 · 36 min commute · Bright' },
          { zh: '共 6 套真实感备选房源，含租金、通勤、距地铁与缺点备注', en: '6 realistic apartment candidates with rent, commute & caveats' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DataDashboard,
      kicker: { zh: '备选房源量化打分', en: 'DECISION MATRIX' },
      metrics: [
        { label: { zh: '综合第 1', en: '#1 Overall' }, value: '阳光雅苑', delta: '88.4 分' },
        { label: { zh: '性价比之王', en: 'Best Value' }, value: '林荫花园', delta: '￥79/㎡' },
        { label: { zh: '直接排除', en: 'Eliminated' }, value: '2 套', delta: '超预算/商水电' },
      ],
      bars: [
        { label: { zh: '阳光雅苑 3 栋（推荐）', en: 'Sunny Court #3' }, percent: 92, valueText: '88.4 分' },
        { label: { zh: '林荫花园 2 期（备选）', en: 'Green Garden' }, percent: 81, valueText: '82.1 分' },
        { label: { zh: '科创里小区', en: 'Kechuang Li' }, percent: 70, valueText: '74.5 分' },
        { label: { zh: '青年 Loft（商水电）', en: 'Youth Loft' }, percent: 44, valueText: '56.2 分' },
      ],
      insight: {
        zh: '阳光雅苑 3 栋在预算内实现通勤与采光最佳平衡，建议带同片区均价优先去谈 200 元月租优惠。',
        en: 'Sunny Court #3 hits the best commute-to-light balance within budget; ideal first pick for negotiation.',
      },
    },
  },
  {
    id: 'data-social-creator',
    categoryId: HomeShowcaseCategoryId.DataAnalysis,
    filterTag: 'work',
    accent: ShowcaseAccent.Rose,
    title: { zh: '自媒体 / 小红书爆款数据复盘', en: 'Creator Content Analytics' },
    subtitle: { zh: '爆款选题特征 + 最佳发文时段', en: 'Viral hooks & best posting slots' },
    badge: { zh: '含示例笔记数据', en: 'Sample posts CSV' },
    description: {
      zh: '拆解账号历史笔记/视频的曝光、收藏率与转粉效率，用数据找出真正能涨粉的选题模板与发布时间。',
      en: 'Breaks down views, save rates, and follower conversion to uncover winning content formats and posting windows.',
    },
    skillId: 'xlsx',
    acceptsUpload: true,
    uploadAccept: '.csv,.xlsx',
    uploadHint: { zh: '可上传小红书、B 站、抖音或公众号后台导出的内容明细表', en: 'Upload exported post metrics from your creator studio' },
    customSlot: {
      label: { zh: '账号赛道与当前最想提升的指标（可选）', en: 'Your niche & target metric (optional)' },
      placeholder: { zh: '例如：职场效率/家居生活博主，重点想提升收藏转粉率并规划下月 8 个选题', en: 'e.g. Productivity creator looking to boost save-to-follow conversion and plan next 8 posts' },
      demoValue: { zh: '分析自带的 8 篇生活效率账号样本数据，拆解爆款规律并生成下阶段选题建议', en: 'Analyze the bundled creator metrics CSV to spot viral patterns and plan next posts' },
    },
    optionGroups: [DATA_OUTPUT_GROUP],
    demoPrompt: {
      zh: '请读取附件中的《自媒体内容数据示例（creator-posts-sample.csv）》，做一次创作者数据复盘：\n1. 为每条内容计算互动率、收藏/曝光比、千次曝光涨粉数，找出表现最好的 3 类题材\n2. 对比不同发布时段（午间 vs 晚间 20:00 后）的流量与涨粉差异\n3. 提炼爆款标题共性，并直接给出一份下周 5 条高潜力选题与标题参考表。',
      en: 'Analyze the attached creator metrics sample (creator-posts-sample.csv):\n1. Compute engagement rate, save rate, and follows per 1k views across content formats\n2. Compare posting times (midday vs evening) on reach and conversion\n3. Extract winning hook patterns and propose 5 high-potential topics for next week.',
    },
    customPromptTemplate: {
      zh: '请读取我上传的内容运营数据并完成爆款复盘：\n1. 计算互动率、收藏率与涨粉转化率，找出头部与尾部内容的差异特征\n2. 分析最佳发布时间与高转化题材\n3. 结合我的诉求输出下阶段选题与标题建议：{{input}}',
      en: 'Analyze my uploaded content analytics dataset:\n1. Calculate engagement, save, and follower conversion rates by format\n2. Identify peak posting times and winning hooks\n3. Propose next content ideas tailored to: {{input}}',
    },
    sampleFiles: [
      {
        name: 'creator-posts-sample.csv',
        mimeType: 'text/csv',
        content: SOCIAL_CONTENT_CSV,
        previewLines: [
          { zh: '20:30 · 月薪1万怎么分配攒钱最快（附表） · 曝光 13.8万 · 涨粉 1620', en: '20:30 · Budget Template Guide · 138k views · +1,620 follows' },
          { zh: '21:00 · 租房5年踩过的8个隐形坑避雷 · 曝光 11.2万 · 涨粉 1240', en: '21:00 · 8 Rental Pitfalls · 112k views · +1,240 follows' },
          { zh: '对比干货清单、避坑指南、前后对比与随拍日常 4 类题材', en: 'Compares checklists, pitfall guides, makeovers & daily vlogs' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DataDashboard,
      kicker: { zh: '创作者爆款归因看板', en: 'CREATOR GROWTH BOARD' },
      metrics: [
        { label: { zh: '最高转粉', en: 'Top Convert' }, value: '11.7‰', delta: '干货模板类' },
        { label: { zh: '黄金时段', en: 'Prime Slot' }, value: '20–21点', delta: '曝光高 6×' },
        { label: { zh: '平均收藏率', en: 'Save Rate' }, value: '6.1%', delta: '工具/清单优' },
      ],
      bars: [
        { label: { zh: '干货模板（附表）', en: 'Templates' }, percent: 96, valueText: '13.8W 曝光' },
        { label: { zh: '避坑指南清单', en: 'Pitfall Lists' }, percent: 82, valueText: '11.2W 曝光' },
        { label: { zh: '前后改造对比', en: 'Makeovers' }, percent: 70, valueText: '9.5W 曝光' },
        { label: { zh: '随拍日常 Vlog', en: 'Casual Vlogs' }, percent: 12, valueText: '0.5W 曝光' },
      ],
      insight: {
        zh: '晚间 20:00–21:00 发布的“数字清单/避坑/附模板”收藏率最高，建议压缩纯日常随拍占比。',
        en: '8–9 PM numbered guides & templates drive 6× reach and peak saves—shift cadence toward actionable checklists.',
      },
    },
  },
  {
    id: 'data-student-grades',
    categoryId: HomeShowcaseCategoryId.DataAnalysis,
    filterTag: 'life',
    accent: ShowcaseAccent.Blue,
    title: { zh: '成绩单趋势与薄弱科诊断', en: 'Exam Score Trend & Diagnosis' },
    subtitle: { zh: '各科进退步曲线 + 提分建议', en: 'Subject trends & study focus' },
    badge: { zh: '老师/家长/学生', en: 'Education' },
    description: {
      zh: '直观追踪多次月考/期中期末各科起伏，一眼识别拉分薄弱科与提分最快抓手，输出清晰诊断报告。',
      en: 'Tracks multi-exam score progression across subjects, isolates bottlenecks, and builds a targeted study plan.',
    },
    skillId: 'xlsx',
    acceptsUpload: true,
    uploadAccept: '.csv,.xlsx',
    uploadHint: { zh: '支持个人历次成绩表或全班成绩汇总表', en: 'Upload individual exam history or full class score sheets' },
    customSlot: {
      label: { zh: '年级阶段与目标分数（可选）', en: 'Grade level & target score (optional)' },
      placeholder: { zh: '例如：高二理科，下学期想冲击总分 560+，请帮我制定寒假薄弱科提分计划', en: 'e.g. Grade 11 student targeting 560+, focus study plan on weakest subjects' },
      demoValue: { zh: '分析自带的 4 次月考成绩示例，诊断偏科情况并生成针对性提分计划', en: 'Diagnose the bundled 4-exam score CSV and create a focused study plan' },
    },
    optionGroups: [DATA_OUTPUT_GROUP],
    demoPrompt: {
      zh: '请读取附件中的《学生历次月考成绩示例（student-scores-sample.csv）》，完成学业诊断分析：\n1. 绘制总分、班级排名与各单科 4 次考试的变化趋势表与进退步幅度\n2. 识别进步最快的优势学科（数学）和持续停滞的短板学科（物理）\n3. 估算各科的现实提分空间，给出一份为期 4 周的周度复习时间分配与提分建议。',
      en: 'Analyze the attached exam history sample (student-scores-sample.csv):\n1. Chart total score, rank, and subject-by-subject progression across 4 exams\n2. Highlight fastest-improving strengths and stalled bottlenecks\n3. Estimate realistic score upside per subject and output a 4-week study plan.',
    },
    customPromptTemplate: {
      zh: '请读取我上传的成绩数据并完成趋势与薄弱项诊断：\n1. 统计各科走势、强弱科分布与排名变化\n2. 定位提分性价比最高的突破口\n3. 结合我的目标输出针对性复习计划：{{input}}',
      en: 'Analyze my uploaded exam score sheet:\n1. Visualize subject trends, strengths, and rank movement\n2. Pinpoint highest-leverage subjects for score gains\n3. Build a targeted study plan for: {{input}}',
    },
    sampleFiles: [
      {
        name: 'student-scores-sample.csv',
        mimeType: 'text/csv',
        content: STUDENT_SCORES_CSV,
        previewLines: [
          { zh: '9月月考总分 482（排名 21） → 12月期末 525（排名 9）', en: 'Sep: 482 (Rank #21) → Dec: 525 (Rank #9)' },
          { zh: '数学连涨 +23 分，物理停留在 69–74 分区间待突破', en: 'Math jumped +23 pts; Physics plateaued at 69–74' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DataDashboard,
      kicker: { zh: '学业趋势诊断看板', en: 'SCORE PROGRESSION' },
      metrics: [
        { label: { zh: '总分净涨', en: 'Total Gain' }, value: '+43 分', delta: '4 次考' },
        { label: { zh: '班级排名', en: 'Class Rank' }, value: '第 9 名', delta: '进 12 位' },
        { label: { zh: '核心短板', en: 'Bottleneck' }, value: '物理', delta: '停滞 71 分' },
      ],
      bars: [
        { label: { zh: '数学（进步最快）', en: 'Math (+23)' }, percent: 94, valueText: '96 → 119' },
        { label: { zh: '英语（稳定领跑）', en: 'English (+7)' }, percent: 88, valueText: '124 → 131' },
        { label: { zh: '化学（稳步提升）', en: 'Chemistry (+8)' }, percent: 76, valueText: '78 → 86' },
        { label: { zh: '物理（重点突破）', en: 'Physics (-1)' }, percent: 48, valueText: '72 → 71' },
      ],
      insight: {
        zh: '数学 4 个月提分 23 分带动排名跃升 12 位；下阶段把 40% 复习时间倾斜至物理力学与电学基础题最易再涨 15+ 分。',
        en: 'Math (+23) drove a 12-rank jump; shifting 40% of review time to Physics fundamentals unlocks +15 pts fastest.',
      },
    },
  },
  {
    id: 'data-portfolio-check',
    categoryId: HomeShowcaseCategoryId.DataAnalysis,
    filterTag: 'life',
    accent: ShowcaseAccent.Indigo,
    title: { zh: '基金 / 持仓体检与风险分布', en: 'Portfolio Allocation & Risk Check' },
    subtitle: { zh: '资产配比 + 回撤压力 + 集中度', en: 'Asset mix, drawdown & risk' },
    badge: { zh: '理财复盘示例', en: 'Sample portfolio' },
    description: {
      zh: '盘点股债/宽基/行业持仓比例、真实收益率与最大回撤风险，帮助普通投资者看清资产配置是否失衡（不构成投资建议）。',
      en: 'Audits equity/bond allocation, returns, dividend yield, and drawdown concentration (informational, not financial advice).',
    },
    skillId: 'xlsx',
    acceptsUpload: true,
    uploadAccept: '.csv,.xlsx',
    uploadHint: { zh: '可上传脱敏后的基金/股票持仓汇总表', en: 'Upload your anonymized portfolio holdings CSV/Excel' },
    customSlot: {
      label: { zh: '你的风险偏好与投资期限（可选）', en: 'Risk tolerance & horizon (optional)' },
      placeholder: { zh: '例如：稳健平衡型，3 年以上闲钱投资，希望单年最大回撤控制在 10% 以内', en: 'e.g. Balanced risk, 3+ year horizon, target max annual drawdown under 10%' },
      demoValue: { zh: '对自带的 15 万元多元基金持仓示例做资产配比、收益与回撤风险体检', en: 'Audit the bundled $150k multi-asset ETF/fund sample for allocation and drawdown risk' },
    },
    optionGroups: [DATA_OUTPUT_GROUP],
    demoPrompt: {
      zh: '请读取附件中的《个人基金持仓示例（portfolio-sample.csv）》，做一次清晰的资产配置体检：\n1. 计算总投入、当前总市值、各标的盈亏额、收益率、持仓占比与现金分红贡献\n2. 分析股/债大类配比与高波动行业基金的集中度风险，做一轮简易压力测试（若权益资产回调 15% 的影响）\n3. 给出客观的再平衡思路与风险提示（明确标注示例数据且不构成具体投资买卖建议）。',
      en: 'Audit the attached sample portfolio (portfolio-sample.csv):\n1. Compute total cost basis, market value, return %, allocation weights, and dividend income\n2. Assess equity/bond balance, concentration risk, and a simple -15% equity stress test\n3. Summarize rebalancing concepts objectively (clearly noting this is informational, not investment advice).',
    },
    customPromptTemplate: {
      zh: '请读取我上传的持仓明细表并完成资产配置体检：\n1. 汇总总收益、各资产类别占比与单标的集中度\n2. 评估回撤暴露并做基础波动压力测试\n3. 结合我的风险偏好给出客观的资产配置优化思路（非具体买卖建议）：{{input}}',
      en: 'Audit my uploaded portfolio spreadsheet:\n1. Summarize total return, asset-class weights, and concentration\n2. Evaluate drawdown exposure with a basic stress test\n3. Outline objective rebalancing considerations for: {{input}}',
    },
    sampleFiles: [
      {
        name: 'portfolio-sample.csv',
        mimeType: 'text/csv',
        content: PORTFOLIO_CSV,
        previewLines: [
          { zh: '沪深300ETF ￥40,000 → ￥43,600 · 纳指100ETF ￥30,000 → ￥35,400', en: 'Broad Equity ETFs +$9,000 · Short Bond Fund steady' },
          { zh: '短债基金占 23% 稳底，科技主题基金回撤 -24.6%', en: '23% short-term bonds anchor risk; Tech theme -24.6% DD' },
        ],
      },
    ],
    preview: {
      kind: ShowcasePreviewKind.DataDashboard,
      kicker: { zh: '资产配置健康体检', en: 'PORTFOLIO HEALTH CHECK' },
      metrics: [
        { label: { zh: '总收益率', en: 'Total Return' }, value: '+8.49%', delta: '含分红' },
        { label: { zh: '股债比例', en: 'Equity/Bond' }, value: '77 / 23', delta: '偏成长' },
        { label: { zh: '年度分红', en: 'Dividends' }, value: '￥2,710', delta: '红利贡献大' },
      ],
      bars: [
        { label: { zh: '宽基指数（沪深+纳指）', en: 'Broad Index' }, percent: 88, valueText: '49.4%' },
        { label: { zh: '短债稳健底仓', en: 'Short Bonds' }, percent: 45, valueText: '22.6%' },
        { label: { zh: '红利低波资产', en: 'Dividend Low-Vol' }, percent: 34, valueText: '16.9%' },
        { label: { zh: '高波动科技主题', en: 'Tech Thematic' }, percent: 22, valueText: '11.1%' },
      ],
      insight: {
        zh: '组合整体正收益且有宽基+短债压舱；科技主题单只回撤达 -24.6%，建议控制单行业仓位不超过 10%。',
        en: 'Broad index + short bonds keep net return positive; cap single thematic funds near 10% to limit drawdown.',
      },
    },
  },
];
