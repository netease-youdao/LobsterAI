import type { PlanType } from './utils';

export interface TaskTemplateSchedule {
  planType: Extract<PlanType, 'daily' | 'weekly'>;
  hour: number;
  minute: number;
  weekday?: number; // 0=Sun,1=Mon,...,6=Sat; only used when planType='weekly'
}

export interface TaskTemplate {
  id: string;
  icon: string;
  name: string;
  description: string;
  prompt: string;
  schedule: TaskTemplateSchedule;
}

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: 'daily-news',
    icon: '📰',
    name: '每日热点推送',
    description: '每天早晨推送国内外热点新闻摘要和热点消息',
    prompt: '请为我推送今日国内外重要新闻，包括：1. 国内要闻 3 条；2. 国际新闻 2 条；3. 科技/财经动态 2 条。每条新闻简要说明背景和影响，语言简洁易懂。',
    schedule: { planType: 'daily', hour: 8, minute: 0 },
  },
  {
    id: 'daily-english-words',
    icon: '📖',
    name: '每日单词抽背',
    description: '每天推送 5 个英语单词，含例句与记忆技巧',
    prompt: '请为我推送今日英语学习内容：随机选取 5 个常用英语单词（B2-C1 级别），每个单词包含：音标、中文释义、一个地道例句（附中文翻译）、以及一个帮助记忆的联想技巧。',
    schedule: { planType: 'daily', hour: 7, minute: 0 },
  },
  {
    id: 'bedtime-story',
    icon: '🌙',
    name: '每日睡前故事',
    description: '每晚推送一个温馨短故事，助眠放松',
    prompt: '请为我创作一个原创的睡前小故事，要求：篇幅 300-500 字，主题积极温馨，风格轻松治愈，适合成年人睡前阅读。可以是寓言、奇幻、生活小品等风格，结尾留有一点温暖的回味。',
    schedule: { planType: 'daily', hour: 21, minute: 30 },
  },
  {
    id: 'weekly-work-report',
    icon: '📊',
    name: '每周工作汇报',
    description: '每周五生成本周工作总结模板并提醒填写',
    prompt: '请帮我生成本周工作汇报模板，包含以下部分：1. 本周完成的主要工作（列表格式）；2. 工作中遇到的问题与解决方案；3. 下周工作计划；4. 需要协调或支持的事项。请以专业简洁的格式输出，方便直接填写后发给领导。',
    schedule: { planType: 'weekly', hour: 17, minute: 0, weekday: 5 },
  },
  {
    id: 'daily-movie',
    icon: '🎬',
    name: '每日电影推荐',
    description: '每天傍晚推荐一部值得一看的电影',
    prompt: '请为我推荐今天值得观看的一部电影，包含：片名（中英文）、上映年份、导演、主演、豆瓣/IMDb 评分、类型标签、一段吸引人的剧情简介（不剧透结局）、以及推荐理由（为什么今天适合看这部片子）。',
    schedule: { planType: 'daily', hour: 18, minute: 30 },
  },
  {
    id: 'daily-plan',
    icon: '📅',
    name: '每日计划提醒',
    description: '每天早上推送今日计划与专注建议',
    prompt: '请帮我规划今天的时间安排，给出一份简洁的日程建议：1. 上午（09:00-12:00）应优先完成的核心任务；2. 下午（14:00-18:00）适合处理的事务；3. 晚上（19:00-22:00）用于学习/复盘的建议；4. 一条今日的专注提示或励志金句。请保持简洁实用风格。',
    schedule: { planType: 'daily', hour: 9, minute: 0 },
  },
  {
    id: 'daily-fitness',
    icon: '💪',
    name: '每日健身打卡',
    description: '每天清晨推送一套居家健身动作',
    prompt: '请为我推送今日居家健身计划，要求：总时长约 20-30 分钟，无需器械，适合普通上班族。包含热身（5 分钟）+ 主要训练（15-20 分钟）+ 拉伸放松（5 分钟）。每个动作说明名称、组数/次数、标准姿势要点。今日训练重点请在上下肢和核心中轮换。',
    schedule: { planType: 'daily', hour: 6, minute: 30 },
  },
  {
    id: 'daily-stock',
    icon: '📈',
    name: '每日市场简报',
    description: '每个工作日早盘前推送市场动态',
    prompt: '请为我生成今日金融市场早间简报，包含：1. 隔夜美股三大指数表现；2. 今日 A 股开盘前需关注的重要消息（政策、财报、宏观数据等）；3. 大宗商品（黄金、原油）最新价格与趋势；4. 今日需重点关注的市场风险提示。请保持客观中立，不构成投资建议。',
    schedule: { planType: 'daily', hour: 9, minute: 15 },
  },
  {
    id: 'weekly-reading',
    icon: '📚',
    name: '每周读书笔记',
    description: '每周日推送一本书的核心思想与阅读建议',
    prompt: '请为我推荐本周值得精读的一本书，并提供：书名、作者、出版年份、核心主题（100字以内）、3-5 个关键洞见或金句（每条附简短解析）、适合哪类读者、阅读时长预估，以及一个可以立即付诸实践的行动建议。',
    schedule: { planType: 'weekly', hour: 10, minute: 0, weekday: 0 },
  },
  {
    id: 'daily-mood-journal',
    icon: '🎭',
    name: '每日心情日记',
    description: '每晚引导记录今日心情与一日回顾',
    prompt: '请以温暖引导者的角色，帮我完成今天的心情日记。引导我回顾：1. 今天最让我满意的一件事；2. 今天遇到的一个小挑战及我如何应对；3. 今天的整体情绪状态（1-10分）；4. 对明天的一个小期待。请用温和鼓励的语气，帮助我整理思绪、保持积极心态。',
    schedule: { planType: 'daily', hour: 22, minute: 0 },
  },
];
