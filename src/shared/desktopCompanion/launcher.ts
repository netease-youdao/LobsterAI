import { type CompanionPoint, type CompanionRect, rectContains } from './geometry';

/** What the orb's hover launcher can start. `Ask` is its input-shaped button; the others are rows. */
export const CompanionLauncherAction = {
  Ask: 'ask',
  Screenshot: 'screenshot',
  Files: 'files',
  OpenApp: 'open-app',
} as const;
export type CompanionLauncherAction = typeof CompanionLauncherAction[keyof typeof CompanionLauncherAction];

/** The launcher's rows, top to bottom. Opening the app is navigation, so it sits below a divider. */
export const COMPANION_LAUNCHER_ROWS: ReadonlyArray<{ action: CompanionLauncherAction; labelKey: string; divided?: boolean }> = [
  { action: CompanionLauncherAction.Screenshot, labelKey: 'desktopCompanionScreenshot' },
  { action: CompanionLauncherAction.Files, labelKey: 'desktopCompanionLauncherFiles' },
  { action: CompanionLauncherAction.OpenApp, labelKey: 'desktopCompanionOpenApp', divided: true },
];

export function isCompanionLauncherAction(value: unknown): value is CompanionLauncherAction {
  return Object.values(CompanionLauncherAction).some(action => action === value);
}

/** Everything that outranks a hover: the launcher never covers, replaces or interrupts these. */
export interface CompanionLauncherBlockers {
  /** The orb is on screen and tasks can start. */
  orbVisible: boolean;
  panelVisible: boolean;
  /** Task bubbles are showing beside the orb. */
  resultsVisible: boolean;
  /** A hint, the drop zone or a task strip already has the stage. */
  stageBusy: boolean;
  /** A file is being dragged anywhere on the desktop. */
  fileDragActive: boolean;
  /** The orb itself is being moved. */
  orbDragging: boolean;
  contextMenuOpen: boolean;
  /** A screenshot is being taken. */
  capturing: boolean;
}

export function canOpenCompanionLauncher(blockers: CompanionLauncherBlockers): boolean {
  return blockers.orbVisible && !blockers.panelVisible && !blockers.resultsVisible && !blockers.stageBusy
    && !blockers.fileDragActive && !blockers.orbDragging && !blockers.contextMenuOpen && !blockers.capturing;
}

/**
 * The launcher stays while the pointer is over the orb or its card. The card's
 * window carries a transparent margin that reaches the orb, so the two
 * rectangles leave no gap to fall through on the way across.
 */
export function companionLauncherHolds(cursor: CompanionPoint, areas: ReadonlyArray<CompanionRect | null>): boolean {
  return areas.some(area => !!area && rectContains(area, cursor));
}
