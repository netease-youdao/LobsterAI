import { DesktopCompanionPanelPlacement, DesktopCompanionSize } from './constants';

export interface CompanionPoint { x: number; y: number }
export interface CompanionSize { width: number; height: number }
export interface CompanionRect extends CompanionPoint, CompanionSize {}

/** Where the selected text sits on screen: from the top-left of its first line to the bottom-right of its last. */
export interface CompanionSelectionAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Spans lines: the toolbar lines up with where it starts instead of centering on it. */
  multiline: boolean;
}

export function clampCompanionBounds(bounds: CompanionRect, workArea: CompanionRect): CompanionRect {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height))),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function isPoint(value: unknown): value is CompanionPoint {
  const point = value as Partial<CompanionPoint> | null;
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

/** Restores the orb at its saved spot, or the lower-right corner of the work area. */
export function resolveCompanionBounds(position: unknown, workArea: CompanionRect, size: CompanionSize = DesktopCompanionSize.Orb): CompanionRect {
  return clampCompanionBounds({
    ...size,
    x: isPoint(position) ? position.x : workArea.x + workArea.width - size.width - DesktopCompanionSize.Margin,
    y: isPoint(position) ? position.y : workArea.y + workArea.height - size.height - DesktopCompanionSize.Margin * 4,
  }, workArea);
}

/** Settles a dropped orb against the nearer left or right edge, keeping it whole and at the same height. */
export function snapCompanionOrbToEdge(bounds: CompanionRect, workArea: CompanionRect): CompanionRect {
  const visible = clampCompanionBounds(bounds, workArea);
  const rightEdge = workArea.x + workArea.width - visible.width;
  const leftDistance = visible.x - workArea.x;
  const rightDistance = rightEdge - visible.x;
  if (Math.min(leftDistance, rightDistance) > DesktopCompanionSize.OrbSnapDistance) return visible;
  return { ...visible, x: leftDistance <= rightDistance ? workArea.x : rightEdge };
}

/** Stages open toward the middle of the screen. */
export function companionStageOpensLeft(orb: CompanionRect, workArea: CompanionRect): boolean {
  return orb.x + orb.width / 2 >= workArea.x + workArea.width / 2;
}

/** Prefer the left whenever the card fits; optional menu space must not force it to the right. */
function companionCardOpensLeft(orb: CompanionRect, size: CompanionSize, workArea: CompanionRect): boolean {
  const fitsLeft = orb.x - size.width + DesktopCompanionSize.SurfacePad >= workArea.x;
  const fitsRight = orb.x + orb.width - DesktopCompanionSize.SurfacePad + size.width <= workArea.x + workArea.width;
  return fitsLeft || (!fitsRight && companionStageOpensLeft(orb, workArea));
}

/**
 * Places a bubble, the drop zone or the quick panel right beside the orb, on
 * the selected side (defaulting to more room), bottom-aligned so it reads as coming out of the
 * character.
 */
export function resolveCompanionStageBounds(
  orb: CompanionRect,
  size: CompanionSize,
  workArea: CompanionRect,
  opensLeft = companionStageOpensLeft(orb, workArea),
): CompanionRect {
  const x = opensLeft ? orb.x - size.width + DesktopCompanionSize.SurfacePad : orb.x + orb.width - DesktopCompanionSize.SurfacePad;
  const y = orb.y + orb.height - size.height + DesktopCompanionSize.SurfacePad / 2;
  return clampCompanionBounds({ ...size, x, y }, workArea);
}

/** Without an orb on screen, the quick panel's card ends this far down the screen, a little below the middle. */
const CENTERED_PANEL_BOTTOM = 0.78;

export interface CompanionComposerRoom { above: number; side: number }
export interface CompanionComposerLayout { bounds: CompanionRect; placement: DesktopCompanionPanelPlacement }

/**
 * The composer window. Its card sits beside the orb like the stage cards, or a
 * little below the middle of the screen when no orb is on screen. The window
 * reaches upward and toward the middle of the screen by as much of `room` as
 * the screen allows, so the composer's menus and submenus open beside the card
 * without moving it.
 */
export function resolveCompanionComposerLayout(
  orb: CompanionRect | null,
  card: CompanionSize,
  room: CompanionComposerRoom,
  workArea: CompanionRect,
): CompanionComposerLayout {
  const placement = !orb ? DesktopCompanionPanelPlacement.Center
    : companionCardOpensLeft(orb, card, workArea) ? DesktopCompanionPanelPlacement.Left : DesktopCompanionPanelPlacement.Right;
  const opensLeft = placement === DesktopCompanionPanelPlacement.Left;
  const cardBounds = orb
    ? resolveCompanionStageBounds(orb, card, workArea, opensLeft)
    : clampCompanionBounds({
      ...card,
      x: workArea.x + (workArea.width - card.width) / 2,
      y: workArea.y + workArea.height * CENTERED_PANEL_BOTTOM - card.height,
    }, workArea);
  const above = Math.max(0, Math.min(room.above, cardBounds.y - workArea.y));
  const side = Math.max(0, Math.min(room.side, opensLeft
    ? cardBounds.x - workArea.x
    : workArea.x + workArea.width - cardBounds.x - cardBounds.width));
  return {
    placement,
    bounds: {
      x: opensLeft ? cardBounds.x - side : cardBounds.x,
      y: cardBounds.y - above,
      width: cardBounds.width + side,
      height: cardBounds.height + above,
    },
  };
}

/** Task bubbles prefer the orb's left on every display; use the right only when the left cannot fit. */
export function resolveCompanionResultBounds(orb: CompanionRect | null, size: CompanionSize, workArea: CompanionRect): CompanionRect {
  if (!orb) return resolveCompanionComposerLayout(null, size, { above: 0, side: 0 }, workArea).bounds;
  return resolveCompanionStageBounds(orb, size, workArea, companionCardOpensLeft(orb, size, workArea));
}

/** The welcome page fills its window, so none of it may overlap the orb's hit area. */
export function resolveCompanionLoginLayout(orb: CompanionRect | null, workArea: CompanionRect): CompanionComposerLayout {
  const size = DesktopCompanionSize.ComposerLogin;
  if (!orb) return resolveCompanionComposerLayout(null, size, { above: 0, side: 0 }, workArea);

  const gap = DesktopCompanionSize.Gap;
  const opensLeft = companionStageOpensLeft(orb, workArea);
  const placement = opensLeft ? DesktopCompanionPanelPlacement.Left : DesktopCompanionPanelPlacement.Right;
  const sideRoom = Math.max(0, opensLeft
    ? orb.x - gap - workArea.x
    : workArea.x + workArea.width - orb.x - orb.width - gap);
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const above = orb.y - gap - height;
  const below = orb.y + orb.height + gap;

  // Keep the full welcome layout above or below a centrally placed orb when it fits.
  if (sideRoom < width && (above >= workArea.y || below + height <= workArea.y + workArea.height)) {
    return {
      placement,
      bounds: clampCompanionBounds({
        width,
        height,
        x: orb.x + (orb.width - width) / 2,
        y: above >= workArea.y ? above : below,
      }, workArea),
    };
  }

  // On small displays the welcome page uses its responsive layout within the available side.
  const sideWidth = Math.min(width, sideRoom);
  return {
    placement,
    bounds: clampCompanionBounds({
      width: sideWidth,
      height,
      x: opensLeft ? orb.x - gap - sideWidth : orb.x + orb.width + gap,
      y: orb.y + orb.height - height,
    }, workArea),
  };
}

/** Text known only by a point, such as the pointer when the orb restores a card: one line around it. */
export function companionPointerAnchor(point: CompanionPoint): CompanionSelectionAnchor {
  return { left: point.x, right: point.x, top: point.y - 18, bottom: point.y + 14, multiline: false };
}

/** How far the toolbar's first button and the card's text sit inside the visible edge. */
const SELECTION_INSET = 12;

/** Toolbar and cards share a column: centered on a one-line selection, starting where a longer one starts. */
function selectionColumnX(anchor: CompanionSelectionAnchor, width: number): number {
  return anchor.multiline
    ? anchor.left - SELECTION_INSET - DesktopCompanionSize.SurfacePad
    : (anchor.left + anchor.right - width) / 2;
}

export interface CompanionToolbarPlacement {
  bounds: CompanionRect;
  /** The toolbar sits above the selection (the usual place). */
  above: boolean;
}

/**
 * The toolbar sits just above the selection, so it never covers the text that
 * follows; it drops below the selection only when there is no room above.
 */
export function resolveCompanionToolbarBounds(
  anchor: CompanionSelectionAnchor,
  size: CompanionSize,
  workArea: CompanionRect,
): CompanionToolbarPlacement {
  const pad = DesktopCompanionSize.SurfacePad;
  const gap = DesktopCompanionSize.Gap;
  const aboveY = anchor.top - gap - size.height + pad;
  const belowY = anchor.bottom + gap - pad;
  const above = aboveY >= workArea.y || belowY + size.height > workArea.y + workArea.height;
  return {
    above,
    bounds: clampCompanionBounds({ ...size, x: selectionColumnX(anchor, size.width), y: above ? aboveY : belowY }, workArea),
  };
}

export interface CompanionCardSlot {
  /** Under the selection (the usual place), or above it. */
  below: boolean;
  /** The window height the card may grow to: the full card, or the whole screen when that is shorter. */
  room: number;
}

/**
 * Answer, translate and read-aloud cards open under the selection so the
 * selected text stays readable, and grow downward. When the full card does not
 * fit there they open on the side with more room. A card that outgrows its side
 * slides over the selection, which it quotes, rather than scroll a short card.
 */
export function companionCardSlot(anchor: CompanionSelectionAnchor, workArea: CompanionRect): CompanionCardSlot {
  const pad = DesktopCompanionSize.SurfacePad;
  const gap = DesktopCompanionSize.Gap;
  const room = Math.min(DesktopCompanionSize.Answer.height, workArea.height);
  const roomBelow = workArea.y + workArea.height - (anchor.bottom + gap - pad);
  const roomAbove = anchor.top - gap + pad - workArea.y;
  return { below: roomBelow >= room || roomBelow >= roomAbove, room };
}

/** Replace the toolbar in place; without a toolbar, fall back to the selection. Keep the card on screen as it grows. */
export function resolveCompanionCardBounds(
  anchor: CompanionSelectionAnchor,
  size: CompanionSize,
  workArea: CompanionRect,
  toolbar: CompanionRect | null = null,
): CompanionRect {
  const pad = DesktopCompanionSize.SurfacePad;
  const gap = DesktopCompanionSize.Gap;
  const slot = companionCardSlot(anchor, workArea);
  const height = Math.min(size.height, slot.room);
  if (toolbar) {
    return clampCompanionBounds({ width: size.width, height, x: toolbar.x, y: toolbar.y }, workArea);
  }
  const y = slot.below ? anchor.bottom + gap - pad : anchor.top - gap - height + pad;
  return clampCompanionBounds({ width: size.width, height, x: selectionColumnX(anchor, size.width), y }, workArea);
}

/**
 * Prefer a dropdown below the toolbar; use the space above only at the screen's bottom edge.
 */
export function companionMenuOpensUp(
  toolbar: CompanionRect,
  menuHeight: number,
  workArea: CompanionRect,
): boolean {
  const fitsBelow = toolbar.y + toolbar.height + menuHeight <= workArea.y + workArea.height;
  const fitsAbove = toolbar.y - menuHeight >= workArea.y;
  return !fitsBelow && fitsAbove;
}

/** Grows the toolbar window to hold its menu without moving the toolbar itself. */
export function resolveCompanionToolbarMenuBounds(
  toolbar: CompanionRect,
  size: CompanionSize,
  menuUp: boolean,
  workArea: CompanionRect,
): CompanionRect {
  return clampCompanionBounds({
    ...size,
    x: toolbar.x,
    y: menuUp ? toolbar.y + toolbar.height - size.height : toolbar.y,
  }, workArea);
}

export function rectContains(rect: CompanionRect, point: CompanionPoint): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}
