import { expect, test } from 'vitest';

import { AwakeClock, SUSPENSION_GAP_MS } from './awakeClock';

const start = Date.parse('2026-10-10T01:30:04Z');

test('counts ordinary polling gaps as awake time', () => {
  const clock = new AwakeClock(start);
  expect(clock.observe(start + 600)).toBe(600);
  expect(clock.observe(start + 2_700)).toBe(2_700);
  expect(clock.observe(start + 2_700 + SUSPENSION_GAP_MS)).toBe(2_700 + SUSPENSION_GAP_MS);
  expect(clock.suspendedMs).toBe(0);
});

test('leaves a system sleep out of the awake time', () => {
  // 2026-10-10 E2E: 67s into startup the machine slept for 8.7 hours.
  const clock = new AwakeClock(start);
  for (let at = 600; at <= 67_200; at += 600) clock.observe(start + at);
  const sleptMs = 31_200_000;
  expect(clock.observe(start + 67_200 + sleptMs)).toBe(67_200);
  expect(clock.suspendedMs).toBe(sleptMs);
  expect(clock.observe(start + 67_800 + sleptMs)).toBe(67_800);
});

test('a wall clock set backwards does not reduce or inflate the awake time', () => {
  const clock = new AwakeClock(start);
  clock.observe(start + 10_000);
  expect(clock.observe(start + 4_000)).toBe(10_000);
  expect(clock.observe(start + 4_600)).toBe(10_600);
  expect(clock.suspendedMs).toBe(0);
});
