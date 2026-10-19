import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

const SERVER_PROVIDER = 'lobsterai-server';
const VIRTUAL_MODELS = new Set(['yd-fast', 'yd-ultra']);

/** Native cron/IM/subagent runs use the same server binding as desktop runs. */
export default {
  id: 'lobster-model-routing',
  name: 'LobsterModelRouting',
  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as { proxyUrl?: string; token?: string } | undefined;
    if (!config?.proxyUrl || !config.token) return;
    api.on('before_model_resolve', async (event, ctx) => {
      if (ctx.modelProviderId !== SERVER_PROVIDER || !ctx.modelId || !VIRTUAL_MODELS.has(ctx.modelId)) return;
      if (!ctx.sessionId) throw new Error('Virtual model routing requires a session id');
      const response = await fetch(`${config.proxyUrl}/models/${ctx.modelId}/resolve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: ctx.sessionId,
          requiresImage: event.attachments?.some(attachment => attachment.kind === 'image') ?? false,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await response.json() as {
        code?: number; message?: string; data?: { modelId?: string; accessible?: boolean };
      };
      if (!response.ok || body.code !== 0 || !body.data?.modelId || body.data.accessible === false
          || VIRTUAL_MODELS.has(body.data.modelId)) {
        throw new Error(body.message || 'Failed to resolve virtual model');
      }
      return { providerOverride: SERVER_PROVIDER, modelOverride: body.data.modelId };
    });
  },
};
