import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildOpenClawLocalTimeContextPrompt,
} = require('../dist-electron/main/libs/openclawLocalTimeContextPrompt.js');

test('openclaw local time context prompt makes future at-timestamps explicit', () => {
  const now = new Date('2026-03-15T08:28:00.000Z');
  const prompt = buildOpenClawLocalTimeContextPrompt(now);

  assert.match(prompt, /authoritative current local time/i);
  assert.match(prompt, /Current local datetime: /);
  assert.match(prompt, /UTC[+-]\d{2}:\d{2}/);
  assert.match(prompt, new RegExp(`Current unix timestamp \\(ms\\): ${now.getTime()}`));
  assert.match(prompt, /future ISO 8601 timestamp with an explicit timezone offset/i);
  assert.match(prompt, /Never send an `at` timestamp that is equal to or earlier/i);
});
