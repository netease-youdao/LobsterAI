import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

const SERVER_PROVIDER = 'lobsterai-server';
const VIRTUAL_MODELS = new Set(['yd-fast', 'yd-ultra']);
// Mirrors NATIVE_RUN_LLM_TRACE_PROXY_PATH in src/shared/cowork/llmTurnUsage.ts.
const NATIVE_RUN_LLM_TRACE_PATH = '/lobsterai/native-run-llm-traces';
const MAX_REPORTED_RUN_TRACES = 512;

const rememberBounded = <K, V>(map: Map<K, V>, key: K, value: V): void => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_REPORTED_RUN_TRACES) map.delete(map.keys().next().value!);
};

/** Native cron/IM/subagent runs use the same server binding as desktop runs. */
export default {
  id: 'lobster-model-routing',
  name: 'LobsterModelRouting',
  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as { proxyUrl?: string; token?: string } | undefined;
    if (!config?.proxyUrl || !config.token) return;
    // Virtual model each run resolved, so its usage report can name the preset.
    const virtualModelByRun = new Map<string, string>();
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
      if (ctx.runId) rememberBounded(virtualModelByRun, ctx.runId, ctx.modelId);
      return { providerOverride: SERVER_PROVIDER, modelOverride: body.data.modelId };
    });

    // This hook is awaited before the first model request. model_call_started
    // is fire-and-forget in OpenClaw and cannot establish usage attribution in time.
    api.on('before_prompt_build', async (_event, ctx) => {
      const usage = ctx as typeof ctx & {
        usageUserMessage?: string; usageJobTitle?: string; jobId?: string;
      };
      if (!ctx.runId || !ctx.trace?.traceId || !ctx.sessionKey
          || (ctx.messageProvider === 'webchat' && ctx.trigger !== 'cron')) return;
      try {
        const response = await fetch(`${config.proxyUrl}${NATIVE_RUN_LLM_TRACE_PATH}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId: ctx.runId,
            traceId: ctx.trace.traceId,
            model: ctx.modelId,
            virtualModelId: virtualModelByRun.get(ctx.runId),
            sessionKey: ctx.sessionKey,
            sessionId: ctx.sessionId,
            messageProvider: ctx.messageProvider,
            trigger: ctx.trigger,
            jobId: usage.jobId,
            jobTitle: usage.usageJobTitle,
            userMessage: usage.usageUserMessage ?? '',
          }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`Usage context report returned ${response.status}`);
      } catch (error) {
        api.logger.warn(`[lobster-model-routing] usage context report failed: ${String(error)}`);
      }
    });

    // IM and cron runs are not started by LobsterAI, so it cannot know their
    // trace. Report each run's package-model trace once so LobsterAI can show
    // the credits and model of the turn; desktop turns are ignored there.
    const reportedRunTraces = new Set<string>();
    api.on('model_call_started', (event, ctx) => {
      const runId = ctx.runId ?? event.runId;
      const traceId = ctx.trace?.traceId;
      if (event.provider !== SERVER_PROVIDER || !runId || !traceId) return;
      const key = `${runId}\u001f${traceId}`;
      if (reportedRunTraces.has(key)) return;
      reportedRunTraces.add(key);
      if (reportedRunTraces.size > MAX_REPORTED_RUN_TRACES) {
        reportedRunTraces.delete(reportedRunTraces.values().next().value!);
      }
      void fetch(`${config.proxyUrl}${NATIVE_RUN_LLM_TRACE_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId,
          traceId,
          model: event.model,
          ...(virtualModelByRun.has(runId) ? { virtualModelId: virtualModelByRun.get(runId) } : {}),
        }),
        signal: AbortSignal.timeout(5_000),
      }).catch((error: unknown) => {
        reportedRunTraces.delete(key);
        api.logger.info(`[lobster-model-routing] trace report failed: run=${runId} trace=${traceId} error=${String(error)}`);
      });
    });
  },
};
