import { EXTRA_ENTERPRISE_EXPERT_TEAM_DEFINITIONS } from './enterpriseExpertTeams';
import { INDUSTRY_EXPERT_TEAM_DEFINITIONS } from './industryExpertTeams';

export type ExpertTeamCategory =
  | 'function'
  | 'platform'
  | 'ecommerce'
  | 'crossBorder'
  | 'finance'
  | 'healthcare'
  | 'logistics'
  | 'tech'
  | 'content'
  | 'marketing'
  | 'legal'
  | 'education'
  | 'design'
  | 'hr'
  | 'mysticism';

export interface PromptSet {
  primary: string;
  examples: [string, string, string];
}

export interface ExpertRoleAvatarHints {
  templateIds: string[];
  keywords: string[];
  category: ExpertTeamCategory;
}

export interface ExpertRoleDefinition {
  key: string;
  name: string;
  description: string;
  systemPrompt: string;
  skillIds: string[];
  avatarHints: ExpertRoleAvatarHints;
}

export interface ExpertTeamDefinition {
  id: string;
  version: number;
  name: string;
  description: string;
  category: ExpertTeamCategory;
  tags: string[];
  legacyNames: string[];
  lead: ExpertRoleDefinition;
  roles: ExpertRoleDefinition[];
  prompts: PromptSet;
}

export interface ExpertTeamRuntimeRole extends ExpertRoleDefinition {
  runtimeAgentId: string;
  avatar: string;
}

export interface ExpertTeamInstanceConfig {
  schemaVersion: 1;
  definitionId: string;
  definitionVersion: number;
  name: string;
  lead: ExpertTeamRuntimeRole;
  roles: ExpertTeamRuntimeRole[];
  prompts: PromptSet;
}

const role = (
  key: string,
  name: string,
  description: string,
  skillIds: string[],
  category: ExpertTeamCategory,
  templateIds: string[],
  keywords: string[],
): ExpertRoleDefinition => ({
  key,
  name,
  description,
  systemPrompt: [
    `你是专家团中的${name}。`,
    `你的职责是：${description}`,
    '只处理与你职责直接相关的工作；信息不足时明确列出需要补充的材料。',
    '先给结论和关键依据，再给可执行步骤、风险与待确认项。',
    '完成后把结构化结果交还主理人，不越权代表整个专家团作最终决策。',
  ].join('\n'),
  skillIds,
  avatarHints: { templateIds, keywords, category },
});

const lead = (
  key: string,
  name: string,
  description: string,
  category: ExpertTeamCategory,
  templateIds: string[],
  keywords: string[],
): ExpertRoleDefinition => role(key, name, description, [], category, templateIds, keywords);

