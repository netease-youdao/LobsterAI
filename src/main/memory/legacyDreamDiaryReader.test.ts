import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  getVisibleLegacyDreamDiaries,
  parseDiaryEntries,
} from '../../renderer/components/cowork/dreamDiaryParser';
import { AgentId } from '../../shared/agent/constants';
import { LEGACY_DREAM_DIARY_FILENAME } from '../../shared/cowork/dreamDiary';
import {
  findLegacyDreamDiaryFile,
  readLegacyDreamDiaries,
} from './legacyDreamDiaryReader';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dream-reader-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('legacyDreamDiaryReader', () => {
  test('returns not found on fresh installs with missing or empty workspaces', () => {
    const missingDir = path.join(createTempDir(), 'non-existent-workspaces');
    expect(readLegacyDreamDiaries(missingDir)).toEqual({
      found: false,
      path: '',
      content: '',
      agents: [],
    });

    const workspacesDir = createTempDir();
    fs.mkdirSync(path.join(workspacesDir, AgentId.Main), { recursive: true });
    fs.writeFileSync(path.join(workspacesDir, AgentId.Main, 'MEMORY.md'), '# User Memories\n- Hello\n');
    expect(readLegacyDreamDiaries(workspacesDir)).toEqual({
      found: false,
      path: '',
      content: '',
      agents: [],
    });

    // Whitespace-only DREAMS.md should also be treated as not found.
    fs.writeFileSync(path.join(workspacesDir, AgentId.Main, LEGACY_DREAM_DIARY_FILENAME), '   \n\n  ');
    expect(readLegacyDreamDiaries(workspacesDir)).toEqual({
      found: false,
      path: '',
      content: '',
      agents: [],
    });
  });

  test('reads main and custom expert DREAMS.md / dreams.md sorted with main first and parses cleanly', () => {
    const workspacesDir = createTempDir();
    const mainDir = path.join(workspacesDir, AgentId.Main);
    const analystDir = path.join(workspacesDir, 'analyst');
    const researcherDir = path.join(workspacesDir, 'researcher');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(analystDir, { recursive: true });
    fs.mkdirSync(researcherDir, { recursive: true });

    const mainContent = [
      '# Dream Diary',
      '',
      '<!-- openclaw:dreaming:diary:start -->',
      '---',
      '*November 14, 2026 at 3:00 AM GMT+8*',
      'Consolidated release notes and TypeScript preferences.',
      '---',
      '*November 15, 2026 at 3:00 AM GMT+8*',
      'Reviewed DSH migration checklist.',
      '<!-- openclaw:dreaming:diary:end -->',
      '',
    ].join('\n');

    const researcherContent = [
      '# Dream Diary',
      '',
      '<!-- openclaw:dreaming:diary:start -->',
      '---',
      '*November 12, 2026 at 3:00 AM GMT+8*',
      'Tracked paper citations.',
      '<!-- openclaw:dreaming:diary:end -->',
      '',
    ].join('\n');

    const analystContent = [
      '# Dream Diary',
      '',
      '<!-- openclaw:dreaming:diary:start -->',
      '---',
      '*November 13, 2026 at 3:00 AM GMT+8*',
      'Summarized quarterly KPIs.',
      '<!-- openclaw:dreaming:diary:end -->',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(mainDir, 'DREAMS.md'), mainContent, 'utf8');
    fs.writeFileSync(path.join(researcherDir, 'dreams.md'), researcherContent, 'utf8');
    fs.writeFileSync(path.join(analystDir, 'DREAMS.md'), analystContent, 'utf8');

    const nameMap: Record<string, string> = {
      analyst: 'Data Analyst',
      researcher: 'Deep Researcher',
    };
    const result = readLegacyDreamDiaries(workspacesDir, {
      resolveAgentName: (id) => nameMap[id],
    });

    expect(result.found).toBe(true);
    expect(result.agentId).toBe(AgentId.Main);
    expect(result.path).toBe(path.join(mainDir, 'DREAMS.md'));
    expect(result.content).toBe(mainContent);
    expect(typeof result.updatedAtMs).toBe('number');
    expect(result.agents?.map((a) => [a.agentId, a.agentName])).toEqual([
      [AgentId.Main, undefined],
      ['analyst', 'Data Analyst'],
      ['researcher', 'Deep Researcher'],
    ]);

    const parsedMain = parseDiaryEntries(result.content ?? '');
    expect(parsedMain).toEqual([
      {
        date: 'November 14, 2026 at 3:00 AM GMT+8',
        body: 'Consolidated release notes and TypeScript preferences.',
      },
      {
        date: 'November 15, 2026 at 3:00 AM GMT+8',
        body: 'Reviewed DSH migration checklist.',
      },
    ]);

    const visible = getVisibleLegacyDreamDiaries(result);
    expect(visible).toHaveLength(3);
  });

  test('supports expert-only diaries, targeted agent queries, and rejects path traversal', () => {
    const workspacesDir = createTempDir();
    const expertDir = path.join(workspacesDir, 'writer');
    fs.mkdirSync(expertDir, { recursive: true });
    const content = [
      '<!-- openclaw:dreaming:diary:start -->',
      '---',
      '*November 10, 2026 at 3:00 AM GMT+8*',
      'Drafted product launch blog post.',
      '<!-- openclaw:dreaming:diary:end -->',
    ].join('\n');
    fs.writeFileSync(path.join(expertDir, 'dreams.md'), content, 'utf8');

    const all = readLegacyDreamDiaries(workspacesDir);
    expect(all.found).toBe(true);
    expect(all.agentId).toBe('writer');
    expect(all.agents).toHaveLength(1);

    const targeted = readLegacyDreamDiaries(workspacesDir, { agentId: 'writer' });
    expect(targeted.found).toBe(true);
    expect(targeted.agentId).toBe('writer');
    expect(targeted.content).toBe(content);

    expect(readLegacyDreamDiaries(workspacesDir, { agentId: AgentId.Main }).found).toBe(false);
    expect(readLegacyDreamDiaries(workspacesDir, { agentId: '../etc' }).found).toBe(false);
  });

  test('findLegacyDreamDiaryFile ignores directories named DREAMS.md', () => {
    const dir = createTempDir();
    fs.mkdirSync(path.join(dir, 'DREAMS.md'), { recursive: true });
    expect(findLegacyDreamDiaryFile(dir)).toBeNull();
  });
});
