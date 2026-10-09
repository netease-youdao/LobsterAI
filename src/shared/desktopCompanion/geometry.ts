import { DesktopCompanionSize } from './constants';

export interface CompanionPoint { x: number; y: number }
export interface CompanionSize { width: number; height: number }
export interface CompanionRect extends CompanionPoint, CompanionSize {}

/** Where a selection sits on screen: the toolbar goes under `bottom`, or above `top`. */
export interface CompanionSelectionAnchor { x: number; top: number; bottom: number }

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
export function resolveCompanionBounds(position: unknown, workArea: CompanionRect): CompanionRect {
  const size = DesktopCompanionSize.Orb;
  return clampCompanionBounds({
    ...size,
    x: isPoint(position) ? position.x : workArea.x + workArea.width - size.width - DesktopCompanionSize.Margin,
    y: isPoint(position) ? position.y : workArea.y + workArea.height - size.height - DesktopCompanionSize.Margin * 4,
  }, workArea);
}

/** Stages open toward the middle of the screen. */
export function companionStageOpensLeft(orb: CompanionRect, workArea: CompanionRect): boolean {
  return orb.x + orb.width / 2 >= workArea.x + workArea.width / 2;
}

/**
 * Places a bubble, the drop zone or the quick panel right beside the orb, on
 * the side with more room, bottom-aligned so it reads as coming out of the
 * character.
 */
export function resolveCompanionStageBounds(orb: CompanionRect, size: CompanionSize, workArea: CompanionRect): CompanionRect {
  const x = companionStageOpensLeft(orb, workArea) ? orb.x - size.width + DesktopCompanionSize.SurfacePad : orb.x + orb.width - DesktopCompanionSize.SurfacePad;
  const y = orb.y + orb.height - size.height + DesktopCompanionSize.SurfacePad / 2;
  return clampCompanionBounds({ ...size, x, y }, workArea);
}

/**
 * The composer window: its card sits beside the orb like the stage cards, and
 * the window reaches upward by as much of `menuRoom` as the screen allows, so
 * the composer's menus open above the card without moving it.
 */
export function resolveCompanionComposerBounds(
  orb: CompanionRect,
  card: CompanionSize,
  menuRoom: number,
  workArea: CompanionRect,
): CompanionRect {
  const cardBounds = resolveCompanionStageBounds(orb, card, workArea);
  const room = Math.max(0, Math.min(menuRoom, cardBounds.y - workArea.y));
  return { ...cardBounds, y: cardBounds.y - room, height: cardBounds.height + room };
}

/** Puts the selection toolbar/answer under the selection, or above it near the bottom edge. */
export function resolveCompanionSelectionBounds(
  anchor: CompanionSelectionAnchor,
  size: CompanionSize,
  workArea: CompanionRect,
): CompanionRect {
  const pad = DesktopCompanionSize.SurfacePad;
  const gap = DesktopCompanionSize.Gap;
  const below = anchor.bottom + gap - pad;
  const above = anchor.top - gap - size.height + pad;
  const fitsBelow = below + size.height <= workArea.y + workArea.height;
  return clampCompanionBounds({
    ...size,
    x: anchor.x - pad,
    y: fitsBelow || above < workArea.y ? below : above,
  }, workArea);
}

export function rectContains(rect: CompanionRect, point: CompanionPoint): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/** Eye direction toward the cursor, in [-1, 1] on each axis, quantized to avoid chatty updates. */
export function companionGaze(orb: CompanionRect, cursor: CompanionPoint): CompanionPoint {
  const cx = orb.x + orb.width / 2;
  const cy = orb.y + orb.height / 2;
  const dx = cursor.x - cx;
  const dy = cursor.y - cy;
  const distance = Math.hypot(dx, dy);
  if (distance < 8) return { x: 0, y: 0 };
  // Eyes reach their limit at ~240px; beyond that they keep the direction.
  const strength = Math.min(1, distance / 240);
  // `|| 0` folds -0 into 0 so equal gazes compare and serialize equal.
  const quantize = (value: number) => Math.round(value * 4) / 4 || 0;
  return { x: quantize((dx / distance) * strength), y: quantize((dy / distance) * strength) };
}
