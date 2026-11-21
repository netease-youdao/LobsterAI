import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  LobsterMemoryService,
  MEMORY_FTS_DB_NAME,
  stripManagedAgentsSection,
  WorkspaceFileName,
} from './lobsterMemoryService';
import {
  appendProjectTag,
  extractProjectKeys,
  filterMarkdownForProject,
  parseGitRemoteToProjectKey,
  resolvePrimaryProjectKey,
  resolveProjectMemoryKeys,
} from './projectMemoryScope';

const tempDirs: string[] = [];
const services: LobsterMemoryService[] = [];

function createService(): LobsterMemoryService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-memory-'));
  tempDirs.push(dir);
  const service = new LobsterMemoryService(dir);
  services.push(service);
  return service;
}

afterEach(() => {
  while (services.length > 0) services.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('LobsterMemoryService', () => {
  test('performs surgical CRUD on MEMORY.md and indexes CJK + English via FTS5', () => {
    const service = createService();

    const added = service.addMemory('main', '用户偏好使用中文回复，代码注释保持英文', 'Preferences');
    service.addMemory('main', 'Project uses Electron 43 and Node 24 runtime', 'Tech Stack');

    const entries = service.listMemories('main');
    expect(entries).toHaveLength(2);
    expect(entries[0].section).toBe('Preferences');

    // 3+ char CJK trigram search
    const cjkHits = service.search('main', '中文回复');
    expect(cjkHits.length).toBeGreaterThan(0);
    expect(cjkHits[0].relPath).toBe(WorkspaceFileName.Memory);

    // Short 2-char CJK fallback search
    const shortCjkHits = service.search('main', '中文');
    expect(shortCjkHits.length).toBeGreaterThan(0);

    // English search
    const enHits = service.search('main', 'Electron 43');
    expect(enHits.length).toBeGreaterThan(0);

    // Update & delete
    const updated = service.updateMemory('main', added.id, '用户偏好简洁中文回复');
    expect(updated?.text).toBe('用户偏好简洁中文回复');
    expect(service.search('main', '简洁中文')).toHaveLength(1);

    expect(service.deleteMemory('main', updated!.id)).toBe(true);
    expect(service.listMemories('main')).toHaveLength(1);
  });

  test('isolates workspaces per agentId and indexes daily memory notes', () => {
    const service = createService();

    service.writeWorkspaceFile('agent-a', WorkspaceFileName.Soul, 'You are Agent A.');
    const relPath = service.appendDailyNote('agent-a', '今天完成了季度财报分析', new Date('2026-11-19T10:00:00Z'));
    expect(relPath).toBe('memory/2026-11-19.md');

    const bundleA = service.readPersonaBundle('agent-a');
    expect(bundleA.soul).toBe('You are Agent A.');

    expect(service.search('agent-a', '季度财报')).toHaveLength(1);
    expect(service.search('main', '季度财报')).toHaveLength(0);

    const snippet = service.readMemorySnippet('agent-a', relPath, 1, 10);
    expect(snippet).toContain('季度财报分析');
  });

  test('rejects path traversal in readMemorySnippet', () => {
    const service = createService();
    service.ensureAgentWorkspace('main');
    expect(() => service.readMemorySnippet('main', '../secret.txt')).toThrow(/outside agent workspace/i);
  });

  test('isolates project-scoped memories across projects and supports git origin + path keys', () => {
    const service = createService();
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-proj-a-'));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-proj-b-'));
    tempDirs.push(projA, projB);

    // Give projA a git origin remote without spawning git.
    fs.mkdirSync(path.join(projA, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(projA, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@GITHUB.com:acme/alpha.git\n',
      'utf8',
    );

    const keyA = resolvePrimaryProjectKey(projA)!;
    const keyB = resolvePrimaryProjectKey(projB)!;
    expect(keyA).toBe('github.com/acme/alpha');
    expect(keyB).toMatch(/^path:/);

    service.addMemory('main', 'Global rule: always write concise bullet points');
    service.addMemory('main', appendProjectTag('Alpha deploy uses pnpm deploy:alpha', keyA));
    service.addMemory('main', `Legacy path rule for Alpha <!-- project: path:${projA} -->`);
    service.addMemory('main', appendProjectTag('Beta deploy uses make release-beta', keyB));
    service.addMemory('main', 'Broken tag entry should never leak <!-- project: -->');

    // In Project A: sees global + git-tagged Alpha + path-tagged Alpha; never Beta or broken tag.
    const hitsA = service.search('main', 'deploy', 10, { workspaceDir: projA });
    expect(hitsA.map((h) => h.snippet)).toEqual(
      expect.arrayContaining(['- Alpha deploy uses pnpm deploy:alpha']),
    );
    expect(hitsA.some((h) => h.snippet.includes('Beta'))).toBe(false);
    expect(hitsA.every((h) => !h.snippet.includes('<!-- project:'))).toBe(true);

    const legacyHitsA = service.search('main', 'Legacy path rule', 10, { workspaceDir: projA });
    expect(legacyHitsA).toHaveLength(1);

    // In Project B: sees Beta + global; never Alpha or broken tag.
    const hitsB = service.search('main', 'deploy', 10, { workspaceDir: projB });
    expect(hitsB.map((h) => h.snippet)).toEqual(['- Beta deploy uses make release-beta']);
    expect(service.search('main', 'Legacy path rule', 10, { workspaceDir: projB })).toHaveLength(0);
    expect(service.search('main', 'concise bullet', 10, { workspaceDir: projB })).toHaveLength(1);
    expect(service.search('main', 'Broken tag entry', 10, { workspaceDir: projA })).toHaveLength(0);
    expect(service.search('main', 'Broken tag entry', 10, { workspaceDir: projB })).toHaveLength(0);

    // Scoped readMemorySnippet hides foreign project lines while preserving line numbers.
    const snippetB = service.readMemorySnippet('main', WorkspaceFileName.Memory, 1, 50, {
      workspaceDir: projB,
    });
    expect(snippetB).toContain('concise bullet points');
    expect(snippetB).toContain('Beta deploy uses make release-beta');
    expect(snippetB).not.toContain('Alpha deploy');
    expect(snippetB).not.toContain('Legacy path rule');
    expect(snippetB).not.toContain('<!-- project:');
  });

  test('shares main global preferences with non-main experts while strictly isolating expert memories', () => {
    const service = createService();
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-exp-proj-a-'));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-exp-proj-b-'));
    tempDirs.push(projA, projB);

    service.writeWorkspaceFile('main', WorkspaceFileName.User, '# User\n- Prefers TypeScript over JS\n');
    service.addMemory('main', 'Global preference: reply with concise bullet points');
    service.addMemory('main', `Main-only Project A note <!-- project: path:${projA} -->`);
    service.appendDailyNote('main', 'Main private daily diary entry', new Date('2026-11-20T00:00:00Z'));

    service.addMemory('expert-a', 'Expert A private codename: FALCON');
    service.addMemory('expert-b', 'Expert B private codename: DOLPHIN');

    // Expert A sees main global MEMORY.md & USER.md + own FALCON; never DOLPHIN, never main project/daily notes.
    const expAGlobal = service.search('expert-a', 'concise bullet', 10, { workspaceDir: projB });
    expect(expAGlobal).toHaveLength(1);
    expect(expAGlobal[0].agentId).toBe('main');

    const expAUser = service.search('expert-a', 'TypeScript', 10, { workspaceDir: projB });
    expect(expAUser).toHaveLength(1);
    expect(expAUser[0].agentId).toBe('main');
    expect(expAUser[0].relPath).toBe(WorkspaceFileName.User);

    expect(service.search('expert-a', 'FALCON', 10, { workspaceDir: projB })).toHaveLength(1);
    expect(service.search('expert-a', 'DOLPHIN', 10, { workspaceDir: projB })).toHaveLength(0);
    expect(service.search('expert-a', 'Main-only Project A', 10, { workspaceDir: projB })).toHaveLength(0);
    expect(service.search('expert-a', 'Main private daily', 10, { workspaceDir: projB })).toHaveLength(0);

    // Expert B sees global + own DOLPHIN, never FALCON.
    expect(service.search('expert-b', 'concise bullet', 10, { workspaceDir: projB })).toHaveLength(1);
    expect(service.search('expert-b', 'DOLPHIN', 10, { workspaceDir: projB })).toHaveLength(1);
    expect(service.search('expert-b', 'FALCON', 10, { workspaceDir: projB })).toHaveLength(0);

    // Opting out of main global sharing works cleanly.
    expect(
      service.search('expert-a', 'concise bullet', 10, { workspaceDir: projB, includeMainGlobal: false }),
    ).toHaveLength(0);
  });

  test('refreshes FTS5 automatically when disk files are edited or deleted, indexes USER.md & nested notes, and cleans up on deleteAgentIndex', () => {
    const service = createService();
    const wsDir = service.ensureAgentWorkspace('expert-x');

    // Initial write via API.
    service.addMemory('expert-x', 'Initial memory alpha');
    expect(service.search('expert-x', 'Initial memory')).toHaveLength(1);

    // Direct out-of-band edit to MEMORY.md, USER.md, and nested memory/topics/arch.md.
    const memPath = path.join(wsDir, WorkspaceFileName.Memory);
    fs.writeFileSync(memPath, '# User Memories\n\n- Updated out-of-band zebra note\n', 'utf8');
    // Bump mtime explicitly so fast filesystems always differ.
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(memPath, future, future);

    fs.writeFileSync(path.join(wsDir, WorkspaceFileName.User), '- User timezone is Asia/Shanghai\n', 'utf8');
    const nestedDir = path.join(wsDir, 'memory', 'topics');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, 'arch.md'), '- Nested architecture note: event sourcing\n', 'utf8');

    expect(service.search('expert-x', 'Initial memory')).toHaveLength(0);
    expect(service.search('expert-x', 'zebra note')).toHaveLength(1);
    expect(service.search('expert-x', 'Asia/Shanghai')).toHaveLength(1);
    expect(service.search('expert-x', 'event sourcing')).toHaveLength(1);

    // Deleting a file on disk removes its FTS5 chunks on next search.
    fs.rmSync(path.join(nestedDir, 'arch.md'));
    expect(service.search('expert-x', 'event sourcing')).toHaveLength(0);

    // Deleting the agent index leaves zero FTS5 rows.
    service.deleteAgentIndex('expert-x');
    fs.rmSync(wsDir, { recursive: true, force: true });
    expect(service.search('expert-x', 'zebra note')).toHaveLength(0);
    expect(service.search('expert-x', 'Asia/Shanghai')).toHaveLength(0);
  });

  test('migrates legacy memory-fts.sqlite missing project_keys column cleanly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-old-fts-'));
    tempDirs.push(dir);
    const oldDb = new Database(path.join(dir, MEMORY_FTS_DB_NAME));
    oldDb.exec(`
      CREATE VIRTUAL TABLE memory_chunks USING fts5(
        agent_id UNINDEXED,
        rel_path UNINDEXED,
        line_start UNINDEXED,
        line_end UNINDEXED,
        content,
        tokenize='trigram'
      );
      INSERT INTO memory_chunks (agent_id, rel_path, line_start, line_end, content)
      VALUES ('main', 'MEMORY.md', 1, 1, 'Stale old schema entry');
    `);
    oldDb.close();

    const mainDir = path.join(dir, 'main');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.writeFileSync(
      path.join(mainDir, WorkspaceFileName.Memory),
      '# User Memories\n- Migrated entry <!-- project: github.com/acme/alpha -->\n- Global surviving fact\n',
      'utf8',
    );

    const service = new LobsterMemoryService(dir);
    services.push(service);

    expect(service.search('main', 'Global surviving fact')).toHaveLength(1);
    expect(service.search('main', 'Stale old schema entry')).toHaveLength(0);
    expect(service.search('main', 'Migrated entry')).toHaveLength(0);
  });
});

