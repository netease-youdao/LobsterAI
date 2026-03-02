/**
 * NIM (NetEase IM) Gateway
 * Manages node-nim SDK V2 connection for receiving and sending messages
 * Adapted from openclaw-nim for Electron main process
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { app } from 'electron';
import {
  NimConfig,
  NimGatewayStatus,
  IMMessage,
  IMMediaAttachment,
  DEFAULT_NIM_STATUS,
} from './types';
import {
  downloadNimMedia,
  sendNimMediaMessage,
  inferMediaPlaceholder,
  cleanupOldNimMediaFiles,
} from './nimMedia';
import { parseMediaMarkers, stripMediaMarkers } from './dingtalkMediaParser';

// Message deduplication cache
const processedMessages = new Map<string, number>();
const MESSAGE_DEDUP_TTL = 5 * 60 * 1000; // 5 minutes

/** Maximum characters per text message */
const MAX_MESSAGE_LENGTH = 5000;

/**
 * NIM message type mapping from V2NIMMessageType enum
 */
type NimMessageType = 'text' | 'image' | 'audio' | 'video' | 'file' | 'geo' | 'notification' | 'custom' | 'tip' | 'robot' | 'unknown';

function convertMessageType(v2Type: number): NimMessageType {
  const typeMap: Record<number, NimMessageType> = {
    0: 'text',
    1: 'image',
    2: 'audio',
    3: 'video',
    4: 'geo',
    5: 'notification',
    6: 'file',
    10: 'tip',
    11: 'robot',
    100: 'custom',
  };
  return typeMap[v2Type] || 'unknown';
}

/**
 * Parse conversationId format: {appId}|{type}|{targetId}
 */
function parseConversationId(conversationId: string): { sessionType: 'p2p' | 'team' | 'superTeam'; targetId: string } {
  const parts = conversationId.split('|');
  if (parts.length >= 3) {
    const typeNum = parseInt(parts[1], 10);
    const sessionType = typeNum === 1 ? 'p2p' as const : typeNum === 2 ? 'team' as const : 'p2p' as const;
    return { sessionType, targetId: parts[2] };
  }
  return { sessionType: 'p2p', targetId: '' };
}

/**
 * Build conversationId using SDK utility or manual fallback
 */
function buildConversationId(conversationIdUtil: any, accountId: string, sessionType: 'p2p' | 'team' | 'superTeam' = 'p2p'): string {
  if (conversationIdUtil) {
    switch (sessionType) {
      case 'p2p':
        return conversationIdUtil.p2pConversationId(accountId) || '';
      case 'team':
        return conversationIdUtil.teamConversationId(accountId) || '';
      case 'superTeam':
        return conversationIdUtil.superTeamConversationId(accountId) || '';
      default:
        return conversationIdUtil.p2pConversationId(accountId) || '';
    }
  }
  // fallback: manual construction
  const typeNum = sessionType === 'p2p' ? 1 : sessionType === 'team' ? 2 : 3;
  return `0|${typeNum}|${accountId}`;
}

/**
 * Get SDK data directory
 */
