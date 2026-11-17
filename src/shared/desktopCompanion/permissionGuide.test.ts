import { describe, expect, test } from 'vitest';

import { CompanionPermission } from './constants';
import {
  COMPANION_PERMISSION_GUIDE_RELAUNCH_SIZE,
  COMPANION_PERMISSION_GUIDE_SIZE as SIZE,
  COMPANION_PERMISSION_INTRO_SIZE,
  companionPermissionGuideSize,
  companionPermissionNeedsRelaunch,
  companionPermissionPaneKey,
  resolvePermissionGuideBounds,
  resolvePermissionIntroBounds,
} from './permissionGuide';

const workArea = { x: 0, y: 25, width: 1440, height: 850 };

describe('resolvePermissionGuideBounds', () => {
  test('sits at the bottom center of the work area when System Settings is not found', () => {
    expect(resolvePermissionGuideBounds(null, SIZE, workArea)).toEqual({
      x: (1440 - SIZE.width) / 2, y: 25 + 850 - SIZE.height - 12, ...SIZE,
    });
  });

  test('sits just below a short System Settings window, the card in line with its app list', () => {
    const settings = { x: 300, y: 80, width: 715, height: 500 };
    const bounds = resolvePermissionGuideBounds(settings, SIZE, workArea);
    expect(bounds).toEqual({ x: 300 + 236 - 22, y: 80 + 500 - 10, ...SIZE });
    // The card starts where the list starts (the window adds a transparent margin), past the 216pt sidebar.
    expect(bounds.x + 22).toBe(settings.x + 236);
  });

  test('overlaps the lower edge of a tall window instead of leaving the screen', () => {
    const settings = { x: 300, y: 60, width: 715, height: 780 };
    expect(resolvePermissionGuideBounds(settings, SIZE, workArea).y).toBe(25 + 850 - SIZE.height - 12);
  });

  test('stays on screen next to a window at the screen edge', () => {
    const settings = { x: 1200, y: 80, width: 715, height: 500 };
    expect(resolvePermissionGuideBounds(settings, SIZE, workArea).x).toBe(1440 - SIZE.width);
  });
});

describe('permission restart', () => {
  test('only Screen Recording waits for a restart and gets the taller card', () => {
    expect(companionPermissionNeedsRelaunch(CompanionPermission.ScreenRecording)).toBe(true);
    expect(companionPermissionNeedsRelaunch(CompanionPermission.Accessibility)).toBe(false);
    expect(companionPermissionGuideSize(CompanionPermission.ScreenRecording)).toEqual(COMPANION_PERMISSION_GUIDE_RELAUNCH_SIZE);
    expect(companionPermissionGuideSize(CompanionPermission.Accessibility)).toEqual(SIZE);
  });
});

describe('permission explanation', () => {
  test('sits centered, a little above the middle of the work area', () => {
    expect(resolvePermissionIntroBounds(COMPANION_PERMISSION_INTRO_SIZE, workArea)).toEqual({
      x: (1440 - COMPANION_PERMISSION_INTRO_SIZE.width) / 2,
      y: Math.round(25 + (850 - COMPANION_PERMISSION_INTRO_SIZE.height) * 0.4),
      ...COMPANION_PERMISSION_INTRO_SIZE,
    });
  });

  test('names the permission the way System Settings does on that macOS', () => {
    expect(companionPermissionPaneKey(CompanionPermission.ScreenRecording, 24)).toBe('desktopCompanionPaneScreenAudio');
    expect(companionPermissionPaneKey(CompanionPermission.ScreenRecording, 23)).toBe('desktopCompanionPaneScreen');
    expect(companionPermissionPaneKey(CompanionPermission.Accessibility, 24)).toBe('desktopCompanionPaneAccessibility');
  });
});