export const EXPERT_TEAM_DEFINITIONS: ExpertTeamDefinition[] = [
  {
    id: 'software-development',
    version: 1,
    name: '软件开发专家团',
    description: '从需求澄清、产品设计、技术架构、研发测试到上线交付的完整软件团队。',
    category: 'tech',
    tags: ['需求梳理', '全栈开发', '测试交付'],
    legacyNames: ['产品交付专家团'],
    lead: lead(
      'delivery_director',
      '交付总监',
      '拆解目标、选择成员、控制质量并整合最终交付。',
      'tech',
      ['project-manager'],
      ['项目', '交付', '总监'],
    ),
    roles: [
      role(
        'product_manager',
        '产品经理',
        '完成需求访谈、范围定义、优先级、PRD 与验收标准。',
        ['create-plan', 'docx'],
        'function',
        ['project-manager'],
        ['产品经理', '产品', '需求'],
      ),
      role(
        'solution_architect',
        '技术架构师',
        '设计系统边界、技术选型、接口、数据模型和非功能要求。',
        ['web-search'],
        'tech',
        [],
        ['架构', '技术', '开发'],
      ),
      role(
        'frontend_engineer',
        '前端工程师',
        '实现交互界面、组件、状态管理、可访问性和前端质量。',
        ['frontend-design', 'playwright'],
        'tech',
        [],
        ['前端', 'UI', '开发'],
      ),
      role(
        'backend_engineer',
        '后端工程师',
        '实现服务、接口、数据存储、鉴权及稳定性方案。',
        ['local-tools', 'web-search'],
        'tech',
        [],
        ['后端', '服务端', '开发'],
      ),
      role(
        'qa_engineer',
        '测试工程师',
        '制定测试策略，覆盖单元、集成、端到端与回归验收。',
        ['playwright'],
        'tech',
        [],
        ['测试', 'QA', '质量'],
      ),
      role(
        'devops_engineer',
        '运维工程师',
        '负责部署、环境、可观测性、发布回滚和运行保障。',
        ['local-tools'],
        'tech',
        [],
        ['运维', '部署', '云'],
      ),
    ],
    prompts: {
      primary: '我想从零开发一个可上线的产品，请先帮我澄清需求并安排产品、架构、开发、测试与交付。',
      examples: [
        '帮我开发一个团队协作工具，先完成需求拆解、架构设计和首期开发计划。',
        '请评审我现有的软件项目，找出架构、代码质量、测试和部署风险。',
        '我要在两周内交付一个 MVP，请安排最小团队、任务分工和验收节点。',
      ],
    },
  },
  {
    id: 'enterprise-legal',
    version: 1,
    name: '企业法务专家团',
    description: '覆盖合同、治理并购、用工、隐私数据、产品合规、监管与 AI 治理。',
    category: 'legal',
    tags: ['企业法务', '合同与交易', '合规诊断'],
    legacyNames: ['企业合规专家团'],
    lead: lead(
      'legal_director',
      '法务协同总监',
      '识别法律议题、分派专业审查并形成分级风险结论。',
      'legal',
      ['legal-compliance'],
      ['法务', '合规', '总监'],
    ),
    roles: [
      role(
        'commercial_contract_counsel',
        '商业合同顾问',
        '审阅商业合同、交易条款、责任边界和谈判方案。',
        ['docx', 'pdf'],
        'legal',
        ['legal-compliance'],
        ['合同', '法务', '顾问'],
      ),
      role(
        'corporate_mna_counsel',
        '公司治理与并购顾问',
        '处理公司治理、股权、投融资、并购及尽调事项。',
        ['docx', 'web-search'],
        'legal',
        [],
        ['并购', '公司法', '股权'],
      ),
      role(
        'employment_counsel',
        '雇佣法务顾问',
        '处理招聘、劳动合同、绩效、离职和劳动争议风险。',
        ['docx', 'web-search'],
        'hr',
        ['hr-recruiter'],
        ['劳动', '雇佣', 'HR'],
      ),
      role(
        'privacy_counsel',
        '隐私数据顾问',
        '评估个人信息、数据流转、授权、跨境和安全合规。',
        ['web-search'],
        'legal',
        [],
        ['隐私', '数据', '安全'],
      ),
      role(
        'product_counsel',
        '产品法务顾问',
        '审查产品规则、用户协议、营销宣传和消费者权益风险。',
        ['docx', 'web-search'],
        'legal',
        [],
        ['产品法务', '用户协议', '合规'],
      ),
      role(
        'regulatory_counsel',
        '监管合规顾问',
        '跟踪适用监管要求并制定牌照、报告和整改清单。',
        ['web-search'],
        'legal',
        [],
        ['监管', '合规', '政策'],
      ),
      role(
        'ai_governance_counsel',
        'AI 治理顾问',
        '评估算法、模型数据、内容安全、知识产权和 AI 治理责任。',
        ['web-search'],
        'legal',
        [],
        ['AI 治理', '算法', '知识产权'],
      ),
    ],
    prompts: {
      primary:
        '请对我们的业务方案做一次跨合同、隐私、用工和监管的法务体检，并给出风险优先级和整改清单。',
      examples: [
        '请组织合同、隐私和产品法务一起审查这份 SaaS 合作方案。',
        '我们准备引入生成式 AI 功能，请梳理数据、内容、知识产权和监管风险。',
        '请为一次公司并购设计法务尽调范围、重点问题和交割前条件。',
      ],
    },
  },
  {
    id: 'a-share-research',
    version: 1,
    name: 'A股全链路研究团队',
    description: '从宏观、市场、产业、公司、估值、资金行为到风险诊断的完整研究链路。',
    category: 'finance',
    tags: ['A股研究', '估值定价', '宏观策略'],
    legacyNames: [],
    lead: lead(
      'research_director',
      '研究总监',
      '制定研究框架、校验事实来源并综合形成投资研究结论。',
      'finance',
      ['stockexpert'],
      ['研究', '股票', '总监'],
    ),
    roles: [
      role(
        'macro_strategist',
        '宏观策略师',
        '分析宏观周期、政策、利率、汇率和资产风格影响。',
        ['stock-explorer', 'web-search'],
        'finance',
        ['stockexpert'],
        ['宏观', '策略', '股票'],
      ),
      role(
        'market_interpreter',
        '市场解读师',
        '解读市场行情、公告事件、板块轮动和情绪变化。',
        ['stock-announcements', 'web-search'],
        'finance',
        ['stockexpert'],
        ['市场', '行情', '股票'],
      ),
      role(
        'equity_analyst',
        '个股研究员',
        '研究公司业务、竞争力、财务质量、催化剂与关键假设。',
        ['stock-analyzer', 'stock-explorer'],
        'finance',
        ['stockexpert', 'financial-report-reader'],
        ['个股', '公司', '财报'],
      ),
      role(
        'valuation_analyst',
        '估值定价师',
        '建立估值框架、情景假设、可比公司和敏感性分析。',
        ['stock-analyzer', 'xlsx'],
        'finance',
        ['financial-report-reader'],
        ['估值', '财务', '定价'],
      ),
      role(
        'industry_analyst',
        '产业链分析师',
        '研究产业链结构、供需、竞争格局和上下游传导。',
        ['stock-explorer', 'web-search'],
        'finance',
        [],
        ['产业链', '行业', '研究'],
      ),
      role(
        'capital_flow_analyst',
        '资金行为分析师',
        '观察资金结构、成交、持仓和行为信号。',
        ['stock-explorer', 'xlsx'],
        'finance',
        [],
        ['资金', '量化', '交易'],
      ),
      role(
        'risk_diagnostician',
        '风险诊断师',
        '识别公告、财务、治理、估值和交易层面的下行风险。',
        ['stock-announcements', 'stock-analyzer'],
        'finance',
        ['risk-assessment'],
        ['风险', '股票', '诊断'],
      ),
    ],
    prompts: {
      primary:
        '请围绕我关注的 A 股标的，组织一份从宏观、行业、公司、估值、资金到风险的完整研究框架。',
      examples: [
        '请对这只 A 股做一次全链路研究，并明确需要我补充的股票代码和持有周期。',
        '请分析一个行业板块近期上涨的宏观、产业和资金驱动因素。',
        '请复核这家公司的财报质量、估值假设、公告风险和主要反方观点。',
      ],
    },
  },
  {
    id: 'content-growth',
    version: 1,
    name: '内容增长专家团',
    description: '把选题、品牌表达、搜索增长、视觉策划、渠道运营和数据复盘串成闭环。',
    category: 'content',
    tags: ['内容策划', '品牌表达', '增长运营'],
    legacyNames: ['内容品牌专家团'],
    lead: lead(
      'content_growth_director',
      '内容增长总监',
      '确定增长目标、编排内容链路并统一品牌与渠道结果。',
      'content',
      ['content-writer'],
      ['内容', '增长', '总监'],
    ),
    roles: [
      role(
        'topic_planner',
        '选题策划',
        '研究受众、热点和竞争内容，形成选题池与内容日历。',
        ['content-planner', 'daily-trending'],
        'content',
        ['content-writer'],
        ['选题', '内容', '策划'],
      ),
      role(
        'brand_copywriter',
        '品牌文案',
        '撰写符合品牌语气的文章、活动、产品和社媒文案。',
        ['article-writer', 'web-search'],
        'content',
        ['content-writer', 'product-copy-optimizer'],
        ['文案', '品牌', '写作'],
      ),
      role(
        'search_growth_researcher',
        'SEO/GEO 研究员',
        '研究搜索意图、关键词、内容结构和生成式搜索引用机会。',
        ['web-search'],
        'marketing',
        [],
        ['SEO', 'GEO', '搜索'],
      ),
      role(
        'visual_planner',
        '视觉策划',
        '制定封面、配图、信息层级和视觉内容生产方案。',
        ['canvas-design', 'seedream'],
        'design',
        [],
        ['视觉', '设计', '封面'],
      ),
      role(
        'channel_operator',
        '渠道运营',
        '制定渠道适配、发布节奏、互动动作和内容复用策略。',
        ['content-planner', 'daily-trending'],
        'marketing',
        ['wechat-official-assistant', 'xiaohongshu-assistant'],
        ['渠道', '运营', '公众号'],
      ),
      role(
        'growth_analyst',
        '数据复盘',
        '定义内容指标，分析曝光、互动、转化和迭代方向。',
        ['xlsx'],
        'marketing',
        ['data-analysis'],
        ['数据', '增长', '复盘'],
      ),
    ],
    prompts: {
      primary:
        '请围绕我们的产品制定一个 30 天内容增长计划，覆盖选题、文案、视觉、渠道分发和数据复盘。',
      examples: [
        '请为一款新产品设计从选题到发布复盘的首月内容增长战役。',
        '请分析我们的现有内容，并给出品牌表达、SEO/GEO 和渠道分发改进方案。',
        '请把一个长篇行业报告拆成公众号、小红书和短视频三套内容。',
      ],
    },
  },
  {
    id: 'customer-operations',
    version: 1,
    name: '客户经营专家团',
    description: '协同销售、客服、客户成功、订单、私域和数据分析，覆盖客户全生命周期。',
    category: 'marketing',
    tags: ['客户经营', '销售协同', '复购增长'],
    legacyNames: ['客户增长专家团'],
    lead: lead(
      'customer_operations_director',
      '客户经营总监',
      '设计客户旅程、选择角色并协调从线索到复购的动作。',
      'marketing',
      ['customer-support'],
      ['客户', '经营', '总监'],
    ),
    roles: [
      role(
        'support_advisor',
        '客服支持顾问',
        '梳理问题分类、回复策略、升级规则和知识库沉淀。',
        ['web-search'],
        'function',
        ['customer-support'],
        ['客服', '支持', '顾问'],
      ),
      role(
        'sales_advisor',
        '销售顾问',
        '设计线索判断、需求发现、方案沟通和成交推进材料。',
        ['docx'],
        'marketing',
        ['advisor-script'],
        ['销售', '顾问', '成交'],
      ),
      role(
        'customer_success_manager',
        '客户成功经理',
        '制定上线、价值实现、健康度、续约和流失挽回计划。',
        ['create-plan'],
        'function',
        ['project-manager'],
        ['客户成功', '项目', '经理'],
      ),
      role(
        'order_operator',
        '订单运营专员',
        '分析订单流程、履约异常、服务衔接和运营规则。',
        ['xlsx'],
        'ecommerce',
        ['after-sales-ticket'],
        ['订单', '售后', '运营'],
      ),
      role(
        'private_domain_operator',
        '私域运营顾问',
        '规划客户分层、企微触达、社群互动和复购运营。',
        ['wecomcli-msg', 'wecomcli-contact'],
        'platform',
        [],
        ['私域', '企微', '运营'],
      ),
      role(
        'customer_data_analyst',
        '客户数据分析师',
        '分析线索、转化、服务、留存、复购和客户价值指标。',
        ['xlsx'],
        'function',
        ['data-analysis'],
        ['客户数据', '分析', '转化'],
      ),
    ],
    prompts: {
      primary: '请梳理从线索到成交再到复购的客户经营流程，并安排销售、客服、客户成功和运营协同。',
      examples: [
        '请为我们的 B2B 客户设计从首次接触到续约的完整客户旅程。',
        '请分析最近客户流失问题，并安排客服、客户成功和数据分析共同排查。',
        '请制定一次面向老客户的私域复购活动和销售跟进机制。',
      ],
    },
  },
  {
    id: 'finance-operations',
    version: 1,
    name: '财务经营专家团',
    description: '围绕收入、成本、预算、现金流、经营指标和风险预警支持管理决策。',
    category: 'finance',
    tags: ['财务分析', '经营复盘', '风险预警'],
    legacyNames: ['经营分析专家团'],
    lead: lead(
      'finance_operations_director',
      '财务经营总监',
      '统一分析口径、安排专业复核并输出管理动作。',
      'finance',
      ['finance-analyst'],
      ['财务', '经营', '总监'],
    ),
    roles: [
      role(
        'financial_analyst',
        '财务分析师',
        '解读报表、利润结构、指标变化和关键财务问题。',
        ['xlsx'],
        'finance',
        ['finance-analyst', 'financial-report-reader'],
        ['财务', '报表', '分析'],
      ),
      role(
        'budget_planner',
        '预算规划师',
        '制定预算假设、部门目标、滚动预测和预算控制机制。',
        ['xlsx', 'create-plan'],
        'finance',
        ['finance-analyst'],
        ['预算', '规划', '财务'],
      ),
      role(
        'cost_analyst',
        '成本分析师',
        '拆解固定与变动成本、单位经济性和降本机会。',
        ['xlsx'],
        'finance',
        ['transport-cost-analysis'],
        ['成本', '分析', '经营'],
      ),
      role(
        'cashflow_manager',
        '现金流管理师',
        '分析经营、投资和融资现金流，预测资金缺口。',
        ['xlsx'],
        'finance',
        ['finance-analyst'],
        ['现金流', '资金', '财务'],
      ),
      role(
        'operations_data_analyst',
        '经营数据分析师',
        '统一经营指标口径并分析增长、效率和结构变化。',
        ['xlsx'],
        'function',
        ['data-analysis'],
        ['经营数据', '指标', '分析'],
      ),
      role(
        'financial_risk_advisor',
        '风险预警师',
        '识别财务异常、经营压力和外部环境风险，设置预警阈值。',
        ['xlsx', 'web-search'],
        'finance',
        ['risk-assessment'],
        ['风险', '预警', '财务'],
      ),
    ],
    prompts: {
      primary:
        '请基于我的经营数据完成收入、成本、预算、现金流和风险的联合分析，并给出本月管理动作。',
      examples: [
        '请分析这份月度经营数据，找出利润、成本和现金流的主要变化原因。',
        '请组织一次年度预算编制，给出假设、模板、责任分工和滚动预测机制。',
        '请为公司建立财务经营预警指标，并说明每项指标触发后的管理动作。',
      ],
    },
  },
  ...EXTRA_ENTERPRISE_EXPERT_TEAM_DEFINITIONS,
  ...INDUSTRY_EXPERT_TEAM_DEFINITIONS,
];

