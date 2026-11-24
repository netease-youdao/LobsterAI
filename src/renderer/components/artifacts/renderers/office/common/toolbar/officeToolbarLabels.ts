const ZH_FONT_LABELS: Record<string, string> = {
  'noto sans sc': '思源黑体',
  'source han sans sc': '思源黑体',
  'source han sans cn': '思源黑体',
  'noto serif sc': '思源宋体',
  'source han serif sc': '思源宋体',
  'source han serif cn': '思源宋体',
  simsun: '宋体',
  nsimsun: '新宋体',
  'songti sc': '宋体',
  stsong: '华文宋体',
  simhei: '黑体',
  'heiti sc': '黑体',
  stheiti: '华文黑体',
  'microsoft yahei': '微软雅黑',
  'microsoft yahei ui': '微软雅黑',
  kaiti: '楷体',
  'kaiti sc': '楷体',
  stkaiti: '华文楷体',
  fangsong: '仿宋',
  stfangsong: '华文仿宋',
  dengxian: '等线',
  'dengxian light': '等线 Light',
  'pingfang sc': '苹方',
};

const ZH_WORD_STYLE_LABELS: Record<string, string> = {
  normal: '正文',
  title: '文档标题',
  subtitle: '副标题',
  heading1: '标题 1',
  heading2: '标题 2',
  heading3: '标题 3',
  heading4: '标题 4',
  heading5: '标题 5',
  heading6: '标题 6',
  quote: '引用',
  intensequote: '明显引用',
  listparagraph: '列表段落',
  nospacing: '无间隔',
  tocheading: '目录标题',
};

const ZH_FONT_SIZE_NAMES: Record<number, string> = {
  42: '初号',
  36: '小初',
  26: '一号',
  24: '小一',
  22: '二号',
  18: '小二',
  16: '三号',
  15: '小三',
  14: '四号',
  12: '小四',
  10.5: '五号',
  9: '小五',
  7.5: '六号',
  6.5: '小六',
  5.5: '七号',
  5: '八号',
};

const isChineseLanguage = (language: string): boolean => language.trim().toLowerCase().startsWith('zh');

export function formatOfficeFontLabel(font: string, language: string): string {
  if (!isChineseLanguage(language)) return font;
  return ZH_FONT_LABELS[font.trim().toLowerCase()] ?? font;
}

export function formatWordStyleLabel(styleId: string, styleName: string, language: string): string {
  const fallback = styleName || styleId;
  if (!isChineseLanguage(language)) return fallback;
  const byId = ZH_WORD_STYLE_LABELS[styleId.trim().toLowerCase().replace(/\s+/g, '')];
  if (byId) return byId;
  const byName = ZH_WORD_STYLE_LABELS[styleName.trim().toLowerCase().replace(/\s+/g, '')];
  return byName ?? fallback;
}

export function formatOfficeFontSizeLabel(points: number, language: string): string {
  if (!isChineseLanguage(language)) return String(points);
  const zhName = ZH_FONT_SIZE_NAMES[points];
  return zhName ? `${zhName} (${points})` : String(points);
}
