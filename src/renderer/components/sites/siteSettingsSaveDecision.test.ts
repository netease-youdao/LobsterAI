import { describe, expect, test } from 'vitest';

import {
  resolveSiteSettingsSaveDecision,
  SiteSettingsSaveDecision,
} from './siteSettingsSaveDecision';

const resolveDecision = (overrides: Partial<Parameters<
  typeof resolveSiteSettingsSaveDecision
>[0]> = {}) => resolveSiteSettingsSaveDecision({
  accessChanged: false,
  actionLoading: false,
  currentAccessStopped: false,
  hasUnsavedSettings: true,
  targetAccessStopped: false,
  ...overrides,
});

describe('resolveSiteSettingsSaveDecision', () => {
  test('saves a title-only change directly', () => {
    expect(resolveDecision()).toBe(SiteSettingsSaveDecision.SaveDirectly);
  });

  test('confirms a live access-mode change', () => {
    expect(resolveDecision({ accessChanged: true })).toBe(
      SiteSettingsSaveDecision.ConfirmChange,
    );
  });

  test('uses the stop warning when access will be stopped', () => {
    expect(resolveDecision({
      accessChanged: true,
      targetAccessStopped: true,
    })).toBe(SiteSettingsSaveDecision.ConfirmStop);
  });

  test('uses the resume warning when stopped access will be restored', () => {
    expect(resolveDecision({
      accessChanged: true,
      currentAccessStopped: true,
    })).toBe(SiteSettingsSaveDecision.ConfirmResume);
  });

  test.each([
    { hasUnsavedSettings: false },
    { actionLoading: true },
  ])('does nothing for $hasUnsavedSettings/$actionLoading state', overrides => {
    expect(resolveDecision(overrides)).toBe(SiteSettingsSaveDecision.None);
  });
});
