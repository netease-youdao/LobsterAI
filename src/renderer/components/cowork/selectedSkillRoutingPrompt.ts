import type { Skill } from '../../types/skill';

export const getSkillDirectoryFromPath = (skillPath: string): string => {
  const normalized = skillPath.trim().replace(/\\/g, '/');
  return normalized.replace(/\/SKILL\.md$/i, '') || normalized;
};

const escapeXmlText = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const WEB_SEARCH_SKILL_ID = 'web-search';

const isRoutableSkill = (skill: Skill): boolean =>
  skill.enabled && skill.skillPath.trim().length > 0;

export const buildSelectedSkillRoutingPrompt = (skills: Skill[]): string | undefined => {
  const selectedSkills = skills.filter(isRoutableSkill);
  if (selectedSkills.length === 0) return undefined;

  const hasWebSearch = selectedSkills.some(skill => skill.id === WEB_SEARCH_SKILL_ID);
  const regularSkills = selectedSkills.filter(skill => skill.id !== WEB_SEARCH_SKILL_ID);

  const sections: string[] = [];

  if (hasWebSearch) {
    sections.push([
      '## 本轮联网搜索',
      '用户已指定本轮使用联网搜索：请直接调用内置 `web_search` 工具检索最新信息（无需调用 `skill` 工具加载 `web-search` 文档）。',
    ].join('\n'));
  }

  if (regularSkills.length > 0) {
    const skillEntries = regularSkills.map((skill) => {
      const location = skill.skillPath.trim();
      return [
        '  <skill>',
        `    <id>${escapeXmlText(skill.id)}</id>`,
        `    <name>${escapeXmlText(skill.name)}</name>`,
        `    <description>${escapeXmlText(skill.description)}</description>`,
        `    <location>${escapeXmlText(location)}</location>`,
        `    <directory>${escapeXmlText(getSkillDirectoryFromPath(location))}</directory>`,
        '  </skill>',
      ].join('\n');
    });

    sections.push([
      '## 本轮已选技能',
      '用户指定以下技能作为本轮优先候选：',
      '- 若有明确适用的技能，请优先调用 `skill` 工具按 `<id>` 加载（或读取 `<location>` 处的 SKILL.md）后再执行；多选时优先最具体的技能，不要一次性预读全部技能。',
      '- 若均不适用，可忽略本区块并按常规流程处理。技能内的相对路径请基于对应 `<directory>` 解析。',
      '',
      '<selected_skills>',
      ...skillEntries,
      '</selected_skills>',
    ].join('\n'));
  }

  return sections.join('\n\n');
};
