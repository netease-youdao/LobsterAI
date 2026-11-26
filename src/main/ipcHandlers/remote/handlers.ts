import fs from 'node:fs';
import path from 'node:path';

import { dialog, ipcMain, type WebContents } from 'electron';

import type { RemoteConnectionOperationRequest, RemoteConnectionRemoveRequest, RemoteConnectionResumeRequest, RemoteConnectionsRequest } from '../../../shared/remote/connections';
import { type RemoteConfigureRequest, RemoteIpc, type RemoteOwner, type RemoteSettingsState } from '../../../shared/remote/constants';
import { RemoteTelemetryEvent, RemoteTelemetryIpc } from '../../../shared/remote/telemetry';
import { validRemoteTelemetryUi } from '../../../shared/remote/telemetryUi';
import { sameOwner } from '../../remote/canonical';
import { configureRemoteSettings } from '../../remote/configureRemoteSettings';
import type { RemoteBridge } from '../../remote/remoteBridge';
import { withRemoteConnectionAccount } from '../../remote/remoteConnectionIpc';
import { RemoteInitializationError} from '../../remote/remoteInitialization';
import { remotePerformance, RemotePerformanceStage } from '../../remote/remotePerformanceLog';
import type { RemoteSettingsController } from '../../remote/remoteSettingsController';
import { captureRemoteTelemetry } from '../../remote/remoteTelemetry';
import { isMainWindowRequest,mainWindowHandler } from '../mainWindowIpc';

export function registerRemoteHandlers(deps: {
  sender(): WebContents | undefined;
  owner(): RemoteOwner | null;
  epoch(): string;
  state(): RemoteSettingsState;
  controller(): RemoteSettingsController | null;
  bridge(retry?: boolean): RemoteBridge;
  retryAccount(): Promise<void>;
}): void {
  const { owner: getCurrentRemoteOwner, epoch: getRemoteAccountEpoch, state: readRemoteState, bridge: initializeRemoteBridge } = deps;
  const handle = mainWindowHandler(deps.sender);
  handle(RemoteIpc.State, () => deps.controller()?.state() ?? readRemoteState());
  ipcMain.on(RemoteTelemetryIpc.Ui, (event, input: unknown) => {
    if (!isMainWindowRequest(deps.sender(), event) || !validRemoteTelemetryUi(input)
      || input.expectedAccountEpoch !== getRemoteAccountEpoch()) return;
    captureRemoteTelemetry().emit(RemoteTelemetryEvent.Ui, { uiInteractionId: input.uiInteractionId,
      uiAction: input.uiAction, uiStage: input.uiStage, surface: input.surface, outcome: input.outcome });
  });
  const connectionAccount = { getAccountEpoch: getRemoteAccountEpoch, getOwner: getCurrentRemoteOwner };
  handle(RemoteIpc.Connections, (_event, input: RemoteConnectionsRequest) => withRemoteConnectionAccount(input, connectionAccount,
    () => remotePerformance.async(RemotePerformanceStage.RemoteConnections, () => initializeRemoteBridge().queryConnections())));
  handle(RemoteIpc.RemoveConnection, (_event, input: RemoteConnectionRemoveRequest) => withRemoteConnectionAccount(input, connectionAccount,
    () => remotePerformance.async(RemotePerformanceStage.RemoteConnections, () => initializeRemoteBridge().removeConnection(input))));
  handle(RemoteIpc.ResumeConnection, (_event, input: RemoteConnectionResumeRequest) => withRemoteConnectionAccount(input, connectionAccount,
    () => remotePerformance.async(RemotePerformanceStage.RemoteConnections, () => initializeRemoteBridge().resumeCurrentConnection(input))));
  handle(RemoteIpc.ConnectionOperation, (_event, input: RemoteConnectionOperationRequest) => withRemoteConnectionAccount(input, connectionAccount,
    () => remotePerformance.async(RemotePerformanceStage.RemoteConnections, () => initializeRemoteBridge().queryConnectionOperation(input.requestId))));

  handle(RemoteIpc.Configure, (_event, input: RemoteConfigureRequest) => configureRemoteSettings(input, {
    getAccountEpoch: getRemoteAccountEpoch,
    getOwner: getCurrentRemoteOwner,
    getController: deps.controller,
    selectWorkspace: async () => {
      const selection = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return !selection.canceled && selection.filePaths[0]
        ? { name: path.basename(selection.filePaths[0]), path: fs.realpathSync(selection.filePaths[0]) } : undefined;
    },
    configureRemote: async changes => {
      try {
        if (changes.retry) {
          const epoch = getRemoteAccountEpoch();
          await deps.retryAccount();
          if (epoch !== getRemoteAccountEpoch()) throw new Error('Account changed');
        }
        const bridge = remotePerformance.sync(RemotePerformanceStage.RemoteInitialize, () => initializeRemoteBridge(changes.retry === true));
        return remotePerformance.async(RemotePerformanceStage.RemoteConfigure, () => bridge.configure(changes));
      } catch (error) {
        // A failed pure recheck returns the precise offline state, never a successful reconnect.
        if (error instanceof RemoteInitializationError && changes.retry && changes.enabled === undefined
          && changes.name === undefined && !changes.workspace && !changes.removeWorkspaceId
          && !changes.reregister && !changes.retrySessionId) return Promise.resolve();
        throw error;
      }
    },
  }));
  handle(RemoteIpc.Decide, async (_event, requestId: string, decision: 'approve' | 'deny') => {
    if (typeof requestId !== 'string' || !['approve', 'deny'].includes(decision)) throw new Error('Invalid access decision');
    const owner = deps.owner();
    const epoch = deps.epoch();
    if (!owner) throw new Error('Sign in before configuring remote access');
    await initializeRemoteBridge().decide(requestId, decision);
    if (epoch !== deps.epoch() || !sameOwner(owner, deps.owner())) throw new Error('Account changed');
    return deps.controller()?.state() ?? readRemoteState();
  });
}
