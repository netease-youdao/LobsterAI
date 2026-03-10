/**
 * NIM QChat Client
 * Manages QChat (Circle Groups / 圈组) subscriptions for receiving and sending messages
 * Adapted from openclaw-nim/src/qchat-client.ts for Electron main process
 */

/**
 * QChat message payload from SDK (supports both camelCase and snake_case variants)
 */
export interface QChatMessagePayload {
  serverId?: string;
  channelId?: string;
  fromAccount?: string;
  fromNick?: string;
  body?: string;
  type?: string;
  msgIdServer?: string;
  time?: number;
  mentionAll?: boolean;
  mentionAccids?: string[];
  // Snake_case variants from SDK
  server_id?: string;
  channel_id?: string;
  from_accid?: string;
  from_nick?: string;
  msg_body?: string;
  msg_type?: number | string;
  msg_server_id?: string;
  timestamp?: number;
  mention_all?: boolean;
  mention_accids?: string[];
}

/**
 * Parsed QChat inbound message
 */
export interface QChatInboundMessage {
  messageId: string;
  serverId: string;
  channelId: string;
  senderAccid: string;
  senderNick?: string;
  text: string;
  timestamp: number;
  wasMentioned: boolean;
}

/**
 * QChat client options
 */
export interface QChatClientOptions {
  account: string;
  serverIds?: string[];
  onMessage?: (msg: QChatInboundMessage) => void | Promise<void>;
  onError?: (error: Error) => void;
  log?: (...args: any[]) => void;
}

/**
 * NIM QChat Client
 *
 * Two-phase lifecycle:
 *   1. initListeners() — register passive event handlers (call AFTER IM init, BEFORE login)
 *   2. activate()      — discover servers & subscribe (call AFTER IM login succeeds)
 */
export class NimQChatClient {
  private nim: any = null;
  private opts: QChatClientOptions;
  private subscribedServerIds: string[] = [];
  private listenersInitialized = false;
  private activated = false;

  constructor(opts: QChatClientOptions) {
    this.opts = opts;
  }

  /**
   * Set the NIM SDK instance to use (reuse existing V2NIM instance)
   * Must be called before initListeners()
   */
  setNim(nim: any): void {
    this.nim = nim;
  }

  get account(): string {
    return this.opts.account;
  }

  get isListening(): boolean {
    return this.listenersInitialized;
  }

  get isActivated(): boolean {
    return this.activated;
  }

  /**
   * Normalize message fields (handle both camelCase and snake_case variants)
   */
  private normalizeMessage(msg: QChatMessagePayload): QChatMessagePayload {
    return {
      ...msg,
      serverId: msg.serverId ?? msg.server_id,
      channelId: msg.channelId ?? msg.channel_id,
      fromAccount: msg.fromAccount ?? msg.from_accid,
      fromNick: msg.fromNick ?? msg.from_nick,
      body: msg.body ?? msg.msg_body,
      type: msg.type ?? (typeof msg.msg_type === 'string' ? msg.msg_type : undefined),
      msgIdServer: msg.msgIdServer ?? msg.msg_server_id,
      time: msg.time ?? msg.timestamp,
      mentionAll: msg.mentionAll ?? msg.mention_all,
      mentionAccids: msg.mentionAccids ?? msg.mention_accids,
    };
  }

  /**
   * Parse QChat message and detect @-mention
   */
  parseMessage(msg: QChatMessagePayload): QChatInboundMessage | null {
    const normalized = this.normalizeMessage(msg);

    const messageType = normalized.type;
    // Only support text messages for now
    const legacyType = typeof msg.msg_type === 'number' ? msg.msg_type : undefined;
    if (messageType && messageType !== 'text') return null;
    if (legacyType !== undefined && legacyType !== 0) return null;

    const serverId = normalized.serverId || '';
    const channelId = normalized.channelId || '';
    const senderAccid = normalized.fromAccount || '';
    const text = normalized.body || '';

    if (!serverId || !channelId || !senderAccid || !text.trim()) return null;

    // Detect @-mention: either @all or bot's account is in the list
    const mentionAll = normalized.mentionAll === true;
    const mentionAccids = normalized.mentionAccids ?? [];
    const wasMentioned = mentionAll || mentionAccids.includes(this.opts.account);

    return {
      messageId: normalized.msgIdServer ?? `${Date.now()}`,
      serverId,
      channelId,
      senderAccid,
      senderNick: normalized.fromNick,
      text: text.trim(),
      timestamp: normalized.time ?? Date.now(),
      wasMentioned,
    };
  }

  /**
   * Phase 1 — Register passive event handlers.
   * Call this AFTER V2NIM init but BEFORE login.
   * Only registers listeners; makes NO outgoing API calls.
   */
  async initListeners(): Promise<void> {
    if (this.listenersInitialized) return;
    const log = this.opts.log ?? console.log;

    if (!this.nim) {
      throw new Error('QChatClient requires NIM instance - call setNim() first');
    }

    // Message listener
    this.nim.qchatMsg?.on('message', (msg: QChatMessagePayload) => {
      const parsed = this.parseMessage(msg);
      if (parsed) {
        this.opts.onMessage?.(parsed);
      }
    });

    // System notification for auto-subscribing new servers
    this.nim.qchatMsg?.on('systemNotification', (notification: any) => {
      const type = notification.type ?? notification.msg_type;
      const serverId = notification.serverId ?? notification.server_id;

      // Handle server invite completion (type 8 or 'serverMemberInviteDone')
      if ((type === 'serverMemberInviteDone' || type === 8) && serverId) {
        if (!this.subscribedServerIds.includes(serverId) && this.activated) {
          log('[QChat] Auto-subscribing to new server:', serverId);
          this.subscribeServer(serverId).catch(err => {
            log('[QChat] Auto-subscribe failed:', err.message || err);
          });
        }
      }
    });

    this.listenersInitialized = true;
    log('[QChat] Listeners initialized');
  }

