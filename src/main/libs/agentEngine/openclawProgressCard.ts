import { ProgressCardGatewayMethod, ProgressCardStepStatus } from '../../../shared/cowork/progressCard';
import { type OpenClawProgressCard,parseProgressCard,parseProgressCardRefreshReceipt } from '../../../shared/cowork/progressCard';
interface Client { request(method: string, params: Record<string, unknown>): Promise<unknown> }
/** The Gateway owns persistence. This bridge only remembers local-to-native identities. */
export class OpenClawProgressCards {
  private watched = new Map<string, string>();
  constructor(private readonly deps: {
    client: () => Client;
    key: (sessionId: string) => string | undefined;
    changed: (sessionId: string) => void;
  }) {}
  async get(sessionId: string): Promise<OpenClawProgressCard | null> {
    const key = this.deps.key(sessionId);
    if (!key) return null;
    this.watched.set(sessionId, key);
    if (this.watched.size > 100) this.watched.delete(this.watched.keys().next().value!);
    const client = this.deps.client();
    const result = await client.request(ProgressCardGatewayMethod.Get, { sessionKey: key });
    this.assertCurrent(sessionId, key, client);
    return parseProgressCard(result, key);
  }
  async refresh(sessionId: string, idempotencyKey: string) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200) throw new Error('Invalid refresh identity');
    const key = this.deps.key(sessionId);
    if (!key) throw new Error('Unknown progress card session');
    const client = this.deps.client();
    const result = await client.request(ProgressCardGatewayMethod.Refresh, { sessionKey: key, idempotencyKey });
    this.assertCurrent(sessionId, key, client);
    return parseProgressCardRefreshReceipt(result);
  }
  async dismiss(sessionId: string, expectedRevision: number): Promise<OpenClawProgressCard | null> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Invalid revision');
    const card = await this.get(sessionId);
    if (!card || card.revision !== expectedRevision) return card;
    if (!card.steps?.length || !card.steps.every(s => s.status === ProgressCardStepStatus.Completed)) throw new Error('Card is not complete');
    const client = this.deps.client();
    this.assertCurrent(sessionId, card.sessionKey, client);
    const result = await client.request(ProgressCardGatewayMethod.Put, { sessionKey: card.sessionKey, expectedRevision });
    this.assertCurrent(sessionId, card.sessionKey, client);
    return parseProgressCard(result, card.sessionKey);
  }
  changed(payload: unknown): void {
    if (!payload || typeof payload !== 'object' || !('sessionKey' in payload)) return;
    for (const [id, key] of this.watched) {
      if (key === payload.sessionKey && this.deps.key(id) === key) this.deps.changed(id);
    }
  }
  reconnected(): void { for (const id of this.watched.keys()) this.deps.changed(id); }
  private assertCurrent(id: string, key: string, client: Client): void {
    if (this.deps.client() !== client || this.deps.key(id) !== key) throw new Error('Progress card connection or session changed');
  }
}
