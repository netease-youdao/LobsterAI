import { expect, test } from 'vitest';

import {
  DEFAULT_APP_WINDOW_HEIGHT,
  DEFAULT_APP_WINDOW_WIDTH,
  MIN_APP_WINDOW_HEIGHT,
  MIN_APP_WINDOW_WIDTH,
  normalizeAppWindowState,
  resolveInitialAppWindowState,
} from './windowState';

test('resolveInitialAppWindowState uses the centered default size on large displays', () => {
  const state = resolveInitialAppWindowState(undefined, [
    { x: 0, y: 0, width: 2560, height: 1440 },
  ]);

  expect(state).toEqual({
    x: 640,
    y: 320,
    width: DEFAULT_APP_WINDOW_WIDTH,
    height: DEFAULT_APP_WINDOW_HEIGHT,
    isMaximized: false,
  });
});

test('resolveInitialAppWindowState scales the default size to fit smaller displays', () => {
  const state = resolveInitialAppWindowState(undefined, [
    { x: 0, y: 0, width: 1000, height: 650 },
  ]);

  expect(state.width).toBe(952);
  expect(state.height).toBe(600);
  expect(state.x).toBe(24);
  expect(state.y).toBe(25);
});

test('resolveInitialAppWindowState restores stored bounds on their matching display', () => {
  const state = resolveInitialAppWindowState(
    { x: 2100, y: 100, width: 1180, height: 760, isMaximized: true },
    [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 1920, height: 1080 },
    ],
  );

  expect(state).toEqual({
    x: 2100,
    y: 100,
    width: 1180,
    height: 760,
    isMaximized: true,
  });
});

test('resolveInitialAppWindowState scales stale large-display bounds into the visible work area', () => {
  const state = resolveInitialAppWindowState(
    { x: 3000, y: 2000, width: 2048, height: 1360 },
    [{ x: 0, y: 0, width: 1440, height: 900 }],
  );

  expect(state).toEqual({
    x: 79,
    y: 24,
    width: 1283,
    height: 852,
    isMaximized: false,
  });
});

test('normalizeAppWindowState rejects invalid stored values', () => {
  expect(normalizeAppWindowState({ width: 0, height: 800 })).toBeUndefined();
  expect(normalizeAppWindowState({ width: 1200 })).toBeUndefined();
  expect(normalizeAppWindowState(null)).toBeUndefined();
});

test('normalizeAppWindowState rounds and keeps minimum-sized values for later fitting', () => {
  expect(normalizeAppWindowState({ x: 1.4, y: 2.6, width: 799.5, height: 599.5 })).toEqual({
    x: 1,
    y: 3,
    width: MIN_APP_WINDOW_WIDTH,
    height: MIN_APP_WINDOW_HEIGHT,
    isMaximized: false,
  });
});
