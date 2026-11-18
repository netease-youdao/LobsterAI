import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { prettifySkillName } from './skill';

describe('prettifySkillName', () => {
  test('turns kebab-case ids into title case', () => {
    expect(prettifySkillName('canvas-design')).toBe('Canvas Design');
    expect(prettifySkillName('web_search')).toBe('Web Search');
    expect(prettifySkillName('a.b.c')).toBe('A B C');
  });

  test('capitalizes a single word', () => {
    expect(prettifySkillName('weather')).toBe('Weather');
  });

  test('keeps known acronyms uppercase', () => {
    expect(prettifySkillName('hr-recruitment')).toBe('HR Recruitment');
    expect(prettifySkillName('ai-seo')).toBe('AI SEO');
    expect(prettifySkillName('pdf')).toBe('PDF');
  });

  test('leaves names that already read as titles untouched', () => {
    expect(prettifySkillName('Stock Analyzer')).toBe('Stock Analyzer');
  });

  test('leaves non-ASCII names untouched', () => {
    expect(prettifySkillName('股票分析')).toBe('股票分析');
    expect(prettifySkillName('画布-设计')).toBe('画布-设计');
  });

  test('collapses repeated separators instead of emitting blanks', () => {
    expect(prettifySkillName('a--b')).toBe('A B');
  });

  test('handles empty and whitespace-only input', () => {
    expect(prettifySkillName('')).toBe('');
    expect(prettifySkillName('   ')).toBe('');
  });
});

describe('getLocalizedSkillName', () => {
  const legacySkills = [
    { id: 'canvas-design', name: 'canvas-design', zh: '画布设计', en: 'Canvas Design' },
    { id: 'create-plan', name: 'create-plan', zh: '计划生成', en: 'Create Plan' },
    { id: 'develop-web-game', name: 'develop-web-game', zh: '网页游戏开发', en: 'Web Game Development' },
    { id: 'playwright', name: 'playwright', zh: 'Playwright 自动化', en: 'Playwright' },
    { id: 'seedance', name: 'seedance', zh: 'Seedance 视频生成', en: 'Seedance' },
    { id: 'seedream', name: 'seedream', zh: 'Seedream 图像生成', en: 'Seedream' },
    { id: 'skill-vetter', name: 'skill-vetter', zh: '技能安全审查', en: 'Skill Vetter' },
    { id: 'technology-news-search', name: 'technology-search', zh: '科技新闻检索', en: 'Tech News Search' },
  ];
  const fetchMarketplace = vi.fn();
  let service: typeof import('./skill')['skillService'];
  let i18n: typeof import('./i18n')['i18nService'];

  beforeEach(async () => {
    // Each case starts without cached marketplace metadata, as on an offline launch.
    vi.resetModules();
    fetchMarketplace.mockReset();
    vi.stubGlobal('window', { electron: { skills: { fetchMarketplace } } });
    service = (await import('./skill')).skillService;
    i18n = (await import('./i18n')).i18nService;
    vi.spyOn(i18n, 'getLanguage').mockReturnValue('zh');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test.each(legacySkills)('preserves offline display names for $id in both languages', ({ id, name, zh, en }) => {
    expect(service.getLocalizedSkillName(id, name)).toBe(zh);
    vi.mocked(i18n.getLanguage).mockReturnValue('en');
    expect(service.getLocalizedSkillName(id, name)).toBe(en);
    expect(fetchMarketplace).not.toHaveBeenCalled();
  });

  test('preserves legacy names when the marketplace request fails', async () => {
    fetchMarketplace.mockResolvedValue({ success: false, error: 'Offline' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await service.fetchMarketplaceSkills()).toEqual({ skills: [], tags: [] });

    expect(fetchMarketplace).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    for (const { id, name, zh } of legacySkills) {
      expect(service.getLocalizedSkillName(id, name)).toBe(zh);
    }
  });

  test('preserves legacy names when the catalog has no display names', async () => {
    fetchMarketplace.mockResolvedValue({
      success: true,
      data: JSON.stringify({ data: { value: { localSkill: legacySkills.map(({ id, name }) => ({ id, name })) } } }),
    });

    await service.fetchMarketplaceSkills();

    for (const { id, name, zh } of legacySkills) {
      expect(service.getLocalizedSkillName(id, name)).toBe(zh);
    }
  });

  test.each(['localSkill', 'marketplace'] as const)('prefers %s metadata over legacy fallback names', async (source) => {
    const entries = legacySkills.map(({ id, name, zh, en }) => ({
      // The local catalog identifies technology-news-search by its frontmatter name.
      id: source === 'localSkill' ? name : id,
      name,
      displayName: { zh: `服务端 ${zh}`, en: `Server ${en}` },
    }));
    fetchMarketplace.mockResolvedValue({
      success: true,
      data: JSON.stringify({ data: { value: { [source]: entries } } }),
    });

    await service.fetchMarketplaceSkills();

    for (const { id, name, zh } of legacySkills) {
      expect(service.getLocalizedSkillName(id, name)).toBe(`服务端 ${zh}`);
    }
    vi.mocked(i18n.getLanguage).mockReturnValue('en');
    for (const { id, name, en } of legacySkills) {
      expect(service.getLocalizedSkillName(id, name)).toBe(`Server ${en}`);
    }
  });

  test('retains the existing fallbacks for current bundled and custom skills', () => {
    expect(service.getLocalizedSkillName('web-search', 'web-search')).toBe('联网搜索');
    expect(service.getLocalizedSkillName('custom-skill', 'custom-skill')).toBe('Custom Skill');
  });
});