function getSdkDataPath(account: string): string {
  let baseDir: string;
  try {
    baseDir = app.getPath('userData');
  } catch {
    baseDir = path.join(os.homedir(), '.lobsterai');
  }
  const dataDir = path.join(baseDir, 'nim-data', account);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

/**
 * Split long text into chunks
 */
function splitMessageIntoChunks(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

export class NimGateway extends EventEmitter {
  private v2Client: any = null;
  private loginService: any = null;
  private messageService: any = null;
  private messageCreator: any = null;
  private conversationIdUtil: any = null;
  private config: NimConfig | null = null;
  private status: NimGatewayStatus = { ...DEFAULT_NIM_STATUS };
  private onMessageCallback?: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>;
  private lastSenderId: string | null = null;
  private log: (...args: any[]) => void = () => {};
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_DELAY_MS = 30_000;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Bound callback references so we can properly remove them from SDK services.
   * Without these, each start/stop cycle leaks native event listeners, and
   * callbacks may fire on freed C++ objects → segfault.
   */
  private boundOnReceiveMessages: ((messages: any[]) => void) | null = null;
  private boundOnLoginStatus: ((status: number) => void) | null = null;
  private boundOnKickedOffline: ((detail: any) => void) | null = null;
  private boundOnLoginFailed: ((error: any) => void) | null = null;
  private boundOnDisconnected: ((error: any) => void) | null = null;

  /**
   * Lifecycle mutex: serializes start() and stop() calls so that rapid
   * toggle (ON → OFF → ON) never causes concurrent native SDK init/uninit.
   */
  private lifecyclePromise: Promise<void> = Promise.resolve();

  /**
   * Flag to indicate that a stop() has been requested (or is in-flight).
   * Used to suppress reconnect timers that were scheduled before stop() was called.
   */
  private stopRequested: boolean = false;

  constructor() {
    super();
  }

  /**
   * Get current gateway status
   */
  getStatus(): NimGatewayStatus {
    return { ...this.status };
  }

  /**
   * Check if gateway is connected
   */
  isConnected(): boolean {
    return this.status.connected;
  }

  /**
   * Update runtime config without restarting the gateway.
   * Used for hot-updating non-credential fields like accountWhitelist.
   */
  updateConfig(partial: Partial<NimConfig>): void {
    if (this.config) {
      this.config = { ...this.config, ...partial };
      this.log('[NIM Gateway] Config updated (hot):', Object.keys(partial).join(', '));
    }
  }

  /**
   * Public method for external reconnection triggers
   */
  reconnectIfNeeded(): void {
    if (this.stopRequested) return;
    if (this.config && (!this.v2Client || !this.status.connected)) {
      this.log('[NIM Gateway] External reconnection trigger');
      this.scheduleReconnect(0);
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   *
   * IMPORTANT: The reconnect callback goes through the public stop()/start()
   * methods which serialize via lifecyclePromise. It never calls uninit()
   * directly, preventing native SDK races.
   */
  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.config || this.stopRequested) {
      return;
    }
    const savedConfig = this.config;
    this.log(`[NIM Gateway] Scheduling reconnect in ${delayMs}ms (attempt ${this.reconnectAttempts + 1})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // Bail out if stop() was called while we were waiting
      if (!savedConfig || this.stopRequested) return;
      try {
        this.reconnectAttempts++;
        // Tear down the old session. We call stopInternal() directly here
        // (instead of the public stop()) because stop() sets stopRequested
        // which would prevent the subsequent start(). The lifecycle mutex
        // is already implicitly serialized by being inside a setTimeout.
        // However, we still need the mutex for safety against user-initiated
        // stop()/start() calls, so we use the public methods but temporarily
        // save and restore stopRequested.
        await this.stop();
        // stop() sets stopRequested=true to suppress further reconnects.
        // Since this IS the reconnect, we clear it to allow start().
        // But first, check if a user-initiated stop() raced with us:
        // if config was cleared, a user stop was intended → bail out.
        if (!this.config) return;
        this.stopRequested = false;
        await this.start(savedConfig);
      } catch (error: any) {
        console.error('[NIM Gateway] Reconnection attempt failed:', error.message);
        if (this.stopRequested) return;
        // Schedule next retry with exponential backoff
        const nextDelay = Math.min(
          (this.reconnectAttempts <= 1 ? 2000 : delayMs * 2),
          this.MAX_RECONNECT_DELAY_MS
        );
        this.scheduleReconnect(nextDelay);
      }
    }, delayMs);
  }

  /**
   * Set message callback
   */
  setMessageCallback(
    callback: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>
  ): void {
    this.onMessageCallback = callback;
  }

  /**
   * Start NIM gateway
   * @param config NIM configuration
   * @param options Additional start options
   * @param options.appDataPathOverride Override the SDK data path (useful for isolated probe instances)
   */
  async start(config: NimConfig, options?: { appDataPathOverride?: string }): Promise<void> {
    // Serialize with any in-flight start/stop operation so that rapid toggle
    // (ON → OFF → ON) never causes concurrent native SDK init/uninit.
    const previous = this.lifecyclePromise;
    let resolve!: () => void;
    this.lifecyclePromise = new Promise<void>(r => { resolve = r; });
    try {
      // Wait for previous operation to finish (ignore its errors)
      await previous.catch(() => {});
      // Clear stopRequested AFTER acquiring the mutex, so a concurrent
      // stop() that was still in-flight won't have its flag cleared early.
      this.stopRequested = false;
      await this.startInternal(config, options);
    } finally {
      resolve();
    }
  }

  /**
   * Internal start implementation (called under lifecycle mutex).
   */
  private async startInternal(config: NimConfig, options?: { appDataPathOverride?: string }): Promise<void> {
    if (this.v2Client) {
      throw new Error('NIM gateway already running');
    }
    // Always keep config for reconnection
    this.config = config;

    if (!config.enabled) {
      console.log('[NIM Gateway] NIM is disabled in config');
      return;
    }

    if (!config.appKey || !config.account || !config.token) {
      throw new Error('NIM appKey, account and token are required');
    }

    this.config = config;
    this.log = config.debug ? console.log.bind(console) : () => {};

    this.log('[NIM Gateway] Starting NIM gateway...');

    try {
      // Require node-nim SDK (use require in main process for native modules)
      const nodenim: any = require('node-nim');

      // Create V2 client
      this.v2Client = new nodenim.V2NIMClient();

      const dataPath = options?.appDataPathOverride || getSdkDataPath(config.account);

      // Initialize SDK
      const initError = this.v2Client.init({
        appkey: config.appKey,
        appDataPath: dataPath,
      });

      if (initError) {
        throw new Error(`NIM SDK V2 initialization failed: ${initError.desc || JSON.stringify(initError)}`);
      }

      this.log('[NIM Gateway] SDK initialized, dataPath:', dataPath);

      // Get services
      this.loginService = this.v2Client.getLoginService();
      this.messageService = this.v2Client.getMessageService();
      this.messageCreator = this.v2Client.messageCreator;
      this.conversationIdUtil = this.v2Client.conversationIdUtil;

      if (!this.loginService || !this.messageService) {
        throw new Error('NIM SDK V2 services not available');
      }

      // Create bound callbacks so we can remove them in stopInternal().
      // Each callback checks this.v2Client as a staleness guard: if uninit()
      // was called and cleanup() nulled the reference, the callback becomes
      // a harmless no-op instead of touching freed native memory.
      this.boundOnReceiveMessages = (messages: any[]) => {
        if (!this.v2Client) return; // stale callback guard
        this.log('[NIM Gateway] Received messages:', messages.length);
        for (const msg of messages) {
          this.handleIncomingMessage(msg);
        }
      };

      this.boundOnLoginStatus = (loginStatus: number) => {
        if (!this.v2Client) return; // stale callback guard
        this.log('[NIM Gateway] Login status changed:', loginStatus);
        // V2NIMLoginStatus: 0=LOGOUT, 1=LOGINED, 2=LOGINING
        if (loginStatus === 1) {
          this.reconnectAttempts = 0; // Reset backoff on success
          this.status.connected = true;
          this.status.lastError = null;
          this.status.startedAt = Date.now();
          this.status.botAccount = this.config?.account || null;
          this.log('[NIM Gateway] Login successful');
          this.emit('connected');
          this.emit('status');

          // 启动时清理旧媒体文件，并设置定期清理（每 24 小时）
          this.cleanupMediaFiles();
          if (!this.cleanupInterval) {
            this.cleanupInterval = setInterval(() => {
              this.cleanupMediaFiles();
            }, 24 * 60 * 60 * 1000);
          }
        } else if (loginStatus === 0) {
          this.status.connected = false;
          this.log('[NIM Gateway] Logged out');
          this.emit('disconnected');
          this.emit('status');
        } else if (loginStatus === 2) {
          this.log('[NIM Gateway] Logging in...');
        }
      };

      this.boundOnKickedOffline = (detail: any) => {
        if (!this.v2Client) return; // stale callback guard
        this.log('[NIM Gateway] Kicked offline:', detail);
        this.status.connected = false;
        this.status.lastError = 'Kicked offline';
        this.emit('error', new Error('Kicked offline'));
        this.emit('status');
        // Schedule reconnect after kicked offline
        this.scheduleReconnect(5000);
      };

      this.boundOnLoginFailed = (error: any) => {
        if (!this.v2Client) return; // stale callback guard
        this.log('[NIM Gateway] Login failed:', error);
        this.status.connected = false;
        this.status.lastError = `Login failed: ${error?.desc || JSON.stringify(error)}`;
        this.emit('error', new Error(this.status.lastError!));
        this.emit('status');
        // Schedule reconnect after login failure
        const delay = Math.min(
          this.reconnectAttempts <= 1 ? 3000 : 3000 * Math.pow(2, this.reconnectAttempts - 1),
          this.MAX_RECONNECT_DELAY_MS
        );
        this.scheduleReconnect(delay);
      };

      this.boundOnDisconnected = (error: any) => {
        if (!this.v2Client) return; // stale callback guard
        this.log('[NIM Gateway] Disconnected:', error);
        this.status.connected = false;
        this.status.lastError = 'Disconnected';
        this.emit('disconnected');
        this.emit('status');
        // Schedule reconnect after unexpected disconnect
        this.scheduleReconnect(3000);
      };

      // Register callbacks using bound references
      this.messageService.on('receiveMessages', this.boundOnReceiveMessages);
      this.loginService.on('loginStatus', this.boundOnLoginStatus);
      this.loginService.on('kickedOffline', this.boundOnKickedOffline);
      this.loginService.on('loginFailed', this.boundOnLoginFailed);
      this.loginService.on('disconnected', this.boundOnDisconnected);

      // Login (don't await - status will be updated via events)
      // But we need to catch potential rejections
      this.log('[NIM Gateway] Initiating login...', config.account);
      this.loginService.login(config.account, config.token, {})
        .catch((error: any) => {
          // Error code 191002 (operation cancelled) can be safely ignored as login will retry
          this.log('[NIM Gateway] Login promise rejected:', error?.code, error?.desc);
          // For non-cancellation errors, emit 'error' so that connectivity tests
          // (and any other listener) are notified even if the 'loginFailed' SDK
          // event does not fire for this particular rejection reason.
          if (error?.code !== 191002) {
            const desc = error?.desc || error?.message || `code ${error?.code}`;
            this.emit('error', new Error(`Login rejected: ${desc}`));
          }
        });

      // Initialize status (will be updated by loginStatus callback)
      // Note: do NOT reset config here – it was set at the top of start()
      this.status = {
        connected: false,
        startedAt: null,
        lastError: null,
        botAccount: config.account,
        lastInboundAt: null,
        lastOutboundAt: null,
      };

      this.log('[NIM Gateway] NIM gateway initialized, waiting for login status...');
    } catch (error: any) {
      const savedConfig = this.config; // Preserve config before cleanup
      this.cleanup();
      this.config = savedConfig; // Restore config so reconnect can work
      this.status = {
        connected: false,
        startedAt: null,
        lastError: error.message,
        botAccount: savedConfig?.account || null,
        lastInboundAt: null,
        lastOutboundAt: null,
      };
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop NIM gateway
   */
  async stop(): Promise<void> {
    // Mark stop as requested so any pending/future reconnect timers are
    // suppressed. This flag is cleared when start() is called again.
    this.stopRequested = true;

    // Serialize with any in-flight start/stop operation.
    const previous = this.lifecyclePromise;
    let resolve!: () => void;
    this.lifecyclePromise = new Promise<void>(r => { resolve = r; });
    try {
      await previous.catch(() => {});
      await this.stopInternal();
    } finally {
      resolve();
    }
  }

  /**
   * Internal stop implementation (called under lifecycle mutex).
   */
  private async stopInternal(): Promise<void> {
    // Cancel any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;

    if (!this.v2Client) {
      this.log('[NIM Gateway] Not running');
      return;
    }

    this.log('[NIM Gateway] Stopping NIM gateway...');

    // STEP 1: Remove event listeners BEFORE uninit() so that native threads
    // that fire callbacks during teardown find no JS listeners to invoke.
    // This is the key fix for the "more stop/start cycles → higher crash
    // probability" issue: without removal, stale callbacks accumulate and
    // may be invoked on freed native objects.
    try {
      if (this.messageService && this.boundOnReceiveMessages) {
        this.messageService.off('receiveMessages', this.boundOnReceiveMessages);
      }
      if (this.loginService) {
        if (this.boundOnLoginStatus) this.loginService.off('loginStatus', this.boundOnLoginStatus);
        if (this.boundOnKickedOffline) this.loginService.off('kickedOffline', this.boundOnKickedOffline);
        if (this.boundOnLoginFailed) this.loginService.off('loginFailed', this.boundOnLoginFailed);
        if (this.boundOnDisconnected) this.loginService.off('disconnected', this.boundOnDisconnected);
      }
    } catch (listenerErr: any) {
      console.warn('[NIM Gateway] Error removing listeners (ignored):', listenerErr?.message || listenerErr);
    }

    // Null out bound references so even if a late native callback somehow
    // still fires, the staleness guard (if (!this.v2Client) return) in
    // each callback will make it a no-op.
    this.boundOnReceiveMessages = null;
    this.boundOnLoginStatus = null;
    this.boundOnKickedOffline = null;
    this.boundOnLoginFailed = null;
    this.boundOnDisconnected = null;

    // STEP 2: Call uninit() to tear down the native SDK.
    try {
      if (this.v2Client) {
        this.log('[NIM Gateway] Calling uninit...');
        try {
          const error = this.v2Client.uninit();
          if (error) {
            this.log('[NIM Gateway] Uninit error:', error.code, error.desc);
          } else {
            this.log('[NIM Gateway] Uninit completed');
          }
        } catch (innerErr: any) {
          console.warn('[NIM Gateway] Uninit native exception (ignored):', innerErr?.message || innerErr);
        }
      }
    } catch (outerErr: any) {
      console.warn('[NIM Gateway] Uninit outer exception (ignored):', outerErr?.message || outerErr);
    }

    // STEP 3: Clean up JavaScript references immediately
    this.cleanup();
    
    // Update status
    this.status = {
      connected: false,
      startedAt: null,
      lastError: null,
      botAccount: this.status.botAccount,
      lastInboundAt: null,
      lastOutboundAt: null,
    };

    this.log('[NIM Gateway] NIM gateway stopped');
    this.emit('disconnected');
    
    // Wait for native SDK resources to be fully released before allowing
    // the next init(). 1000ms gives the C++ destructor and OS enough time
    // to tear down sockets, threads and memory-mapped files.
    // Increased from 500ms to 1000ms for extra safety on repeated cycles.
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  /**
   * Clean up internal references (does NOT clear config to allow reconnection)
   */
  private cleanup(): void {
    this.v2Client = null;
    this.loginService = null;
    this.messageService = null;
    this.messageCreator = null;
    this.conversationIdUtil = null;
    // Clean up media cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    // NOTE: intentionally NOT clearing this.config here so reconnectIfNeeded() can use it
  }

  /**
   * Check if message was already processed (deduplication)
   */
  private isMessageProcessed(messageId: string): boolean {
    this.cleanupProcessedMessages();
    if (processedMessages.has(messageId)) {
      return true;
    }
    processedMessages.set(messageId, Date.now());
    return false;
  }

  /**
   * Clean up expired messages from cache
   */
  private cleanupProcessedMessages(): void {
    const now = Date.now();
    processedMessages.forEach((timestamp, messageId) => {
      if (now - timestamp > MESSAGE_DEDUP_TTL) {
        processedMessages.delete(messageId);
      }
    });
  }

  /**
   * Parse V2 message attachment fields
   * 与 openclaw-nim/src/client.ts 的 parseV2Attachment 一致
   */
  private parseV2Attachment(msg: any): { url?: string; name?: string; size?: number; width?: number; height?: number; duration?: number } | undefined {
    const attachment = msg.attachment;
    if (!attachment) return undefined;

    return {
      url: attachment.url,
      name: attachment.name,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
      duration: attachment.duration,
    };
  }

  /**
   * Handle incoming V2 message from SDK
   * 支持 text、image、audio、video、file 消息类型
   */
  private async handleIncomingMessage(msg: any): Promise<void> {
    try {
      const msgId = String(msg.messageServerId || msg.messageClientId || '');
      const senderId = String(msg.senderId || '');

      // Ignore messages from self
      if (this.config && senderId === this.config.account) {
        this.log('[NIM Gateway] Ignoring self message');
        return;
      }

      // Whitelist filtering: if accountWhitelist is set, only process messages from whitelisted accounts
      if (this.config?.accountWhitelist) {
        const whitelist = this.config.accountWhitelist
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);

        if (whitelist.length > 0) {
          const whitelistSet = new Set(whitelist);
          if (!whitelistSet.has(senderId)) {
            this.log(`[NIM Gateway] Ignoring message from non-whitelisted account: ${senderId}`);
            return;
          }
        }
      }

      // Deduplication
      if (this.isMessageProcessed(msgId)) {
        this.log(`[NIM Gateway] Duplicate message ignored: ${msgId}`);
        return;
      }

      const msgType = convertMessageType(msg.messageType);

      // 支持的消息类型：text, image, audio, video, file
      const supportedTypes: NimMessageType[] = ['text', 'image', 'audio', 'video', 'file'];
      if (!supportedTypes.includes(msgType)) {
        this.log(`[NIM Gateway] Ignoring unsupported message type: ${msgType}`);
        return;
      }

      const { sessionType } = parseConversationId(msg.conversationId || '');

      // Only handle P2P messages
      if (sessionType !== 'p2p') {
        this.log(`[NIM Gateway] Ignoring non-p2p message, sessionType: ${sessionType}`);
        return;
      }

      // 构建消息内容和媒体附件
      let content = '';
      const attachments: IMMediaAttachment[] = [];

      if (msgType === 'text') {
        // 纯文本消息
        content = msg.text || '';
        if (!content.trim()) {
          this.log('[NIM Gateway] Ignoring empty text message');
          return;
        }
      } else if (['image', 'audio', 'video', 'file'].includes(msgType)) {
        // 媒体消息：生成占位符文本，附带 URL（与 openclaw-nim/src/bot.ts 一致）
        const attach = this.parseV2Attachment(msg);
        const placeholder = inferMediaPlaceholder(msgType);
        const attachUrl = attach?.url;
        content = attachUrl ? `${placeholder} ${attachUrl}` : placeholder;

        // 下载媒体文件
        if (attachUrl) {
          const nimMediaType = msgType as 'image' | 'audio' | 'video' | 'file';
          const downloaded = await downloadNimMedia(
            attachUrl,
            {
              name: attach?.name,
              size: attach?.size,
              width: attach?.width,
              height: attach?.height,
              duration: attach?.duration,
            },
            nimMediaType,
            this.log,
          );

          if (downloaded) {
            attachments.push(downloaded);
          }
        }
      }

      // Create IMMessage
      const message: IMMessage = {
        platform: 'nim',
        messageId: msgId,
        conversationId: msg.conversationId || senderId,
        senderId,
        content,
        chatType: 'direct',
        timestamp: msg.createTime || Date.now(),
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      this.status.lastInboundAt = Date.now();

      this.log('[NIM Gateway] 收到消息:', JSON.stringify({
        msgId,
        senderId,
        sessionType,
        msgType,
        content: content.substring(0, 100),
        conversationId: msg.conversationId,
        hasAttachments: attachments.length > 0,
      }, null, 2));

      // Create reply function with media support
      const replyFn = async (text: string) => {
        this.log('[NIM Gateway] 发送回复:', JSON.stringify({
          to: senderId,
          replyLength: text.length,
          reply: text.substring(0, 200),
        }, null, 2));

        await this.sendReplyWithMedia(senderId, text);
        this.status.lastOutboundAt = Date.now();
      };

      // Store last sender for notifications
      this.lastSenderId = senderId;

      // Emit message event
      this.emit('message', message);

      // Call message callback if set
      if (this.onMessageCallback) {
        try {
          await this.onMessageCallback(message, replyFn);
        } catch (error: any) {
          console.error(`[NIM Gateway] Error in message callback: ${error.message}`);
          await replyFn(`抱歉，处理消息时出现错误：${error.message}`);
        }
      }
    } catch (err: any) {
      console.error(`[NIM Gateway] Error handling incoming message: ${err.message}`);
    }
  }

  /**
   * Send a text message to a target account
   */
  private async sendText(to: string, text: string): Promise<void> {
    if (!this.messageService || !this.messageCreator) {
      throw new Error('NIM SDK not ready');
    }

    const message = this.messageCreator.createTextMessage(text);
    if (!message) {
      throw new Error('Failed to create text message');
    }

    const conversationId = buildConversationId(this.conversationIdUtil, to, 'p2p');
    this.log('[NIM Gateway] Sending text to:', conversationId, 'text:', text.substring(0, 50));

    const result = await this.messageService.sendMessage(message, conversationId, {}, () => {});
    this.log('[NIM Gateway] Send result:', result);
  }

  /**
   * Send long text with auto-splitting
   */
  private async sendLongText(to: string, text: string): Promise<void> {
    const chunks = splitMessageIntoChunks(text);

    for (const chunk of chunks) {
      await this.sendText(to, chunk);

      // Avoid sending too fast
      if (chunks.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Send a media file message to a target account
   */
  private async sendMedia(to: string, filePath: string): Promise<void> {
    if (!this.messageService || !this.messageCreator) {
      throw new Error('NIM SDK not ready');
    }

    const conversationId = buildConversationId(this.conversationIdUtil, to, 'p2p');
    await sendNimMediaMessage(
      this.messageService,
      this.messageCreator,
      conversationId,
      filePath,
      this.log,
    );
  }

  /**
   * Send reply with media marker parsing
   * 解析文本中的媒体标记（如 ![image](/path/to/img.png)），
   * 先发送纯文本部分，再逐个发送媒体文件。
   * 与 Telegram/DingTalk/Feishu Gateway 的 replyFn 行为一致。
   */
  private async sendReplyWithMedia(to: string, text: string): Promise<void> {
    // 1. 解析媒体标记
    const markers = parseMediaMarkers(text);

    if (markers.length === 0) {
      // 没有媒体标记，纯文本发送
      await this.sendLongText(to, text);
      return;
    }

    this.log(`[NIM Gateway] Found ${markers.length} media marker(s) in reply`);

    // 2. 先发送去除标记后的文本（如果有）
    const strippedText = stripMediaMarkers(text, markers);
    if (strippedText.trim()) {
      await this.sendLongText(to, strippedText);
      // 文本和第一个媒体之间的间隔
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 3. 逐个发送媒体文件
    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];

      try {
        // 检查文件是否存在
        if (!fs.existsSync(marker.path)) {
          this.log(`[NIM Gateway] Media file not found: ${marker.path}`);
          continue;
        }

        await this.sendMedia(to, marker.path);
        this.log(`[NIM Gateway] Sent media: ${marker.type} ${marker.path}`);
      } catch (error: any) {
        console.error(`[NIM Gateway] Failed to send media ${marker.path}: ${error.message}`);
      }

      // 媒体之间的间隔
      if (i < markers.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Get the current notification target for persistence.
   */
  getNotificationTarget(): string | null {
    return this.lastSenderId;
  }

  /**
   * Restore notification target from persisted state.
   */
  setNotificationTarget(senderId: string): void {
    this.lastSenderId = senderId;
  }

  /**
   * Send a notification message to the last known sender
   */
  async sendNotification(text: string): Promise<void> {
    if (!this.lastSenderId || !this.messageService) {
      throw new Error('No conversation available for notification');
    }
    await this.sendLongText(this.lastSenderId, text);
    this.status.lastOutboundAt = Date.now();
  }

  /**
   * Send a notification message with media support to the last known sender
   */
  async sendNotificationWithMedia(text: string): Promise<void> {
    if (!this.lastSenderId || !this.messageService) {
      throw new Error('No conversation available for notification');
    }
    await this.sendReplyWithMedia(this.lastSenderId, text);
    this.status.lastOutboundAt = Date.now();
  }

  /**
   * Clean up downloaded media files (called periodically)
   */
  cleanupMediaFiles(): void {
    try {
      cleanupOldNimMediaFiles();
    } catch (error: any) {
      this.log('[NIM Gateway] Media cleanup error:', error.message);
    }
  }
}
