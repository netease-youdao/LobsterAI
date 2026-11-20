/**
 * Base driver contract for `@lobsterai/dsh-channels`.
 * Every platform driver is pure ESM using Node 24's built-in `fetch` and
 * `WebSocket` (zero native bindings, zero OpenClaw SDK imports).
 */

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
   * }} options
   */
  constructor(options) {
    this.platform = options.platform;
    this.instanceId = options.instanceId;
    this.config = options.config || {};
    this.onInbound = options.onInbound;
    this.onStatus = options.onStatus;
    this.abortController = null;
    this.state = 'stopped';
    this.lastError = null;
    this.botInfo = null;
  }

  setState(state, error = null, botInfo = undefined) {
    this.state = state;
    this.lastError = error;
    if (botInfo !== undefined) this.botInfo = botInfo;
    this.onStatus?.({ state: this.state, error: this.lastError, botInfo: this.botInfo });
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
    };
  }

  async start() {
    if (this.abortController) return;
    this.abortController = new AbortController();
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
