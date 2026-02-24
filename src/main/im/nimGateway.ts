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
  DEFAULT_NIM_STATUS,
} from './types';

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
   * Public method for external reconnection triggers
   */
  reconnectIfNeeded(): void {
    if (this.config && (!this.v2Client || !this.status.connected)) {
      this.log('[NIM Gateway] External reconnection trigger');
      this.scheduleReconnect(0);
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.config) {
      return;
    }
    const savedConfig = this.config;
    this.log(`[NIM Gateway] Scheduling reconnect in ${delayMs}ms (attempt ${this.reconnectAttempts + 1})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!savedConfig) return;
      try {
        // Reset v2Client if still hanging
        if (this.v2Client) {
          try {
            this.v2Client.uninit();
          } catch (_) { /* ignore */ }
          this.v2Client = null;
          this.loginService = null;
          this.messageService = null;
          this.messageCreator = null;
          this.conversationIdUtil = null;
        }
        this.reconnectAttempts++;
        await this.start(savedConfig);
        // start() sets this.config = savedConfig internally, so we're fine
      } catch (error: any) {
        console.error('[NIM Gateway] Reconnection attempt failed:', error.message);
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
   */
  async start(config: NimConfig): Promise<void> {
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

      const dataPath = getSdkDataPath(config.account);

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

      // Register message receive callback
      this.messageService.on('receiveMessages', (messages: any[]) => {
        this.log('[NIM Gateway] Received messages:', messages.length);
        for (const msg of messages) {
          this.handleIncomingMessage(msg);
        }
      });

      // Register login status callback
      this.loginService.on('loginStatus', (loginStatus: number) => {
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
        } else if (loginStatus === 0) {
          this.status.connected = false;
          this.log('[NIM Gateway] Logged out');
          this.emit('disconnected');
          this.emit('status');
        } else if (loginStatus === 2) {
          this.log('[NIM Gateway] Logging in...');
        }
      });

      this.loginService.on('kickedOffline', (detail: any) => {
        this.log('[NIM Gateway] Kicked offline:', detail);
        this.status.connected = false;
        this.status.lastError = 'Kicked offline';
        this.emit('error', new Error('Kicked offline'));
        this.emit('status');
        // Schedule reconnect after kicked offline
        this.scheduleReconnect(5000);
      });

      this.loginService.on('loginFailed', (error: any) => {
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
      });

      this.loginService.on('disconnected', (error: any) => {
        this.log('[NIM Gateway] Disconnected:', error);
        this.status.connected = false;
        this.status.lastError = 'Disconnected';
        this.emit('disconnected');
        this.emit('status');
        // Schedule reconnect after unexpected disconnect
        this.scheduleReconnect(3000);
      });

      // Login (don't await - status will be updated via events)
      // But we need to catch potential rejections
      this.log('[NIM Gateway] Initiating login...', config.account);
      this.loginService.login(config.account, config.token, {})
        .catch((error: any) => {
          // Login errors will be handled by 'loginFailed' event listener
          // This catch is just to prevent Unhandled Rejection
          // Error code 191002 (operation cancelled) can be safely ignored as login will retry
          this.log('[NIM Gateway] Login promise rejected (will retry via events):', error?.code, error?.desc);
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

    // CRITICAL: Directly uninit without any delay or listener removal
    // This is the safest approach to avoid race conditions with native callbacks
    try {
      if (this.v2Client) {
        this.log('[NIM Gateway] Calling uninit immediately...');
        const error = this.v2Client.uninit();
        if (error) {
          this.log('[NIM Gateway] Uninit error:', error.code, error.desc);
        } else {
          this.log('[NIM Gateway] Uninit completed');
        }
      }
    } catch (error: any) {
      this.log('[NIM Gateway] Uninit exception:', error?.message || error);
    }

    // Clean up JavaScript references immediately
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
    
    // Wait a bit for native cleanup before allowing restart
    // This delay is AFTER cleanup to prevent blocking the UI
    await new Promise(resolve => setTimeout(resolve, 300));
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
   * Handle incoming V2 message from SDK
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

      // Deduplication
      if (this.isMessageProcessed(msgId)) {
        this.log(`[NIM Gateway] Duplicate message ignored: ${msgId}`);
        return;
      }

      const msgType = convertMessageType(msg.messageType);

      // Only handle text messages for now
      if (msgType !== 'text') {
        this.log(`[NIM Gateway] Ignoring non-text message type: ${msgType}`);
        return;
      }

      const { sessionType } = parseConversationId(msg.conversationId || '');

      // Only handle P2P messages
      if (sessionType !== 'p2p') {
        this.log(`[NIM Gateway] Ignoring non-p2p message, sessionType: ${sessionType}`);
        return;
      }

      const content = msg.text || '';
      if (!content.trim()) {
        this.log('[NIM Gateway] Ignoring empty message');
        return;
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
      };

      this.status.lastInboundAt = Date.now();

      this.log('[NIM Gateway] 收到消息:', JSON.stringify({
        msgId,
        senderId,
        sessionType,
        msgType,
        content: content.substring(0, 100),
        conversationId: msg.conversationId,
      }, null, 2));

      // Create reply function
      const replyFn = async (text: string) => {
        this.log('[NIM Gateway] 发送回复:', JSON.stringify({
          to: senderId,
          replyLength: text.length,
          reply: text.substring(0, 200),
        }, null, 2));

        await this.sendLongText(senderId, text);
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
   * Send a notification message to the last known sender
   */
  async sendNotification(text: string): Promise<void> {
    if (!this.lastSenderId || !this.messageService) {
      throw new Error('No conversation available for notification');
    }
    await this.sendLongText(this.lastSenderId, text);
    this.status.lastOutboundAt = Date.now();
  }
}
