import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  LobsterMemoryService,
  MEMORY_FTS_DB_NAME,
  parseMemoryMarkdown,
  stripLegacyDreamingPromotions,
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

  test('close() is idempotent, releases WAL handles cleanly, and lazily re-opens on later queries', () => {
    const service = createService();
    service.addMemory('main', 'Initial persisted memory before backup restore');
    expect(service.search('main', 'Initial persisted')).toHaveLength(1);

    const ftsPath = path.join(service.getWorkspacesDir(), MEMORY_FTS_DB_NAME);
    expect(fs.existsSync(ftsPath)).toBe(true);

    // Idempotent close releases SQLite + WAL handles cleanly.
    service.close();
    service.close();
    expect(fs.existsSync(`${ftsPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${ftsPath}-shm`)).toBe(false);

    // Simulate restore clearing workspacesDir and restoring new MEMORY.md without FTS DB.
    fs.rmSync(service.getWorkspacesDir(), { recursive: true, force: true });
    fs.mkdirSync(path.join(service.getWorkspacesDir(), 'main'), { recursive: true });
    fs.writeFileSync(
      path.join(service.getWorkspacesDir(), 'main', WorkspaceFileName.Memory),
      '# User Memories\n\n- Restored memory after backup import\n',
      'utf8',
    );

    // Subsequent search lazily re-opens the FTS DB and indexes the restored file.
    expect(service.search('main', 'Initial persisted')).toHaveLength(0);
    const restoredHits = service.search('main', 'Restored memory');
    expect(restoredHits).toHaveLength(1);
    expect(restoredHits[0].snippet).toContain('Restored memory after backup import');
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

  test('strips blank lines inside multi-line addMemory and updateMemory so entries never split', () => {
    const service = createService();

    const added = service.addMemory('main', 'Line 1\n\nLine 2\n\n\nLine 3');
    expect(added.text).toBe('Line 1\nLine 2\nLine 3');
    expect(service.listMemories('main')).toHaveLength(1);
    expect(service.listMemories('main')[0].text).toBe('Line 1\nLine 2\nLine 3');

    const updated = service.updateMemory('main', added.id, 'Updated 1\n\n\nUpdated 2\n\nUpdated 3');
    expect(updated?.text).toBe('Updated 1\nUpdated 2\nUpdated 3');
    const afterEdit = service.listMemories('main');
    expect(afterEdit).toHaveLength(1);
    expect(afterEdit[0].text).toBe('Updated 1\nUpdated 2\nUpdated 3');
  });

  test('avoids double-bulleting inputs starting with "- "', () => {
    const service = createService();

    const added = service.addMemory('main', '- Prefers TypeScript strict mode');
    expect(added.text).toBe('Prefers TypeScript strict mode');
    const rawAfterAdd = service.readWorkspaceFile('main', WorkspaceFileName.Memory);
    expect(rawAfterAdd).toContain('- Prefers TypeScript strict mode');
    expect(rawAfterAdd).not.toContain('- - ');

    const updated = service.updateMemory('main', added.id, '- Prefers Rust and TypeScript');
    expect(updated?.text).toBe('Prefers Rust and TypeScript');
    const rawAfterUpdate = service.readWorkspaceFile('main', WorkspaceFileName.Memory);
    expect(rawAfterUpdate).toContain('- Prefers Rust and TypeScript');
    expect(rawAfterUpdate).not.toContain('- - ');
  });

  test('maintains stable indentation across repeated multi-line edits', () => {
    const service = createService();
    const initialText = 'Release flow:\n- bump version\n  - patch minor\n- run tests';

    let entry = service.addMemory('main', initialText);
    expect(entry.text).toBe(initialText);

    for (let i = 1; i <= 5; i += 1) {
      const nextText = `Release flow v${i}:\n- bump version\n  - patch minor\n- run tests`;
      const updated = service.updateMemory('main', entry.id, nextText);
      expect(updated).not.toBeNull();
      entry = updated!;
      expect(entry.text).toBe(nextText);
    }

    const raw = service.readWorkspaceFile('main', WorkspaceFileName.Memory);
    expect(raw).toContain('- Release flow v5:\n  - bump version\n    - patch minor\n  - run tests');
    expect(service.listMemories('main')).toHaveLength(1);
    expect(service.listMemories('main')[0].text).toBe(
      'Release flow v5:\n- bump version\n  - patch minor\n- run tests',
    );
  });

  test('assigns unique disambiguated IDs for duplicate text and updates/deletes only the targeted entry', () => {
    const service = createService();
    const duplicateMd = [
      '# User Memories',
      '',
      '## Work',
      '',
      '- Prefers concise answers',
      '',
      '## Personal',
      '',
      '- Prefers concise answers',
      '',
    ].join('\n');
    service.writeWorkspaceFile('main', WorkspaceFileName.Memory, duplicateMd);

    const entries = service.listMemories('main');
    expect(entries).toHaveLength(2);
    expect(entries[0].id).not.toBe(entries[1].id);
    expect(entries[0].section).toBe('Work');
    expect(entries[1].section).toBe('Personal');

    // Update only the second duplicate entry
    const updatedSecond = service.updateMemory('main', entries[1].id, 'Prefers detailed stories');
    expect(updatedSecond?.section).toBe('Personal');
    const afterUpdate = service.listMemories('main');
    expect(afterUpdate).toHaveLength(2);
    expect(afterUpdate[0].text).toBe('Prefers concise answers');
    expect(afterUpdate[1].text).toBe('Prefers detailed stories');

    // Re-seed duplicates and verify deleteMemory removes only the targeted one
    service.writeWorkspaceFile('main', WorkspaceFileName.Memory, duplicateMd);
    const dupesAgain = service.listMemories('main');
    expect(service.deleteMemory('main', dupesAgain[1].id)).toBe(true);
    const afterDelete = service.listMemories('main');
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0].section).toBe('Work');
    expect(afterDelete[0].text).toBe('Prefers concise answers');
  });

  test('keeps multi-line HTML comments verbatim without turning lines 2..N into entries', () => {
    const service = createService();
    const md = [
      '# User Memories',
      '',
      '<!-- multi-line header comment',
      'line 2 inside comment',
      'line 3 closing -->',
      '',
      '## Notes',
      '',
      '<!-- openclaw-memory-promotion:memory:memory/2026-06-23.md:74:74',
      'extra metadata line -->',
      '- Real memory fact',
      '',
      '# Reset Heading',
      '',
      '- Top level fact',
      '',
    ].join('\n');
    service.writeWorkspaceFile('main', WorkspaceFileName.Memory, md);

    const entries = service.listMemories('main');
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('Real memory fact');
    expect(entries[0].section).toBe('Notes');
    expect(entries[1].text).toBe('Top level fact');
    expect(entries[1].section).toBeUndefined();

    // Comments survive edits verbatim
    service.updateMemory('main', entries[0].id, 'Edited real memory fact');
    const raw = service.readWorkspaceFile('main', WorkspaceFileName.Memory);
    expect(raw).toContain('<!-- multi-line header comment\nline 2 inside comment\nline 3 closing -->');
    expect(raw).toContain('<!-- openclaw-memory-promotion:memory:memory/2026-06-23.md:74:74\nextra metadata line -->');
    expect(raw).toContain('- Edited real memory fact');
  });

  test('strips inline metadata comments from display text while preserving them safely on edit', () => {
    const service = createService();
    const md = [
      '# User Memories',
      '',
      '- Uses dark theme <!-- project: lobsterai --> <!-- importance: high -->',
      '- Deploy checklist: <!-- trigger: release -->',
      '  - run unit tests',
      '  <!-- openclaw-memory-promotion:memory:memory/2026-06-23.md:10:12 -->',
      '',
    ].join('\n');
    service.writeWorkspaceFile('main', WorkspaceFileName.Memory, md);

    const entries = service.listMemories('main');
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('Uses dark theme');
    expect(entries[1].text).toBe('Deploy checklist:\n- run unit tests');

    // Unmodified edit leaves inline metadata untouched byte-for-byte
    const unchanged = service.updateMemory('main', entries[1].id, entries[1].text);
    expect(unchanged?.text).toBe('Deploy checklist:\n- run unit tests');
    expect(service.readWorkspaceFile('main', WorkspaceFileName.Memory)).toBe(md);

    // Modified edit updates entry.text cleanly and preserves inline metadata comments
    const edited = service.updateMemory('main', entries[0].id, 'Uses system theme');
    expect(edited?.text).toBe('Uses system theme');
    const rawAfterEdit = service.readWorkspaceFile('main', WorkspaceFileName.Memory);
    expect(rawAfterEdit).toContain(
      '- Uses system theme <!-- project: lobsterai --> <!-- importance: high -->',
    );
    expect(service.listMemories('main')[0].text).toBe('Uses system theme');

    // Standalone parsed segments ignore metadata-only lines
    const parsed = parseMemoryMarkdown('- <!-- project: empty -->\n- Valid entry\n');
    const parsedEntries = parsed.segments.filter((s) => s.kind === 'entry').map((s) => s.entry?.text);
    expect(parsedEntries).toEqual(['Valid entry']);
  });

  test('create -> edit -> delete immediately updates BOTH MEMORY.md and FTS5 search index', () => {
    const service = createService();

    const created = service.addMemory('main', 'AlphaQuantumProject uses PostgreSQL 17');
    expect(service.readWorkspaceFile('main', WorkspaceFileName.Memory)).toContain('AlphaQuantumProject');
    expect(service.search('main', 'AlphaQuantumProject')).toHaveLength(1);

    const edited = service.updateMemory('main', created.id, 'BetaNebulaProject uses SQLite FTS5');
    expect(edited).not.toBeNull();
    const rawAfterEdit = service.readWorkspaceFile('main', WorkspaceFileName.Memory);
    expect(rawAfterEdit).not.toContain('AlphaQuantumProject');
    expect(rawAfterEdit).toContain('BetaNebulaProject');
    expect(service.search('main', 'AlphaQuantumProject')).toHaveLength(0);
    expect(service.search('main', 'BetaNebulaProject')).toHaveLength(1);

    expect(service.deleteMemory('main', edited!.id)).toBe(true);
    expect(service.readWorkspaceFile('main', WorkspaceFileName.Memory)).not.toContain('BetaNebulaProject');
    expect(service.search('main', 'BetaNebulaProject')).toHaveLength(0);
    expect(service.listMemories('main')).toHaveLength(0);
  });

  test('editing a project-tagged memory preserves its project tag and FTS5 project isolation', () => {
    const service = createService();
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-edit-proj-a-'));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-edit-proj-b-'));
    tempDirs.push(projA, projB);

    fs.mkdirSync(path.join(projA, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(projA, '.git', 'config'),
      '[remote "origin"]\n\turl = git@github.com:acme/project-alpha.git\n',
      'utf8',
    );

    const keyA = resolvePrimaryProjectKey(projA)!;
    expect(keyA).toBe('github.com/acme/project-alpha');

    const added = service.addMemory('main', appendProjectTag('AlphaOriginalDeploy uses pnpm build', keyA));
    expect(added.text).toBe('AlphaOriginalDeploy uses pnpm build');
    expect(service.listMemories('main').map((e) => e.text)).toEqual(['AlphaOriginalDeploy uses pnpm build']);

    // Edit via updateMemory with clean display text (no tag passed by caller / UI)
    const updated = service.updateMemory('main', added.id, 'AlphaUpdatedDeploy uses pnpm release');
    expect(updated).not.toBeNull();
    expect(updated?.text).toBe('AlphaUpdatedDeploy uses pnpm release');

    // Disk file retains the <!-- project: ... --> tag, while listMemories stays clean
    const rawOnDisk = service.readWorkspaceFile('main', WorkspaceFileName.Memory);
    expect(rawOnDisk).toContain('- AlphaUpdatedDeploy uses pnpm release <!-- project: github.com/acme/project-alpha -->');
    expect(service.listMemories('main').map((e) => e.text)).toEqual(['AlphaUpdatedDeploy uses pnpm release']);

    // FTS5 recall remains isolated to Project A and never leaks into Project B or global scope
    const hitsInA = service.search('main', 'AlphaUpdatedDeploy', 10, { workspaceDir: projA });
    expect(hitsInA).toHaveLength(1);
    expect(hitsInA[0].snippet).toBe('- AlphaUpdatedDeploy uses pnpm release');
    expect(hitsInA[0].snippet).not.toContain('<!-- project:');
    expect(service.search('main', 'AlphaOriginalDeploy', 10, { workspaceDir: projA })).toHaveLength(0);
    expect(service.search('main', 'AlphaUpdatedDeploy', 10, { workspaceDir: projB })).toHaveLength(0);
    expect(service.search('main', 'AlphaUpdatedDeploy', 10)).toHaveLength(0);
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

describe('LobsterMemoryService projectKeys metadata and batch deletion', () => {
  test('exposes inline and heading-inherited projectKeys while stripping tags from section titles', () => {
    const service = createService();
    const md = [
      '# User Memories',
      '',
      '- Global user preference',
      '- Inline repo rule <!-- project: github.com/acme/lobsterai -->',
      '',
      '## Repo Notes <!-- project: path:/Users/dev/demo -->',
      '',
      '- Inherited project note',
      '',
    ].join('\n');

    service.writeWorkspaceFile('main', WorkspaceFileName.Memory, md);
    const entries = service.listMemories('main');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ text: 'Global user preference' });
    expect(entries[0].projectKeys).toBeUndefined();
    expect(entries[1]).toMatchObject({
      text: 'Inline repo rule',
      projectKeys: ['github.com/acme/lobsterai'],
    });
    expect(entries[2]).toMatchObject({
      text: 'Inherited project note',
      section: 'Repo Notes',
      projectKeys: ['path:/Users/dev/demo'],
    });
  });

  test('deleteMemories removes multiple entries atomically and prunes emptied section headings', () => {
    const service = createService();
    const md = [
      '# User Memories',
      '',
      '- Likes cats',
      '',
      '## Promoted From Short-Term Memory (2026-06-28)',
      '',
      '- Noisy promoted entry 1',
      '- Noisy promoted entry 2',
      '',
      '## Unrelated Empty Heading',
      '',
      '## Work',
      '',
      '- Keep this rule',
      '',
    ].join('\n');

    service.writeWorkspaceFile('main', WorkspaceFileName.Memory, md);
    const entries = service.listMemories('main');
    const promotedIds = entries
      .filter((entry) => entry.section?.startsWith('Promoted From Short-Term Memory'))
      .map((entry) => entry.id);
    expect(promotedIds).toHaveLength(2);

    expect(service.deleteMemories('main', promotedIds)).toBe(2);

    const remaining = service.listMemories('main');
    expect(remaining.map((entry) => entry.text)).toEqual(['Likes cats', 'Keep this rule']);

    const rawAfter = service.readWorkspaceFile('main', WorkspaceFileName.Memory);
    expect(rawAfter).not.toContain('Promoted From Short-Term Memory');
    expect(rawAfter).toContain('## Unrelated Empty Heading');
    expect(rawAfter).toContain('## Work');
    expect(service.search('main', 'Noisy promoted')).toHaveLength(0);
  });
});