describe('projectMemoryScope helpers', () => {
  test('normalizes git remote URLs and resolves worktree + subdirectory keys without spawning git', () => {
    expect(parseGitRemoteToProjectKey('https://GitHub.COM/OpenClaw/OpenClaw.git')).toBe(
      'github.com/OpenClaw/OpenClaw',
    );
    expect(parseGitRemoteToProjectKey('git@GITHUB.com:acme/alpha.git')).toBe('github.com/acme/alpha');
    expect(parseGitRemoteToProjectKey('ssh://git@example.com:22/srv/Repo;Prod.git')).toBe(
      'example.com/srv/Repo%3bProd',
    );

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-git-wt-'));
    tempDirs.push(root);
    const repo = path.join(root, 'repo');
    const sub = path.join(repo, 'packages', 'web');
    const wt = path.join(root, 'repo-wt');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt1'), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/acme/alpha.git\n',
      'utf8',
    );
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'wt1', 'commondir'), '../..\n', 'utf8');
    fs.writeFileSync(
      path.join(wt, '.git'),
      `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt1')}\n`,
      'utf8',
    );

    expect(resolveProjectMemoryKeys(sub)[0]).toBe('github.com/acme/alpha');
    expect(resolveProjectMemoryKeys(wt)[0]).toBe('github.com/acme/alpha');
  });

  test('extracts multiple tags and filters markdown while pruning foreign project headings', () => {
    expect(
      extractProjectKeys(
        '- Shared rule <!-- project: github.com/acme/alpha, github.com/acme/beta --> <!-- project: path:/tmp/gamma -->',
      ),
    ).toEqual({
      annotated: true,
      keys: ['github.com/acme/alpha', 'github.com/acme/beta', 'path:/tmp/gamma'],
    });

    const md = [
      '# User Memories',
      '',
      '## Preferences',
      '- Global concise style',
      '',
      '## Alpha Notes',
      '- Alpha only command <!-- project: github.com/acme/alpha -->',
      '  - Nested alpha detail',
      '',
      '## Beta Notes',
      '- Beta only command <!-- project: github.com/acme/beta -->',
    ].join('\n');

    const forBeta = filterMarkdownForProject(md, ['github.com/acme/beta']);
    expect(forBeta).toContain('# User Memories');
    expect(forBeta).toContain('## Preferences');
    expect(forBeta).toContain('- Global concise style');
    expect(forBeta).toContain('## Beta Notes');
    expect(forBeta).toContain('- Beta only command');
    expect(forBeta).not.toContain('## Alpha Notes');
    expect(forBeta).not.toContain('Alpha only command');
    expect(forBeta).not.toContain('Nested alpha detail');
    expect(forBeta).not.toContain('<!-- project:');
  });
});

