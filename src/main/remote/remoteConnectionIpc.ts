import type { RemoteConnectionsRequest } from '../../shared/remote/connections';
import { type RemoteOwner, RemoteSettingsError } from '../../shared/remote/constants';

/** A queued management action must never cross logout, workspace switching or a new login. */
export async function withRemoteConnectionAccount<T>(input: RemoteConnectionsRequest,
  deps: { getAccountEpoch(): string; getOwner(): RemoteOwner | null }, action: () => Promise<T>): Promise<T> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid connection management request');
  const epoch = deps.getAccountEpoch(), owner = deps.getOwner();
  if (!owner) throw new Error('Sign in before managing connections');
  const assertCurrent = () => {
    const current = deps.getOwner();
    if (deps.getAccountEpoch() !== epoch || input.expectedAccountEpoch !== undefined && input.expectedAccountEpoch !== epoch
      || !current || current.userId !== owner.userId || current.scopeKey !== owner.scopeKey) throw new Error(RemoteSettingsError.AccountChanged);
  };
  try {
    assertCurrent();
    const result = await action();
    assertCurrent();
    return result;
  } catch (error) {
    assertCurrent();
    // Electron preserves Error.message, not custom Error fields; expose only the stable code and message.
    if (error instanceof Error && 'code' in error && typeof error.code === 'number') throw new Error(`${error.code}: ${error.message}`);
    throw error;
  }
}
