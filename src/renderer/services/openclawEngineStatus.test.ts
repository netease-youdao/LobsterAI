import { afterEach, expect, test, vi } from 'vitest';

import { getLanguage as getMainLanguage, setLanguage as setMainLanguage, t as mainText } from '../../main/i18n';
import { OpenClawConfigApplyPendingReason, OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import type { OpenClawEngineStatus } from '../types/cowork';
import { i18nService } from './i18n';
import { isConfigApplyPendingStatus, resolveEngineNotReadyMessage } from './openclawEngineStatus';

afterEach(() => vi.restoreAllMocks());

const starting: OpenClawEngineStatus = {
  phase: OpenClawEnginePhase.Starting, version: '2026.8.1', message: 'Starting OpenClaw gateway...', canRetry: false,
};
const configPending: OpenClawEngineStatus = { ...starting, message: 'applying', configApplyPending: true };
const modelSettingsPending: OpenClawEngineStatus = {
  ...configPending,
  configApplyPendingReason: OpenClawConfigApplyPendingReason.ModelSettings,
};
const stalled: OpenClawEngineStatus = {
  phase: OpenClawEnginePhase.Running, version: '2026.8.1', canRetry: false,
  configApplyStalled: { detail: 'config.apply failed: gateway request timeout for config.apply' },
};

test('only an admission reply about an unapplied config is excluded from engine lifecycle state', () => {
  expect(isConfigApplyPendingStatus(configPending)).toBe(true);
  expect(isConfigApplyPendingStatus(starting)).toBe(false);
  // A stall rides on real engine status: the renderer must keep it.
  expect(isConfigApplyPendingStatus(stalled)).toBe(false);
  expect(isConfigApplyPendingStatus(undefined)).toBe(false);
});

test('explains why a task was refused instead of always claiming the engine is starting', () => {
  vi.spyOn(i18nService, 't').mockImplementation(key => key);
  expect(resolveEngineNotReadyMessage(configPending)).toBe('coworkErrorConfigApplyPending');
  expect(resolveEngineNotReadyMessage(modelSettingsPending)).toBe('coworkErrorConfigApplyPendingForModel');
  expect(resolveEngineNotReadyMessage(starting)).toBe('coworkErrorEngineNotReady');
  expect(resolveEngineNotReadyMessage(null)).toBe('coworkErrorEngineNotReady');
});

test.each(['zh', 'en'] as const)('keeps %s model-pending copy consistent without assuming active tasks', language => {
  const previousMainLanguage = getMainLanguage(), previousRendererLanguage = i18nService.getLanguage();
  try {
    setMainLanguage(language);
    i18nService.setLanguage(language, { persist: false });
    const message = resolveEngineNotReadyMessage(modelSettingsPending);
    expect(message).toBe(mainText('openClawConfigApplyPendingForModel'));
    expect(message).toContain(language === 'zh' ? '尚未确认生效' : "haven't been confirmed as applied");
    expect(message).toContain(language === 'zh' ? '如有任务运行' : 'If tasks are running');
    expect(message).not.toContain(language === 'zh' ? '先停止正在运行的任务' : 'Stop the running tasks');
  } finally {
    setMainLanguage(previousMainLanguage);
    i18nService.setLanguage(previousRendererLanguage, { persist: false });
  }
});
