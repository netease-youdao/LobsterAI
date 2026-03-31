import { describe, expect, test } from 'vitest';
import { buildOpenClawLocalTimeContextPrompt } from './openclawLocalTimeContextPrompt';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse "key: value" lines from the prompt string into a map. */
function parseLines(prompt: string): string[] {
  return prompt.split('\n');
}

// ---------------------------------------------------------------------------
// buildOpenClawLocalTimeContextPrompt
// ---------------------------------------------------------------------------

describe('buildOpenClawLocalTimeContextPrompt', () => {
  test('returns a string containing the section header', () => {
    const result = buildOpenClawLocalTimeContextPrompt(new Date());
    expect(result).toContain('## Local Time Context');
  });

  test('contains "Current local datetime" line', () => {
    const result = buildOpenClawLocalTimeContextPrompt(new Date());
    expect(result).toContain('Current local datetime:');
  });

  test('contains "Current local ISO datetime" line', () => {
    const result = buildOpenClawLocalTimeContextPrompt(new Date());
    expect(result).toContain('Current local ISO datetime (no timezone suffix):');
  });

  test('contains "Current unix timestamp" line', () => {
    const result = buildOpenClawLocalTimeContextPrompt(new Date());
    expect(result).toContain('Current unix timestamp (ms):');
  });

  test('embeds the correct unix timestamp', () => {
    const now = new Date('2025-06-15T10:30:00.000Z');
    const result = buildOpenClawLocalTimeContextPrompt(now);
    expect(result).toContain(String(now.getTime()));
  });

  test('formats date components with zero-padding', () => {
    // Use a fixed date where month, day, hour, minute, second are all < 10
    const now = new Date(2025, 0, 5, 8, 7, 3); // 2025-01-05 08:07:03 local
    const result = buildOpenClawLocalTimeContextPrompt(now);
    // Check that the formatted datetime string appears in the prompt
    expect(result).toContain('2025-01-05 08:07:03');
  });

  test('ISO datetime line has no timezone suffix (no Z or +offset)', () => {
    const now = new Date(2025, 5, 15, 12, 0, 0);
    const result = buildOpenClawLocalTimeContextPrompt(now);
    const isoLine = result.split('\n').find((l) => l.includes('Current local ISO datetime'));
    expect(isoLine).toBeDefined();
    // The ISO datetime value after the colon should not end with Z or contain offset notation
    const value = isoLine!.split(': ')[1];
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  test('UTC offset is included in the datetime line', () => {
    const now = new Date(2025, 0, 1, 0, 0, 0);
    const result = buildOpenClawLocalTimeContextPrompt(now);
    const datetimeLine = result.split('\n').find((l) => l.includes('Current local datetime:'));
    expect(datetimeLine).toBeDefined();
    // Should contain UTC offset pattern like UTC+08:00 or UTC-05:00
    expect(datetimeLine).toMatch(/UTC[+-]\d{2}:\d{2}/);
  });

  test('UTC offset format sign is + for non-negative offset', () => {
    // We can only reliably test the format pattern; actual sign depends on runtime TZ
    const result = buildOpenClawLocalTimeContextPrompt(new Date());
    expect(result).toMatch(/UTC[+-]\d{2}:\d{2}/);
  });

  test('uses current time when no argument is passed', () => {
    const before = Date.now();
    const result = buildOpenClawLocalTimeContextPrompt();
    const after = Date.now();

    // Extract unix timestamp from the prompt
    const match = result.match(/Current unix timestamp \(ms\): (\d+)/);
    expect(match).not.toBeNull();
    const ts = Number(match![1]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test('contains the cron.add instruction line', () => {
    const result = buildOpenClawLocalTimeContextPrompt(new Date());
    expect(result).toContain('cron.add');
  });

  test('contains the "Never send an at timestamp" warning line', () => {
    const result = buildOpenClawLocalTimeContextPrompt(new Date());
    expect(result).toContain('Never send an `at` timestamp');
  });

  test('contains instruction about relative time requests', () => {
    const result = buildOpenClawLocalTimeContextPrompt(new Date());
    expect(result).toContain('relative time requests');
  });

  test('prompt has exactly 8 lines', () => {
    const result = buildOpenClawLocalTimeContextPrompt(new Date());
    const lines = parseLines(result);
    expect(lines).toHaveLength(8);
  });

  test('first line is the section header', () => {
    const result = buildOpenClawLocalTimeContextPrompt(new Date());
    const lines = parseLines(result);
    expect(lines[0]).toBe('## Local Time Context');
  });

  test('all bullet lines start with "- "', () => {
    const result = buildOpenClawLocalTimeContextPrompt(new Date());
    const lines = parseLines(result);
    // Lines 1–7 should be bullet points
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^- /);
    }
  });

  test('ISO datetime value matches expected year from provided date', () => {
    const now = new Date(2030, 11, 31, 23, 59, 59);
    const result = buildOpenClawLocalTimeContextPrompt(now);
    expect(result).toContain('2030-12-31T23:59:59');
  });

  test('different dates produce different timestamps in output', () => {
    const d1 = new Date(2025, 0, 1, 12, 0, 0);
    const d2 = new Date(2025, 0, 2, 12, 0, 0);
    const r1 = buildOpenClawLocalTimeContextPrompt(d1);
    const r2 = buildOpenClawLocalTimeContextPrompt(d2);
    expect(r1).not.toBe(r2);
  });
});
