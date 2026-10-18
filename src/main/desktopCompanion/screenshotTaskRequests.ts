import type { ScreenshotTaskRequest } from '../../shared/desktopCompanion/screenshotTask';

/** Claims survive renderer remounts; completed requests can acknowledge again without rerunning a task. */
export class ScreenshotTaskRequests {
  pending: ScreenshotTaskRequest | undefined;
  private active = new Set<string>();
  private completed = new Map<string, string>();

  offer(request: ScreenshotTaskRequest): void {
    if (this.pending) this.active.delete(this.pending.id);
    this.pending = request;
    this.active.add(request.id);
  }

  consume(id: string): ScreenshotTaskRequest | null {
    if (this.pending?.id !== id) return null;
    const request = this.pending;
    this.pending = undefined;
    return request;
  }

  isCurrent(id: string): boolean { return this.active.has(id); }

  finish(id: string, sessionId: string): void {
    if (!this.active.delete(id)) return;
    this.completed.set(id, sessionId);
    if (this.completed.size > 32) this.completed.delete(this.completed.keys().next().value!);
  }

  matches(id: string, sessionId: string): boolean { return this.completed.get(id) === sessionId; }

  reset(): void { this.pending = undefined; this.active.clear(); this.completed.clear(); }
}
