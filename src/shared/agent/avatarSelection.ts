import {
  AgentAvatarSvg,
  DefaultAgentAvatar,
  encodeAgentAvatarIcon,
  isAgentAvatarSvg,
  parseAgentAvatarIcon,
} from './avatar';

export const AgentCreateIconSource = {
  InitialRandom: 'initial_random',
  TitleMatch: 'title_match',
  AiDraft: 'ai_draft',
  UserCustom: 'user_custom',
} as const;

export type AgentCreateIconSource = typeof AgentCreateIconSource[keyof typeof AgentCreateIconSource];

export interface PickRandomAgentAvatarOptions {
  /** Existing agent icons (encoded strings or raw SVG ids) to avoid repeating while unused icons remain. */
  existingIcons?: readonly (string | null | undefined)[];
  /** Previously rolled icon to exclude so reopening the create flow always feels fresh. */
  excludeIcon?: string | null;
  /** Avoid `DefaultAgentAvatar.svg` (`lobster`) while other default icons are available. Defaults to `true`. */
  avoidDefault?: boolean;
  /** Injectable PRNG returning `[0, 1)` for deterministic tests. Defaults to `Math.random`. */
  random?: () => number;
}

export interface ResolveTitleIconInput {
  title: string;
  initialIcon: string;
  currentIcon: string;
  currentSource: AgentCreateIconSource;
}

export interface ResolveAiDraftIconInput {
  draftAvatarSvg?: AgentAvatarSvg;
  draftName?: string;
  currentIcon: string;
  currentSource: AgentCreateIconSource;
}

export interface ResolvedAgentIconState {
  icon: string;
  source: AgentCreateIconSource;
}

interface AvatarKeywordRule {
  svg: AgentAvatarSvg;
  /** CJK / substring keywords matched case-insensitively on the raw title. */
  zhKeywords: readonly string[];
  /** ASCII words or space-separated phrases matched on normalized token boundaries. */
  enKeywords: readonly string[];
}

const ALL_AGENT_AVATAR_SVGS: readonly AgentAvatarSvg[] = Object.values(AgentAvatarSvg);

/**
 * Domain-specific rules are ordered before broader container categories (`Document`, `Folder`, `Brain`, `Briefcase`)
 * so tie scores favor the specific domain (e.g. "体检报告" -> `Diagnosis`, "宠物医生" -> `Pet`, "减脂食谱" -> `Fitness`).
 */
