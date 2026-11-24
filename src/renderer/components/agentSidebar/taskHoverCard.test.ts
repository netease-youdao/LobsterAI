import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import {
  calculateTaskHoverCardPosition,
  formatTaskHoverUpdatedTime,
  formatTaskWorkspaceDisplay,
  TASK_HOVER_CARD_HORIZONTAL_GAP,
  TASK_HOVER_CARD_TITLE_ALIGN_OFFSET,
  TASK_HOVER_CARD_VIEWPORT_PADDING,
} from './taskHoverCard';

afterEach(() => {
  vi.restoreAllMocks();
  i18nService.setLanguage('zh', { persist: false });
});

test('formatTaskWorkspaceDisplay resolves folder name and compacts home directory paths', () => {
  expect(formatTaskWorkspaceDisplay('/Users/alice/Dev/lobsterai/')).toEqual({
    folderName: 'lobsterai',
    displayPath: '~/Dev/lobsterai',
    fullPath: '/Users/alice/Dev/lobsterai',
  });

  expect(formatTaskWorkspaceDisplay('C:\\Users\\alice\\Projects\\app\\')).toEqual({
    folderName: 'app',
    displayPath: '~\\Projects\\app',
    fullPath: 'C:\\Users\\alice\\Projects\\app',
  });

  expect(formatTaskWorkspaceDisplay('', '/home/bob/work')).toEqual({
    folderName: 'work',
    displayPath: '~/work',
    fullPath: '/home/bob/work',
  });

  expect(formatTaskWorkspaceDisplay('/', '')).toEqual({
    folderName: '/',
    displayPath: '/',
    fullPath: '/',
  });

  expect(formatTaskWorkspaceDisplay('', '   ')).toBeNull();
});

test('formatTaskHoverUpdatedTime always includes year, month, day and time', () => {
  const now = new Date(2026, 10, 24, 19, 30).getTime(); // 2026-11-24 19:30 local
  const today = new Date(2026, 10, 24, 17, 11).getTime();
  const yesterday = new Date(2026, 10, 23, 9, 5).getTime();
  const earlierThisYear = new Date(2026, 10, 12, 14, 20).getTime();
  const lastYear = new Date(2025, 4, 8, 8, 3).getTime();

  i18nService.setLanguage('zh', { persist: false });
  expect(formatTaskHoverUpdatedTime(today, { now })).toBe('更新于 2026/11/24 17:11');
  expect(formatTaskHoverUpdatedTime(yesterday, { now })).toBe('更新于 2026/11/23 09:05');
  expect(formatTaskHoverUpdatedTime(earlierThisYear, { now })).toBe('更新于 2026/11/12 14:20');
  expect(formatTaskHoverUpdatedTime(lastYear, { now })).toBe('更新于 2025/05/08 08:03');
  expect(formatTaskHoverUpdatedTime(0, { now })).toBe('更新于 2026/11/24 19:30');

  i18nService.setLanguage('en', { persist: false });
  expect(formatTaskHoverUpdatedTime(today, { now })).toBe('Updated 2026/11/24 17:11');
  expect(formatTaskHoverUpdatedTime(yesterday, { now })).toBe('Updated 2026/11/23 09:05');
  expect(formatTaskHoverUpdatedTime(earlierThisYear, { now })).toBe('Updated 2026/11/12 14:20');
  expect(formatTaskHoverUpdatedTime(lastYear, { now })).toBe('Updated 2025/05/08 08:03');
  expect(formatTaskHoverUpdatedTime(Number.NaN, { now })).toBe('Updated 2026/11/24 19:30');
});

test('calculateTaskHoverCardPosition anchors outside sidebar right edge and clamps within viewport', () => {
  expect(calculateTaskHoverCardPosition(
    { rowTop: 180, rowHeight: 32, sidebarRight: 260 },
    { width: 1280, height: 800 },
    { width: 276, height: 120 },
  )).toEqual({
    left: 260 + TASK_HOVER_CARD_HORIZONTAL_GAP,
    top: 180 - TASK_HOVER_CARD_TITLE_ALIGN_OFFSET,
  });

  // Clamps near top and bottom edges.
  expect(calculateTaskHoverCardPosition(
    { rowTop: 4, rowHeight: 32, sidebarRight: 260 },
    { width: 1280, height: 800 },
    { width: 276, height: 120 },
  ).top).toBe(TASK_HOVER_CARD_VIEWPORT_PADDING);

  expect(calculateTaskHoverCardPosition(
    { rowTop: 760, rowHeight: 32, sidebarRight: 260 },
    { width: 1280, height: 800 },
    { width: 276, height: 120 },
  ).top).toBe(800 - 120 - TASK_HOVER_CARD_VIEWPORT_PADDING);

  // Clamps horizontally on very narrow viewports.
  expect(calculateTaskHoverCardPosition(
    { rowTop: 200, rowHeight: 32, sidebarRight: 400 },
    { width: 500, height: 800 },
    { width: 276, height: 120 },
  ).left).toBe(500 - 276 - TASK_HOVER_CARD_VIEWPORT_PADDING);
});