describe('stripLegacyDreamingPromotions', () => {
  test('strips OpenClaw Dreaming short-term promotion sections and reflection noise while keeping user memories', () => {
    const raw = [
      '# User Memories',
      '',
      '- wn 的公司是 NetEase（网易）',
      '- 我喜欢小猫咪',
      '- 我喜欢和白开水',
      '',
      '## Promoted From Short-Term Memory (2026-06-28)',
      '',
      '<!-- openclaw-memory-promotion:memory:memory/2026-06-23.md:74:74 -->',
      '- istant` kept surfacing across 35 memories.; confidence: 0.79; evidence: memory/.dreams/session-corpus/2026-06-12.txt:2-2, memory/.dreams/session-corpus/2026-06-12.txt:4-4; note: reflection [score=0.857 recalls=0 avg=0.620 source=memory/2026-06-23.md:74-74]',
      '',
    ].join('\n');

    const result = stripLegacyDreamingPromotions(raw);
    expect(result.changed).toBe(true);
    expect(result.removedEntries).toBe(1);
    expect(result.content).toBe([
      '# User Memories',
      '',
      '- wn 的公司是 NetEase（网易）',
      '- 我喜欢小猫咪',
      '- 我喜欢和白开水',
      '',
    ].join('\n'));
  });

  test('preserves genuine user memory appended after a legacy promoted block and drops the bogus heading', () => {
    const raw = [
      '# User Memories',
      '',
      '- 我喜欢小猫咪',
      '',
      '## Promoted From Short-Term Memory (2026-06-28)',
      '',
      '<!-- openclaw-memory-promotion:memory:memory/2026-06-23.md:74:74 -->',
      '- promoted fact; confidence: 0.79',
      '- 我喜欢喝美式咖啡',
      '',
    ].join('\n');

    const result = stripLegacyDreamingPromotions(raw);
    expect(result.changed).toBe(true);
    expect(result.removedEntries).toBe(1);
    expect(result.content).not.toContain('Promoted From Short-Term Memory');
    expect(result.content).not.toContain('promoted fact');
    expect(result.content).toContain('- 我喜欢小猫咪');
    expect(result.content).toContain('- 我喜欢喝美式咖啡');
  });

  test('returns empty string when MEMORY.md contained only legacy promoted blocks and leaves normal files untouched', () => {
    const onlyNoise = [
      '# User Memories',
      '',
      '## Promoted From Short-Term Memory (2026-06-28)',
      '',
      '- fragment; confidence: 0.80; evidence: memory/.dreams/session-corpus/2026-06-12.txt:1-2',
      '',
    ].join('\n');
    const cleaned = stripLegacyDreamingPromotions(onlyNoise);
    expect(cleaned).toEqual({ content: '', changed: true, removedEntries: 1 });

    const cleanUserFile = '# User Memories\n\n- Prefers TypeScript\n- Always run vitest\n';
    const untouched = stripLegacyDreamingPromotions(cleanUserFile);
    expect(untouched).toEqual({ content: cleanUserFile, changed: false, removedEntries: 0 });
  });
});

