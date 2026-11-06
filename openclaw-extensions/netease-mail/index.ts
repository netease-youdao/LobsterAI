import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import { readMailAuthorization } from './authorization';
import { MAIL_PROVIDER, refreshMailCredential } from './refresh';
import { registerMailTools } from './tools';

export default {
  id: MAIL_PROVIDER,
  name: 'NetEase Mail OAuth',
  register(api: OpenClawPluginApi) {
    const clientId = api.pluginConfig?.clientId;
    if (typeof clientId !== 'string' || !clientId) return;
    registerMailTools(api, clientId);
    api.registerProvider({
      id: MAIL_PROVIDER, label: 'NetEase Mail', auth: [],
      refreshOAuth: credential => refreshMailCredential(credential, {
        clientId, scopes: readMailAuthorization(api.runtime.state.resolveStateDir(), clientId)?.scopes,
      }),
    });
  },
};
