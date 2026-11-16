import { describe, expect, test } from 'vitest';

import {
  canOpenCompanionLauncher,
  COMPANION_LAUNCHER_ROWS,
  CompanionLauncherAction,
  type CompanionLauncherBlockers,
  companionLauncherHolds,
  isCompanionLauncherAction,
} from './launcher';

const free: CompanionLauncherBlockers = {
  orbVisible: true, panelVisible: false, resultsVisible: false, stageBusy: false,
  fileDragActive: false, orbDragging: false, contextMenuOpen: false, capturing: false,
};

describe('companion launcher', () => {
  test('opens only when the orb is on screen and nothing else has the place beside it', () => {
    expect(canOpenCompanionLauncher(free)).toBe(true);
    expect(canOpenCompanionLauncher({ ...free, orbVisible: false })).toBe(false);
    const blockers = ['panelVisible', 'resultsVisible', 'stageBusy', 'fileDragActive', 'orbDragging', 'contextMenuOpen', 'capturing'] as const;
    for (const blocker of blockers) {
      expect(canOpenCompanionLauncher({ ...free, [blocker]: true }), blocker).toBe(false);
    }
  });

  test('holds over the orb or the card, on their edges, and across the margin where they meet', () => {
    const orb = { x: 1200, y: 400, width: 60, height: 60 };
    // The card's window overlaps the orb's by its transparent margin.
    const card = { x: 946, y: 248, width: 276, height: 223 };
    expect(companionLauncherHolds({ x: 1230, y: 430 }, [orb, card])).toBe(true);
    expect(companionLauncherHolds({ x: 1000, y: 300 }, [orb, card])).toBe(true);
    expect(companionLauncherHolds({ x: 1210, y: 440 }, [orb, card])).toBe(true);
    expect(companionLauncherHolds({ x: 1260, y: 460 }, [orb, card])).toBe(true);
    expect(companionLauncherHolds({ x: 945, y: 300 }, [orb, card])).toBe(false);
    expect(companionLauncherHolds({ x: 1230, y: 399 }, [orb, card])).toBe(false);
  });

  test('a missing orb or card holds nothing', () => {
    expect(companionLauncherHolds({ x: 10, y: 10 }, [null, null])).toBe(false);
    expect(companionLauncherHolds({ x: 10, y: 10 }, [null, { x: 0, y: 0, width: 20, height: 20 }])).toBe(true);
  });

  test('lists the actions as rows and keeps the input-shaped button out of them', () => {
    expect(COMPANION_LAUNCHER_ROWS.map(row => row.action)).toEqual([
      CompanionLauncherAction.Screenshot, CompanionLauncherAction.Files, CompanionLauncherAction.OpenApp,
    ]);
    expect(COMPANION_LAUNCHER_ROWS[0].divided).toBeUndefined();
    expect(COMPANION_LAUNCHER_ROWS[COMPANION_LAUNCHER_ROWS.length - 1].divided).toBe(true);
  });

  test('accepts only known actions from the renderer', () => {
    for (const action of Object.values(CompanionLauncherAction)) expect(isCompanionLauncherAction(action)).toBe(true);
    for (const value of ['settings', '', null, undefined, 1, {}]) expect(isCompanionLauncherAction(value)).toBe(false);
  });
});