describe('LobsterMemoryService FTS5 legacy Dreaming daily-note filtering', () => {
  test('excludes OpenClaw Dreaming light/rem blocks and orphan tails from search while keeping accurate line numbers', () => {
    const service = createService();
    const dailyDir = path.join(service.getAgentWorkspaceDir('main'), 'memory');
    fs.mkdirSync(dailyDir, { recursive: true });
    const dailyLines = [
      '# 2026-06-23',
      '- Real morning standup note about Phoenix launch',
      '',
      '## Light Sleep',
      '<!-- openclaw:dreaming:light:start -->',
      '- Candidate: Reflections: Theme: `assistant` kept surfacing across 22 memories.; confidence: 0.76; evidence: memory/.dreams/session-corpus/2026-06-15.txt:2-2; note: reflection',
      '  - confidence: 0.62',
      '  - status: staged',
      '<!-- openclaw:dreaming:light:end -->',
      'istant` kept surfacing across 35 memories.; confidence: 0.79; evidence: memory/.dreams/session-corpus/2026-06-12.txt:2-2; note: reflection',
      '  - status: staged',
      '<!-- openclaw:dreaming:light:end -->',
      '',
      '## REM Sleep',
      '<!-- openclaw:dreaming:rem:start -->',
      '### Possible Lasting Truths',
      '- Phantom dreaming truth about Orion Nebula',
      '<!-- openclaw:dreaming:rem:end -->',
      '',
      '- Real evening decision: deploy Phoenix canary on Friday',
      '',
    ];
    fs.writeFileSync(path.join(dailyDir, '2026-06-23.md'), dailyLines.join('\n'), 'utf8');

    expect(service.search('main', 'session-corpus')).toHaveLength(0);
    expect(service.search('main', 'Orion Nebula')).toHaveLength(0);
    expect(service.search('main', 'istant')).toHaveLength(0);

    const morningHits = service.search('main', 'Phoenix launch');
    expect(morningHits).toHaveLength(1);
    expect(morningHits[0].lineStart).toBe(2);

    const eveningHits = service.search('main', 'Phoenix canary');
    expect(eveningHits).toHaveLength(1);
    expect(eveningHits[0].lineStart).toBe(20);
  });

  test('automatically rebuilds older schema-version memory-fts.sqlite to purge previously indexed Dreaming chunks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-fts-v1-'));
    tempDirs.push(dir);
    const mainDir = path.join(dir, 'main');
    const dailyDir = path.join(mainDir, 'memory');
    fs.mkdirSync(dailyDir, { recursive: true });
    const dailyPath = path.join(dailyDir, '2026-06-23.md');
    fs.writeFileSync(
      dailyPath,
      [
        '## Light Sleep',
        '<!-- openclaw:dreaming:light:start -->',
        '- Candidate: StaleDreamingNoiseToken; evidence: memory/.dreams/session-corpus/2026-06-12.txt:1-1',
        '<!-- openclaw:dreaming:light:end -->',
        '',
        '- GenuineDailySurvivingToken',
        '',
      ].join('\n'),
      'utf8',
    );
    const stat = fs.statSync(dailyPath);

    // Seed a legacy user_version=0 DB that already cached the stale Dreaming chunk with matching mtime/size.
    const legacyDb = new Database(path.join(dir, MEMORY_FTS_DB_NAME));
    legacyDb.exec(`
      CREATE VIRTUAL TABLE memory_chunks USING fts5(
        agent_id UNINDEXED,
        rel_path UNINDEXED,
        line_start UNINDEXED,
        line_end UNINDEXED,
        project_keys UNINDEXED,
        content,
        tokenize='trigram'
      );
      CREATE TABLE memory_file_meta (
        agent_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (agent_id, rel_path)
      );
    `);
    legacyDb
      .prepare('INSERT INTO memory_chunks (agent_id, rel_path, line_start, line_end, project_keys, content) VALUES (?, ?, ?, ?, ?, ?)')
      .run('main', 'memory/2026-06-23.md', 3, 3, '', 'StaleDreamingNoiseToken');
    legacyDb
      .prepare('INSERT INTO memory_file_meta (agent_id, rel_path, mtime_ms, size) VALUES (?, ?, ?, ?)')
      .run('main', 'memory/2026-06-23.md', stat.mtimeMs, stat.size);
    legacyDb.close();

    const service = new LobsterMemoryService(dir);
    services.push(service);

    expect(service.search('main', 'StaleDreamingNoiseToken')).toHaveLength(0);
    expect(service.search('main', 'GenuineDailySurvivingToken')).toHaveLength(1);
  });
});