const normalizeRuntimeSegment = (value: string, fallback: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28);
  return normalized || fallback;
};

export const buildExpertTeamRuntimeAgentId = (leadAgentId: string, roleKey: string): string => {
  const compactLeadId = normalizeRuntimeSegment(leadAgentId, 'lead').slice(-16);
  const compactRoleKey = normalizeRuntimeSegment(roleKey, 'role').slice(0, 24);
  return `team_${compactLeadId}_${compactRoleKey}`.slice(0, 48);
};

export function createExpertTeamInstance(
  definition: ExpertTeamDefinition,
  leadAgentId: string,
  resolvedAvatars: Record<string, string>,
): ExpertTeamInstanceConfig {
  const toRuntimeRole = (definitionRole: ExpertRoleDefinition): ExpertTeamRuntimeRole => ({
    ...definitionRole,
    runtimeAgentId: buildExpertTeamRuntimeAgentId(leadAgentId, definitionRole.key),
    avatar: resolvedAvatars[definitionRole.key] || '',
  });
  return {
    schemaVersion: 1,
    definitionId: definition.id,
    definitionVersion: definition.version,
    name: definition.name,
    lead: toRuntimeRole(definition.lead),
    roles: definition.roles.map(toRuntimeRole),
    prompts: definition.prompts,
  };
}

