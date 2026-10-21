import { describe, expect, test } from 'vitest';

import { DesktopCompanionPanelPlacement, DesktopCompanionSize } from './constants';
import {
  clampCompanionBounds,
  companionMenuOpensUp,
  companionStageOpensLeft,
  resolveCompanionBounds,
  resolveCompanionCardBounds,
  resolveCompanionComposerLayout,
  resolveCompanionLoginLayout,
  resolveCompanionResultBounds,
  resolveCompanionStageBounds,
  resolveCompanionToolbarBounds,
  resolveCompanionToolbarMenuBounds,
  snapCompanionOrbToEdge,
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

  test.each([DesktopCompanionSize.BrandOrb, DesktopCompanionSize.Orb])('snaps a %j orb within the left threshold on an offset display', size => {
    for (const distance of [0, 20, DesktopCompanionSize.OrbSnapDistance]) {
      expect(snapCompanionOrbToEdge({ ...size, x: workArea.x + distance, y: 300 }, workArea))
        .toEqual({ ...size, x: workArea.x, y: 300 });
    }
  });

  test.each([DesktopCompanionSize.BrandOrb, DesktopCompanionSize.Orb])('snaps a %j orb within the right threshold on offset displays', size => {
    for (const x of [-1920, 1440]) {
      const area = { ...workArea, x };
      const rightEdge = area.x + area.width - size.width;
      for (const distance of [0, 20, DesktopCompanionSize.OrbSnapDistance]) {
        expect(snapCompanionOrbToEdge({ ...size, x: rightEdge - distance, y: 300 }, area))
          .toEqual({ ...size, x: rightEdge, y: 300 });
      }
    }
  });

  test('leaves drops outside both thresholds and near the top and bottom edges in place', () => {
    for (const position of [
      { x: workArea.x + DesktopCompanionSize.OrbSnapDistance + 1, y: 300 },
      { x: -orb.width - DesktopCompanionSize.OrbSnapDistance - 1, y: 300 },
      { x: -900, y: workArea.y + 10 },
      { x: -900, y: workArea.y + workArea.height - orb.height - 10 },
    ]) {
      const bounds = { ...orb, ...position };
      expect(snapCompanionOrbToEdge(bounds, workArea)).toEqual(bounds);
    }
  });

  test('uses the usable edges and keeps the whole orb visible at both corners', () => {
    const area = { x: 80, y: 25, width: 1360, height: 875 };
    expect(snapCompanionOrbToEdge({ ...orb, x: 110, y: 880 }, area))
      .toEqual({ ...orb, x: 80, y: 900 - orb.height });
    expect(snapCompanionOrbToEdge({ ...orb, x: 1340, y: 880 }, area))
      .toEqual({ ...orb, x: 1440 - orb.width, y: 900 - orb.height });
  });

  test('chooses the nearer edge when both thresholds overlap on a narrow work area', () => {
    const area = { x: 100, y: 25, width: orb.width + 60, height: 875 };
    expect(snapCompanionOrbToEdge({ ...orb, x: 120, y: 300 }, area).x).toBe(100);
    expect(snapCompanionOrbToEdge({ ...orb, x: 140, y: 300 }, area).x).toBe(160);
  });
});

