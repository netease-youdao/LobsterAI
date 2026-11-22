import { describe, expect, test } from 'vitest';

import {
  flattenDiaryBody,
  formatDiaryChipLabel,
  getVisibleLegacyDreamDiaries,
  hasMeaningfulDiaryContent,
  parseDiaryDateMs,
  parseDiaryEntries,
} from './dreamDiaryParser';

// Same layout OpenClaw's memory-core writes into DREAMS.md.
const buildDreamsFile = (entries: Array<{ date: string; narrative: string }>, eol = '\n'): string => {
  const body = entries.map(({ date, narrative }) => `\n---\n\n*${date}*\n\n${narrative}\n`).join('');
  return `# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->${body}\n<!-- openclaw:dreaming:diary:end -->\n`
    .replace(/\n/g, eol);
};

describe('parseDiaryEntries', () => {
  test('reads entries between the diary markers in file order', () => {
    const raw = buildDreamsFile([
      { date: 'November 11, 2026 at 3:00 AM GMT+8', narrative: 'First night.' },
      { date: 'November 12, 2026 at 3:00 AM GMT+8', narrative: 'Second night.\nStill dreaming.' },
    ]);

    expect(parseDiaryEntries(raw)).toEqual([
      { date: 'November 11, 2026 at 3:00 AM GMT+8', body: 'First night.' },
      { date: 'November 12, 2026 at 3:00 AM GMT+8', body: 'Second night.\nStill dreaming.' },
    ]);
  });

  test('handles CRLF line endings', () => {
    const raw = buildDreamsFile(
      [{ date: 'November 12, 2026 at 3:00 AM GMT+8', narrative: 'Windows night.' }],
      '\r\n',
    );

    expect(parseDiaryEntries(raw)).toEqual([
      { date: 'November 12, 2026 at 3:00 AM GMT+8', body: 'Windows night.' },
    ]);
  });

  test('returns no entries for a freshly seeded diary', () => {
    expect(parseDiaryEntries(buildDreamsFile([]))).toEqual([]);
  });

  test('parses real OpenClaw DREAMS.md sections and does not mistake bold headings for dates', () => {
    const raw = [
      '# Dream Diary',
      '',
      '<!-- openclaw:dreaming:diary:start -->',
      '---',
      '*November 14, 2026 at 3:00 AM GMT+8*',
      'What Happened',
      '1. Reviewed release notes [memory/2026-11-13.md:12]',
      'Reflections',
      '- Team prefers concise PR summaries',
      '---',
      '**Unstamped Reflection**',
      'Remember to verify migration backups.',
      '<!-- openclaw:dreaming:diary:end -->',
      '',
    ].join('\n');

    const entries = parseDiaryEntries(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].date).toBe('November 14, 2026 at 3:00 AM GMT+8');
    expect(flattenDiaryBody(entries[0].body)).toEqual([
      'Reviewed release notes',
      'Team prefers concise PR summaries',
    ]);
    expect(entries[1]).toEqual({
      date: '',
      body: '**Unstamped Reflection**\nRemember to verify migration backups.',
    });
  });
});

describe('hasMeaningfulDiaryContent and getVisibleLegacyDreamDiaries', () => {
  test('distinguishes empty seeded templates from meaningful historical diaries', () => {
    expect(hasMeaningfulDiaryContent('')).toBe(false);
    expect(hasMeaningfulDiaryContent(null)).toBe(false);
    expect(hasMeaningfulDiaryContent(buildDreamsFile([]))).toBe(false);
    expect(
      hasMeaningfulDiaryContent(
        buildDreamsFile([{ date: 'November 14, 2026 at 3:00 AM GMT+8', narrative: 'Kept note.' }]),
      ),
    ).toBe(true);
    expect(hasMeaningfulDiaryContent('Plain user notes without markers')).toBe(true);
  });

  test('filters out empty seeded agents while preserving legacy single-agent payloads', () => {
    expect(
      getVisibleLegacyDreamDiaries({ found: false, path: '', content: '', agents: [] }),
    ).toEqual([]);

    const realContent = buildDreamsFile([
      { date: 'November 14, 2026 at 3:00 AM GMT+8', narrative: 'Expert dream note.' },
    ]);
    expect(
      getVisibleLegacyDreamDiaries({
        found: true,
        agentId: 'main',
        path: '/workspaces/main/DREAMS.md',
        content: buildDreamsFile([]),
        agents: [
          { agentId: 'main', path: '/workspaces/main/DREAMS.md', content: buildDreamsFile([]) },
          { agentId: 'researcher', agentName: 'Researcher', path: '/workspaces/researcher/DREAMS.md', content: realContent },
        ],
      }),
    ).toEqual([
      {
        agentId: 'researcher',
        agentName: 'Researcher',
        path: '/workspaces/researcher/DREAMS.md',
        content: realContent,
      },
    ]);

    expect(
      getVisibleLegacyDreamDiaries({
        found: true,
        path: '/workspaces/main/DREAMS.md',
        content: realContent,
      }),
    ).toEqual([
      {
        agentId: 'main',
        path: '/workspaces/main/DREAMS.md',
        content: realContent,
        updatedAtMs: undefined,
      },
    ]);
  });
});

describe('flattenDiaryBody', () => {
  test('drops section headings, list markers and memory source refs', () => {
    const body = [
      'What Happened',
      '1. Reviewed the release checklist [memory/2026-11-12.md:4]',
      'Candidates',
      '- [0.82] likely_durable: Prefers pnpm over npm',
    ].join('\n');

    expect(flattenDiaryBody(body)).toEqual([
      'Reviewed the release checklist',
      'Prefers pnpm over npm',
    ]);
  });
});

describe('diary dates', () => {
  test('parses OpenClaw stamps that Date.parse rejects', () => {
    const stamp = 'November 14, 2026 at 3:00 AM GMT+8';
    expect(Number.isNaN(Date.parse(stamp))).toBe(true);

    const parsed = parseDiaryDateMs(stamp);
    expect(parsed).not.toBeNull();
    const value = new Date(parsed as number);
    expect([value.getFullYear(), value.getMonth() + 1, value.getDate()]).toEqual([2026, 11, 14]);
  });

  test('formats chips as month/day and falls back to the raw text', () => {
    expect(formatDiaryChipLabel('November 14, 2026 at 3:00 AM GMT+8')).toBe('11/14');
    expect(formatDiaryChipLabel('someday')).toBe('someday');
    expect(parseDiaryDateMs('  ')).toBeNull();
  });
});
