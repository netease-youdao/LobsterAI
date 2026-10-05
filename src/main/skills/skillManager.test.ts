import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const nodeRuntimeMocks = vi.hoisted(() => ({
  resolveNodeRuntimeForSpawn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: vi.fn() } } },
}));

vi.mock('../libs/nodeRuntime', () => nodeRuntimeMocks);

import { __skillManagerTestUtils } from './skillManager';

const {
  parseFrontmatter,
  isTruthy,
  extractDescription,
  getSkillScriptRuntimeCandidates,
  SkillTempDirPrefix,
  resolveInstallFolderName,
  resolveInstallTarget,
  deriveNpmPackageBaseName,
  deriveZipUrlBaseName,
} = __skillManagerTestUtils;

afterEach(() => {
  nodeRuntimeMocks.resolveNodeRuntimeForSpawn.mockReset();
});

// ==================== parseFrontmatter ====================

test('parseFrontmatter: simple key-value pairs', () => {
  const raw = '---\nname: demo\ndescription: A simple skill\nofficial: true\n---\n# Content here\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('demo');
  expect(frontmatter.description).toBe('A simple skill');
  expect(frontmatter.official).toBe(true); // YAML parses 'true' as boolean
  expect(content.trim()).toBe('# Content here');
});

test('parseFrontmatter: block scalar with pipe (|)', () => {
  const raw = '---\nname: demo\ndescription: |\n  A multi-line description.\n  Second line.\n---\n# Content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('demo');
  expect(frontmatter.description).toBe('A multi-line description.\nSecond line.\n');
  expect(content.trim()).toBe('# Content');
});

test('parseFrontmatter: folded scalar with greater-than (>)', () => {
  const raw = '---\nname: demo\ndescription: >\n  A folded\n  description.\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('demo');
  expect(frontmatter.description).toBe('A folded description.\n');
});

test('parseFrontmatter: quoted strings', () => {
  const raw = '---\nname: "quoted name"\ndescription: \'single quoted\'\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('quoted name');
  expect(frontmatter.description).toBe('single quoted');
});

test('parseFrontmatter: nested objects', () => {
  const raw = '---\nname: demo\nmetadata:\n  short-description: A short desc\n  version: 2\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('demo');
  expect(frontmatter.metadata).toEqual({ 'short-description': 'A short desc', version: 2 });
});

test('parseFrontmatter: arrays', () => {
  const raw = '---\nname: demo\ntags:\n  - tool\n  - search\n  - web\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.tags).toEqual(['tool', 'search', 'web']);
});

test('parseFrontmatter: boolean values as native YAML booleans', () => {
  const raw = '---\nname: demo\nofficial: true\nisOfficial: false\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.official).toBe(true);
  expect(frontmatter.isOfficial).toBe(false);
});

test('parseFrontmatter: no frontmatter returns empty object and full content', () => {
  const raw = '# Just a heading\nSome content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter).toEqual({});
  expect(content).toBe(raw);
});

test('parseFrontmatter: empty frontmatter returns empty object', () => {
  const raw = '---\n\n---\n# Content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter).toEqual({});
  expect(content.trim()).toBe('# Content');
});

test('parseFrontmatter: BOM is stripped', () => {
  const raw = '\uFEFF---\nname: bom-test\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('bom-test');
});

test('parseFrontmatter: Windows line endings (CRLF)', () => {
  const raw = '---\r\nname: win\r\ndescription: windows\r\n---\r\n# Content\r\n';
  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('win');
  expect(frontmatter.description).toBe('windows');
});