const AVATAR_KEYWORD_RULES: readonly AvatarKeywordRule[] = [
  {
    svg: AgentAvatarSvg.Pet,
    zhKeywords: [
      '宠物医生', '宠物护理', '宠物', '萌宠', '猫咪', '小猫', '喵星人', '养猫', '撸猫',
      '狗狗', '小狗', '汪星人', '养狗', '遛狗', '铲屎官', '兽医', '猫粮', '狗粮', '水族', '养鱼', '鹦鹉', '仓鼠',
    ],
    enKeywords: [
      'pet', 'pets', 'cat', 'cats', 'kitten', 'kitty', 'dog', 'dogs', 'puppy', 'doggy',
      'vet', 'veterinary', 'animal', 'animals', 'hamster', 'parrot', 'aquarium', 'paw',
    ],
  },
  {
    svg: AgentAvatarSvg.Diagnosis,
    zhKeywords: [
      '体检报告', '医疗', '医学', '健康', '体检', '诊断', '医生', '问诊', '医院',
      '用药', '药品', '疾病', '营养', '膳食', '养生', '康复', '病例', '病历', '症状', '牙科', '中医', '保健',
    ],
    enKeywords: [
      'health', 'healthcare', 'medical', 'medicine', 'doctor', 'clinic', 'hospital',
      'diagnosis', 'symptom', 'symptoms', 'nutrition', 'diet', 'wellness', 'pharmacy', 'nurse', 'patient', 'checkup', 'clinical',
    ],
  },
  {
    svg: AgentAvatarSvg.Scales,
    zhKeywords: [
      '法律', '法务', '合同', '律师', '合规', '条款', '仲裁', '维权', '税务',
      '审计', '风控', '政策', '法规', '知识产权', '专利', '版权', '诉讼', '协议', '公证', '天平',
    ],
    enKeywords: [
      'law', 'legal', 'lawyer', 'attorney', 'contract', 'contracts', 'compliance',
      'audit', 'auditor', 'tax', 'policy', 'regulation', 'regulatory', 'patent', 'copyright', 'trademark', 'clause', 'governance', 'court', 'justice', 'scales',
    ],
  },
  {
    svg: AgentAvatarSvg.Translation,
    zhKeywords: [
      '翻译', '口译', '笔译', '同传', '英语', '英文', '日语', '日文', '韩语', '韩文',
      '法语', '德语', '西班牙语', '俄语', '外语', '双语', '多语言', '本地化', '国际化', '词典', '口语', '背单词', '语法',
    ],
    enKeywords: [
      'translate', 'translation', 'translator', 'interpret', 'interpreter',
      'english', 'japanese', 'korean', 'french', 'german', 'spanish', 'bilingual', 'multilingual',
      'localization', 'l10n', 'i18n', 'dictionary', 'vocabulary', 'grammar', 'language', 'languages',
    ],
  },
  {
    svg: AgentAvatarSvg.Travel,
    zhKeywords: [
      '旅行攻略', '旅游攻略', '出行攻略', '旅行', '旅游', '出游', '出行', '机票', '酒店', '民宿',
      '签证', '景点', '自驾', '出差', '行程', '露营', '徒步', '导游', '环游', '度假', '航班', '探店',
    ],
    enKeywords: [
      'travel guide', 'tour guide', 'travel', 'trip', 'trips', 'tour', 'tourism', 'tourist',
      'vacation', 'holiday', 'flight', 'flights', 'hotel', 'hotels', 'itinerary', 'visa', 'camping', 'hiking', 'journey', 'destination', 'passport',
    ],
  },
  {
    svg: AgentAvatarSvg.Fitness,
    zhKeywords: [
      '力量训练', '健身', '运动', '减脂', '增肌', '减肥', '瘦身', '跑步', '马拉松',
      '瑜伽', '普拉提', '锻炼', '体能', '撸铁', '塑形', '燃脂', '骑行', '游泳', '篮球', '足球', '网球', '羽毛球',
    ],
    enKeywords: [
      'fitness coach', 'personal trainer', 'weight loss', 'fitness', 'workout', 'workouts', 'gym',
      'exercise', 'sport', 'sports', 'running', 'runner', 'marathon', 'yoga', 'pilates', 'cardio', 'strength', 'muscle', 'cycling', 'swimming', 'athlete', 'crossfit',
    ],
  },
  {
    svg: AgentAvatarSvg.Meditation,
    zhKeywords: [
      '心理咨询', '自我关怀', '冥想', '正念', '放松', '睡眠', '助眠', '失眠', '解压',
      '专注', '情绪', '疗愈', '心理', '禅', '呼吸', '静心', '舒缓', '焦虑',
    ],
    enKeywords: [
      'mental health', 'meditation', 'meditate', 'mindfulness', 'mindful', 'relax', 'relaxation',
      'sleep', 'insomnia', 'calm', 'zen', 'breath', 'breathing', 'focus', 'therapy', 'mental', 'psychology', 'mood', 'stress', 'healing',
    ],
  },
  {
    svg: AgentAvatarSvg.Music,
    zhKeywords: [
      '音乐', '作曲', '作词', '编曲', '吉他', '钢琴', '歌曲', '歌单', '乐理', '旋律', '唱歌', '声乐', '乐器', '乐队', '混音', '说唱', '民谣',
    ],
    enKeywords: [
      'music', 'musical', 'musician', 'song', 'songs', 'lyrics', 'composer', 'compose',
      'melody', 'guitar', 'piano', 'band', 'chord', 'chords', 'beat', 'beats', 'synth', 'dj', 'singing', 'vocal', 'midi', 'soundtrack',
    ],
  },
  {
    svg: AgentAvatarSvg.Headphones,
    zhKeywords: [
      '有声书', '播客', '音频', '语音', '配音', '听书', '客服', '电话', '热线', '声音', '录音', '转写', '字幕', '电台', '耳机', '口播',
    ],
    enKeywords: [
      'customer support', 'podcast', 'podcasts', 'audio', 'voice', 'voiceover', 'tts', 'asr',
      'speech', 'audiobook', 'radio', 'sound', 'helpdesk', 'headphones', 'transcript', 'transcription', 'subtitle', 'subtitles',
    ],
  },
  {
    svg: AgentAvatarSvg.Entertainment,
    zhKeywords: [
      '视频剪辑', '剧本杀', '短视频', '二次元', '娱乐', '游戏', '电影', '影视', '追剧',
      '动漫', '漫画', '综艺', '直播', '搞笑', '段子', '影评', '电竞', '桌游', '剪辑',
    ],
    enKeywords: [
      'game', 'games', 'gaming', 'gamer', 'movie', 'movies', 'film', 'cinema', 'anime', 'manga',
      'drama', 'entertainment', 'comedy', 'humor', 'streaming', 'video', 'youtube', 'bilibili', 'tiktok', 'esports',
    ],
  },
  {
    svg: AgentAvatarSvg.ShoppingCart,
    zhKeywords: [
      '供应链', '购物车', '电商', '购物', '选品', '带货', '跨境', '淘宝', '天猫', '京东',
      '拼多多', '亚马逊', '商品', '比价', '采购', '零售', '店铺', '买手', '种草', '网购', '导购',
    ],
    enKeywords: [
      'supply chain', 'shop', 'shopping', 'ecommerce', 'store', 'retail', 'cart',
      'amazon', 'shopify', 'taobao', 'tmall', 'merchandise', 'procurement', 'buyer', 'sourcing', 'checkout',
    ],
  },
  {
    svg: AgentAvatarSvg.Data,
    zhKeywords: [
      '数据分析', '透视表', '数据库', '数据', '统计', '报表', '图表', '股票', '股市',
      '财报', '财务', '金融', '投资', '理财', '基金', '量化', '交易', '估值', '指标', '看板', '大盘', '表格',
    ],
    enKeywords: [
      'data analysis', 'data science', 'data', 'analytics', 'analysis', 'analyst', 'chart', 'charts',
      'dashboard', 'metrics', 'kpi', 'bi', 'sql', 'excel', 'xlsx', 'csv', 'spreadsheet', 'statistics', 'stats',
      'stock', 'stocks', 'finance', 'financial', 'investing', 'investment', 'trading', 'quant', 'portfolio', 'database', 'etl',
    ],
  },
  {
    svg: AgentAvatarSvg.Repair,
    zhKeywords: [
      '工具箱', '修理', '维修', '排障', '排查', '调试', '修复', '运维', '故障', '测试', '质检', '巡检', '排错',
    ],
    enKeywords: [
      'ci cd', 'repair', 'fix', 'debug', 'debugger', 'debugging', 'bug', 'bugs',
      'troubleshoot', 'troubleshooting', 'devops', 'sre', 'ops', 'qa', 'test', 'testing', 'tester', 'maintenance', 'incident', 'hotfix', 'patch',
    ],
  },
  {
    svg: AgentAvatarSvg.Code,
    zhKeywords: [
      '程序员', '工程师', '小程序', '写代码', '代码', '编程', '开发', '前端', '后端', '全栈', '算法', '架构', '接口', '源码',
    ],
    enKeywords: [
      'code review', 'code', 'coding', 'coder', 'dev', 'developer', 'development', 'engineer', 'engineering',
      'frontend', 'backend', 'fullstack', 'programming', 'programmer', 'software', 'algorithm', 'api', 'sdk', 'cli',
      'git', 'github', 'pr', 'python', 'typescript', 'javascript', 'react', 'vue', 'nextjs', 'nodejs',
      'java', 'golang', 'rust', 'cpp', 'csharp', 'swift', 'kotlin', 'flutter', 'miniapp', 'compiler', 'refactor', 'codebase',
    ],
  },
  {
    svg: AgentAvatarSvg.Artboard,
    zhKeywords: [
      '室内设计', '品牌视觉', '设计', '画板', '插画', '海报', '视觉', '排版', '原型',
      '美工', '绘画', '画画', '图片', '修图', '摄影', '图标', '徽标', '交互', '平面', '配色', '建筑', '生图',
    ],
    enKeywords: [
      'ui ux', 'design', 'designer', 'ui', 'ux', 'figma', 'sketch', 'artboard', 'illustration', 'illustrator',
      'poster', 'visual', 'graphic', 'graphics', 'layout', 'prototype', 'wireframe', 'branding', 'logo',
      'icon', 'icons', 'art', 'artist', 'draw', 'drawing', 'paint', 'painting', 'photo', 'photography', 'image', 'canvas', '3d',
    ],
  },
  {
    svg: AgentAvatarSvg.Experiment,
    zhKeywords: [
      '实验室', '医学研究', '实验', '科研', '科学', '化学', '生物', '物理', '研发', '基因', '分子', '仿真', '评测', '基准',
    ],
    enKeywords: [
      'ab test', 'a b', 'experiment', 'experiments', 'lab', 'laboratory', 'science', 'scientific',
      'scientist', 'chemistry', 'biology', 'physics', 'hypothesis', 'benchmark', 'eval', 'evals', 'biotech', 'genome',
    ],
  },
  {
    svg: AgentAvatarSvg.GraduationCap,
    zhKeywords: [
      '教学', '教案', '课程', '备课', '学术', '论文', '考研', '备考', '留学', '导师',
      '学习', '考试', '作业', '老师', '教师', '讲师', '辅导', '刷题', '题库', '学位', '毕业', '博士', '教育', '培训', '课堂', '校园',
    ],
    enKeywords: [
      'study', 'learn', 'learning', 'course', 'courses', 'lesson', 'lessons', 'teach', 'teacher', 'teaching',
      'tutor', 'academic', 'paper', 'thesis', 'dissertation', 'exam', 'quiz', 'homework', 'school', 'college',
      'university', 'campus', 'education', 'training', 'student', 'mentor', 'professor', 'phd', 'scholar', 'ielts', 'toefl', 'gre', 'sat',
    ],
  },
  {
    svg: AgentAvatarSvg.Inspiration,
    zhKeywords: [
      '社交媒体', '头脑风暴', '活动策划', '品牌营销', '小红书', '新媒体', '灵感', '创意',
      '策划', '社媒', '抖音', '微博', '知乎', '运营', '营销', '推广', '爆款', '选题', '增长', '公关', '广告', '流量',
    ],
    enKeywords: [
      'social media', 'brand strategy', 'idea', 'ideas', 'inspiration', 'inspire', 'brainstorm', 'brainstorming',
      'campaign', 'marketing', 'growth', 'seo', 'social', 'viral', 'xiaohongshu', 'rednote', 'instagram', 'twitter', 'xhs', 'ads', 'advertising', 'ideation',
    ],
  },
  {
    svg: AgentAvatarSvg.Creation,
    zhKeywords: [
      '公众号', '自媒体', '口播稿', '新闻稿', '写作', '文案', '创作', '编辑', '文章', '博客',
      '小说', '故事', '剧本', '散文', '诗歌', '润色', '改写', '扩写', '撰稿', '专栏', '软文', '文字', '作家',
    ],
    enKeywords: [
      'write', 'writer', 'writing', 'copywriting', 'copywriter', 'content', 'editor', 'editorial',
      'article', 'articles', 'blog', 'blogger', 'novel', 'story', 'fiction', 'script', 'essay', 'draft', 'drafting', 'author', 'journalist', 'ghostwriter', 'creation', 'creative',
    ],
  },
  {
    svg: AgentAvatarSvg.Lightning,
    zhKeywords: [
      '时间管理', '自动化', '工作流', '批处理', '番茄钟', '效率', '提效', '快捷', '定时',
      '爬虫', '抓取', '监控', '同步', '集成', '闪电', '极速', '日程', '待办', '提醒', '脚本',
    ],
    enKeywords: [
      'automation', 'automate', 'workflow', 'workflows', 'productivity', 'efficient', 'efficiency',
      'fast', 'quick', 'speed', 'lightning', 'trigger', 'cron', 'schedule', 'scheduler', 'batch', 'scraper', 'crawler', 'monitor', 'sync', 'todo', 'tasks', 'calendar', 'reminder', 'macro', 'pipeline',
    ],
  },
  {
    svg: AgentAvatarSvg.PottedPlant,
    zhKeywords: [
      '断舍离', '慢生活', '植物', '园艺', '绿植', '养花', '多肉', '盆栽', '花卉', '种菜',
      '阳台', '环保', '低碳', '自然', '生态', '家居', '家装', '收纳', '花艺', '插花', '咖啡', '茶道',
    ],
    enKeywords: [
      'plant', 'plants', 'garden', 'gardening', 'botany', 'flower', 'flowers', 'succulent', 'bonsai',
      'herb', 'herbs', 'nature', 'eco', 'green', 'sustainability', 'sustainable', 'interior', 'decor', 'minimalism', 'tea', 'coffee',
    ],
  },
  {
    svg: AgentAvatarSvg.Heart,
    zhKeywords: [
      '生活管家', '情感', '恋爱', '约会', '婚姻', '陪伴', '倾诉', '社交', '关系', '育儿',
      '亲子', '家庭', '母婴', '公益', '志愿', '关心', '温暖', '树洞', '朋友', '闺蜜', '夸夸', '鼓励', '爱心', '管家', '做饭', '菜谱', '食谱', '烘焙', '美食', '下厨',
    ],
    enKeywords: [
      'love', 'dating', 'relationship', 'relationships', 'companion', 'friend', 'family', 'parenting',
      'baby', 'kids', 'care', 'heart', 'charity', 'volunteer', 'empathy', 'cooking', 'recipe', 'recipes', 'chef', 'kitchen', 'baking', 'food', 'lifestyle',
    ],
  },
  {
    svg: AgentAvatarSvg.Tag,
    zhKeywords: [
      '薅羊毛', '标签', '分类', '打标', '定价', '价格', '优惠', '促销', '账单', '记账', '预算', '报销', '发票', '省钱', '折扣',
    ],
    enKeywords: [
      'tag', 'tags', 'tagging', 'label', 'labels', 'pricing', 'price', 'discount', 'coupon',
      'deal', 'deals', 'budget', 'expense', 'expenses', 'invoice', 'billing', 'bookkeeping', 'receipt', 'receipts',
    ],
  },
  {
    svg: AgentAvatarSvg.Books,
    zhKeywords: [
      '行业研究', '论文阅读', '知识库', '图书馆', '研究', '调研', '阅读', '读书', '书籍', '书单', '拆书', '文献', '百科', '历史', '资料', '精读', '研报',
    ],
    enKeywords: [
      'industry research', 'book review', 'literature review', 'book', 'books', 'read', 'reading', 'reader',
      'research', 'researcher', 'library', 'literature', 'encyclopedia', 'history', 'knowledge', 'reference', 'bibliography',
    ],
  },
  {
    svg: AgentAvatarSvg.Briefcase,
    zhKeywords: [
      '项目经理', '公文包', '职场', '求职', '面试', '简历', '职业', '办公', '商务', '商业', '管理', '招聘', '人事', '销售', '客户', '顾问', '老板', '高管', '创业', '合作',
    ],
    enKeywords: [
      'career coach', 'career', 'job', 'interview', 'resume', 'cv', 'business', 'office', 'workplace',
      'manager', 'management', 'pm', 'hr', 'recruiting', 'recruiter', 'sales', 'crm', 'consultant', 'consulting', 'startup', 'executive', 'enterprise', 'briefcase', 'b2b',
    ],
  },
  {
    svg: AgentAvatarSvg.Brain,
    zhKeywords: [
      '产品经理', '产品规划', '战略规划', '人工智能', '大模型', '提示词', '大脑', '产品', '需求', '思维', '战略', '决策', '逻辑', '思考', '复盘', '拆解', '智囊', '策略',
    ],
    enKeywords: [
      'product planner', 'product manager', 'brain', 'product', 'prd', 'strategy', 'strategic', 'thinking',
      'mind', 'mindmap', 'decision', 'logic', 'architect', 'architecture', 'ai', 'llm', 'prompt', 'prompts', 'reasoning', 'cognitive', 'advisor',
    ],
  },
  {
    svg: AgentAvatarSvg.Folder,
    zhKeywords: [
      '文件整理', '文件管理', '本地文件', '文件夹', '资料库', '工作区', '归档', '目录', '网盘', '文件',
    ],
    enKeywords: [
      'folder', 'folders', 'directory', 'files', 'file', 'archive', 'vault', 'obsidian', 'notion', 'workspace', 'dropbox', 'drive', 'organizer', 'storage',
    ],
  },
  {
    svg: AgentAvatarSvg.Document,
    zhKeywords: [
      '会议纪要', '演示文稿', '幻灯片', '文档', '周报', '日报', '月报', '年报', '纪要', '总结', '摘要', '报告', '汇报', '笔记', '备忘', '大纲', '方案', '公文', '邮件', '信件',
    ],
    enKeywords: [
      'doc', 'docs', 'document', 'documents', 'documentation', 'report', 'reports', 'summary', 'summarize', 'summarizer',
      'minutes', 'notes', 'note', 'memo', 'markdown', 'pdf', 'word', 'docx', 'ppt', 'pptx', 'slides', 'presentation', 'deck', 'email', 'mail', 'newsletter', 'outline', 'wiki',
    ],
  },
  {
    svg: AgentAvatarSvg.Lobster,
    zhKeywords: ['小龙虾', '龙虾'],
    enKeywords: ['lobster', 'lobsterai'],
  },
];

