import type {
  InstalledKitRecord,
  KitSkillMetadata,
} from '../../shared/kit/constants';
import {
  SkinPackKitBundle,
  SkinPackKitId,
  SkinPackKitMetadata,
  SkinPackSkillId,
} from '../../shared/skin/kit';

const SKIN_CREATOR_SKILL_METADATA: KitSkillMetadata = {
  id: SkinPackSkillId.BuiltIn,
  name: {
    en: 'AI Appearance Designer',
    zh: 'AI 外观设计',
  },
  description: {
    en: 'Designs and applies coordinated LobsterAI backgrounds, emblems, and interface colors.',
    zh: '设计并应用协调的 LobsterAI 背景、徽记和界面配色。',
  },
};

const SKIN_PACK_STARTER_PROMPT = {
  en: 'Create a custom AI skin for LobsterAI using {primary and accent colors} as the palette, centered on {theme or character}, set in {scene and mood}, and designed for {use case or purpose}. Generate a coordinated backdrop, emblem, and interface colors from this idea, then apply them to LobsterAI.',
  zh: '请为 LobsterAI 创建一套以 {主色与辅助色} 为主色调、以 {主题或人物} 为视觉中心的 AI 皮肤；画面呈现 {场景与氛围}，并适合 {使用场景或用途}。请据此生成协调的背景、徽记和界面配色，并自动应用到 LobsterAI。',
};

export function buildSkinPackMarketplaceKit(): Record<string, unknown> {
  return {
    id: SkinPackKitId.BuiltIn,
    name: {
      en: 'Customize LobsterAI',
      zh: 'LobsterAI 外观定制',
    },
    description: {
      en: 'Describe the look you want. AI creates a custom backdrop and emblem, coordinates the interface colors, and applies it to LobsterAI.',
      zh: '用一句话定制 LobsterAI 外观，AI 会生成专属背景与徽记、匹配界面配色并自动应用。',
    },
    icon: SkinPackKitMetadata.IconUrl,
    author: 'LobsterAI',
    version: SkinPackKitMetadata.Version,
    workflowKind: SkinPackKitMetadata.WorkflowKind,
    tryAsking: [
      SKIN_PACK_STARTER_PROMPT,
      {
        en: 'Turn LobsterAI into a blue-and-white championship night: a legendary number 10 lifting the world trophy in golden confetti, full of passion, glory, and collectible fan-memento energy',
        zh: '把 LobsterAI 变成蓝白冠军之夜：传奇 10 号在金色纸雨中高举世界冠军奖杯，热血、荣耀，像一件值得收藏的球迷纪念品',
      },
      {
        en: 'Turn LobsterAI into a bright, airy red-and-gold prosperity theme with a dignified, welcoming East Asian God of Wealth as the main visual. Use generous ivory and warm-cream space, with vermilion, gold, auspicious clouds, and flowing golden lines as accents—festive and luxurious without feeling gaudy, for market analysis, investment research, and daily reviews',
        zh: '把 LobsterAI 打造成明亮通透的红金招财主题：一位威严亲和的东方财神作为主视觉，以大面积象牙白和暖米色为画布，朱红、金色、祥云与流动金线作为点缀，喜庆华贵但不俗艳，适合行情分析、投资研究与每日复盘',
      },
      {
        en: 'Design a fan tribute look with a sea of red lights and refined East Asian stage aesthetics: a gentle young actor-singer silhouette, silver spotlights, and an elegant commemorative mood',
        zh: '设计一套红色灯海与东方舞台美学的应援外观：青年演员歌手的温柔剪影、银色追光和克制高级的纪念感',
      },
      {
        en: 'Turn LobsterAI into a bright post-rain morning study with an orange cat: creamy white, pale wood, soft daylight, and green plants by the window, fresh, quiet, comforting, and suited to reading, learning, and everyday work',
        zh: '把 LobsterAI 打造成一间有橘猫陪伴的雨后清晨书房：奶油白、浅木色、柔和天光和窗边绿植，空气清新、安静治愈，整体明亮轻盈，适合阅读、学习与日常工作',
      },
      {
        en: 'Turn LobsterAI into a deep-blue data and automation command center with abstract trend light trails, precise grids, and amber status lights, built for coding, analysis, market monitoring, and long-running tasks',
        zh: '把 LobsterAI 变成深蓝数据与自动化指挥舱：抽象趋势光轨、精密网格和琥珀色状态灯，适合代码、分析、盯盘与长期任务',
      },
      {
        en: 'Create a bright cream-white and champagne-gold brand-studio look for content creators with airy daylight photography, lightweight editorial collage, and refined product displays—clean, polished, and suited to image, video, and ecommerce creation',
        zh: '为内容创作者打造一套明亮的奶油白与香槟金品牌工作室外观：通透摄影棚日光、轻盈杂志拼贴和精致商品陈列，干净高级，适合图片、视频与电商创作',
      },
    ],
    skills: {
      bundle: SkinPackKitBundle.BuiltIn,
      list: [SKIN_CREATOR_SKILL_METADATA],
    },
    mcpServers: [],
    connectors: [],
  };
}

export function buildInstalledSkinPackKitRecord(): InstalledKitRecord {
  return {
    id: SkinPackKitId.BuiltIn,
    version: SkinPackKitMetadata.Version,
    installedAt: Date.now(),
    workflowKind: SkinPackKitMetadata.WorkflowKind,
    skills: {
      skillIds: [SkinPackSkillId.BuiltIn],
      metadata: {
        [SkinPackSkillId.BuiltIn]: SKIN_CREATOR_SKILL_METADATA,
      },
    },
    mcpServers: [],
    connectors: [],
  };
}