test('parseFrontmatter: invalid YAML returns empty frontmatter gracefully', () => {
  const raw = '---\n: invalid\n  bad:\n    - [\n---\n# Content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter).toEqual({});
  expect(content).toMatch(/# Content/);
});

// ==================== isTruthy ====================

test('isTruthy: native boolean true', () => {
  expect(isTruthy(true)).toBe(true);
});

test('isTruthy: native boolean false', () => {
  expect(isTruthy(false)).toBe(false);
});

test('isTruthy: string "true"', () => {
  expect(isTruthy('true')).toBe(true);
  expect(isTruthy('True')).toBe(true);
  expect(isTruthy('TRUE')).toBe(true);
});

test('isTruthy: string "yes" and "1"', () => {
  expect(isTruthy('yes')).toBe(true);
  expect(isTruthy('1')).toBe(true);
});

test('isTruthy: string "false" and others', () => {
  expect(isTruthy('false')).toBe(false);
  expect(isTruthy('no')).toBe(false);
  expect(isTruthy('0')).toBe(false);
  expect(isTruthy('random')).toBe(false);
});

test('isTruthy: undefined and null', () => {
  expect(isTruthy(undefined)).toBe(false);
  expect(isTruthy(null)).toBe(false);
});

test('isTruthy: number and object', () => {
  expect(isTruthy(1)).toBe(false);
  expect(isTruthy({})).toBe(false);
});

// ==================== extractDescription ====================

test('extractDescription: extracts first non-empty line', () => {
  expect(extractDescription('\n\nFirst line\nSecond line\n')).toBe('First line');
});

test('extractDescription: strips markdown heading markers', () => {
  expect(extractDescription('## Heading\nContent')).toBe('Heading');
  expect(extractDescription('### Sub heading')).toBe('Sub heading');
});

test('extractDescription: returns empty string for empty content', () => {
  expect(extractDescription('')).toBe('');
  expect(extractDescription('\n\n\n')).toBe('');
});

test('getSkillScriptRuntimeCandidates delegates to shared node runtime resolution', () => {
  nodeRuntimeMocks.resolveNodeRuntimeForSpawn.mockReturnValue({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: [],
    env: {},
  });

  expect(getSkillScriptRuntimeCandidates({ PATH: 'ignored' })).toEqual([{
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: [],
    extraEnv: undefined,
  }]);
});

test('getSkillScriptRuntimeCandidates preserves Electron-as-node fallback env', () => {
  nodeRuntimeMocks.resolveNodeRuntimeForSpawn.mockReturnValue({
    command: 'C:\\LobsterAI\\LobsterAI.exe',
    args: [],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });

  expect(getSkillScriptRuntimeCandidates({ PATH: 'ignored' })).toEqual([{
    command: 'C:\\LobsterAI\\LobsterAI.exe',
    args: [],
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
  }]);
});

// ==================== Integration: real-world SKILL.md patterns ====================

test('integration: typical official skill frontmatter', () => {
  const raw = [
    '---',
    'name: docx',
    'description: "Comprehensive document creation, editing, and analysis"',
    'license: Proprietary. LICENSE.txt has complete terms',
    'official: true',
    '---',
    '',
    '# DOCX creation, editing, and analysis',
    'Detailed instructions here.',
  ].join('\n');

  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('docx');
  expect(frontmatter.description).toBe('Comprehensive document creation, editing, and analysis');
  expect(frontmatter.license).toBe('Proprietary. LICENSE.txt has complete terms');
  expect(isTruthy(frontmatter.official)).toBe(true);
  expect(content).toMatch(/# DOCX creation/);
});

test('integration: skill with metadata nested object', () => {
  const raw = [
    '---',
    'name: create-plan',
    'description: Create a concise plan',
    'official: true',
    'metadata:',
    '  short-description: Create a plan',
    '---',
    '',
    '# Create Plan',
  ].join('\n');

  const { frontmatter } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('create-plan');
  expect(frontmatter.metadata).toEqual({ 'short-description': 'Create a plan' });
});

test('integration: skill with block scalar description', () => {
  const raw = [
    '---',
    'name: demo',
    'description: |',
    '  A multi-line description.',
    '  Second line.',
    '---',
    '',
    '# Demo Skill',
  ].join('\n');

  const { frontmatter, content } = parseFrontmatter(raw);
  expect(frontmatter.name).toBe('demo');
  expect(String(frontmatter.description || '').trim()).toBe('A multi-line description.\nSecond line.');
  expect(content).toMatch(/# Demo Skill/);
});

// ==================== parseClawhubUrl ====================

/**
 * Unit tests for parseClawhubUrl in skillManager.ts.
 *
 * Logic is mirrored inline because skillManager.ts imports Electron APIs
 * which cannot be loaded outside the Electron main process.
 */

// ---------------------------------------------------------------------------
// Mirror of parseClawhubUrl from skillManager.ts
// ---------------------------------------------------------------------------

const parseClawhubUrl = (source: string): { name: string } | null => {
  try {
    const url = new URL(source);
    if (url.hostname !== 'clawhub.ai' && url.hostname !== 'www.clawhub.ai') return null;
    const segments = url.pathname.split('/').filter(Boolean);
    // Format: /skills/{owner}/{name}
    if (segments.length >= 3 && segments[0] === 'skills') {
      return { name: segments[2] };
    }
    // Format: /skills/{name}
    if (segments.length >= 2 && segments[0] === 'skills') {
      return { name: segments[1] };
    }
    // Format: /{owner}/{name} (no /skills/ prefix)
    if (segments.length >= 2) {
      return { name: segments[1] };
    }
    return null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// /{owner}/{name} format
// ---------------------------------------------------------------------------

test('clawhub: /{owner}/{name} extracts skill name', () => {
  expect(parseClawhubUrl('https://clawhub.ai/steipete/slack')).toEqual({ name: 'slack' });
});

test('clawhub: /{owner}/{name} with www prefix', () => {
  expect(parseClawhubUrl('https://www.clawhub.ai/steipete/slack')).toEqual({ name: 'slack' });
});

test('clawhub: /{owner}/{name} with trailing slash', () => {
  expect(parseClawhubUrl('https://clawhub.ai/anthropic/web-search/')).toEqual({ name: 'web-search' });
});

// ---------------------------------------------------------------------------
// /skills/{owner}/{name} format
// ---------------------------------------------------------------------------

test('clawhub: /skills/{owner}/{name} extracts skill name', () => {
  expect(parseClawhubUrl('https://clawhub.ai/skills/steipete/slack')).toEqual({ name: 'slack' });
});

test('clawhub: /skills/{owner}/{name} with trailing slash', () => {
  expect(parseClawhubUrl('https://clawhub.ai/skills/anthropic/web-search/')).toEqual({ name: 'web-search' });
});

// ---------------------------------------------------------------------------
// /skills/{name} format
// ---------------------------------------------------------------------------

test('clawhub: /skills/{name} extracts skill name', () => {
  expect(parseClawhubUrl('https://clawhub.ai/skills/slack')).toEqual({ name: 'slack' });
});

// ---------------------------------------------------------------------------
// Rejected inputs
// ---------------------------------------------------------------------------

test('clawhub: non-clawhub hostname returns null', () => {
  expect(parseClawhubUrl('https://github.com/steipete/slack')).toBeNull();
});

test('clawhub: root path returns null', () => {
  expect(parseClawhubUrl('https://clawhub.ai/')).toBeNull();
});

test('clawhub: single segment path returns null', () => {
  expect(parseClawhubUrl('https://clawhub.ai/about')).toBeNull();
});

test('clawhub: invalid URL returns null', () => {
  expect(parseClawhubUrl('not-a-url')).toBeNull();
});

test('clawhub: empty string returns null', () => {
  expect(parseClawhubUrl('')).toBeNull();
});

// ==================== install folder naming ====================

const writeSkillFixture = (dir: string, options: { skillMd?: string; meta?: unknown } = {}): string => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), options.skillMd ?? '# Untitled skill\n');
  if (options.meta !== undefined) {
    const meta = typeof options.meta === 'string' ? options.meta : JSON.stringify(options.meta);
    fs.writeFileSync(path.join(dir, '_meta.json'), meta);
  }
  return dir;
};

const skillMdNamed = (name: string): string => `---\nname: ${name}\ndescription: test skill\n---\n# Body\n`;

describe('skill install naming', () => {
  let fixtureRoot = '';

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-skill-install-name-'));
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const makeTempRoot = (prefix: string): string => fs.mkdtempSync(path.join(fixtureRoot, prefix));

  describe('resolveInstallFolderName', () => {
    test('keeps the name of a skill directory wrapped inside the extraction root', () => {
      const tempRoot = makeTempRoot(SkillTempDirPrefix.Zip);
      const skillDir = writeSkillFixture(path.join(tempRoot, 'skill-vetter'), {
        skillMd: skillMdNamed('Skill Vetter'),
        meta: { slug: 'other-slug' },
      });

      expect(resolveInstallFolderName(skillDir, { extractionRoots: [tempRoot], sourceName: 'download' }))
        .toBe('skill-vetter');
    });

    test('uses the _meta.json slug for a skill at the zip root', () => {
      const tempRoot = writeSkillFixture(makeTempRoot(SkillTempDirPrefix.Zip), {
        skillMd: skillMdNamed('desktop-computer-automation'),
        meta: { ownerId: 'owner-1', slug: 'midscene-computer-automation', version: '1.0.3' },
      });

      expect(resolveInstallFolderName(tempRoot, { extractionRoots: [tempRoot], sourceName: 'download' }))
        .toBe('midscene-computer-automation');
    });

    test.each([
      ['no _meta.json', undefined],
      ['_meta.json without slug', { version: '1.0.0' }],
      ['blank slug', { slug: '  ' }],
      ['malformed _meta.json', '{ not json'],
    ])('falls back to the frontmatter name with %s', (_label, meta) => {
      const tempRoot = writeSkillFixture(makeTempRoot(SkillTempDirPrefix.Zip), {
        skillMd: skillMdNamed('notebooklm'),
        meta,
      });

      expect(resolveInstallFolderName(tempRoot, { extractionRoots: [tempRoot], sourceName: 'download' }))
        .toBe('notebooklm');
    });

    test.each([
      ['no frontmatter', '# Just a heading\n'],
      ['invalid YAML frontmatter', '---\n: invalid\n  bad:\n    - [\n---\n# Body\n'],
      ['a name with no folder-safe characters', skillMdNamed('数据分析')],
    ])('falls back to the source name with %s', (_label, skillMd) => {
      const tempRoot = writeSkillFixture(makeTempRoot(SkillTempDirPrefix.Zip), { skillMd });

      expect(resolveInstallFolderName(tempRoot, { extractionRoots: [tempRoot], sourceName: 'data-tools v2' }))
        .toBe('data-tools-v2');
    });

    test('falls back to "skill" when no candidate is usable', () => {
      const tempRoot = writeSkillFixture(makeTempRoot(SkillTempDirPrefix.Zip));

      expect(resolveInstallFolderName(tempRoot, { extractionRoots: [tempRoot] })).toBe('skill');
    });

    test('normalizes the chosen candidate like any other folder name', () => {
      const tempRoot = writeSkillFixture(makeTempRoot(SkillTempDirPrefix.Zip), { meta: { slug: ' My Skill! ' } });

      expect(resolveInstallFolderName(tempRoot, { extractionRoots: [] })).toBe('My-Skill');
    });

    test.each(Object.values(SkillTempDirPrefix))('recognizes a %s temp root by its prefix alone', (prefix) => {
      const tempRoot = writeSkillFixture(makeTempRoot(prefix), { meta: { slug: 'skill-vetter' } });

      expect(resolveInstallFolderName(tempRoot, { extractionRoots: [] })).toBe('skill-vetter');
    });

    test.each([
      ['remote zip', path.join('remote-skill')],
      ['npm package', path.join('npm-extracted', 'package')],
    ])('treats a listed %s extraction root as unnamed', (_label, relativeDir) => {
      const tempRoot = makeTempRoot(SkillTempDirPrefix.Zip);
      const skillDir = writeSkillFixture(path.join(tempRoot, relativeDir), { skillMd: skillMdNamed('weather') });

      expect(resolveInstallFolderName(skillDir, { extractionRoots: [tempRoot, skillDir] })).toBe('weather');
    });

    test('keeps the name of an unlisted directory even if it looks like a layout folder', () => {
      const skillDir = writeSkillFixture(path.join(fixtureRoot, 'package'), { skillMd: skillMdNamed('weather') });

      expect(resolveInstallFolderName(skillDir, { extractionRoots: [] })).toBe('package');
    });
  });

  describe('resolveInstallTarget', () => {
    const release = { ownerId: 'owner-1', slug: 'skill-vetter', version: '1.0.0', publishedAt: 1769863429632 };
    let skillsRoot = '';
    let incoming = '';

    beforeEach(() => {
      skillsRoot = path.join(fixtureRoot, 'SKILLs');
      fs.mkdirSync(skillsRoot);
      incoming = writeSkillFixture(path.join(fixtureRoot, 'incoming'), { meta: release });
    });

    test('uses the folder name when it is free', () => {
      expect(resolveInstallTarget(skillsRoot, 'skill-vetter', incoming)).toEqual({
        targetDir: path.join(skillsRoot, 'skill-vetter'),
        alreadyInstalled: false,
      });
    });

    test('reports the same release as already installed instead of duplicating it', () => {
      writeSkillFixture(path.join(skillsRoot, 'skill-vetter'), { meta: { ...release, publishedAt: 1 } });

      expect(resolveInstallTarget(skillsRoot, 'skill-vetter', incoming)).toEqual({
        targetDir: path.join(skillsRoot, 'skill-vetter'),
        alreadyInstalled: true,
      });
    });

    test.each([
      ['has no _meta.json', undefined],
      ['is another version', { ...release, version: '1.0.1' }],
      ['has another owner', { ...release, ownerId: 'owner-2' }],
      ['has another slug', { ...release, slug: 'other-skill' }],
    ])('adds a suffix when the existing skill %s', (_label, existingMeta) => {
      writeSkillFixture(path.join(skillsRoot, 'skill-vetter'), { meta: existingMeta });

      expect(resolveInstallTarget(skillsRoot, 'skill-vetter', incoming)).toEqual({
        targetDir: path.join(skillsRoot, 'skill-vetter-1'),
        alreadyInstalled: false,
      });
    });

    test('adds a suffix when the incoming skill has no version to compare', () => {
      const unversioned = writeSkillFixture(path.join(fixtureRoot, 'unversioned'), {
        meta: { ownerId: release.ownerId, slug: release.slug },
      });
      writeSkillFixture(path.join(skillsRoot, 'skill-vetter'), {
        meta: { ownerId: release.ownerId, slug: release.slug },
      });

      expect(resolveInstallTarget(skillsRoot, 'skill-vetter', unversioned)).toEqual({
        targetDir: path.join(skillsRoot, 'skill-vetter-1'),
        alreadyInstalled: false,
      });
    });

    test('finds the same release behind a suffixed name', () => {
      writeSkillFixture(path.join(skillsRoot, 'skill-vetter'));
      writeSkillFixture(path.join(skillsRoot, 'skill-vetter-1'), { meta: release });

      expect(resolveInstallTarget(skillsRoot, 'skill-vetter', incoming)).toEqual({
        targetDir: path.join(skillsRoot, 'skill-vetter-1'),
        alreadyInstalled: true,
      });
    });
  });
});

describe('install source names', () => {
  test.each([
    ['my-skill', 'my-skill'],
    ['my-skill@1.2.0', 'my-skill'],
    ['@scope/my-skill', 'my-skill'],
    ['@scope/my-skill@^1.2.0', 'my-skill'],
  ])('deriveNpmPackageBaseName(%s) → %s', (spec, expected) => {
    expect(deriveNpmPackageBaseName(spec)).toBe(expected);
  });

  test.each([
    ['https://example.com/skills/my-skill.zip', 'my-skill'],
    ['https://example.com/a/My%20Skill.ZIP?token=1#x', 'My Skill'],
    ['https://example.com/a/bad%E0.zip', 'bad%E0'],
    ['not a url', ''],
  ])('deriveZipUrlBaseName(%s) → %s', (url, expected) => {
    expect(deriveZipUrlBaseName(url)).toBe(expected);
  });
});
