import { describe, expect, test } from 'vitest';

import { type AppUpdateRuntimeState, AppUpdateStatus } from '../../../shared/appUpdate/constants';
import { isAppUpdateReadyToInstall, shouldShowAppUpdateNotice } from './appUpdateNoticeState';

const createState = (
  status: AppUpdateRuntimeState['status'],
  overrides: Partial<AppUpdateRuntimeState> = {},
): AppUpdateRuntimeState => ({
  status,
  source: null,
  info: {
    latestVersion: '2026.9.4',
    date: '2026-09-04',
    changeLog: { zh: { title: '', content: [] }, en: { title: '', content: [] } },
    url: 'https://updates.example.com/lobsterai-2026.9.4.dmg',
  },
  progress: null,
  readyFilePath: null,
  readyFileHash: null,
  errorMessage: null,
  ...overrides,
});

describe('shouldShowAppUpdateNotice', () => {
  test('stays silent while nothing is known or a download is in flight', () => {
    expect(shouldShowAppUpdateNotice(createState(AppUpdateStatus.Idle))).toBe(false);
    expect(shouldShowAppUpdateNotice(createState(AppUpdateStatus.Checking))).toBe(false);
    expect(shouldShowAppUpdateNotice(createState(AppUpdateStatus.Downloading, {
      progress: { received: 10, total: 100, percent: 0.1, speed: 5 },
    }))).toBe(false);
  });

  test('surfaces states that need the user', () => {
    expect(shouldShowAppUpdateNotice(createState(AppUpdateStatus.Available))).toBe(true);
    expect(shouldShowAppUpdateNotice(createState(AppUpdateStatus.Ready, {
      readyFilePath: '/tmp/update.dmg',
    }))).toBe(true);
    expect(shouldShowAppUpdateNotice(createState(AppUpdateStatus.Installing, {
      readyFilePath: '/tmp/update.dmg',
    }))).toBe(true);
    expect(shouldShowAppUpdateNotice(createState(AppUpdateStatus.Error, {
      errorMessage: 'Download failed',
    }))).toBe(true);
  });

  test('keeps a ready update visible through a routine re-check', () => {
    expect(shouldShowAppUpdateNotice(createState(AppUpdateStatus.Checking, {
      readyFilePath: '/tmp/update.dmg',
    }))).toBe(true);
  });

  test('never shows anything without update metadata', () => {
    expect(shouldShowAppUpdateNotice(createState(AppUpdateStatus.Error, { info: null }))).toBe(false);
    expect(shouldShowAppUpdateNotice(createState(AppUpdateStatus.Ready, {
      info: null,
      readyFilePath: '/tmp/update.dmg',
    }))).toBe(false);
  });
});

describe('isAppUpdateReadyToInstall', () => {
  test('requires a verified installer path', () => {
    expect(isAppUpdateReadyToInstall(createState(AppUpdateStatus.Ready))).toBe(false);
    expect(isAppUpdateReadyToInstall(createState(AppUpdateStatus.Ready, {
      readyFilePath: '/tmp/update.dmg',
    }))).toBe(true);
  });

  test('treats a re-check of a ready update as still ready', () => {
    expect(isAppUpdateReadyToInstall(createState(AppUpdateStatus.Checking, {
      readyFilePath: '/tmp/update.dmg',
    }))).toBe(true);
    expect(isAppUpdateReadyToInstall(createState(AppUpdateStatus.Downloading, {
      readyFilePath: '/tmp/update.dmg',
    }))).toBe(false);
  });
});
