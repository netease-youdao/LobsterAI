import { type BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { type RemoteAgentSettingsAuthorization, RemoteAgentSettingsIpc, type RemoteAgentSettingsRevoke,RemoteAgentSettingsSection } from '../../shared/remote/agentSettings';
import { t } from '../i18n';
import type { RemoteAgentSettingsProtocol } from './remoteAgentSettingsProtocol';

interface Dependencies { getWindow(): BrowserWindow | null; getProtocol(): RemoteAgentSettingsProtocol | null }
const name = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 100);
const labels = {
  [RemoteAgentSettingsSection.Model]: 'remoteAgentSettingsModel', [RemoteAgentSettingsSection.Collaboration]: 'remoteAgentSettingsCollaboration',
  [RemoteAgentSettingsSection.Identity]: 'remoteAgentSettingsIdentity', [RemoteAgentSettingsSection.Memory]: 'remoteAgentSettingsMemory',
  [RemoteAgentSettingsSection.UserProfile]: 'remoteAgentSettingsUserProfile',
};
/** Main-window-only IPC plus a native confirmation: model/browser tool requests cannot create grants. */
export function registerRemoteAgentSettingsIpc(deps: Dependencies): void {
  const protocol = (event: IpcMainInvokeEvent): RemoteAgentSettingsProtocol => {
    const window = deps.getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('SETTINGS_ACCESS_DENIED');
    const value = deps.getProtocol(); if (!value) throw new Error('SETTINGS_UNAVAILABLE'); return value;
  };
  ipcMain.handle(RemoteAgentSettingsIpc.State, event => protocol(event).state());
  ipcMain.handle(RemoteAgentSettingsIpc.Authorize, async (event, input: RemoteAgentSettingsAuthorization) => {
    const client = protocol(event), state = await client.state();
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['expectedAccountEpoch', 'agentId', 'mobileDeviceId', 'grantId', 'grantVersion', 'sections'].includes(key))
      || input.expectedAccountEpoch !== state.accountEpoch || !state.supported) throw new Error('SETTINGS_ACCESS_STALE');
    const phone = state.candidates.find(item => item.mobileDeviceId === input.mobileDeviceId && item.grantId === input.grantId && item.grantVersion === input.grantVersion);
    const agent = state.agents.find(item => item.agentId === input.agentId);
    if (!phone || !agent) throw new Error('SETTINGS_ACCESS_STALE');
    const { settingsPermissions } = await import('./remoteAgentSettingsAccess');
    const sections = settingsPermissions(input.sections, state.conversationReady);
    const selected = Object.entries(sections).filter(([, permission]) => permission.read);
    if (!selected.length) throw new Error('SETTINGS_INVALID_REQUEST');
    const detail = selected.map(([section, permission]) => `${t(labels[section as RemoteAgentSettingsSection])}: ${[
      t('remoteAgentSettingsRead'), ...(permission.directUpdate ? [t('remoteAgentSettingsDirect')] : []),
      ...(permission.conversationUpdate ? [t('remoteAgentSettingsConversation')] : []),
    ].join(', ')}`).join('\n');
    const window = deps.getWindow(); if (!window || window.isDestroyed()) throw new Error('SETTINGS_ACCESS_STALE');
    const confirmation = await dialog.showMessageBox(window, { type: 'question', title: t('remoteAgentSettingsConfirmTitle'),
      message: t('remoteAgentSettingsConfirm', { phone: name(phone.name), agent: name(agent.name) }),
      detail: `${detail}${agent.agentId === 'main' ? `\n\n${t('remoteAgentSettingsShared')}` : ''}`,
      buttons: [t('remoteAgentSettingsCancel'), t('remoteAgentSettingsAuthorize')], defaultId: 0, cancelId: 0, noLink: true });
    if (confirmation.response !== 1) throw new Error('SETTINGS_AUTHORIZATION_CANCELLED');
    if (protocol(event) !== client) throw new Error('SETTINGS_ACCESS_STALE');
    return client.authorize({ ...input, sections });
  });
  ipcMain.handle(RemoteAgentSettingsIpc.Revoke, (event, input: RemoteAgentSettingsRevoke) => {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['expectedAccountEpoch', 'bindingId', 'bindingVersion'].includes(key))) throw new Error('SETTINGS_INVALID_REQUEST');
    return protocol(event).revoke(input);
  });
}
