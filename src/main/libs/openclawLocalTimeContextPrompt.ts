// v2 carries only the changing value. The rules for using it are static, so
// they live in the cached AGENTS.md section (MANAGED_LOCAL_TIME_POLICY_PROMPT)
// instead of costing uncached input on every user turn.
const LOCAL_TIME_V2_START = '<!-- lobsterai:local-time-context:v2 -->';
const LOCAL_TIME_V2_END = '<!-- /lobsterai:local-time-context:v2 -->';
const LOCAL_TIME_V2_LINE = /^Local time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} \([^\n()]+\), unix ms \d+\.$/;

// v1 footers still sit in stored transcripts; keep recognizing them for display.
const LOCAL_TIME_START = '<!-- lobsterai:local-time-context:v1 -->';
const LOCAL_TIME_END = '<!-- /lobsterai:local-time-context:v1 -->';
const LOCAL_TIME_HEADING = '## Local Time Context';
const LOCAL_TIME_AUTHORITY = '- Treat this section as the authoritative current local time for this machine.';
const LOCAL_TIME_RULES = [
  '- For relative time requests (e.g. "1 minute later", "tomorrow 9am"), compute from this local time unless the user specifies another timezone.',
  '- When calling `cron.add` with `schedule.kind: "at"`, send a future ISO 8601 timestamp with an explicit timezone offset.',
  '- Never send an `at` timestamp that is equal to or earlier than the current local time.',
];

/** Static rules for the managed AGENTS.md section; the per-turn footer only carries the time. */
export const MANAGED_LOCAL_TIME_POLICY_PROMPT = [
  '## Local Time',
  '',
  '- App chat messages end with a "Local time:" line: treat it as the authoritative current local time for this machine.',
  '- Compute relative times ("1 minute later", "tomorrow 9am") from it unless the user specifies another timezone.',
  '- For a one-shot scheduled task (`schedule.kind: "at"`), send a future ISO 8601 timestamp with an explicit timezone offset, never one equal to or earlier than the current local time.',
].join('\n');

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatLocalIsoWithoutTimezone(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatUtcOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  return `${sign}${pad(hours)}:${pad(minutes)}`;
}

export function buildOpenClawLocalTimeContextPrompt(now = new Date()): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  return [
    LOCAL_TIME_V2_START,
    `Local time: ${formatLocalIsoWithoutTimezone(now)}${formatUtcOffset(now)} (${timezone}), unix ms ${now.getTime()}.`,
    LOCAL_TIME_V2_END,
  ].join('\n');
}

function stripV2Footer(trimmed: string): string | undefined {
  if (!trimmed.endsWith(`\n${LOCAL_TIME_V2_END}`)) return undefined;
  const index = trimmed.lastIndexOf(`\n\n${LOCAL_TIME_V2_START}\n`);
  if (index < 0) return undefined;
  const body = trimmed.slice(index + 2 + LOCAL_TIME_V2_START.length + 1, -LOCAL_TIME_V2_END.length - 1);
  return LOCAL_TIME_V2_LINE.test(body) ? trimmed.slice(0, index) : undefined;
}

/** Read-only display projection of an outbound prompt, never a transcript migration. */
export function stripOpenClawLocalTimeContextFooter(text: string): string {
  const trimmed = text.trimEnd();
  const strippedV2 = stripV2Footer(trimmed);
  if (strippedV2 !== undefined) return strippedV2;
  const marked = trimmed.endsWith(`\n${LOCAL_TIME_END}`);
  const start = marked ? LOCAL_TIME_START : LOCAL_TIME_HEADING;
  const index = trimmed.lastIndexOf(`\n\n${start}\n`);
  if (index < 0) return text;
  const footer = trimmed.slice(index + 2);
  const body = marked
    ? footer.slice(LOCAL_TIME_START.length + 1, -LOCAL_TIME_END.length - 1)
    : footer;
  const lines = body.split('\n');
  // Also recognize the complete legacy generated footer. A user-written heading,
  // partial quote, or ordinary discussion of time must remain untouched.
  if (lines.length !== 8
    || lines[0] !== LOCAL_TIME_HEADING
    || lines[1] !== LOCAL_TIME_AUTHORITY
    || !/^- Current local datetime: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(timezone: [^\n]+, UTC[+-]\d{2}:\d{2}\)$/.test(lines[2])
    || !/^- Current local ISO datetime \(no timezone suffix\): \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(lines[3])
    || !/^- Current unix timestamp \(ms\): \d+$/.test(lines[4])
    || !LOCAL_TIME_RULES.every((line, offset) => lines[offset + 5] === line)) {
    return text;
  }
  return trimmed.slice(0, index);
}
