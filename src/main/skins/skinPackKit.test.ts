import { describe, expect, test } from 'vitest';

import { SkinWorkflowKind } from '../../shared/skin/constants';
import {
  SkinPackKitBundle,
  SkinPackKitId,
  SkinPackKitMetadata,
  SkinPackSkillId,
} from '../../shared/skin/kit';
import {
  buildInstalledSkinPackKitRecord,
  buildSkinPackMarketplaceKit,
} from './skinPackKit';

describe('AI Skin Designer built-in kit', () => {
  test('publishes only the bundled skin creator skill', () => {
    const kit = buildSkinPackMarketplaceKit() as {
      id: string;
      name: { en: string; zh: string };
      description: { en: string; zh: string };
      icon: string;
      version: string;
      workflowKind: string;
      tryAsking: Array<{ en: string; zh: string }>;
      skills: {
        bundle: string;
        list: Array<{
          id: string;
          name: { en: string; zh: string };
        }>;
      };
      mcpServers: unknown[];
      connectors: unknown[];
    };

    expect(kit).toMatchObject({
      id: SkinPackKitId.BuiltIn,
      name: {
        en: 'Customize LobsterAI',
        zh: 'LobsterAI 外观定制',
      },
      description: {
        zh: '用一句话定制 LobsterAI 外观，AI 会生成专属背景与徽记、匹配界面配色并自动应用。',
      },
      icon: SkinPackKitMetadata.IconUrl,
      version: SkinPackKitMetadata.Version,
      workflowKind: SkinWorkflowKind.SkinPack,
      skills: {
        bundle: SkinPackKitBundle.BuiltIn,
        list: [{
          id: SkinPackSkillId.BuiltIn,
          name: {
            en: 'AI Appearance Designer',
            zh: 'AI 外观设计',
          },
        }],
      },
      mcpServers: [],
      connectors: [],
    });
    expect(kit.version).toBe('0.3.0');
    expect(kit.tryAsking).toHaveLength(7);
    expect(kit.tryAsking.map(prompt => prompt.zh)).toEqual([
      '请为 LobsterAI 创建一套以 {主色与辅助色} 为主色调、以 {主题或人物} 为视觉中心的 AI 皮肤；画面呈现 {场景与氛围}，并适合 {使用场景或用途}。请据此生成协调的背景、徽记和界面配色，并自动应用到 LobsterAI。',
      '把 LobsterAI 变成蓝白冠军之夜：传奇 10 号在金色纸雨中高举世界冠军奖杯，热血、荣耀，像一件值得收藏的球迷纪念品',
      '把 LobsterAI 打造成明亮通透的红金招财主题：一位威严亲和的东方财神作为主视觉，以大面积象牙白和暖米色为画布，朱红、金色、祥云与流动金线作为点缀，喜庆华贵但不俗艳，适合行情分析、投资研究与每日复盘',
      '设计一套红色灯海与东方舞台美学的应援外观：青年演员歌手的温柔剪影、银色追光和克制高级的纪念感',
      '把 LobsterAI 打造成一间有橘猫陪伴的雨后清晨书房：奶油白、浅木色、柔和天光和窗边绿植，空气清新、安静治愈，整体明亮轻盈，适合阅读、学习与日常工作',
      '把 LobsterAI 变成深蓝数据与自动化指挥舱：抽象趋势光轨、精密网格和琥珀色状态灯，适合代码、分析、盯盘与长期任务',
      '为内容创作者打造一套明亮的奶油白与香槟金品牌工作室外观：通透摄影棚日光、轻盈杂志拼贴和精致商品陈列，干净高级，适合图片、视频与电商创作',
    ]);
    expect(kit.tryAsking[0].en.match(/\{[^}]+\}/g)).toHaveLength(4);
    expect(kit.tryAsking[0].zh.match(/\{[^}]+\}/g)).toHaveLength(4);
    expect(kit.tryAsking[0].zh).not.toContain('留空');
    expect(kit.skills.list).toHaveLength(1);
  });

  test('persists the trusted workflow marker with the fixed skill id', () => {
    const record = buildInstalledSkinPackKitRecord();

    expect(record).toMatchObject({
      id: SkinPackKitId.BuiltIn,
      version: SkinPackKitMetadata.Version,
      workflowKind: SkinWorkflowKind.SkinPack,
      skills: {
        skillIds: [SkinPackSkillId.BuiltIn],
      },
      mcpServers: [],
      connectors: [],
    });
  });
});
