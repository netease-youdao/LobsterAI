import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./logReporter', () => ({
  reportYdAnalyzer: vi.fn(async () => true),
}));

import { LogReporterAction, LogReporterSource } from '../../shared/analytics/constants';
import { DshEngineErrorCode, DshEnginePhase } from '../../shared/dshEngine/constants';
import {
  buildDshEnabledChangedEvent,
  buildDshOpenWorkbenchEvent,
  DSH_ANALYTICS_ERROR_DETAIL_MAX_LENGTH,
  DshAnalyticsActionType,
  DshAnalyticsErrorCode,
  DshAnalyticsResult,
  DshAnalyticsSettingKey,
  reportDshEnabledChanged,
  reportDshOpenWorkbench,
  resolveDshOpenWorkbenchErrorCode,
  sanitizeDshErrorDetail,
} from './dshAnalytics';
import { reportYdAnalyzer } from './logReporter';

const reportMock = vi.mocked(reportYdAnalyzer);

beforeEach(() => {
  reportMock.mockClear();
});

describe('sanitizeDshErrorDetail', () => {
  test('strips the ipc wrapper prefix', () => {
    const error = new Error("Error invoking remote method 'dsh:openWorkbench': Error: DeepSeek Harness is not enabled");
    expect(sanitizeDshErrorDetail(error)).toBe('DeepSeek Harness is not enabled');
  });

  test('replaces a macOS home (with a spaced user name) by ~ and keeps the tail', () => {
    const error = new Error('Invalid dsh runtime manifest at /Users/jane doe/Library/Application Support/LobsterAI/dsh/manifest.json');
    expect(sanitizeDshErrorDetail(error)).toBe(
      'Invalid dsh runtime manifest at ~/Library/Application Support/LobsterAI/dsh/manifest.json'
    );
  });

  test('replaces a linux home and stops at punctuation after the user name', () => {
    expect(sanitizeDshErrorDetail(new Error('Another dsh is using /home/jane/.dsh (lock_held)'))).toBe(
      'Another dsh is using ~/.dsh (lock_held)'
    );
    expect(sanitizeDshErrorDetail(new Error('EACCES: /Users/jane doe (read-only)'))).toBe('EACCES: ~ (read-only)');
  });

  test('replaces a windows home with either separator', () => {
    expect(sanitizeDshErrorDetail(new Error('EPERM: C:\\Users\\Jane Doe\\AppData\\Roaming\\LobsterAI\\dsh'))).toBe(
      'EPERM: ~\\AppData\\Roaming\\LobsterAI\\dsh'
    );
    expect(sanitizeDshErrorDetail(new Error('EPERM: c:/users/jane doe/AppData/Roaming'))).toBe('EPERM: ~/AppData/Roaming');
  });

  test('masks absolute paths outside a home directory', () => {
    expect(sanitizeDshErrorDetail(new Error('spawn /opt/homebrew/bin/tar ENOENT'))).toBe('spawn <path> ENOENT');
    expect(sanitizeDshErrorDetail(new Error('tar not found at D:\\Tools\\tar.exe'))).toBe('tar not found at <path>');
  });

  test('drops url queries and fragments but keeps the origin and path', () => {
    const error = new Error('HTTP 403 from https://dl.example.com/dsh/rc7.tgz?token=secret#frag');
    expect(sanitizeDshErrorDetail(error)).toBe('HTTP 403 from https://dl.example.com/dsh/rc7.tgz');
  });

  test('keeps structured messages untouched', () => {
    expect(sanitizeDshErrorDetail(new Error('DeepSeek Harness engine failed to start (phase=failed, error=ready_timeout)'))).toBe(
      'DeepSeek Harness engine failed to start (phase=failed, error=ready_timeout)'
    );
    expect(sanitizeDshErrorDetail(new Error('Archive sha256 mismatch: expected abc, got def'))).toBe(
      'Archive sha256 mismatch: expected abc, got def'
    );
  });

  test('collapses whitespace and truncates long messages', () => {
    const detail = sanitizeDshErrorDetail(new Error(`first line\n  second\tline ${'x'.repeat(400)}`));
    expect(detail.startsWith('first line second line xxx')).toBe(true);
    expect(detail).toHaveLength(DSH_ANALYTICS_ERROR_DETAIL_MAX_LENGTH);
    expect(detail.endsWith('…')).toBe(true);
  });

  test('accepts non-Error values', () => {
    expect(sanitizeDshErrorDetail('plain string failure')).toBe('plain string failure');
    expect(sanitizeDshErrorDetail({ code: 42 })).toBe('[object Object]');
    expect(sanitizeDshErrorDetail(undefined)).toBe('undefined');
  });
});

