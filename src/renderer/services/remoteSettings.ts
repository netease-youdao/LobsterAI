import {
  type RemoteConfigureRequest,
  type RemoteSettingsApi,
  RemoteSettingsError,
  type RemoteSettingsState,
} from '../../shared/remote/constants';
import { isNewRemoteState } from '../components/settings/remoteControlState';

export interface RemoteSettingsSnapshot {
  state: RemoteSettingsState | null;
  busy: boolean;
  error: string | null;
}

type SettingsApi = Pick<RemoteSettingsApi, 'state' | 'configure' | 'onChanged'>;
type SettingsIdentity = Pick<RemoteSettingsState, 'accountEpoch' | 'owner'>;

const sameIdentity = (left: SettingsIdentity, right: SettingsIdentity): boolean => (
  left.accountEpoch === right.accountEpoch
    && left.owner?.userId === right.owner?.userId && left.owner?.scopeKey === right.owner?.scopeKey
);

const confirmsChanges = (state: RemoteSettingsState, changes: RemoteConfigureRequest): boolean => {
  const fields = ['enabled', 'keepAwakeEnabled', 'name'] as const;
  const changedFields = fields.filter(field => changes[field] !== undefined);
  return changedFields.length > 0 && !changes.retry && !changes.addWorkspace && !changes.removeWorkspaceId
    && changedFields.every(field => state[field] === changes[field]);
};

export class RemoteSettingsService {
  private snapshot: RemoteSettingsSnapshot = { state: null, busy: false, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly retiredEpochs = new Set<string>();
  private identity: SettingsIdentity | null = null;
  private revision = -1;
  private generation = 0;
  private readSequence = 0;
  private subscriptionSequence = 0;
  private unsubscribeRemote: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private submitting = false;
  private unconfirmed = false;
  private awaitingRefresh = false;
  private bufferedState: RemoteSettingsState | null = null;

  constructor(private readonly getApi: () => SettingsApi = () => window.electron.remote) {}

  getSnapshot = (): RemoteSettingsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      const subscription = ++this.subscriptionSequence;
      this.unsubscribeRemote = this.getApi().onChanged(state => {
        if (subscription !== this.subscriptionSequence) return;
        if (!this.awaitingRefresh) {
          this.accept(state);
        } else if (!(state.accountEpoch && this.retiredEpochs.has(state.accountEpoch))
          && (state.stateRevision ?? 0) >= this.revision && isNewRemoteState(this.bufferedState, state)) {
          this.bufferedState = state;
        }
      });
      void this.refresh();
      this.timer = setInterval(() => { void this.refresh(); }, 5000);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size !== 0) return;
      this.subscriptionSequence++;
      this.readSequence++;
      this.unsubscribeRemote?.();
      this.unsubscribeRemote = undefined;
      clearInterval(this.timer);
      this.timer = undefined;
    };
  };

  invalidate = (): void => {
    this.generation++;
    this.readSequence++;
    this.unconfirmed = false;
    this.awaitingRefresh = true;
    this.bufferedState = null;
    this.update({ state: null, error: null });
  };

  refresh = async (): Promise<void> => {
    const generation = this.generation;
    const sequence = ++this.readSequence;
    try {
      const state = await this.getApi().state();
      if (generation !== this.generation || sequence !== this.readSequence) return;
      this.finishRefresh(state);
    } catch {
      if (generation === this.generation && sequence === this.readSequence
        && !this.finishRefresh() && !this.submitting) {
        this.update({ error: this.unconfirmed ? 'remoteSettingsUnconfirmed' : 'remoteStateUnavailable' });
      }
    }
  };

  private finishRefresh(state?: RemoteSettingsState): boolean {
    // Subscription notifications can overtake state(), including during an account boundary.
    const latest = this.bufferedState && (!state || isNewRemoteState(state, this.bufferedState))
      ? this.bufferedState : state;
    this.bufferedState = null;
    if (!latest || !this.accept(latest)) return false;
    this.awaitingRefresh = false;
    this.unconfirmed = false;
    if (!this.submitting) this.update({ error: null });
    return true;
  }

  /** True confirms local persistence; power and connection failures remain in the state. */
  submit = async (changes: RemoteConfigureRequest): Promise<boolean> => {
    if (this.submitting) return false;
    if (this.unconfirmed) {
      await this.refresh();
      return false;
    }
    const initial = this.snapshot.state;
    if (!initial?.accountEpoch || !initial.owner) {
      await this.refresh();
      return false;
    }
    const generation = this.generation;
    this.submitting = true;
    this.update({ busy: true, error: null });
    try {
      const result = await this.getApi().configure({ ...changes, expectedAccountEpoch: initial.accountEpoch });
      if (generation !== this.generation) return false;
      if (!sameIdentity(initial, result)) {
        this.invalidate();
        this.update({ error: RemoteSettingsError.AccountChanged });
        return false;
      }
      this.accept(result);
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      if (error instanceof Error && error.message.includes(RemoteSettingsError.AccountChanged)) {
        this.invalidate();
        this.update({ error: RemoteSettingsError.AccountChanged });
        return false;
      }
      return await this.reconcile(initial, changes, generation);
    } finally {
      this.submitting = false;
      this.update({ busy: false });
    }
  };

  private async reconcile(initial: RemoteSettingsState, changes: RemoteConfigureRequest, generation: number): Promise<boolean> {
    try {
      const current = await this.getApi().state();
      if (generation !== this.generation) return false;
      if (!sameIdentity(initial, current)) {
        this.invalidate();
        this.update({ error: RemoteSettingsError.AccountChanged });
        return false;
      }
      this.accept(current);
      const confirmed = this.snapshot.state !== null && confirmsChanges(this.snapshot.state, changes);
      this.update({ error: confirmed ? null : 'remoteSaveFailed' });
      return confirmed;
    } catch {
      if (generation === this.generation) {
        this.unconfirmed = true;
        this.update({ error: 'remoteSettingsUnconfirmed' });
      }
      return false;
    }
  }

  private accept(state: RemoteSettingsState): boolean {
    if ((state.accountEpoch && this.retiredEpochs.has(state.accountEpoch))
      || (state.stateRevision ?? 0) < this.revision
      || !isNewRemoteState(this.snapshot.state, state)) return false;
    if (this.identity && !sameIdentity(this.identity, state)) {
      if (this.identity.accountEpoch && this.identity.accountEpoch !== state.accountEpoch) {
        this.retiredEpochs.add(this.identity.accountEpoch);
      }
      this.generation++;
      this.unconfirmed = false;
      this.update({ error: null });
    }
    this.identity = { owner: state.owner, accountEpoch: state.accountEpoch };
    this.revision = state.stateRevision ?? 0;
    this.update({ state });
    return true;
  }

  private update(changes: Partial<RemoteSettingsSnapshot>): void {
    const next = { ...this.snapshot, ...changes };
    if (next.state === this.snapshot.state && next.busy === this.snapshot.busy && next.error === this.snapshot.error) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export const remoteSettingsService = new RemoteSettingsService();