function extractAvatarSvg(value: string | null | undefined): AgentAvatarSvg | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  const parsed = parseAgentAvatarIcon(trimmed);
  if (parsed) return parsed.svg;
  return isAgentAvatarSvg(trimmed) ? trimmed : null;
}

function normalizeAsciiText(text: string): { padded: string; tokenSet: Set<string> } {
  const normalized = text
    .replace(/c\+\+/gi, ' cpp ')
    .replace(/c#/gi, ' csharp ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (!normalized) {
    return { padded: '', tokenSet: new Set() };
  }

  return {
    padded: ` ${normalized} `,
    tokenSet: new Set(normalized.split(' ')),
  };
}

function filterContainedMatches(matches: string[]): string[] {
  if (matches.length <= 1) return matches;
  return matches.filter((candidate, index) => (
    !matches.some((other, otherIndex) => (
      otherIndex !== index
      && other.length > candidate.length
      && other.includes(candidate)
    ))
  ));
}

function scoreKeywordRule(
  rule: AvatarKeywordRule,
  lowerTitle: string,
  ascii: { padded: string; tokenSet: Set<string> },
): number {
  const matchedZh: string[] = [];
  for (const keyword of rule.zhKeywords) {
    if (lowerTitle.includes(keyword)) {
      matchedZh.push(keyword);
    }
  }

  const matchedEn: string[] = [];
  if (ascii.padded) {
    for (const keyword of rule.enKeywords) {
      if (keyword.includes(' ')) {
        if (ascii.padded.includes(` ${keyword} `)) {
          matchedEn.push(keyword);
        }
      } else if (ascii.tokenSet.has(keyword)) {
        matchedEn.push(keyword);
      }
    }
  }

  let score = 0;
  for (const keyword of filterContainedMatches(matchedZh)) {
    score += keyword.length * 2;
  }
  for (const keyword of filterContainedMatches(matchedEn)) {
    const wordCount = keyword.split(' ').length;
    score += wordCount * 4;
  }
  return score;
}