describe('buildDshEnabledChangedEvent', () => {
  test('reports an actual toggle with previous and next values', () => {
    expect(buildDshEnabledChangedEvent(false, true)).toEqual({
      action: LogReporterAction.ExperimentalSettingChanged,
      settingKey: DshAnalyticsSettingKey.Enabled,
      settingValue: true,
      previousValue: false,
      source: LogReporterSource.SettingsExperimental,
    });
    expect(buildDshEnabledChangedEvent(true, false)?.settingValue).toBe(false);
  });

  test('returns null when the value did not change', () => {
    expect(buildDshEnabledChangedEvent(true, true)).toBeNull();
    expect(buildDshEnabledChangedEvent(false, false)).toBeNull();
  });
});

describe('resolveDshOpenWorkbenchErrorCode', () => {
  test('maps the feature-off rejection without engine state', () => {
    const error = new Error("Error invoking remote method 'dsh:openWorkbench': Error: DeepSeek Harness is not enabled");
    expect(resolveDshOpenWorkbenchErrorCode(null, error)).toBe(DshAnalyticsErrorCode.NotEnabled);
  });

  test('uses the engine code only in terminal failure phases', () => {
    const error = new Error('engine failed');
    expect(resolveDshOpenWorkbenchErrorCode({ phase: DshEnginePhase.Failed, errorCode: DshEngineErrorCode.InstallFailed }, error))
      .toBe(DshEngineErrorCode.InstallFailed);
    expect(resolveDshOpenWorkbenchErrorCode({ phase: DshEnginePhase.NotInstalled, errorCode: DshEngineErrorCode.RuntimeMissing }, error))
      .toBe(DshEngineErrorCode.RuntimeMissing);
  });

  test('falls back to unknown when the state carries no code for this failure', () => {
    const error = new Error('engine failed');
    expect(resolveDshOpenWorkbenchErrorCode({ phase: DshEnginePhase.Failed, errorCode: null }, error)).toBe(DshAnalyticsErrorCode.Unknown);
    expect(resolveDshOpenWorkbenchErrorCode({ phase: DshEnginePhase.Ready, errorCode: DshEngineErrorCode.InstallFailed }, error))
      .toBe(DshAnalyticsErrorCode.Unknown);
    expect(resolveDshOpenWorkbenchErrorCode(null, error)).toBe(DshAnalyticsErrorCode.Unknown);
  });
});

describe('buildDshOpenWorkbenchEvent', () => {
  test('omits error fields on success', () => {
    expect(buildDshOpenWorkbenchEvent({ phaseBefore: DshEnginePhase.Ready, result: DshAnalyticsResult.Success })).toEqual({
      action: LogReporterAction.DshAction,
      actionType: DshAnalyticsActionType.OpenWorkbench,
      source: LogReporterSource.SettingsExperimental,
      phaseBefore: DshEnginePhase.Ready,
      result: DshAnalyticsResult.Success,
      errorCode: undefined,
      errorDetail: undefined,
    });
  });

  test('carries the error class and a masked detail on failure', () => {
    const event = buildDshOpenWorkbenchEvent({
      phaseBefore: DshEnginePhase.NotInstalled,
      result: DshAnalyticsResult.Failed,
      errorCode: DshEngineErrorCode.InstallFailed,
      error: new Error("Error invoking remote method 'dsh:openWorkbench': Error: Extracted runtime is incomplete at /Users/jane/Library/dsh, missing: bin/dsh"),
    });
    expect(event.result).toBe(DshAnalyticsResult.Failed);
    expect(event.errorCode).toBe(DshEngineErrorCode.InstallFailed);
    expect(event.errorDetail).toBe('Extracted runtime is incomplete at ~/Library/dsh, missing: bin/dsh');
  });

  test('defaults a failure without a class to unknown and skips detail without an error', () => {
    const event = buildDshOpenWorkbenchEvent({ phaseBefore: DshEnginePhase.Stopped, result: DshAnalyticsResult.Failed });
    expect(event.errorCode).toBe(DshAnalyticsErrorCode.Unknown);
    expect(event.errorDetail).toBeUndefined();
  });
});

describe('report helpers', () => {
  test('reportDshEnabledChanged sends through reportYdAnalyzer only on change', () => {
    reportDshEnabledChanged(false, true);
    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(reportMock).toHaveBeenCalledWith(expect.objectContaining({
      action: LogReporterAction.ExperimentalSettingChanged,
      settingValue: true,
    }));

    reportDshEnabledChanged(true, true);
    expect(reportMock).toHaveBeenCalledTimes(1);
  });

  test('reportDshOpenWorkbench sends the built event', () => {
    reportDshOpenWorkbench({ phaseBefore: DshEnginePhase.Stopped, result: DshAnalyticsResult.Success });
    expect(reportMock).toHaveBeenCalledWith(expect.objectContaining({
      action: LogReporterAction.DshAction,
      actionType: DshAnalyticsActionType.OpenWorkbench,
      result: DshAnalyticsResult.Success,
    }));
  });
});
