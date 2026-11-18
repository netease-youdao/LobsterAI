import { CompanionPermission, DesktopCompanionSize } from './constants';
import { clampCompanionBounds, type CompanionRect, type CompanionSize } from './geometry';

export const CompanionPermissionGuideIpc = {
  Info: 'desktop-companion:permission-guide-info',
  Proceed: 'desktop-companion:permission-guide-proceed',
  Close: 'desktop-companion:permission-guide-close',
  Drag: 'desktop-companion:permission-guide-drag',
  Relaunch: 'desktop-companion:permission-guide-relaunch',
} as const;

/** The same window first explains the permission, then floats beside System Settings. */
export const CompanionPermissionGuideStage = { Intro: 'intro', Guide: 'guide' } as const;
export type CompanionPermissionGuideStage = typeof CompanionPermissionGuideStage[keyof typeof CompanionPermissionGuideStage];

export interface CompanionPermissionGuideInfo {
  permission: CompanionPermission;
  stage: CompanionPermissionGuideStage;
  /** Copy key for the permission as System Settings names it on this macOS version. */
  paneKey: string;
  /** The app as the System Settings list names it: LobsterAI, or Electron in development. */
  appName: string;
  appIcon: string | null;
  /** macOS applies this permission only after the app restarts (Screen Recording). */
  relaunchRequired: boolean;
}

export interface CompanionPermissionGuideBridge {
  getPermissionGuide(): Promise<CompanionPermissionGuideInfo | null>;
  /** From the explanation: open System Settings and turn the card into the guide beside it. */
  proceedPermissionGuide(): Promise<CompanionPermissionGuideInfo | null>;
  closePermissionGuide(): Promise<void>;
  /** Call from dragstart: the system drag of the app bundle has to begin inside that event. */
  dragPermissionGuideApp(): void;
  /** Quits and reopens LobsterAI so a permission granted in System Settings takes effect. */
  relaunchForPermission(): Promise<void>;
}

/** A 420 × 172 explanation card (room for a two-line English detail) plus the transparent shadow margin. */
export const COMPANION_PERMISSION_INTRO_SIZE: CompanionSize = { width: 464, height: 216 };
/** A 600 × 136 card, wide enough for the Chinese instruction on one line, plus the transparent shadow margin. */
export const COMPANION_PERMISSION_GUIDE_SIZE: CompanionSize = { width: 644, height: 180 };
/** The same card with a restart line for permissions macOS applies only after a restart. */
export const COMPANION_PERMISSION_GUIDE_RELAUNCH_SIZE: CompanionSize = { width: 644, height: 212 };

// macOS 15 (Darwin 24) renamed Screen Recording to "Screen & System Audio Recording".
const DARWIN_SCREEN_AUDIO_RECORDING = 24;

export function companionPermissionNeedsRelaunch(permission: CompanionPermission): boolean {
  return permission === CompanionPermission.ScreenRecording;
}

export function companionPermissionGuideSize(permission: CompanionPermission): CompanionSize {
  return companionPermissionNeedsRelaunch(permission) ? COMPANION_PERMISSION_GUIDE_RELAUNCH_SIZE : COMPANION_PERMISSION_GUIDE_SIZE;
}

/** The copy key for the permission's name in System Settings, so the user can match it there. */
export function companionPermissionPaneKey(permission: CompanionPermission, darwinMajor: number): string {
  if (permission === CompanionPermission.Accessibility) return 'desktopCompanionPaneAccessibility';
  return darwinMajor >= DARWIN_SCREEN_AUDIO_RECORDING ? 'desktopCompanionPaneScreenAudio' : 'desktopCompanionPaneScreen';
}

// The window's transparent margin is inside these numbers; the card itself sits 22px further in.
const GUIDE_GAP_BELOW_SETTINGS = -10;
const GUIDE_SCREEN_MARGIN = 12;
// Measured through accessibility on macOS 15: past the 216pt sidebar, both the Accessibility and the
// Screen Recording app lists start 236pt from the window's left edge.
const SETTINGS_APP_LIST_LEFT = 236;

/** Centered, a little above the middle of the screen, like a system dialog. */
export function resolvePermissionIntroBounds(size: CompanionSize, workArea: CompanionRect): CompanionRect {
  return clampCompanionBounds({
    x: workArea.x + (workArea.width - size.width) / 2,
    y: workArea.y + (workArea.height - size.height) * 0.4,
    ...size,
  }, workArea);
}

/**
 * Just below the System Settings window, the card's left edge in line with its app list so the
 * arrow points into the list, not at the sidebar; over the window's lower edge when the screen
 * ends first. Without the window, bottom center of the work area.
 */
export function resolvePermissionGuideBounds(
  settings: CompanionRect | null,
  size: CompanionSize,
  workArea: CompanionRect,
): CompanionRect {
  const bottom = workArea.y + workArea.height - size.height - GUIDE_SCREEN_MARGIN;
  if (!settings) {
    return clampCompanionBounds({ x: workArea.x + (workArea.width - size.width) / 2, y: bottom, ...size }, workArea);
  }
  return clampCompanionBounds({
    x: settings.x + SETTINGS_APP_LIST_LEFT - DesktopCompanionSize.SurfacePad,
    y: Math.min(settings.y + settings.height + GUIDE_GAP_BELOW_SETTINGS, bottom),
    ...size,
  }, workArea);
}