/**
 * Pick a random default SVG avatar for a newly created agent.
 * Prefers unused non-default SVGs so newly created agents are visually distinct
 * even when users never manually change the avatar.
 */
export function pickRandomAgentAvatarSvg(options: PickRandomAgentAvatarOptions = {}): AgentAvatarSvg {
  const avoidDefault = options.avoidDefault ?? true;
  const excludedSvg = extractAvatarSvg(options.excludeIcon);
  const usedSvgs = new Set<AgentAvatarSvg>();

  if (options.existingIcons) {
    for (const icon of options.existingIcons) {
      const svg = extractAvatarSvg(icon);
      if (svg) usedSvgs.add(svg);
    }
  }

  const nonDefaultPool = avoidDefault
    ? ALL_AGENT_AVATAR_SVGS.filter(svg => svg !== DefaultAgentAvatar.svg)
    : ALL_AGENT_AVATAR_SVGS;

  const candidateTiers: AgentAvatarSvg[][] = [
    nonDefaultPool.filter(svg => !usedSvgs.has(svg) && svg !== excludedSvg),
    nonDefaultPool.filter(svg => svg !== excludedSvg),
    ALL_AGENT_AVATAR_SVGS.filter(svg => svg !== excludedSvg),
    [...ALL_AGENT_AVATAR_SVGS],
  ];

  const pool = candidateTiers.find(tier => tier.length > 0) ?? ALL_AGENT_AVATAR_SVGS;
  const rawRandom = (options.random ?? Math.random)();
  const normalizedRandom = Number.isFinite(rawRandom) ? Math.min(Math.max(rawRandom, 0), 1) : 0;
  const index = Math.min(Math.floor(normalizedRandom * pool.length), pool.length - 1);
  return pool[index] ?? ALL_AGENT_AVATAR_SVGS[0];
}

