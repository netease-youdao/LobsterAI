// Dream Diary parsing helpers. Mirrors OpenClaw's DREAMS.md layout:
//   <!-- openclaw:dreaming:diary:start -->
//   ---
//   *November 14, 2026 at 3:00 AM GMT+8*
//   narrative...
//   <!-- openclaw:dreaming:diary:end -->

import { AgentId } from '../../../shared/agent/constants';
import type { DreamDiaryData, LegacyAgentDreamDiary } from '../../../shared/cowork/dreamDiary';

export type DiaryEntry = {
  date: string;
  body: string;
};

const DIARY_START_RE = /<!--\s*openclaw:dreaming:diary:start\s*-->/;
const DIARY_END_RE = /<!--\s*openclaw:dreaming:diary:end\s*-->/;
const DIARY_SEPARATOR_RE = /(?:^|\n)---[ \t]*(?:\n|$)/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const EMPTY_DIARY_BOILERPLATE_LINE_RE = /^(?:#+\s*dream\s+diary\s*|---+)$/i;
// Leading calendar date of OpenClaw's en-US diary stamps, e.g. "November 14, 2026".
const DIARY_CALENDAR_DATE_RE = /^([A-Za-z]+\s+\d{1,2},\s*\d{4})/;

const DIARY_SECTION_HEADINGS = new Set([
  'What Happened',
  'Reflections',
  'Candidates',
  'Possible Lasting Updates',
]);

export function parseDiaryEntries(raw: string): DiaryEntry[] {
  const normalized = raw.replace(/\r\n?/g, '\n');
  let content = normalized;
  const startMatch = DIARY_START_RE.exec(normalized);
  const endMatch = DIARY_END_RE.exec(normalized);
  if (startMatch && endMatch && endMatch.index > startMatch.index) {
    content = normalized.slice(startMatch.index + startMatch[0].length, endMatch.index);
  }
  const entries: DiaryEntry[] = [];
  const blocks = content.split(DIARY_SEPARATOR_RE).filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    let date = '';
    const bodyLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        !date
        && trimmed.startsWith('*')
        && !trimmed.startsWith('**')
        && trimmed.endsWith('*')
        && trimmed.length > 2
      ) {
        date = trimmed.slice(1, -1);
        continue;
      }
      if (trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
      if (trimmed.length > 0) bodyLines.push(trimmed);
    }
    if (bodyLines.length > 0) {
      entries.push({ date, body: bodyLines.join('\n') });
    }
  }
  return entries;
}

/**
 * Returns true when `raw` contains either parsed diary entries or non-empty
 * text beyond OpenClaw's freshly-seeded empty `# Dream Diary` markers.
 */
export function hasMeaningfulDiaryContent(raw?: string | null): boolean {
  if (!raw || !raw.trim()) return false;
  if (parseDiaryEntries(raw).length > 0) return true;
  const remaining = raw
    .replace(/\r\n?/g, '\n')
    .replace(HTML_COMMENT_RE, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !EMPTY_DIARY_BOILERPLATE_LINE_RE.test(line));
  return remaining.length > 0;
}

/**
 * Resolve the ordered list of historical agent diaries that actually have
 * readable content to display in Settings -> Memory.
 */
export function getVisibleLegacyDreamDiaries(
  diary?: DreamDiaryData | null,
): LegacyAgentDreamDiary[] {
  if (!diary || !diary.found) return [];
  if (Array.isArray(diary.agents) && diary.agents.length > 0) {
    return diary.agents.filter((agent) => hasMeaningfulDiaryContent(agent.content));
  }
  if (hasMeaningfulDiaryContent(diary.content)) {
    return [
      {
        agentId: diary.agentId || AgentId.Main,
        path: diary.path,
        content: diary.content ?? '',
        updatedAtMs: diary.updatedAtMs,
      },
    ];
  }
  return [];
}

export function flattenDiaryBody(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !DIARY_SECTION_HEADINGS.has(line))
    .map((line) => line.replace(/\s*\[memory\/[^\]]+\]/g, ''))
    .map((line) =>
      line
        .replace(/^(?:\d+\.\s+|-\s+(?:\[[^\]]+\]\s+)?(?:[a-z_]+:\s+)?)/i, '')
        .replace(/^(?:likely_durable|likely_situational|unclear):\s+/i, '')
        .trim(),
    )
    .filter((line) => line.length > 0);
}

/**
 * Parses the calendar day of a diary date stamp. OpenClaw writes stamps such
 * as "November 14, 2026 at 3:00 AM GMT+8", which `Date.parse` rejects because
 * of the "at" separator. Only the calendar part is used so the chip shows the
 * day the diary was written, regardless of the viewer's time zone.
 */
export function parseDiaryDateMs(date: string): number | null {
  const trimmed = date.trim();
  if (!trimmed) return null;
  const calendar = DIARY_CALENDAR_DATE_RE.exec(trimmed)?.[1];
  const candidates = [calendar, trimmed, trimmed.replace(/\s+at\s+/i, ' ')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function formatDiaryChipLabel(date: string): string {
  const parsed = parseDiaryDateMs(date);
  if (parsed === null) return date;
  const value = new Date(parsed);
  return `${value.getMonth() + 1}/${value.getDate()}`;
}