export function parseExpertTeamInstanceConfig(value: unknown): ExpertTeamInstanceConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Partial<ExpertTeamInstanceConfig>;
  if (
    input.schemaVersion !== 1 ||
    typeof input.definitionId !== 'string' ||
    typeof input.name !== 'string' ||
    !input.lead ||
    !Array.isArray(input.roles) ||
    !input.prompts
  )
    return null;
  const roles = [input.lead, ...input.roles];
  if (
    roles.some(
      item =>
        !item ||
        typeof item.key !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.runtimeAgentId !== 'string' ||
        !Array.isArray(item.skillIds) ||
        item.skillIds.length > 2,
    )
  )
    return null;
  return input as ExpertTeamInstanceConfig;
}

export function buildExpertTeamLeadPrompt(instance: ExpertTeamInstanceConfig): string {
  const roster = instance.roles
    .map(member =>
      [
        `- ${member.name}`,
        `  - agentId: ${member.runtimeAgentId}`,
        `  - 职责: ${member.description}`,
        `  - 技能: ${member.skillIds.length > 0 ? member.skillIds.join(', ') : '无专用技能'}`,
      ].join('\n'),
    )
    .join('\n');

  return [
    `你是“${instance.name}”唯一的顶层主理人，角色是${instance.lead.name}。`,
    instance.lead.description,
    '先澄清目标、材料、范围和交付标准，再决定需要哪些子智能体。除纯问候外，专家团任务必须至少委派 2 位不同成员；跨专业、可并行或需要复核的任务选择最少且足够的成员协作，不要无条件召集全员。',
    '创建成员时必须调用 sessions_spawn，使用下列英文 agentId，并把对应中文角色名写入 label。跨角色委派必须使用 context="isolated"（不要使用 fork）；task 中应写清本轮目标、已知材料、边界、输出格式和验收要求。',
    '优先并行处理互不依赖的工作；使用 sessions_history 查看记录，或使用 sessions_send 补充要求 收集结果。若成员失败，可补充上下文后重试一次。',
    '你负责校验成员结论之间的冲突、事实来源和遗漏，最终仅由你向用户交付统一结果。成员配置保存在本机；不要把尚未返回的成员任务描述为完成。',
    `【可调用成员】\n${roster}`,
    '最终答复应包含：结论、关键依据、已完成工作、风险或待确认项、建议下一步。',
  ].join('\n\n');
}

export const findExpertTeamDefinition = (idOrName: string): ExpertTeamDefinition | undefined => {
  const normalized = idOrName.trim();
  return EXPERT_TEAM_DEFINITIONS.find(
    definition =>
      definition.id === normalized ||
      definition.name === normalized ||
      definition.legacyNames.includes(normalized),
  );
};
