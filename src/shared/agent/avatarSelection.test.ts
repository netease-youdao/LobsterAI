import { describe, expect, test } from 'vitest';

import { AgentAvatarSvg, DefaultAgentAvatar, DefaultAgentAvatarIcon, encodeAgentAvatarIcon } from './avatar';
import {
  AgentCreateIconSource,
  matchAgentAvatarSvgByTitle,
  pickRandomAgentAvatarIcon,
  pickRandomAgentAvatarSvg,
  resolveAgentIconOnAiDraft,
  resolveAgentIconOnTitleChange,
} from './avatarSelection';

describe('pickRandomAgentAvatarSvg', () => {
  test('avoids the default lobster icon while other icons are available', () => {
    const picked = new Set<AgentAvatarSvg>();
    for (let i = 0; i < 60; i += 1) {
      picked.add(pickRandomAgentAvatarSvg({ random: () => i / 60 }));
    }

    expect(picked.has(DefaultAgentAvatar.svg)).toBe(false);
    expect(picked.size).toBe(Object.values(AgentAvatarSvg).length - 1);
  });

  test('prefers icons not already used by existing agents and excludes the previous roll', () => {
    const allNonDefault = Object.values(AgentAvatarSvg).filter(svg => svg !== DefaultAgentAvatar.svg);
    const keepUnused = allNonDefault.slice(0, 2);
    const existingIcons = [
      DefaultAgentAvatarIcon,
      ...allNonDefault.slice(2).map(svg => encodeAgentAvatarIcon({ svg })),
    ];

    const first = pickRandomAgentAvatarSvg({ existingIcons, random: () => 0 });
    expect(keepUnused).toContain(first);

    const second = pickRandomAgentAvatarSvg({
      existingIcons,
      excludeIcon: encodeAgentAvatarIcon({ svg: first }),
      random: () => 0,
    });
    expect(second).not.toBe(first);
    expect(keepUnused).toContain(second);
  });

  test('falls back cleanly when every non-default icon is already in use', () => {
    const allIcons = Object.values(AgentAvatarSvg).map(svg => encodeAgentAvatarIcon({ svg }));
    const excluded = encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Code });

    const picked = pickRandomAgentAvatarSvg({
      existingIcons: allIcons,
      excludeIcon: excluded,
      random: () => 0,
    });

    expect(picked).not.toBe(DefaultAgentAvatar.svg);
    expect(picked).not.toBe(AgentAvatarSvg.Code);
  });

  test('handles boundary PRNG values safely', () => {
    const iconAtOne = pickRandomAgentAvatarIcon({ random: () => 1 });
    const iconAtNaN = pickRandomAgentAvatarIcon({ random: () => Number.NaN });
    expect(iconAtOne.startsWith('agent-avatar-svg:')).toBe(true);
    expect(iconAtNaN.startsWith('agent-avatar-svg:')).toBe(true);
    expect(iconAtOne).not.toBe(DefaultAgentAvatarIcon);
  });
});

describe('matchAgentAvatarSvgByTitle', () => {
  test.each([
    ['Python 代码助手', AgentAvatarSvg.Code],
    ['前端开发专家', AgentAvatarSvg.Code],
    ['CodeReviewer', AgentAvatarSvg.Code],
    ['C++ 后端服务', AgentAvatarSvg.Code],
    ['Bug 排查助手', AgentAvatarSvg.Repair],
    ['DevOps 运维专家', AgentAvatarSvg.Repair],
    ['求职面试顾问', AgentAvatarSvg.Briefcase],
    ['Career Coach', AgentAvatarSvg.Briefcase],
    ['天猫电商选品', AgentAvatarSvg.ShoppingCart],
    ['财务数据分析', AgentAvatarSvg.Data],
    ['Stock Analyst', AgentAvatarSvg.Data],
    ['周报整理助手', AgentAvatarSvg.Document],
    ['PPT 汇报助手', AgentAvatarSvg.Document],
    ['Obsidian Vault', AgentAvatarSvg.Folder],
    ['个人记账预算', AgentAvatarSvg.Tag],
    ['产品规划师', AgentAvatarSvg.Brain],
    ['学术论文辅导', AgentAvatarSvg.GraduationCap],
    ['行业研究专家', AgentAvatarSvg.Books],
    ['生物实验室助手', AgentAvatarSvg.Experiment],
    ['体检报告解读', AgentAvatarSvg.Diagnosis],
    ['法律合同审查', AgentAvatarSvg.Scales],
    ['英语翻译官', AgentAvatarSvg.Translation],
    ['i18n Translator', AgentAvatarSvg.Translation],
    ['公众号文案写作', AgentAvatarSvg.Creation],
    ['UI/UX 设计助手', AgentAvatarSvg.Artboard],
    ['吉他作曲老师', AgentAvatarSvg.Music],
    ['电影推荐官', AgentAvatarSvg.Entertainment],
    ['播客字幕转写', AgentAvatarSvg.Headphones],
    ['小红书爆款运营', AgentAvatarSvg.Inspiration],
    ['自动化工作流', AgentAvatarSvg.Lightning],
    ['日本旅行攻略', AgentAvatarSvg.Travel],
    ['减脂健身教练', AgentAvatarSvg.Fitness],
    ['助眠冥想引导', AgentAvatarSvg.Meditation],
    ['情感陪伴树洞', AgentAvatarSvg.Heart],
    ['阳台养花绿植', AgentAvatarSvg.PottedPlant],
    ['猫咪护理管家', AgentAvatarSvg.Pet],
    ['宠物医生', AgentAvatarSvg.Pet],
    ['小龙虾助手', AgentAvatarSvg.Lobster],
  ])('matches "%s" to %s', (title, expected) => {
    expect(matchAgentAvatarSvgByTitle(title)).toBe(expected);
  });

  test('returns null for blank or generic titles without domain signals', () => {
    expect(matchAgentAvatarSvgByTitle('')).toBeNull();
    expect(matchAgentAvatarSvgByTitle('   ')).toBeNull();
    expect(matchAgentAvatarSvgByTitle('我的助手')).toBeNull();
    expect(matchAgentAvatarSvgByTitle('Project Alpha')).toBeNull();
    expect(matchAgentAvatarSvgByTitle('Snippet Helper')).toBeNull();
  });

  test('avoids ASCII substring false positives', () => {
    expect(matchAgentAvatarSvgByTitle('Doctor Helper')).toBe(AgentAvatarSvg.Diagnosis);
    expect(matchAgentAvatarSvgByTitle('Category Manager')).toBe(AgentAvatarSvg.Briefcase);
    expect(matchAgentAvatarSvgByTitle('Smart Chart')).toBe(AgentAvatarSvg.Data);
    expect(matchAgentAvatarSvgByTitle('Email Writer')).toBe(AgentAvatarSvg.Creation);
  });
});

