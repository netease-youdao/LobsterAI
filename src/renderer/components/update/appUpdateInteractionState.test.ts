import { describe, expect, test } from 'vitest';

import { AppUpdateStatus } from '../../../shared/appUpdate/constants';
import {
  isAppUpdateInteractionBlockingStatus,
  shouldBlockAppInteractionForUpdate,
} from './appUpdateInteractionState';

describe('app update interaction state', () => {
  test.each([
    AppUpdateStatus.Ready,
    AppUpdateStatus.Installing,
  ])('blocks an active user-initiated install while status is %s', (status) => {
    expect(shouldBlockAppInteractionForUpdate(true, status)).toBe(true);
  });

  test.each([
    AppUpdateStatus.Idle,
    AppUpdateStatus.Checking,
    AppUpdateStatus.Available,
    AppUpdateStatus.Downloading,
    AppUpdateStatus.Error,
  ])('does not block while status is %s', (status) => {
    expect(isAppUpdateInteractionBlockingStatus(status)).toBe(false);
    expect(shouldBlockAppInteractionForUpdate(true, status)).toBe(false);
  });

  test.each([
    AppUpdateStatus.Downloading,
    AppUpdateStatus.Ready,
    AppUpdateStatus.Installing,
  ])('does not block background update status %s', (status) => {
    expect(shouldBlockAppInteractionForUpdate(false, status)).toBe(false);
  });
});