  /**
   * Phase 2 — Discover servers and subscribe to channels.
   * Call this AFTER IM login succeeds.
   * Makes active API calls (getServersByPage, subscribeAllChannel).
   */
  async activate(): Promise<void> {
    if (this.activated) return;
    if (!this.listenersInitialized) {
      await this.initListeners();
    }

    const log = this.opts.log ?? console.log;
    let serverIds = this.opts.serverIds ?? [];

    if (serverIds.length === 0) {
      log('[QChat] No servers configured, discovering joined servers...');
      serverIds = await this.discoverJoinedServers();
      log(`[QChat] Discovered ${serverIds.length} servers`);
    }

    if (serverIds.length === 0) {
      log('[QChat] No servers found, waiting for invites');
      this.activated = true;
      return;
    }

    // Subscribe to ALL channels in each server
    try {
      const resp = await this.nim.qchatServer.subscribeAllChannel({
        type: 1, // kNIMQChatSubscribeTypeMsg
        serverIds,
      });

      const failedServers = resp.failServerIds ?? [];
      if (failedServers.length > 0) {
        log('[QChat] Subscribe failed for servers:', failedServers.join(', '));
      }

      this.subscribedServerIds = serverIds.filter(id => !failedServers.includes(id));
      log(`[QChat] Subscribed to ${this.subscribedServerIds.length} servers:`, this.subscribedServerIds.join(', '));
    } catch (err: any) {
      log('[QChat] Subscribe error:', err.message || err);
    }

    this.activated = true;
  }

  /**
   * Auto-discover joined servers by paginating through getServersByPage
   */
  private async discoverJoinedServers(): Promise<string[]> {
    const serverIds: string[] = [];
    let timestamp = 0;
    const PAGE_LIMIT = 100;

    for (let page = 0; page < 20; page++) {
      try {
        const resp = await this.nim.qchatServer.getServersByPage({
          timestamp,
          limit: PAGE_LIMIT,
        });

        const servers = resp.datas ?? [];
        if (servers.length === 0) break;

        for (const s of servers) {
          if (s.serverId) serverIds.push(s.serverId);
        }

        const hasMore = resp.listQueryTag?.hasMore ?? servers.length >= PAGE_LIMIT;
        if (!hasMore) break;

        const lastServer = servers[servers.length - 1];
        if (lastServer.createTime) {
          timestamp = lastServer.createTime;
        } else {
          break;
        }
      } catch (err: any) {
        console.error('[QChat] discoverJoinedServers error:', err.message || err);
        break;
      }
    }

    return serverIds;
  }

  /**
   * Subscribe to a single server (used for dynamic subscription)
   */
  private async subscribeServer(serverId: string): Promise<void> {
    const log = this.opts.log ?? console.log;

    try {
      const resp = await this.nim.qchatServer.subscribeAllChannel({
        type: 1,
        serverIds: [serverId],
      });

      const failed = resp.failServerIds ?? [];
      if (!failed.includes(serverId)) {
        this.subscribedServerIds.push(serverId);
        log(`[QChat] Subscribed to server: ${serverId}, total: ${this.subscribedServerIds.length}`);
      }
    } catch (err: any) {
      log('[QChat] subscribeServer error:', err.message || err);
    }
  }

  /**
   * Send a text message to a QChat channel
   */
  async sendText(
    serverId: string,
    channelId: string,
    text: string
  ): Promise<{ ok: boolean; msgServerId?: string; error?: string }> {
    const log = this.opts.log ?? console.log;

    try {
      const resp = await this.nim.qchatMsg.sendMessage({
        serverId,
        channelId,
        type: 'text',
        body: text,
      });

      log(`[QChat] Message sent to ${serverId}:${channelId}`);
      return {
        ok: true,
        msgServerId: resp.message?.msgIdServer ?? resp.msgIdServer,
      };
    } catch (err: any) {
      return {
        ok: false,
        error: err.message || String(err),
      };
    }
  }

  /**
   * Stop and clean up QChat subscriptions
   */
  async stop(): Promise<void> {
    if (!this.activated) return;

    const log = this.opts.log ?? console.log;

    // Unsubscribe from all servers
    if (this.subscribedServerIds.length > 0) {
      try {
        await this.nim.qchatServer.subscribeAllChannel({
          type: 1,
          serverIds: [], // empty = unsubscribe all
        });
        log('[QChat] Unsubscribed from all servers');
      } catch {
        // Ignore unsubscribe errors during shutdown
      }
    }

    this.activated = false;
    this.subscribedServerIds = [];
    log('[QChat] Stopped');
  }
}
