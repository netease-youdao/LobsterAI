/** Durable, account-scoped outbox. A title is acknowledged only by HTTP success + code 0. */
export type PendingUsageTitle = {
  owner: string;
  sessionId: string;
  title: string;
  revision: number;
  attempts: number;
  retryAt: number;
};
export type UsageTitleOutbox = { revision: number; pending: PendingUsageTitle[] };

type Dependencies = {
  load: () => UsageTitleOutbox | undefined;
  save: (state: UsageTitleOutbox) => void;
  getOwner: () => string | null;
  send: (entry: PendingUsageTitle) => Promise<Response>;
  now?: () => number;
};

export class UsageTitleSync {
  private readonly state: UsageTitleOutbox;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: Dependencies) {
    this.state = deps.load() ?? { revision: 0, pending: [] };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, 30_000);
    this.timer.unref?.();
    void this.flush();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  enqueue(sessionId: string, title: string): void {
    const owner = this.deps.getOwner();
    if (!owner || !title.trim()) return;
    const boundedTitle = Array.from(title).slice(0, 512).join('');
    const previous = this.state.pending.find(entry => entry.owner === owner && entry.sessionId === sessionId);
    if (previous?.title === boundedTitle) return;
    const revision = Math.max(this.now(), this.state.revision + 1);
    this.state.revision = revision;
    this.state.pending = this.state.pending.filter(entry => entry !== previous);
    this.state.pending.push({ owner, sessionId, title: boundedTitle, revision, attempts: 0, retryAt: 0 });
    this.deps.save(this.state);
    void this.flush();
  }

  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().catch(() => {
      // A local persistence error must not interrupt model calls; the durable entry is retried later.
    }).finally(() => { this.running = null; });
    return this.running;
  }

  private async drain(): Promise<void> {
    for (const entry of [...this.state.pending]) {
      if (entry.owner !== this.deps.getOwner() || entry.retryAt > this.now()) continue;
      let succeeded = false;
      try {
        const response = await this.deps.send(entry);
        const body = await response.json() as { code?: number };
        succeeded = response.ok && body.code === 0;
      } catch { /* Offline, timeout and invalid JSON all leave the entry pending. */ }
      const current = this.state.pending.find(item => item.owner === entry.owner && item.sessionId === entry.sessionId);
      // A delayed response must never erase or back off a newer rename.
      if (current?.revision !== entry.revision) continue;
      if (succeeded) this.state.pending = this.state.pending.filter(item => item !== current);
      else {
        current.attempts++;
        current.retryAt = this.now() + Math.min(300_000, 30_000 * 2 ** Math.min(current.attempts - 1, 4));
      }
      this.deps.save(this.state);
    }
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
}