describe('surfaces around the orb', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };

  describe('task bubbles', () => {
    const size = { width: DesktopCompanionSize.ResultCompactWidth, height: 160 };
    const pad = DesktopCompanionSize.SurfacePad;

    test.each([-1920, 0, 1440])('stays left when it fits, including on the left half of a display at x=%i', x => {
      const workArea = { ...area, x };
      for (const offset of [size.width - pad, 500, 1100]) {
        const anchor = { ...orb, x: x + offset, y: 300 };
        const bounds = resolveCompanionResultBounds(anchor, size, workArea);
        expect(bounds.x + bounds.width - pad).toBe(anchor.x);
        expect(bounds.y + bounds.height).toBe(anchor.y + anchor.height + pad / 2);
        expect(bounds).toEqual(clampCompanionBounds(bounds, workArea));
      }
    });

    test('uses the right only when the left cannot fit and remains visible at screen corners', () => {
      for (const position of [{ x: 0, y: 25 }, { x: size.width - pad - 1, y: 800 }]) {
        const anchor = { ...orb, ...position };
        const bounds = resolveCompanionResultBounds(anchor, size, area);
        expect(bounds.x + pad).toBe(anchor.x + anchor.width);
        expect(bounds).toEqual(clampCompanionBounds(bounds, area));
      }
    });

    test('keeps the existing centered placement without an orb and clamps on a narrow display', () => {
      expect(resolveCompanionResultBounds(null, size, area))
        .toEqual(resolveCompanionComposerLayout(null, size, { above: 0, side: 0 }, area).bounds);
      const narrow = { x: -300, y: 0, width: 300, height: 200 };
      const bounds = resolveCompanionResultBounds({ ...orb, x: -150, y: 100 }, size, narrow);
      expect(bounds).toEqual(clampCompanionBounds(bounds, narrow));
    });
  });

  describe('composer', () => {
    const pad = DesktopCompanionSize.SurfacePad;
    const card = { width: DesktopCompanionSize.Composer.width + pad * 2, height: 230 + pad * 2 };
    const room = { above: DesktopCompanionSize.ComposerMenuRoom, side: DesktopCompanionSize.ComposerSideRoom };

    test('opens right beside the orb, with room above the card and toward the middle of the screen', () => {
      const low = { ...orb, x: 1356, y: 790 };
      const { bounds, placement } = resolveCompanionComposerLayout(low, card, room, area);
      expect(placement).toBe(DesktopCompanionPanelPlacement.Left);
      // The card (inside the transparent pad) ends at the orb's edge and its bottom meets the character's.
      expect(bounds.x + bounds.width - pad).toBe(low.x);
      expect(bounds.y + bounds.height - pad).toBe(low.y + low.height - pad / 2);
      expect(bounds.height).toBe(card.height + room.above);
      expect(bounds.width).toBe(card.width + room.side);
    });

    test('opens to the right of an orb on the left half, with the room on that side', () => {
      const left = { ...orb, x: 40, y: 700 };
      const { bounds, placement } = resolveCompanionComposerLayout(left, card, room, area);
      expect(placement).toBe(DesktopCompanionPanelPlacement.Right);
      expect(bounds.x + pad).toBe(left.x + left.width);
      expect(bounds.width).toBe(card.width + room.side);
    });

    test.each([-1920, 0, 1440])('prefers the left when the card fits on a display at x=%i, even without room for all menus', x => {
      const workArea = { ...area, x, width: 2560 };
      for (const offset of [card.width - pad, 500, 1100]) {
        const anchor = { ...orb, x: x + offset, y: 700 };
        const { bounds, placement } = resolveCompanionComposerLayout(anchor, card, room, workArea);
        expect(placement).toBe(DesktopCompanionPanelPlacement.Left);
        expect(bounds.x + bounds.width - pad).toBe(anchor.x);
        expect(bounds.width).toBeGreaterThanOrEqual(card.width);
        expect(bounds).toEqual(clampCompanionBounds(bounds, workArea));
      }
    });

    test('keeps the card in place and trims the room near the screen edges', () => {
      const high = { ...orb, x: 1356, y: 120 };
      const near = resolveCompanionComposerLayout(high, card, room, area).bounds;
      expect(near.y).toBe(area.y);
      expect(near.y + near.height).toBe(resolveCompanionStageBounds(high, card, area).y + card.height);
      // A wide card next to an orb near the middle cannot take the whole side room.
      const narrowArea = { x: 0, y: 25, width: 900, height: 875 };
      const middle = resolveCompanionComposerLayout({ ...orb, x: 470, y: 700 }, card, room, narrowArea).bounds;
      expect(middle.x).toBe(narrowArea.x);
    });

    test('opens a little below the middle of the screen when no orb is on screen', () => {
      const { bounds, placement } = resolveCompanionComposerLayout(null, card, room, area);
      expect(placement).toBe(DesktopCompanionPanelPlacement.Center);
      expect(bounds.x + card.width / 2).toBe(area.x + area.width / 2);
      const cardBottom = bounds.y + bounds.height;
      expect(cardBottom).toBeGreaterThan(area.y + area.height / 2 + card.height / 2);
      expect(cardBottom).toBeLessThan(area.y + area.height);
      expect(bounds.width).toBe(card.width + room.side);
    });
  });

  describe('login page', () => {
    const gap = DesktopCompanionSize.Gap;
    const size = DesktopCompanionSize.ComposerLogin;

    test.each([DesktopCompanionSize.BrandOrb, DesktopCompanionSize.Orb])(
      'leaves the whole %j orb clear at both screen edges', orbSize => {
        const right = { ...orbSize, x: area.width - orbSize.width, y: 700 };
        const left = { ...orbSize, x: area.x, y: area.y };
        const before = resolveCompanionLoginLayout(right, area);
        const after = resolveCompanionLoginLayout(left, area);
        expect(before.placement).toBe(DesktopCompanionPanelPlacement.Left);
        expect(before.bounds).toMatchObject(size);
        expect(before.bounds.x + before.bounds.width).toBe(right.x - gap);
        expect(after.placement).toBe(DesktopCompanionPanelPlacement.Right);
        expect(after.bounds).toMatchObject(size);
        expect(after.bounds.x).toBe(left.x + left.width + gap);
        expect(after.bounds.y).toBe(area.y);
      },
    );

    test.each([700, 100])('uses vertical room for a full-size welcome page near the middle at y=%i', y => {
      const middle = { ...orb, x: 700, y };
      const { bounds } = resolveCompanionLoginLayout(middle, area);
      expect(bounds).toMatchObject(size);
      expect(bounds.y + bounds.height <= middle.y - gap || bounds.y >= middle.y + middle.height + gap).toBe(true);
      expect(bounds).toEqual(clampCompanionBounds(bounds, area));
    });

    test.each([0, -916])('shrinks within the free side on a small display starting at x=%i', x => {
      const small = { x, y: 25, width: 916, height: 431 };
      for (const offset of [0, 430, 816]) {
        const anchor = { ...DesktopCompanionSize.BrandOrb, x: x + offset, y: 350 };
        const { bounds } = resolveCompanionLoginLayout(anchor, small);
        expect(bounds).toEqual(clampCompanionBounds(bounds, small));
        expect(bounds.height).toBe(size.height);
        expect(bounds.x + bounds.width <= anchor.x - gap || bounds.x >= anchor.x + anchor.width + gap).toBe(true);
      }
    });

    test('keeps the shortcut-only welcome page centered without an orb', () => {
      const layout = resolveCompanionLoginLayout(null, area);
      expect(layout.placement).toBe(DesktopCompanionPanelPlacement.Center);
      expect(layout.bounds).toMatchObject(size);
      expect(layout.bounds.x + layout.bounds.width / 2).toBe(area.x + area.width / 2);
    });
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
  const size = { width: 400, height: 80 };
  const pad = DesktopCompanionSize.SurfacePad;
  const word = { left: 300, right: 380, top: 200, bottom: 220, multiline: false };
  const paragraph = { left: 520, right: 260, top: 200, bottom: 300, multiline: true };

  test('sits just above the selection, centered on a one-line selection', () => {
    const { bounds, above } = resolveCompanionToolbarBounds(word, size, area);
    expect(above).toBe(true);
    expect(bounds.y + bounds.height - pad).toBeLessThanOrEqual(200);
    expect(bounds.y + bounds.height - pad).toBeGreaterThan(188);
    expect(bounds.x + bounds.width / 2).toBe(340);
  });

  test('lines up with where a longer selection starts, above its first line', () => {
    const { bounds } = resolveCompanionToolbarBounds(paragraph, size, area);
    expect(bounds.y + bounds.height - pad).toBeLessThanOrEqual(200);
    // The first button sits over the first selected character.
    expect(bounds.x + pad).toBeGreaterThan(500);
    expect(bounds.x + pad).toBeLessThan(520);
  });

  test('drops below the selection only when there is no room above', () => {
    const { bounds, above } = resolveCompanionToolbarBounds({ ...word, top: 30, bottom: 50 }, size, area);
    expect(above).toBe(false);
    expect(bounds.y + pad).toBeGreaterThanOrEqual(50);
  });

  test('never runs off the right edge', () => {
    const { bounds } = resolveCompanionToolbarBounds({ ...word, left: 1400, right: 1430 }, size, area);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440);
  });

  const full = DesktopCompanionSize.Answer;

  test.each([
    word,
    { ...paragraph, bottom: 820 },
    { ...word, top: 30, bottom: 50 },
  ])('replaces the measured toolbar at the same origin for %j', anchor => {
    const toolbar = resolveCompanionToolbarBounds(anchor, size, area).bounds;
    for (const height of [236, 330, full.height]) {
      const card = resolveCompanionCardBounds(anchor, { width: full.width, height }, area, toolbar);
      expect(card).toMatchObject({ x: toolbar.x, y: toolbar.y, height });
    }
  });

  test('a card at the bottom right stays as close to the toolbar as the screen allows', () => {
    const anchor = { ...word, left: 1400, right: 1430, top: 840, bottom: 860 };
    const toolbar = resolveCompanionToolbarBounds(anchor, size, area).bounds;
    for (const height of [236, full.height]) {
      const card = resolveCompanionCardBounds(anchor, { width: full.width, height }, area, toolbar);
      expect(card).toEqual({ x: area.width - full.width, y: area.height - height, width: full.width, height });
    }
  });

  test('toolbar-anchored cards stay inside a small secondary display with negative coordinates', () => {
    const secondary = { x: -1280, y: -600, width: 1280, height: 560 };
    const anchor = { ...paragraph, left: -250, right: -200, top: -150, bottom: -80 };
    const toolbar = resolveCompanionToolbarBounds(anchor, size, secondary).bounds;
    const card = resolveCompanionCardBounds(anchor, full, secondary, toolbar);
    expect(card).toEqual({ x: -full.width, y: secondary.y, width: full.width, height: secondary.height });
  });

  test('cards open under the selection and keep it readable', () => {
    const card = resolveCompanionCardBounds(paragraph, { width: 444, height: 484 }, area);
    expect(card.y + pad).toBeGreaterThanOrEqual(300);
    expect(card.height).toBe(484);
  });

  test('near the bottom a card opens above the selection and grows upward', () => {
    const above = resolveCompanionCardBounds({ ...word, top: 760, bottom: 780 }, { width: 444, height: 300 }, area);
    expect(above.y + above.height - pad).toBeLessThanOrEqual(760);
    const taller = resolveCompanionCardBounds({ ...word, top: 760, bottom: 780 }, { width: 444, height: 500 }, area);
    expect(taller.y + taller.height).toBe(above.y + above.height);
  });

  test('stays under the selection whenever the full card fits there, even with more room above', () => {
    const portrait = { x: 0, y: 0, width: 1080, height: 1440 };
    const card = resolveCompanionCardBounds({ ...word, top: 760, bottom: 780 }, full, portrait);
    expect(card.y + pad).toBeGreaterThanOrEqual(780);
    expect(card.height).toBe(full.height);
  });

  test('opens on the side with more room when the full card fits on neither', () => {
    // 376px below the selection, 536px above it.
    const card = resolveCompanionCardBounds({ ...word, top: 520, bottom: 540 }, { width: 444, height: 300 }, area);
    expect(card.y + card.height - pad).toBeLessThanOrEqual(520);
  });

  test('a card that outgrows its side slides over the selection instead of scrolling, staying on screen', () => {
    // 516px below the selection, 396px above it.
    const middle = { ...word, top: 380, bottom: 400 };
    const short = resolveCompanionCardBounds(middle, { width: 444, height: 300 }, area);
    expect(short.y + pad).toBeGreaterThanOrEqual(400);
    const long = resolveCompanionCardBounds(middle, { width: 444, height: 900 }, area);
    expect(long.height).toBe(full.height);
    expect(long.y + long.height).toBe(900);
    expect(long.y + pad).toBeLessThan(380);
    // Above the selection, the card meets the top edge and then reaches down over it.
    const high = resolveCompanionCardBounds({ ...word, top: 500, bottom: 520 }, { width: 444, height: 900 }, area);
    expect(high).toMatchObject({ y: 0, height: full.height });
  });

  test('a selection taller than the screen gets a full card over it', () => {
    const tall = { left: 300, right: 200, top: 120, bottom: 820, multiline: true };
    const card = resolveCompanionCardBounds(tall, full, area);
    expect(card).toEqual(clampCompanionBounds(card, area));
    expect(card.height).toBe(full.height);
  });

  test('on a screen shorter than the full card, the card is as tall as the screen', () => {
    const short = { x: 0, y: 25, width: 1280, height: 560 };
    const card = resolveCompanionCardBounds({ ...word, top: 300, bottom: 320 }, full, short);
    expect(card).toMatchObject({ y: 25, height: 560 });
  });

  test('opens the menu below the toolbar unless only the space above can fit it', () => {
    const below = { x: 300, y: 204, width: 400, height: 80 };
    expect(companionMenuOpensUp(below, 200, area)).toBe(false);
    expect(companionMenuOpensUp({ ...below, y: 760 }, 200, area)).toBe(true);
    const above = { x: 300, y: 600, width: 400, height: 80 };
    expect(companionMenuOpensUp(above, 200, area)).toBe(false);
    expect(companionMenuOpensUp({ ...above, y: 100 }, 200, area)).toBe(false);
  });

  test('grows the window for the menu while the toolbar stays where it was', () => {
    const toolbar = { x: 300, y: 600, width: 400, height: 80 };
    expect(resolveCompanionToolbarMenuBounds(toolbar, { width: 400, height: 260 }, false, area))
      .toEqual({ x: 300, y: 600, width: 400, height: 260 });
    const up = resolveCompanionToolbarMenuBounds(toolbar, { width: 400, height: 260 }, true, area);
    expect(up.y + up.height).toBe(toolbar.y + toolbar.height);
  });
});
