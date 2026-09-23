let qaProxyOptions;
const qaStartProxy = startOpenClawTokenProxy;
startOpenClawTokenProxy = options => { qaProxyOptions = options; return qaStartProxy(options); };
globalThis.__configQa = {
  fault: null, events: [],
  manager: () => getOpenClawEngineManager(),
  adapter: () => openClawRuntimeAdapter,
  sync: options => syncOpenClawConfig(options),
  barrier: () => waitForOpenClawConfigApply('qa-observation'),
  status() {
    const m = this.manager();
    return { engine: m.getStatus(), pid: m.getGatewayProcessPid(), generation: m.getGatewayProcessGeneration(), pending: openClawConfigRecovery.pending,
      error: openClawConfigRecovery.error, respawnRequired: openClawConfigRecovery.requiresRespawn, proxy: getOpenClawTokenProxyPort(), deferred: deferredRestartReason,
      workloads: getConfigRestartWorkloads() };
  },
  async snapshot() {
    const client = this.adapter()?.getGatewayClient();
    const result = client ? await client.request('config.get', {}) : null;
    const source = JSON.parse(require('node:fs').readFileSync(this.manager().getConfigPath(), 'utf8'));
    return { ...this.status(), sourcePlanUrl: source.models?.providers?.['lobsterai-server']?.baseUrl,
      snapshot: result ? { valid: result.valid, hash: result.hash, configRevisionHash: result.configRevisionHash, appliedConfigHash: result.appliedConfigHash } : null };
  },
  async rebind() {
    if (!qaProxyOptions) throw new Error('Original token proxy dependencies are not captured');
    const previous = getOpenClawTokenProxyPort();
    stopOpenClawTokenProxy();
    const result = await qaStartProxy(qaProxyOptions);
    this.events.push({ event: 'proxy-rebound', previous, next: result.port, time: Date.now() });
    return { previous, next: result.port };
  },
  inject(mode, count = 1) {
    const client = this.adapter()?.getGatewayClient();
    if (!client) throw new Error('Gateway client unavailable');
    if (!client.__qaOriginalRequest) {
      client.__qaOriginalRequest = client.request.bind(client);
      client.request = async (method, params, opts) => {
        if (method === 'config.apply') {
          const fault = this.fault;
          this.events.push({ event: method, time: Date.now(), mode: fault?.remaining > 0 ? fault.mode : 'real' });
          if (fault?.remaining > 0) {
            fault.remaining--;
            if (fault.mode === 'ack-unapplied') return { ok: true };
            if (fault.mode === 'rate-limit') throw Object.assign(new Error('control-plane rate limit'), { retryAfterMs: 45000 });
            if (fault.mode === 'invalid') return client.__qaOriginalRequest(method, { ...params, raw: '{"agents":{"defaults":{"notAConfigField":true}}}' }, opts);
            if (fault.mode === 'timeout-committed') {
              await client.__qaOriginalRequest(method, params, opts);
              throw new Error('config.apply request timed out (QA dropped response after real apply)');
            }
          }
        }
        return client.__qaOriginalRequest(method, params, opts);
      };
    }
    this.fault = mode ? { mode, remaining: count } : null;
    return this.fault;
  },
  async shutdown() {
    isQuitting = true;
    clearDeferredRestart();
    openClawRuntimeAdapter?.disconnectGatewayClient();
    await this.manager().stopGateway();
    stopOpenClawTokenProxy();
    require('electron').app.exit(0);
  },
};