describe('stripManagedAgentsSection', () => {
  test('keeps user instructions and removes legacy LobsterAI managed block', () => {
    const raw = [
      '# My Custom Rules',
      'Always format tables cleanly.',
      '',
      '<!-- LobsterAI managed: do not edit below this line -->',
      '## Managed OpenClaw Instructions',
      'Internal policy text',
    ].join('\n');

    expect(stripManagedAgentsSection(raw)).toBe('# My Custom Rules\nAlways format tables cleanly.');
  });

  test('strips OpenClaw stock AGENTS.md workspace boilerplate while preserving trailing user rules', () => {
    const stock = [
      '# AGENTS.md - Your Workspace',
      '',
      'This folder is home. Treat it that way.',
      '',
      '## First Run',
      'If `BOOTSTRAP.md` exists, follow it.',
      '',
      '## Tools',
      'Voice storytelling: sag ElevenLabs TTS',
      '',
      '## Make It Yours',
      '',
      'This is a starting point. Add your own conventions, style, and rules as you figure out what works.',
      '',
      '## Related',
      '',
      '- [Default AGENTS.md](/reference/AGENTS.default)',
      '- [Heartbeat](/gateway/heartbeat)',
    ].join('\n');

    expect(stripManagedAgentsSection(stock)).toBe('');
    expect(stripManagedAgentsSection(`${stock}\n\n## 我的自定义规则\n- 回复始终带目录`)).toBe(
      '## 我的自定义规则\n- 回复始终带目录',
    );
  });

  test('preserves non-OpenClaw custom AGENTS.md manuals intact', () => {
    const custom = '# AGENTS.md — 抖音带货官工作手册\n\n- 选品先看佣金率与复购率';
    expect(stripManagedAgentsSection(custom)).toBe(custom);
  });
});
