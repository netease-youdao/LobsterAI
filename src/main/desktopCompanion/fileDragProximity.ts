import { DesktopCompanionSize, DesktopCompanionTiming } from '../../shared/desktopCompanion/constants';
import type { CompanionPoint, CompanionRect } from '../../shared/desktopCompanion/geometry';

interface FileDragProximityHost {
  getCursor(): CompanionPoint;
  getOrbBounds(): CompanionRect | null;
  onEnter(): void;
  onLeave(): void;
}

/** Watches only during a file drag; never adds an invisible window over the desktop. */
export class CompanionFileDragProximity {
  private timer: ReturnType<typeof setInterval> | undefined;
  private nearSince: number | null = null;
  private active = false;

  constructor(private readonly host: FileDragProximityHost) {}

  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(this.poll, DesktopCompanionTiming.DropProximityPollMs);
    this.poll();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.nearSince = null;
    this.active = false;
  }

  private poll = (): void => {
    const orb = this.host.getOrbBounds();
    const cursor = this.host.getCursor();
    const radius = orb ? Math.max(orb.width, orb.height) / 2 + DesktopCompanionSize.DropProximityPadding
      + (this.active ? DesktopCompanionSize.DropProximityExitPadding : 0) : 0;
    const near = orb && Math.hypot(cursor.x - orb.x - orb.width / 2, cursor.y - orb.y - orb.height / 2) <= radius;
    if (!near) {
      this.nearSince = null;
      if (this.active) {
        this.active = false;
        this.host.onLeave();
      }
      return;
    }
    if (this.active) return;
    this.nearSince ??= Date.now();
    if (Date.now() - this.nearSince >= DesktopCompanionTiming.DropExpandDelayMs) {
      this.active = true;
      this.host.onEnter();
    }
  };
}
