import { afterEach, expect, test, vi } from 'vitest';

import { OpenClawEngineErrorCode, OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import type { OpenClawEngineStatus } from '../types/cowork';
import { i18nService } from './i18n';
import { isConfigApplyPendingStatus, resolveEngineNotReadyMessage } from './openclawEngineStatus';

afterEach(() => vi.restoreAllMocks());

const starting: OpenClawEngineStatus = {
  phase: OpenClawEnginePhase.Starting, version: '2026.8.1', message: 'Starting OpenClaw gateway...', canRetry: false,
};
const configPending: OpenClawEngineStatus = { ...starting, message: 'applying', configApplyPending: true };
const stalled: OpenClawEngineStatus = {
  phase: OpenClawEnginePhase.Error, version: '2026.8.1', message: 'stalled',
  errorCode: OpenClawEngineErrorCode.ConfigApplyStalled, canRetry: false,
};

test('only an admission reply about an unapplied config is excluded from engine lifecycle state', () => {
  expect(isConfigApplyPendingStatus(configPending)).toBe(true);
  expect(isConfigApplyPendingStatus(starting)).toBe(false);
  expect(isConfigApplyPendingStatus(stalled)).toBe(false);
  expect(isConfigApplyPendingStatus(undefined)).toBe(false);
});

test('explains why a task was refused instead of always claiming the engine is starting', () => {
  vi.spyOn(i18nService, 't').mockImplementation(key => key);
  expect(resolveEngineNotReadyMessage(configPending)).toBe('coworkErrorConfigApplyPending');
  expect(resolveEngineNotReadyMessage(stalled)).toBe('coworkErrorConfigApplyStalled');
  expect(resolveEngineNotReadyMessage(starting)).toBe('coworkErrorEngineNotReady');
  expect(resolveEngineNotReadyMessage(null)).toBe('coworkErrorEngineNotReady');
});
