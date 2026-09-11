import { type RemoteConfigureRequest, type RemoteOwner, RemoteSettingsError, type RemoteSettingsState } from '../../shared/remote/constants';
import type { RemoteSettingsController } from './remoteSettingsController';

interface ConfigureDependencies {
  getAccountEpoch(): string;
  getOwner(): RemoteOwner | null;
  getController(): RemoteSettingsController | null;
  selectWorkspace(): Promise<{ name: string; path: string } | undefined>;
  configureRemote(changes: {
    enabled?: boolean; name?: string; workspace?: { name: string; path: string };
    removeWorkspaceId?: string; retry?: boolean;
  }): Promise<unknown>;
}

/** Fences settings IPC work across queued requests, directory dialogs and bridge completion. */
export async function configureRemoteSettings(
  input: RemoteConfigureRequest,
  deps: ConfigureDependencies,
): Promise<RemoteSettingsState> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid remote settings');
  const accountEpoch = deps.getAccountEpoch();
  if (input.expectedAccountEpoch !== undefined && input.expectedAccountEpoch !== accountEpoch) {
    throw new Error(RemoteSettingsError.AccountChanged);
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('Invalid remote enabled setting');
  if (input.retry !== undefined && typeof input.retry !== 'boolean') throw new Error('Invalid retry setting');
  const actor = deps.getOwner();
  if (!actor) throw new Error('Sign in before configuring remote access');
  const owner = { ...actor };
  const controller = deps.getController();
  if (!controller) throw new Error('Remote settings are not initialized');
  const assertCurrent = () => {
    const current = deps.getOwner();
    if (deps.getAccountEpoch() !== accountEpoch || !current
      || current.userId !== owner.userId || current.scopeKey !== owner.scopeKey) {
      throw new Error(RemoteSettingsError.AccountChanged);
    }
  };

  try {
    assertCurrent();
    const workspace = input.addWorkspace ? await deps.selectWorkspace() : undefined;
    assertCurrent();
    if (input.keepAwakeEnabled !== undefined) controller.setKeepAwake(input.keepAwakeEnabled);
    assertCurrent();
    if (input.retry) controller.restoreKeepAwake();
    assertCurrent();
    if (input.keepAwakeEnabled !== undefined && input.enabled === undefined && input.name === undefined
      && !input.retry && !input.addWorkspace && !input.removeWorkspaceId) return controller.state();
    await deps.configureRemote({ enabled: input.enabled, name: input.name, workspace,
      removeWorkspaceId: input.removeWorkspaceId, retry: input.retry });
    assertCurrent();
    controller.notify();
    return controller.state();
  } catch (error) {
    assertCurrent();
    throw error;
  }
}
