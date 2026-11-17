import type { LocalizedText } from '../../types/skill';

/**
 * Localized display names for the skills bundled with the app
 * (the ones listed in SKILLs/skills.config.json).
 *
 * These names remain available offline. Server `displayName` metadata takes
 * precedence — see `skillService.getLocalizedSkillName()`.
 *
 * When adding a bundled skill, add its display name here too; a missing entry
 * only means the prettified English name is shown.
 */
export const BUNDLED_SKILL_DISPLAY_NAMES: Record<string, LocalizedText> = {
  'article-writer': { zh: '长文写作', en: 'Article Writer' },
  'content-planner': { zh: '内容规划', en: 'Content Planner' },
  'daily-trending': { zh: '每日热点', en: 'Daily Trending' },
  'docx': { zh: 'Word 文档处理', en: 'Word Documents' },
  'frontend-design': { zh: '前端页面设计', en: 'Frontend Design' },
  'imap-smtp-email': { zh: '邮件收发', en: 'Email (IMAP/SMTP)' },
  'local-tools': { zh: '本地工具', en: 'Local Tools' },
  'pdf': { zh: 'PDF 处理', en: 'PDF Toolkit' },
  'pptx': { zh: 'PPT 制作', en: 'PowerPoint Slides' },
  'remotion': { zh: '程序化视频', en: 'Programmatic Video' },
  'skill-creator': { zh: '技能创建', en: 'Skill Creator' },
  'skin-creator': { zh: '皮肤创建', en: 'Skin Creator' },
  'stock-analyzer': { zh: '股票分析', en: 'Stock Analyzer' },
  'stock-announcements': { zh: '上市公司公告', en: 'Stock Announcements' },
  'stock-explorer': { zh: '行情浏览', en: 'Stock Explorer' },
  'weather': { zh: '天气查询', en: 'Weather' },
  'web-search': { zh: '联网搜索', en: 'Web Search' },
  'xlsx': { zh: '表格处理', en: 'Excel Spreadsheets' },
  'youdaonote': { zh: '有道云笔记', en: 'Youdao Note' },
};

/**
 * Offline names for formerly bundled skills retained in user data after upgrades.
 * This compatibility map does not determine which skills are currently built in.
 */
export const LEGACY_BUNDLED_SKILL_DISPLAY_NAMES: Record<string, LocalizedText> = {
  'canvas-design': { zh: '画布设计', en: 'Canvas Design' },
  'create-plan': { zh: '计划生成', en: 'Create Plan' },
  'develop-web-game': { zh: '网页游戏开发', en: 'Web Game Development' },
  'playwright': { zh: 'Playwright 自动化', en: 'Playwright' },
  'seedance': { zh: 'Seedance 视频生成', en: 'Seedance' },
  'seedream': { zh: 'Seedream 图像生成', en: 'Seedream' },
  'skill-vetter': { zh: '技能安全审查', en: 'Skill Vetter' },
  'technology-news-search': { zh: '科技新闻检索', en: 'Tech News Search' },
};
