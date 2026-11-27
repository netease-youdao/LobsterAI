/**
 * Base driver contract for `@lobsterai/dsh-channels`.
 * Platform drivers use Node's HTTP and WebSocket clients without native
 * bindings or OpenClaw SDK imports.
 */

let nextStartupAttempt = 0;

export class BaseChannelDriver {
  /**
   * @param {{
   *   platform: string,
   *   instanceId: string,
   *   config: Record<string, unknown>,
   *   onInbound: (msg: {
   *     platform: string,
   *     instanceId: string,
   *     chatId: string,
   *     senderId: string,
   *     senderName?: string,
   *     text: string,
   *     messageId?: string,
   *     chatType?: 'direct' | 'group',
   *     replyContext?: Record<string, unknown>,
   *   }) => Promise<void>,
   *   onStatus?: (status: { state: string, error?: string | null, botInfo?: Record<string, unknown> }) => void,
   *   logStartup?: (message: string) => void,
   * }} options
   */
  constructor(options) {
    this.platform = options.platform;
    this.instanceId = options.instanceId;
    this.config = options.config || {};
    this.onInbound = options.onInbound;
    this.onStatus = options.onStatus;
    this.logStartup = options.logStartup;
    this.startup = null;
    this.abortController = null;
    this.state = 'stopped';
    this.lastError = null;
    this.botInfo = null;
    this.startedAt = null;
    this.lastInboundAt = null;
    this.lastOutboundAt = null;
  }

  // Only record first-connect milestones. A driver may retry before it is
  // ready and may report 'connected' again on later polls or reconnects.
  markStartupStage(stage, outcome) {
    if (!this.startup || this.startup.seen.has(stage)) return;
    const { attempt, since, seen } = this.startup;
    seen.add(stage);
    const elapsedMs = Math.round(performance.now() - since);
    this.logStartup(
      `[DshStartup] pid=${process.pid} platform=${this.platform} attempt=${attempt} stage=${stage} elapsedMs=${elapsedMs}`
      + (outcome ? ` outcome=${outcome}` : ''),
    );
  }

  setState(state, error = null, botInfo = undefined) {
    this.state = state;
    this.lastError = error;
    this.markStartupStage(state);
    if (state === 'connected' || state === 'stopped') this.startup = null;
    if (botInfo !== undefined) this.botInfo = botInfo;
    if (state === 'connected' && this.startedAt === null) {
      this.startedAt = Date.now();
    } else if (state === 'stopped') {
      this.startedAt = null;
    }
    this.onStatus?.({
      state: this.state,
      error: this.lastError,
      botInfo: this.botInfo,
      startedAt: this.startedAt,
      lastInboundAt: this.lastInboundAt,
      lastOutboundAt: this.lastOutboundAt,
    });
  }

  markInbound() {
    this.lastInboundAt = Date.now();
    this.onStatus?.({
      state: this.state,
      error: this.lastError,
      botInfo: this.botInfo,
      startedAt: this.startedAt,
      lastInboundAt: this.lastInboundAt,
      lastOutboundAt: this.lastOutboundAt,
    });
  }

  markOutbound() {
    this.lastOutboundAt = Date.now();
    this.onStatus?.({
      state: this.state,
      error: this.lastError,
      botInfo: this.botInfo,
      startedAt: this.startedAt,
      lastInboundAt: this.lastInboundAt,
      lastOutboundAt: this.lastOutboundAt,
    });
  }

  isSenderAllowed(senderId) {
    const allowFrom = this.config.allowFrom;
    if (!Array.isArray(allowFrom) || allowFrom.length === 0) return true;
    const normalized = String(senderId || '').trim();
    return allowFrom.some((entry) => {
      const rule = String(entry || '').trim();
      return rule === '*' || rule === normalized;
    });
  }

  getStatus() {
    return {
      platform: this.platform,
      instanceId: this.instanceId,
      state: this.state,
      error: this.lastError,
      botInfo: this.botInfo,
      startedAt: this.startedAt,
      lastInboundAt: this.lastInboundAt,
      lastOutboundAt: this.lastOutboundAt,
    };
  }

  async start() {
    if (this.abortController) return;
    this.abortController = new AbortController();
    if (this.logStartup) {
      this.startup = { attempt: ++nextStartupAttempt, since: performance.now(), seen: new Set() };
    }
    this.setState('connecting', null);
    try {
      await this.connect(this.abortController.signal);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.setState('error', msg);
      throw error;
    }
  }

  async stop() {
    const ac = this.abortController;
    this.abortController = null;
    if (ac) ac.abort(new Error('Driver stopped'));
    try {
      await this.disconnect();
    } finally {
      this.setState('stopped', null);
    }
  }

  /** @param {AbortSignal} _signal */
  async connect(_signal) {
    throw new Error(`${this.platform}: connect() not implemented`);
  }

  async disconnect() {}

  /**
   * @param {{ chatId: string, text: string, replyContext?: Record<string, unknown> }} _payload
   */
  async sendMessage(_payload) {
    throw new Error(`${this.platform}: sendMessage() not implemented`);
  }
}

export function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
