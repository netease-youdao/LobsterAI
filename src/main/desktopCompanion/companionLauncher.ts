import { DesktopCompanionTiming } from '../../shared/desktopCompanion/constants';
import { type CompanionPoint, type CompanionRect, rectContains } from '../../shared/desktopCompanion/geometry';
import { companionLauncherHolds } from '../../shared/desktopCompanion/launcher';

interface LauncherHoverHost {
  getCursor(): CompanionPoint;
  getOrbBounds(): CompanionRect | null;
  /** The launcher window's bounds while it is showing. */
  getCardBounds(): CompanionRect | null;
  /** Nothing more important has the user's attention. */
  canOpen(): boolean;
  isOpen(): boolean;
  /** Returns whether the launcher is now showing. */
  open(): boolean;
  close(): void;
}

/**
 * Hover intent for the orb's launcher. It opens once the pointer has rested on
 * the orb, and closes once the pointer has been away from both the orb and the
 * card for a moment. Closing is decided from the cursor position rather than
 * the windows' leave events: two windows hand the pointer to each other, and a
 * window that hides under the pointer reports nothing at all.
 */
export class CompanionLauncherHover {
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private awaySince: number | null = null;
  private suppressed = false;

  constructor(private readonly host: LauncherHoverHost) {}

  /** The orb reports the pointer arriving with no button held, and leaving. */
  setOrbHover(hovering: boolean): void {
    if (!hovering) {
      this.cancelOpen();
      // The next visit is a new hover.
      this.suppressed = false;
      return;
    }
    if (this.suppressed || this.openTimer !== undefined || this.host.isOpen()) return;
    this.openTimer = setTimeout(() => {
      this.openTimer = undefined;
      const orb = this.host.getOrbBounds();
      // A leave can go unreported; open only if the pointer really is still there.
      if (!orb || !rectContains(orb, this.host.getCursor()) || !this.host.canOpen()) return;
      if (this.host.open()) this.watch();
    }, DesktopCompanionTiming.LauncherOpenDelayMs);
  }

  /**
   * The orb was pressed, moved or right-clicked: that is the user's answer, so
   * the launcher steps aside and stays away until the pointer leaves and returns.
   */
  suppress(): void {
    this.suppressed = true;
    this.cancelOpen();
    this.stopWatching();
    if (this.host.isOpen()) this.host.close();
  }

  /** The orb is gone; nothing is hovered any more. */
  reset(): void {
    this.suppressed = false;
    this.cancelOpen();
    this.stopWatching();
  }

  private cancelOpen(): void {
    clearTimeout(this.openTimer);
    this.openTimer = undefined;
  }

  private watch(): void {
    this.stopWatching();
    this.pollTimer = setInterval(this.poll, DesktopCompanionTiming.LauncherPollMs);
  }

  private stopWatching(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.awaySince = null;
  }

  private poll = (): void => {
    // Something else took the stage, or an action closed it.
    if (!this.host.isOpen()) { this.stopWatching(); return; }
    if (companionLauncherHolds(this.host.getCursor(), [this.host.getOrbBounds(), this.host.getCardBounds()])) {
      this.awaySince = null;
      return;
    }
    this.awaySince ??= Date.now();
    if (Date.now() - this.awaySince < DesktopCompanionTiming.LauncherCloseDelayMs) return;
    this.stopWatching();
    this.host.close();
  };
}
