import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, test } from 'vitest';

const HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/persona-helpers.mjs'),
).href;

type PersonaHelpers = {
  MAX_INLINE_MEMORY_CHARS: number;
  MEMORY_WRITE_POLICY_PROMPT: string;
  stripLegacyOpenClawAgentsBoilerplate: (content: string) => string;
  sanitizeMemoryMarkdownForPrompt: (content: string, maxChars?: number) => string;
  parseSkillFrontmatter: (markdown: string) => { meta: Record<string, string>; body: string };
  filterMarkdownForProject: (
    markdown: string,
    activeProjectKeys?: readonly string[],
    options?: { stripTags?: boolean; globalOnly?: boolean },
  ) => string;
  resolveProjectMemoryKeys: (cwd?: string | null) => string[];
  assembleWorkspacePersona: (
    workspacesDir: string,
    agentId: string,
    customSystemPrompt?: string,
    options?: { workspaceDir?: string; memoryEnabled?: boolean },
  ) => string;
};

let cachedHelpers: PersonaHelpers | null = null;
async function loadHelpers(): Promise<PersonaHelpers> {
  if (!cachedHelpers) {
    cachedHelpers = (await import(HELPERS_URL)) as PersonaHelpers;
  }
  return cachedHelpers;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('persona-helpers', () => {
  test('parses YAML multiline block scalars and folded scalars in SKILL.md frontmatter', async () => {
    const { parseSkillFrontmatter } = await loadHelpers();

    const literalBlock = [
      '---',
      'name: article-writer',
      'description: |',
      '  Multi-style article creation skill.',
      '  Supports 5 writing styles.',
      'official: true',
      '---',
      '',
      '# Body',
    ].join('\n');

    const parsedLiteral = parseSkillFrontmatter(literalBlock);
    expect(parsedLiteral.meta.name).toBe('article-writer');
    expect(parsedLiteral.meta.description).toBe(
      'Multi-style article creation skill.\nSupports 5 writing styles.',
    );
    expect(parsedLiteral.body.trim()).toBe('# Body');

    const foldedBlock = [
      '---',
      'name: folded-skill',
      'description: >-',
      '  First line of description',
      '  second line of description.',
      '---',
      'body',
    ].join('\n');

    const parsedFolded = parseSkillFrontmatter(foldedBlock);
    expect(parsedFolded.meta.description).toBe('First line of description second line of description.');
  });

  test('strips OpenClaw stock AGENTS.md boilerplate and memory-promotion HTML comments while keeping user content', async () => {
    const {
      stripLegacyOpenClawAgentsBoilerplate,
      sanitizeMemoryMarkdownForPrompt,
      assembleWorkspacePersona,
    } = await loadHelpers();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-persona-'));
    tempDirs.push(dir);
    const agentDir = path.join(dir, 'main');
    fs.mkdirSync(agentDir, { recursive: true });

    fs.writeFileSync(path.join(agentDir, 'SOUL.md'), '简洁专业', 'utf8');
    fs.writeFileSync(path.join(agentDir, 'IDENTITY.md'), '你是 LobsterAI', 'utf8');
    fs.writeFileSync(
      path.join(agentDir, 'AGENTS.md'),
      [
        '# AGENTS.md - Your Workspace',
        '',
        'This folder is home. Treat it that way.',
        '',
        '## First Run',
        'If `BOOTSTRAP.md` exists, follow it.',
        '',
        '## Make It Yours',
        '',
        'This is a starting point. Add your own conventions, style, and rules as you figure out what works.',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentDir, 'MEMORY.md'),
      [
        '# User Memories',
        '- 喜欢简洁中文回复',
        '',
        '<!-- openclaw-memory-promotion:memory:memory/2026-06-23.md:74:74 -->',
        '- 常用 macOS',
      ].join('\n'),
      'utf8',
    );

    expect(stripLegacyOpenClawAgentsBoilerplate('# AGENTS.md — 业务规则\n- 保持中文')).toBe(
      '# AGENTS.md — 业务规则\n- 保持中文',
    );
    expect(
      sanitizeMemoryMarkdownForPrompt('<!-- openclaw-memory-promotion:foo -->\n- 事实A'),
    ).toBe('- 事实A');

    const assembled = assembleWorkspacePersona(dir, 'main', '# 回复风格\n- 简洁直接');
    expect(assembled).toContain('## 角色设定\n\n简洁专业');
    expect(assembled).toContain('## 身份信息\n\n你是 LobsterAI');
    expect(assembled).toContain('## 长期记忆');
    expect(assembled).toContain('- 喜欢简洁中文回复');
    expect(assembled).not.toContain('openclaw-memory-promotion');
    expect(assembled).not.toContain('BOOTSTRAP.md');
    expect(assembled).not.toContain('## 工作区指令');
    expect(assembled).not.toContain('Persona (SOUL.md)');
    expect(assembled).toContain('# 回复风格\n- 简洁直接');
  });

  test('enforces inline MEMORY.md character budget and appends retrieval hint when truncated', async () => {
    const { MAX_INLINE_MEMORY_CHARS, sanitizeMemoryMarkdownForPrompt } = await loadHelpers();

    expect(MAX_INLINE_MEMORY_CHARS).toBe(3000);

    const shortContent = '# User Memories\n- 偏好中文回复\n- 使用 macOS';
    expect(sanitizeMemoryMarkdownForPrompt(shortContent)).toBe(shortContent);

    const longLines = Array.from({ length: 120 }, (_, idx) => (
      `- 记忆条目 ${String(idx + 1).padStart(3, '0')}：这是一条用于验证内联长度上限的历史长期记忆内容。`
    ));
    const longContent = longLines.join('\n');
    expect(longContent.length).toBeGreaterThan(MAX_INLINE_MEMORY_CHARS);

    const truncated = sanitizeMemoryMarkdownForPrompt(longContent);
    expect(truncated).toContain('lobster_memory_search');
    expect(truncated).toContain('lobster_memory_get');
    // Body before the truncation notice should stay within budget and break on a line boundary.
    const [bodyPart] = truncated.split('\n\n（长期记忆较长');
    expect(bodyPart.length).toBeLessThanOrEqual(MAX_INLINE_MEMORY_CHARS);
    expect(bodyPart.endsWith('历史长期记忆内容。')).toBe(true);
  });

  test('shares main global preferences with non-main experts while isolating expert private and foreign project memories', async () => {
    const {
      assembleWorkspacePersona,
      MEMORY_WRITE_POLICY_PROMPT,
      resolveProjectMemoryKeys,
    } = await loadHelpers();

    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-persona-iso-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-persona-proj-a-'));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-persona-proj-b-'));
    tempDirs.push(wsRoot, projA, projB);

    fs.mkdirSync(path.join(projA, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(projA, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n',
      'utf8',
    );
    expect(resolveProjectMemoryKeys(projA)).toContain('github.com/acme/alpha');

    // Seed main + expert-a + expert-b workspaces.
    for (const id of ['main', 'expert-a', 'expert-b']) {
      fs.mkdirSync(path.join(wsRoot, id), { recursive: true });
    }
    fs.writeFileSync(
      path.join(wsRoot, 'main', 'USER.md'),
      '# Profile\n- Global user prefers concise bullet points\n- Project A main-only user note <!-- project: github.com/acme/alpha -->\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(wsRoot, 'main', 'MEMORY.md'),
      '# User Memories\n- Always respond in Chinese\n- Main Project A build rule <!-- project: github.com/acme/alpha -->\n',
      'utf8',
    );
    fs.writeFileSync(path.join(wsRoot, 'expert-a', 'SOUL.md'), 'You are Expert A.', 'utf8');
    fs.writeFileSync(
      path.join(wsRoot, 'expert-a', 'MEMORY.md'),
      [
        '# User Memories',
        '- Expert A private codename: FALCON',
        `- Project A convention: run pnpm check:alpha <!-- project: path:${projA} -->`,
        '- Git-tagged Alpha rule: use strict ESM <!-- project: github.com/acme/alpha -->',
        `- Project B convention: run make beta <!-- project: path:${projB} -->`,
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(wsRoot, 'expert-b', 'SOUL.md'), 'You are Expert B.', 'utf8');
    fs.writeFileSync(
      path.join(wsRoot, 'expert-b', 'MEMORY.md'),
      '# User Memories\n- Expert B private codename: DOLPHIN\n',
      'utf8',
    );

    // Expert A in Project A: global prefs + FALCON + Project A rules, never DOLPHIN or Project B or main project tags.
    const promptExpAInA = assembleWorkspacePersona(wsRoot, 'expert-a', '', { workspaceDir: projA });
    expect(promptExpAInA).toContain('## Global User Preferences');
    expect(promptExpAInA).toContain('Global user prefers concise bullet points');
    expect(promptExpAInA).toContain('## Global Memory');
    expect(promptExpAInA).toContain('Always respond in Chinese');
    expect(promptExpAInA).toContain('FALCON');
    expect(promptExpAInA).toContain('run pnpm check:alpha');
    expect(promptExpAInA).toContain('use strict ESM');
    expect(promptExpAInA).not.toContain('DOLPHIN');
    expect(promptExpAInA).not.toContain('make beta');
    expect(promptExpAInA).not.toContain('Main Project A build rule');
    expect(promptExpAInA).not.toContain('Project A main-only user note');
    expect(promptExpAInA).not.toContain('<!-- project:');

    // Expert A in Project B: global prefs + FALCON + Project B rule, NEVER Project A rules.
    const promptExpAInB = assembleWorkspacePersona(wsRoot, 'expert-a', '', { workspaceDir: projB });
    expect(promptExpAInB).toContain('Global user prefers concise bullet points');
    expect(promptExpAInB).toContain('FALCON');
    expect(promptExpAInB).toContain('run make beta');
    expect(promptExpAInB).not.toContain('pnpm check:alpha');
    expect(promptExpAInB).not.toContain('use strict ESM');

    // Expert B in Project B: global prefs + DOLPHIN, NEVER FALCON.
    const promptExpBInB = assembleWorkspacePersona(wsRoot, 'expert-b', '', { workspaceDir: projB });
    expect(promptExpBInB).toContain('Global user prefers concise bullet points');
    expect(promptExpBInB).toContain('Always respond in Chinese');
    expect(promptExpBInB).toContain('DOLPHIN');
    expect(promptExpBInB).not.toContain('FALCON');

    // memoryEnabled: false omits all memory & user preference sections while keeping SOUL.md.
    const promptDisabled = assembleWorkspacePersona(wsRoot, 'expert-a', 'Custom rule', {
      workspaceDir: projA,
      memoryEnabled: false,
    });
    expect(promptDisabled).toContain('You are Expert A.');
    expect(promptDisabled).toContain('Custom rule');
    expect(promptDisabled).not.toContain('Global User Preferences');
    expect(promptDisabled).not.toContain('Global Memory');
    expect(promptDisabled).not.toContain('FALCON');
    expect(promptDisabled).not.toContain('concise bullet points');

    // Write policy prompt covers write-before-confirm and both scopes.
    expect(MEMORY_WRITE_POLICY_PROMPT).toContain('lobster_memory_save');
    expect(MEMORY_WRITE_POLICY_PROMPT).toContain('scope: "project"');
    expect(MEMORY_WRITE_POLICY_PROMPT).toContain('scope: "global"');
  });
});
