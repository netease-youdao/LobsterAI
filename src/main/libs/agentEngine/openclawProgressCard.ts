import {
  isSameProgressCardSessionKey,
  type OpenClawProgressCard,
  parseProgressCard,
  ProgressCardGatewayMethod,
} from '../../../shared/cowork/progressCard';

interface ProgressCardGatewayClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Most sessions a window watches at once; the oldest watch is dropped beyond it. */
const MAX_WATCHED_SESSIONS = 100;

/**
 * Bridges Cowork sessions to OpenClaw's native progress cards. The Gateway
 * owns the cards; this only maps local session ids to native session keys,
 * reads and clears cards, and turns Gateway change broadcasts into
 * per-session invalidations for the sessions a window has read.
 */
export class OpenClawProgressCards {
  private readonly watched = new Map<string, string>();

  constructor(private readonly deps: {
    client: () => ProgressCardGatewayClient;
    sessionKey: (sessionId: string) => string | undefined;
    changed: (sessionId: string) => void;
  }) {}

  async get(sessionId: string): Promise<OpenClawProgressCard | null> {
    const sessionKey = this.deps.sessionKey(sessionId);
    if (!sessionKey) return null;
    this.watch(sessionId, sessionKey);
    const client = this.deps.client();
    const result = await client.request(ProgressCardGatewayMethod.Get, { sessionKey });
    this.assertCurrent(sessionId, sessionKey, client);
    return parseProgressCard(result, sessionKey);
  }

  /**
   * Clears the card the user is looking at. The Gateway only clears when the
   * stored revision still matches, so a card the agent rewrote meanwhile
   * survives and comes back as the result.
   */
  async dismiss(sessionId: string, expectedRevision: number): Promise<OpenClawProgressCard | null> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('Invalid progress card revision');
    }
    const card = await this.get(sessionId);
    if (!card || card.revision !== expectedRevision) return card;
    const client = this.deps.client();
    const result = await client.request(ProgressCardGatewayMethod.Put, {
      sessionKey: card.sessionKey,
      expectedRevision,
    });
    this.assertCurrent(sessionId, card.sessionKey, client);
    return parseProgressCard(result, card.sessionKey);
  }

  /** A Gateway `progressCard.changed` broadcast: invalidate every watching session it concerns. */
  changed(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const { sessionKey } = payload as { sessionKey?: unknown };
    if (typeof sessionKey !== 'string') return;
    for (const [sessionId, watchedKey] of this.watched) {
      const currentKey = this.deps.sessionKey(sessionId);
      if (currentKey && isSameProgressCardSessionKey(watchedKey, sessionKey)
        && isSameProgressCardSessionKey(currentKey, watchedKey)) {
        this.deps.changed(sessionId);
      }
    }
  }

  /** Cards may have changed while the connection was down; every watcher rereads. */
  reconnected(): void {
    for (const sessionId of this.watched.keys()) {
      this.deps.changed(sessionId);
    }
  }

  private watch(sessionId: string, sessionKey: string): void {
    this.watched.delete(sessionId);
    this.watched.set(sessionId, sessionKey);
    if (this.watched.size > MAX_WATCHED_SESSIONS) {
      const oldest = this.watched.keys().next().value;
      if (oldest !== undefined) this.watched.delete(oldest);
    }
  }

  /** A reply that crossed a reconnect or a session-key change describes stale state. */
  private assertCurrent(sessionId: string, sessionKey: string, client: ProgressCardGatewayClient): void {
    const currentKey = this.deps.sessionKey(sessionId);
    if (this.deps.client() !== client || !currentKey || !isSameProgressCardSessionKey(currentKey, sessionKey)) {
      throw new Error('Progress card connection or session changed');
    }
  }
}
