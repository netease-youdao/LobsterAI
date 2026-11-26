import { app, session, shell } from 'electron';

import { NeteaseMail } from '../../../shared/neteaseMail/constants';
import type { CoworkStore } from '../../coworkStore';
import { t } from '../../i18n';
import type { DshRuntimeAdapter } from '../../libs/agentEngine/dshRuntimeAdapter';
import type { McpOAuthManager } from '../mcpOAuthManager';
import type { McpRuntime } from '../mcpRuntime';
import { createNeteaseMailAuthStore } from '../neteaseMailAuthStore';
import { getNeteaseMailOAuthConfig } from '../neteaseMailConfig';
import { NeteaseMailConnection } from '../neteaseMailConnection';
import { NeteaseMailHost } from './host';
import { mailConfirmationDetailsForIpc } from './protocol';

interface DesktopDeps {
  getRuntime: () => McpRuntime;
  getStore: () => CoworkStore;
  getManager: () => McpOAuthManager | null;
  getAdapter: () => DshRuntimeAdapter | undefined;
  sync: (options: { reason: string; waitForMcpServerId?: string }) => Promise<{ success: boolean; mcpServerConnected?: boolean }>;
}

export function createNeteaseMailDesktop(deps: DesktopDeps) {
  const config = getNeteaseMailOAuthConfig(app.isPackaged);
  const getServer = () => deps.getRuntime().getStore().listServers().find(server => server.registryId === NeteaseMail.RegistryId);
  const fetchMail: typeof fetch = (input, init) => session.defaultSession.fetch(input instanceof Request ? input.url : input.toString(), init);
  const host = new NeteaseMailHost({
    config, getServer, getManager: deps.getManager, fetch: fetchMail,
    getSession: id => deps.getStore().getSession(id, 0),
    getTurnSignal: id => deps.getAdapter()?.getActiveTurnSignal(id),
    publish: (id, callId, result) => {
      const message = deps.getStore().addMessage(id, { type: 'tool_result', content: result.content[0].text,
        metadata: { toolUseId: callId, toolResultDetails: result.details, isFinal: false, isStreaming: true } });
      deps.getAdapter()?.emit('message', id, { ...message,
        metadata: { ...message.metadata, toolResultDetails: mailConfirmationDetailsForIpc(result.details) } });
    },
  });
  const connection = new NeteaseMailConnection({
    config, confirmations: host, getMcpStore: () => deps.getRuntime().getStore(),
    getAuthStore: () => {
      const manager = deps.getManager();
      return config && manager ? createNeteaseMailAuthStore(manager, config, getServer, () => host.invalidate()) : undefined;
    },
    openExternal: url => shell.openExternal(url), fetch: fetchMail, callbackText: () => t('neteaseMailAuthorizationReturned'),
    sync: async serverId => {
      const result = await deps.sync({ reason: 'netease-mail-authorization', waitForMcpServerId: serverId });
      return { success: result.success && (!serverId || result.mcpServerConnected === true) };
    },
    broadcast: () => deps.getRuntime().broadcastServersChanged(),
  });
  return { host, connection };
}
