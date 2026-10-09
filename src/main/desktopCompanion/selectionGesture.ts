import type { CompanionPoint } from '../../shared/desktopCompanion/geometry';

// selection-hook's macOS thresholds (src/mac/selection_hook.mm), in screen points and ms.
// The hook also requires an I-beam cursor, which JavaScript cannot see.
const MIN_DRAG_DISTANCE = 8;
const MAX_PRESS_MS = 15_000;
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_DISTANCE = 3;

interface Mark {
  point: CompanionPoint;
  at: number;
}

const distance = (a: CompanionPoint, b: CompanionPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Recognizes the left-button drags and double-clicks that selection-hook treats as selecting text. */
export class SelectionGestureTracker {
  private press: Mark | null = null;
  private release: (Mark & { quick: boolean }) | null = null;

  down(point: CompanionPoint, at: number): void {
    this.press = { point, at };
  }

  /** Whether this release ends a drag or a double-click. */
  up(point: CompanionPoint, at: number): boolean {
    const { press, release: previous } = this;
    this.press = null;
    if (!press) {
      this.release = null;
      return false;
    }
    const held = at - press.at;
    const quick = held <= DOUBLE_CLICK_MS;
    this.release = { point, at, quick };
    if (held > MAX_PRESS_MS) return false;
    const moved = distance(point, press.point);
    if (moved >= MIN_DRAG_DISTANCE) return true;
    return quick && !!previous?.quick
      && moved <= DOUBLE_CLICK_DISTANCE
      && distance(point, previous.point) <= DOUBLE_CLICK_DISTANCE
      && press.at - previous.at <= DOUBLE_CLICK_MS;
  }
}