describe('resolveAgentIconOnTitleChange', () => {
  const initialIcon = encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Inspiration });

  test('switches from initial random icon to matched icon and reverts when cleared', () => {
    const matched = resolveAgentIconOnTitleChange({
      title: '英语翻译助手',
      initialIcon,
      currentIcon: initialIcon,
      currentSource: AgentCreateIconSource.InitialRandom,
    });
    expect(matched).toEqual({
      icon: encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Translation }),
      source: AgentCreateIconSource.TitleMatch,
    });

    const reverted = resolveAgentIconOnTitleChange({
      title: '我的小助手',
      initialIcon,
      currentIcon: matched.icon,
      currentSource: matched.source,
    });
    expect(reverted).toEqual({
      icon: initialIcon,
      source: AgentCreateIconSource.InitialRandom,
    });
  });

  test('preserves manually customized and AI-drafted icons when title edits occur', () => {
    const customIcon = encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Heart });
    expect(resolveAgentIconOnTitleChange({
      title: 'Python 编程助手',
      initialIcon,
      currentIcon: customIcon,
      currentSource: AgentCreateIconSource.UserCustom,
    })).toEqual({
      icon: customIcon,
      source: AgentCreateIconSource.UserCustom,
    });

    const aiIcon = encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Books });
    expect(resolveAgentIconOnTitleChange({
      title: 'Python 编程助手',
      initialIcon,
      currentIcon: aiIcon,
      currentSource: AgentCreateIconSource.AiDraft,
    })).toEqual({
      icon: aiIcon,
      source: AgentCreateIconSource.AiDraft,
    });
  });
});

describe('resolveAgentIconOnAiDraft', () => {
  const initialIcon = encodeAgentAvatarIcon({ svg: AgentAvatarSvg.PottedPlant });

  test('applies AI draft avatar unless user manually customized the icon', () => {
    expect(resolveAgentIconOnAiDraft({
      draftAvatarSvg: AgentAvatarSvg.Data,
      draftName: '周报助手',
      currentIcon: initialIcon,
      currentSource: AgentCreateIconSource.InitialRandom,
    })).toEqual({
      icon: encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Data }),
      source: AgentCreateIconSource.AiDraft,
    });

    const customIcon = encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Heart });
    expect(resolveAgentIconOnAiDraft({
      draftAvatarSvg: AgentAvatarSvg.Data,
      draftName: '周报助手',
      currentIcon: customIcon,
      currentSource: AgentCreateIconSource.UserCustom,
    })).toEqual({
      icon: customIcon,
      source: AgentCreateIconSource.UserCustom,
    });
  });

  test('falls back to matching draft name when AI draft omits avatarSvg', () => {
    expect(resolveAgentIconOnAiDraft({
      draftName: '周报助手',
      currentIcon: initialIcon,
      currentSource: AgentCreateIconSource.InitialRandom,
    })).toEqual({
      icon: encodeAgentAvatarIcon({ svg: AgentAvatarSvg.Document }),
      source: AgentCreateIconSource.TitleMatch,
    });
  });
});