export function pickRandomAgentAvatarIcon(options: PickRandomAgentAvatarOptions = {}): string {
  return encodeAgentAvatarIcon({ svg: pickRandomAgentAvatarSvg(options) });
}

/**
 * Match the best-fitting default avatar SVG from an agent title (Chinese or English).
 * Returns `null` when the title carries no strong domain signal so callers can keep
 * their randomly chosen initial icon.
 */
export function matchAgentAvatarSvgByTitle(title: string): AgentAvatarSvg | null {
  const trimmed = title.trim();
  if (!trimmed) return null;

  const lowerTitle = trimmed.toLowerCase();
  const ascii = normalizeAsciiText(trimmed);

  let bestSvg: AgentAvatarSvg | null = null;
  let bestScore = 0;

  for (const rule of AVATAR_KEYWORD_RULES) {
    const score = scoreKeywordRule(rule, lowerTitle, ascii);
    if (score > bestScore) {
      bestScore = score;
      bestSvg = rule.svg;
    }
  }

  return bestSvg;
}

/**
 * Update the agent-create modal's icon when the title changes, respecting
 * manual user selections and AI-drafted avatar picks.
 */
export function resolveAgentIconOnTitleChange(input: ResolveTitleIconInput): ResolvedAgentIconState {
  if (
    input.currentSource === AgentCreateIconSource.UserCustom
    || input.currentSource === AgentCreateIconSource.AiDraft
  ) {
    return {
      icon: input.currentIcon,
      source: input.currentSource,
    };
  }

  const matchedSvg = matchAgentAvatarSvgByTitle(input.title);
  if (matchedSvg) {
    return {
      icon: encodeAgentAvatarIcon({ svg: matchedSvg }),
      source: AgentCreateIconSource.TitleMatch,
    };
  }

  return {
    icon: input.initialIcon,
    source: AgentCreateIconSource.InitialRandom,
  };
}

/**
 * Update the agent-create modal's icon when an AI draft finishes generating,
 * without overwriting an icon the user explicitly picked.
 */
export function resolveAgentIconOnAiDraft(input: ResolveAiDraftIconInput): ResolvedAgentIconState {
  if (input.currentSource === AgentCreateIconSource.UserCustom) {
    return {
      icon: input.currentIcon,
      source: input.currentSource,
    };
  }

  if (input.draftAvatarSvg) {
    return {
      icon: encodeAgentAvatarIcon({ svg: input.draftAvatarSvg }),
      source: AgentCreateIconSource.AiDraft,
    };
  }

  if (input.draftName) {
    const matchedSvg = matchAgentAvatarSvgByTitle(input.draftName);
    if (matchedSvg) {
      return {
        icon: encodeAgentAvatarIcon({ svg: matchedSvg }),
        source: AgentCreateIconSource.TitleMatch,
      };
    }
  }

  return {
    icon: input.currentIcon,
    source: input.currentSource,
  };
}
