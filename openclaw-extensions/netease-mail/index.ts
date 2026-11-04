import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

import { MAIL_PROVIDER, refreshMailCredential } from './refresh';

export default {
  id: MAIL_PROVIDER,
  name: 'NetEase Mail OAuth',
  register(api: OpenClawPluginApi) {
    const clientId = api.pluginConfig?.clientId;
    if (typeof clientId !== 'string' || !clientId) return;
    api.registerProvider({
      id: MAIL_PROVIDER, label: 'NetEase Mail', auth: [],
      refreshOAuth: credential => refreshMailCredential(credential, { clientId }),
    });
  },
};
