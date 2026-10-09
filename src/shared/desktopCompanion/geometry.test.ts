import { describe, expect, test } from 'vitest';

import { DesktopCompanionSize } from './constants';
import {
  clampCompanionBounds,
  companionGaze,
  companionStageOpensLeft,
  resolveCompanionBounds,
  resolveCompanionComposerBounds,
  resolveCompanionSelectionBounds,
  resolveCompanionStageBounds,
} from './geometry';

const orb = DesktopCompanionSize.Orb;

describe('orb placement', () => {
  const workArea = { x: -1920, y: 25, width: 1920, height: 1055 };

  test('restores a visible position after the former display is disconnected', () => {
    const result = resolveCompanionBounds({ x: 2500, y: 2000 }, workArea);
    expect(result.x + result.width).toBeLessThanOrEqual(0);
    expect(result.y + result.height).toBeLessThanOrEqual(1080);
    expect(result.x).toBeGreaterThanOrEqual(-1920);
  });

  test('ignores malformed saved positions and starts in the lower right', () => {
    const result = resolveCompanionBounds({ x: 'left', y: Number.NaN }, workArea);
    expect(result).toEqual(resolveCompanionBounds(null, workArea));
    expect(result.x + result.width).toBeLessThan(0);
    expect(result.x + result.width).toBeGreaterThan(-60);
  });

  test('keeps a dropped orb whole on its own display, even at an edge shared with another one', () => {
    const area = { x: 0, y: 0, width: 1440, height: 900 };
    expect(clampCompanionBounds({ ...orb, x: 1440 - orb.width / 2, y: 300 }, area)).toEqual({ ...orb, x: 1440 - orb.width, y: 300 });
    expect(clampCompanionBounds({ ...orb, x: -20, y: -10 }, area)).toEqual({ ...orb, x: 0, y: 0 });
  });
});

describe('surfaces around the orb', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };

  test('opens the composer right beside the orb, with room for its menus above the card', () => {
    const pad = DesktopCompanionSize.SurfacePad;
    const card = { width: DesktopCompanionSize.Composer.width + pad * 2, height: 170 + pad * 2 };
    const room = DesktopCompanionSize.ComposerMenuRoom;
    const low = { ...orb, x: 1356, y: 790 };
    const beside = resolveCompanionComposerBounds(low, card, room, area);
    // The card (inside the transparent pad) ends at the orb's edge and its bottom meets the character's.
    expect(beside.x + beside.width - pad).toBe(low.x);
    expect(beside.y + beside.height - pad).toBe(low.y + low.height - pad / 2);
    expect(beside.height).toBe(card.height + room);
    // Near the top there is less room, but the card stays where it was.
    const high = { ...orb, x: 1356, y: 120 };
    const near = resolveCompanionComposerBounds(high, card, room, area);
    expect(near.y).toBe(area.y);
    expect(near.y + near.height).toBe(resolveCompanionStageBounds(high, card, area).y + card.height);
  });

  test('opens the stage toward the middle of the screen, bottom-aligned with the orb', () => {
    const size = { width: 300, height: 140 };
    const right = { ...orb, x: 1364, y: 700 };
    expect(companionStageOpensLeft(right, area)).toBe(true);
    const stage = resolveCompanionStageBounds(right, size, area);
    expect(stage.x + stage.width).toBeLessThanOrEqual(right.x + DesktopCompanionSize.SurfacePad);
    expect(stage.y + stage.height).toBeGreaterThan(right.y + right.height - DesktopCompanionSize.SurfacePad);
    const left = { ...orb, x: 0, y: 700 };
    expect(companionStageOpensLeft(left, area)).toBe(false);
    expect(resolveCompanionStageBounds(left, size, area).x).toBeGreaterThanOrEqual(left.x + left.width - DesktopCompanionSize.SurfacePad);
  });

  test('keeps a stage on screen when the orb sits in a corner', () => {
    const stage = resolveCompanionStageBounds({ ...orb, x: 1364, y: 30 }, { width: 448, height: 214 }, area);
    expect(stage).toEqual(clampCompanionBounds(stage, area));
    expect(stage.y).toBeGreaterThanOrEqual(area.y);
  });
});

describe('selection toolbar placement', () => {
  const area = { x: 0, y: 0, width: 1440, height: 900 };
  const size = { width: 400, height: 64 };

  test('sits just under the selected line', () => {
    const bounds = resolveCompanionSelectionBounds({ x: 300, top: 200, bottom: 220 }, size, area);
    expect(bounds.y + DesktopCompanionSize.SurfacePad).toBeGreaterThanOrEqual(220);
    expect(bounds.y + DesktopCompanionSize.SurfacePad).toBeLessThan(240);
  });

  test('flips above the selection near the bottom edge', () => {
    const bounds = resolveCompanionSelectionBounds({ x: 300, top: 860, bottom: 880 }, size, area);
    expect(bounds.y + bounds.height - DesktopCompanionSize.SurfacePad).toBeLessThanOrEqual(860);
  });

  test('never runs off the right edge', () => {
    const bounds = resolveCompanionSelectionBounds({ x: 1400, top: 200, bottom: 220 }, size, area);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440);
  });
});

describe('gaze', () => {
  const center = { ...orb, x: 500, y: 500 };
  const middle = { x: 500 + orb.width / 2, y: 500 + orb.height / 2 };

  test('looks straight ahead when the cursor is on the character', () => {
    expect(companionGaze(center, { x: middle.x + 2, y: middle.y - 3 })).toEqual({ x: 0, y: 0 });
  });

  test('turns toward the cursor and saturates far away', () => {
    expect(companionGaze(center, { x: 2000, y: middle.y - 4 })).toEqual({ x: 1, y: 0 });
    const near = companionGaze(center, { x: middle.x + 60, y: middle.y });
    expect(near.x).toBeGreaterThan(0);
    expect(near.x).toBeLessThan(1);
  });

  test('quantizes so tiny moves do not flood IPC', () => {
    const a = companionGaze(center, { x: 900, y: 700 });
    const b = companionGaze(center, { x: 903, y: 702 });
    expect(a).toEqual(b);
  });
});
