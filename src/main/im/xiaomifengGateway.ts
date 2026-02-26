/**
 * Xiaomifeng Gateway (小蜜蜂)
 * Manages node-nim SDK V2 connection for receiving messages
 * Sends messages via HTTP API
 * 
 * Based on NIM Gateway, adapted for Xiaomifeng's custom message format (type 100)
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { app } from 'electron';
import {
  XiaomifengConfig,
  XiaomifengGatewayStatus,
  IMMessage,
  DEFAULT_XIAOMIFENG_STATUS,
} from './types';

// ==================== Constants ====================

/** Message deduplication cache: messageId -> timestamp */
const processedMessages = new Map<string, number>();

/** Message deduplication TTL (5 minutes) */
const MESSAGE_DEDUP_TTL = 5 * 60 * 1000;

/** Maximum message length for Xiaomifeng HTTP API */
const MAX_MESSAGE_LENGTH = 1500;

/** Initial reconnect delay */
const INITIAL_RECONNECT_DELAY_MS = 3000;

/** Maximum reconnect delay (30 seconds) */
const MAX_RECONNECT_DELAY_MS = 30_000;

/** State persistence file name */
const STATE_FILE_NAME = 'xiaomifeng-state.json';

/** SDK Data directory name */
const SDK_DATA_DIR = 'xiaomifeng-nim-data';

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

    // Try to split at newline first
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      // Try to split at space
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      // Force split at maxLength
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

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
 * Get SDK data directory
 */
function getSdkDataPath(account: string): string {
  let baseDir: string;
  try {
    baseDir = app.getPath('userData');
  } catch {
    baseDir = path.join(os.homedir(), '.lobsterai');
  }
  const dataDir = path.join(baseDir, SDK_DATA_DIR, account);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

/**
 * Safely parse JSON with fallback
 */
function safeParseJSON<T>(input: string | object, fallback: T): T {
  if (typeof input === 'object') return input as T;
  try {
    return JSON.parse(input);
  } catch {
    return fallback;
  }
}

/**
 * Create default gateway status
 */
function createDefaultStatus(botAccount: string | null = null): XiaomifengGatewayStatus {
  return {
    connected: false,
    startedAt: null,
    lastError: null,
    botAccount,
    lastInboundAt: null,
    lastOutboundAt: null,
  };
}

export class XiaomifengGateway extends EventEmitter {
  // 写死的配置常量
  private static readonly FIXED_APP_KEY = '1c114416fb93ec4d5489e885a64eb6c5';
  private static readonly FIXED_HTTP_FROM = 'youdaoClaw';
  
  // HTTP API URLs
  private static readonly BEE_TOKEN_API_URL = 'http://api.mifengs.com/worklife-go/api/v1/claw/im/oauth2/accessToken';
  private static readonly BEE_HTTP_API_URL = 'http://api.mifengs.com/worklife-go/api/v1/claw/im/send';

  // Access Token 缓存（类似钉钉，2小时过期）
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  // node-nim SDK references (like NIM Gateway)
  private v2Client: any = null;
  private loginService: any = null;
  private messageService: any = null;

  private config: XiaomifengConfig | null = null;
  private status: XiaomifengGatewayStatus = { ...DEFAULT_XIAOMIFENG_STATUS };
  private onMessageCallback?: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>;
  private log: (...args: any[]) => void = () => {};

  // 保存最后会话信息用于通知发送
  private lastConversation: {
    senderId: string;
    conversationId: string;
    beeChatId?: string;
  } | null = null;

  // 重连机制
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts: number = 0;
  
  // 是否因为被踢下线而不再重连
  private kickedByOtherClient: boolean = false;
  
  // 持久化：最后处理的消息时间戳（防止重启后重复处理历史消息）
  private lastProcessedTimestamp: number = 0;
  private stateFilePath: string = '';

  constructor() {
    super();
    this.initStatePersistence();
  }

  /**
   * Initialize state persistence
   */
  private initStatePersistence(): void {
    try {
      const userDataPath = app.getPath('userData');
      this.stateFilePath = path.join(userDataPath, STATE_FILE_NAME);
      this.loadPersistedState();
    } catch {
      // app 可能还未初始化
      console.warn('[Xiaomifeng Gateway] Could not get userData path, state will not be persisted');
    }
  }

  /**
   * Load persisted state from disk
   */
  private loadPersistedState(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const data = fs.readFileSync(this.stateFilePath, 'utf8');
        const state = JSON.parse(data);
        this.lastProcessedTimestamp = state.lastProcessedTimestamp || 0;
        console.log('[Xiaomifeng Gateway] Loaded persisted state, lastProcessedTimestamp:', this.lastProcessedTimestamp);
      }
    } catch (error: any) {
      console.warn('[Xiaomifeng Gateway] Failed to load persisted state:', error.message);
    }
  }

  /**
   * Save persisted state to disk
   */
  private savePersistedState(): void {
    try {
      if (!this.stateFilePath) return;
      const state = {
        lastProcessedTimestamp: this.lastProcessedTimestamp,
        savedAt: Date.now(),
      };
      fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (error: any) {
      console.warn('[Xiaomifeng Gateway] Failed to save persisted state:', error.message);
    }
  }

  /**
   * Get current gateway status
   */
  getStatus(): XiaomifengGatewayStatus {
    return { ...this.status };
  }

  /**
   * Check if gateway is connected
   */
  isConnected(): boolean {
    return this.status.connected;
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
   * Public method for external reconnection triggers (e.g., network events)
   */
  reconnectIfNeeded(): void {
    // 如果是被踢下线，不自动重连
    if (this.kickedByOtherClient) {
      this.log('[Xiaomifeng Gateway] Skipping reconnection - account logged in elsewhere');
      return;
    }
    if (this.config && (!this.v2Client || !this.status.connected)) {
      this.log('[Xiaomifeng Gateway] External reconnection trigger');
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
    // 如果是被踢下线，不自动重连
    if (this.kickedByOtherClient) {
      this.log('[Xiaomifeng Gateway] Skipping reconnection - account logged in elsewhere');
      return;
    }
    const savedConfig = this.config;
    this.log(`[Xiaomifeng Gateway] Scheduling reconnect in ${delayMs}ms (attempt ${this.reconnectAttempts + 1})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!savedConfig) return;
      try {
        if (this.v2Client) {
          try {
            this.v2Client.uninit();
          } catch (_) { /* ignore */ }
          this.v2Client = null;
          this.loginService = null;
          this.messageService = null;
        }
        this.reconnectAttempts++;
        await this.start(savedConfig);
      } catch (error: any) {
        console.error('[Xiaomifeng Gateway] Reconnection attempt failed:', error.message);
        const nextDelay = Math.min(
          (this.reconnectAttempts <= 1 ? 2000 : delayMs * 2),
          MAX_RECONNECT_DELAY_MS
        );
        this.scheduleReconnect(nextDelay);
      }
    }, delayMs);
  }

  /**
   * Start Xiaomifeng gateway using node-nim SDK
   */
  async start(config: XiaomifengConfig): Promise<void> {
    if (this.v2Client) {
      throw new Error('Xiaomifeng gateway already running');
    }
    this.config = config;
    
    // 重置被踢下线状态，允许手动重新启动
    this.kickedByOtherClient = false;

    if (!config.enabled) {
      console.log('[Xiaomifeng Gateway] Xiaomifeng is disabled in config');
      return;
    }

    if (!config.clientId || !config.secret) {
      throw new Error('Xiaomifeng clientId 和 secret 必填');
    }

    this.log = config.debug ? console.log.bind(console) : () => {};
    console.log('[Xiaomifeng Gateway] Starting with node-nim SDK...');
    console.log('[Xiaomifeng Gateway] Using fixed appKey:', XiaomifengGateway.FIXED_APP_KEY);
    //console.log('[Xiaomifeng Gateway] Will skip messages older than:', new Date(this.lastProcessedTimestamp).toISOString());
    console.log('[Xiaomifeng Gateway] config.debug =', config.debug);

    try {
      // Require node-nim SDK (native module)
      let nodenim: any;
      try {
        console.log('[Xiaomifeng Gateway] About to require node-nim...');
        console.log('[Xiaomifeng Gateway] process.platform:', process.platform);
        console.log('[Xiaomifeng Gateway] process.arch:', process.arch);
        console.log('[Xiaomifeng Gateway] __dirname:', __dirname);
        
        // 检查是否已经有其他地方加载了 node-nim
        const cachedModule = require.cache[require.resolve('node-nim')];
        if (cachedModule) {
          console.log('[Xiaomifeng Gateway] node-nim already in require cache');
          nodenim = cachedModule.exports;
        } else {
          console.log('[Xiaomifeng Gateway] Loading node-nim fresh...');
          nodenim = require('node-nim');
        }
        console.log('[Xiaomifeng Gateway] node-nim SDK loaded successfully');
      } catch (loadError: any) {
        console.error('[Xiaomifeng Gateway] Failed to load node-nim SDK:', loadError.message);
        console.error('[Xiaomifeng Gateway] Load error stack:', loadError.stack);
        throw new Error(`Failed to load node-nim SDK: ${loadError.message}`);
      }

      // Create V2 client
      this.v2Client = new nodenim.V2NIMClient();
      console.log('[Xiaomifeng Gateway] V2NIMClient instance created');

      const dataPath = getSdkDataPath(config.clientId);
      this.log('[Xiaomifeng Gateway] Data path:', dataPath);

      // Initialize SDK with fixed appKey
      // NOTE: node-nim SDK is a singleton - if NIM Gateway has already initialized with a different appKey,
      // this will fail. Only one appKey can be used per process.
      console.log('[Xiaomifeng Gateway] Attempting SDK init with appKey:', XiaomifengGateway.FIXED_APP_KEY);
      const initResult = this.v2Client.init({
        appkey: XiaomifengGateway.FIXED_APP_KEY,
        appDataPath: dataPath,
      });
      console.log('[Xiaomifeng Gateway] SDK init result:', JSON.stringify(initResult));

      // Check for init errors - init() may return an error object or null/undefined on success
      if (initResult && (initResult.code !== undefined || initResult.desc !== undefined)) {
        const errorDesc = initResult.desc || `Error code: ${initResult.code}`;
        console.error('[Xiaomifeng Gateway] SDK init failed:', errorDesc);
        throw new Error(`NIM SDK V2 initialization failed: ${errorDesc}. Note: node-nim SDK is singleton - if NIM Gateway is already running with a different appKey, Xiaomifeng Gateway cannot start.`);
      }

      console.log('[Xiaomifeng Gateway] SDK initialized successfully, dataPath:', dataPath);

      // Get services
      this.loginService = this.v2Client.getLoginService();
      this.messageService = this.v2Client.getMessageService();

      if (!this.loginService || !this.messageService) {
        throw new Error('NIM SDK V2 services not available');
      }

      // Register message receive callback
      this.messageService.on('receiveMessages', (messages: any[]) => {
        this.log('[Xiaomifeng Gateway] Received messages:', messages.length);
        for (const msg of messages) {
          this.handleIncomingMessage(msg);
        }
      });

      // Register login status callback
      this.loginService.on('loginStatus', (loginStatus: number) => {
        console.log('[Xiaomifeng Gateway] Login status changed:', loginStatus);
        // V2NIMLoginStatus: 0=LOGOUT, 1=LOGINED, 2=LOGINING
        if (loginStatus === 1) {
          this.reconnectAttempts = 0;
          this.status.connected = true;
          this.status.lastError = null;
          this.status.startedAt = Date.now();
          this.status.botAccount = this.config?.clientId || null;
          this.log('[Xiaomifeng Gateway] Login successful');
          this.emit('connected');
          this.emit('status');
        } else if (loginStatus === 0) {
          this.status.connected = false;
          this.log('[Xiaomifeng Gateway] Logged out');
          this.emit('disconnected');
          this.emit('status');
        } else if (loginStatus === 2) {
          this.log('[Xiaomifeng Gateway] Logging in...');
        }
      });

      this.loginService.on('kickedOffline', (detail: any) => {
        console.log('[Xiaomifeng Gateway] Kicked offline, detail:', JSON.stringify(detail));
        this.status.connected = false;
        
        // 检查是否是被其他客户端踢下线
        // V2NIMKickedOfflineDetail 包含 reason 字段：
        // - 1: KICK_BY_CLIENT (被另一个客户端踢掉)
        // - 2: KICK_BY_SERVER (被服务器踢掉)
        // - 3: KICK_BY_CLIENT_MANUAL_LOGIN (手动登录导致)
        const kickReason = detail?.reason || detail?.kickReason || 0;
        const isKickedByOtherClient = kickReason === 1 || kickReason === 3;
        
        if (isKickedByOtherClient) {
          // 被其他客户端踢下线，设置错误消息并不再重连
          this.kickedByOtherClient = true;
          
          // 清理任何已存在的重连定时器
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          
          this.status.lastError = '账号已在其它地方登录';
          console.warn('[Xiaomifeng Gateway] 账号已在其它地方登录，不再自动重连');
          this.emit('error', new Error('账号已在其它地方登录'));
          this.emit('kickedByOtherClient'); // 发出特殊事件以便上层处理
        } else {
          // 其他踢出原因，仍然尝试重连
          this.status.lastError = 'Kicked offline';
          this.emit('error', new Error('Kicked offline'));
          this.scheduleReconnect(5000);
        }
        
        this.emit('status');
      });

      this.loginService.on('loginFailed', (error: any) => {
        console.error('[Xiaomifeng Gateway] Login failed:', JSON.stringify(error));
        this.status.connected = false;
        this.status.lastError = `Login failed: ${error?.desc || JSON.stringify(error)}`;
        this.emit('error', new Error(this.status.lastError!));
        this.emit('status');
        const delay = Math.min(
          this.reconnectAttempts <= 1 ? INITIAL_RECONNECT_DELAY_MS : INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
          MAX_RECONNECT_DELAY_MS
        );
        this.scheduleReconnect(delay);
      });

      this.loginService.on('disconnected', (error: any) => {
        this.log('[Xiaomifeng Gateway] Disconnected:', error);
        this.status.connected = false;
        // 如果是被踢下线，保留原来的错误信息，不要覆盖
        if (!this.kickedByOtherClient) {
          this.status.lastError = 'Disconnected';
        }
        this.emit('disconnected');
        this.emit('status');
        this.scheduleReconnect(3000);
      });

      // Login: use clientId as account, secret as token
      console.log('[Xiaomifeng Gateway] Initiating login with account:', config.clientId);
      console.log('[Xiaomifeng Gateway] Token length:', config.secret?.length || 0);
      this.loginService.login(config.clientId, config.secret, {})
        .then(() => {
          console.log('[Xiaomifeng Gateway] Login promise resolved');
        })
        .catch((error: any) => {
          console.error('[Xiaomifeng Gateway] Login promise rejected:', error?.code, error?.desc, JSON.stringify(error));
        });

      // Initialize status
      this.status = createDefaultStatus(config.clientId);

      this.log('[Xiaomifeng Gateway] Gateway initialized, waiting for login status...');
    } catch (error: any) {
      const savedConfig = this.config;
      this.cleanup();
      this.config = savedConfig;
      this.status = createDefaultStatus(savedConfig?.clientId || null);
      this.status.lastError = error.message;
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop Xiaomifeng gateway
   */
  async stop(): Promise<void> {
    if (!this.v2Client) {
      this.log('[Xiaomifeng Gateway] Not running');
      return;
    }

    this.log('[Xiaomifeng Gateway] Stopping...');

    try {
      // Clear reconnect timer
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // Logout
      if (this.loginService) {
        try {
          await this.loginService.logout();
        } catch (e) {
          // Ignore logout errors
        }
      }

      // Uninit SDK
      if (this.v2Client) {
        try {
          this.v2Client.uninit();
        } catch (e) {
          // Ignore uninit errors
        }
      }

      this.cleanup();

      this.status = createDefaultStatus();

      this.log('[Xiaomifeng Gateway] Stopped');
      this.emit('disconnected');

    } catch (error: any) {
      console.error(`[Xiaomifeng Gateway] Error stopping: ${error.message}`);
      this.status.lastError = error.message;
    }
  }

  /**
   * Clean up internal references
   */
  private cleanup(): void {
    this.v2Client = null;
    this.loginService = null;
    this.messageService = null;
  }

  /**
   * Handle incoming message from node-nim SDK
   */
  private async handleIncomingMessage(msg: any): Promise<void> {
    try {
      const msgId = String(msg.messageServerId || msg.messageClientId || '');
      const senderId = String(msg.senderId || '');

      // Ignore messages from self
      if (this.config && senderId === this.config.clientId) {
        this.log('[Xiaomifeng Gateway] Ignoring self message');
        return;
      }

      // Deduplication
      if (this.isMessageProcessed(msgId)) {
        this.log(`[Xiaomifeng Gateway] Duplicate message ignored: ${msgId}`);
        return;
      }

      // Skip old messages based on timestamp
      const messageTime = msg.createTime || 0;
      if (messageTime > 0 && messageTime <= this.lastProcessedTimestamp) {
        this.log('[Xiaomifeng Gateway] Skipping old message:', msgId);
        return;
      }

      // Update last processed timestamp
      if (messageTime > this.lastProcessedTimestamp) {
        this.lastProcessedTimestamp = messageTime;
        this.savePersistedState();
      }

      const msgType = convertMessageType(msg.messageType);
      this.log('[Xiaomifeng Gateway] Message type:', msgType, 'raw type:', msg.messageType);

      // Handle type 100 custom message (Xiaomifeng format)
      if (msgType === 'custom' || msg.messageType === 100) {
        await this.processCustomMessage(msg, msgId);
        return;
      }

      // Handle regular text messages
      if (msgType !== 'text') {
        this.log(`[Xiaomifeng Gateway] Ignoring non-text/non-custom message type: ${msgType}`);
        return;
      }

      await this.processTextMessage(msg, msgId, senderId);
    } catch (err: any) {
      console.error(`[Xiaomifeng Gateway] Error handling incoming message: ${err.message}`);
    }
  }

  /**
   * Process regular text message
   */
  private async processTextMessage(msg: any, msgId: string, senderId: string): Promise<void> {
    const { sessionType } = parseConversationId(msg.conversationId || '');
    const content = msg.text || '';

    if (!content.trim()) {
      this.log('[Xiaomifeng Gateway] Ignoring empty message');
      return;
    }

    this.log('[Xiaomifeng Gateway] Received text message:', JSON.stringify({
      msgId,
      senderId,
      sessionType,
      content: content.substring(0, 100),
    }, null, 2));

    const message: IMMessage = {
      platform: 'xiaomifeng',
      messageId: msgId,
      conversationId: msg.conversationId || senderId,
      senderId,
      content,
      chatType: sessionType === 'p2p' ? 'direct' : 'group',
      timestamp: msg.createTime || Date.now(),
    };

    await this.dispatchMessage(message, senderId, msg.conversationId || senderId);
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
   * Dispatch message to callback and emit events (shared logic)
   */
  private async dispatchMessage(
    message: IMMessage,
    replyTargetId: string,
    conversationId: string,
    beeChatId?: string
  ): Promise<void> {
    this.status.lastInboundAt = Date.now();

    // Create reply function using HTTP API
    const replyFn = async (text: string) => {
      this.log('[Xiaomifeng Gateway] Sending reply via HTTP:', text.substring(0, 100));
      await this.sendBeeReply(replyTargetId, text);
      this.status.lastOutboundAt = Date.now();
    };

    this.lastConversation = {
      senderId: message.senderId,
      conversationId,
      beeChatId,
    };

    this.emit('message', message);

    if (this.onMessageCallback) {
      try {
        await this.onMessageCallback(message, replyFn);
      } catch (error: any) {
        console.error(`[Xiaomifeng Gateway] Error in message callback: ${error.message}`);
        try {
          await replyFn(`处理消息时出错: ${error.message}`);
        } catch (replyError: any) {
          console.error(`[Xiaomifeng Gateway] Failed to send error reply: ${replyError.message}`);
        }
      }
    }
  }

  /**
   * Process type 100 custom message (Xiaomifeng bee format)
   * 
   * Message format example (from attachment.raw):
   * {
   *   "senderId": "yd.xxx@163.com",
   *   "chatId": "youdao111@bee.163.com",
   *   "msgType": 1,
   *   "content": "{\"text\":\"用户消息\"}"
   * }
   */
  private async processCustomMessage(msg: any, msgId: string): Promise<void> {
    this.log('[Xiaomifeng Gateway] Processing custom message (type 100)');

    // Get raw attachment content
    const rawContent = msg.attachment?.raw || msg.text || '';
    if (!rawContent) {
      this.log('[Xiaomifeng Gateway] No content in custom message');
      return;
    }

    // Parse bee message format using safeParseJSON
    const beeMessage = safeParseJSON(rawContent, null);
    if (!beeMessage) {
      this.log('[Xiaomifeng Gateway] Failed to parse custom message JSON');
      return;
    }

    const beeSenderId = beeMessage.senderId || msg.senderId || '';
    const beeChatId = beeMessage.chatId || '';

    // Parse inner content using safeParseJSON
    const innerContent = safeParseJSON(beeMessage.content, { text: beeMessage.content }) as { text: any; subType?: number };

    // Check subType - only process subType = 1 (text messages) or no subType
    if (innerContent.subType !== undefined && innerContent.subType !== 1) {
      this.log('[Xiaomifeng Gateway] Skipping custom message with subType:', innerContent.subType);
      return;
    }

    const messageContent = innerContent.text || '';
    if (!messageContent) {
      this.log('[Xiaomifeng Gateway] Empty custom message content');
      return;
    }

    this.log('[Xiaomifeng Gateway] Parsed bee message:', JSON.stringify({
      beeSenderId,
      beeChatId,
      content: messageContent.substring(0, 100),
    }, null, 2));

    // Create IMMessage
    const message: IMMessage = {
      platform: 'xiaomifeng',
      messageId: msgId,
      conversationId: beeChatId || msg.conversationId || beeSenderId,
      senderId: beeSenderId,
      senderName: beeSenderId,
      content: messageContent,
      chatType: 'direct',
      timestamp: msg.createTime || Date.now(),
    };

    const chatIdForReply = beeChatId || beeSenderId;
    await this.dispatchMessage(message, chatIdForReply, beeChatId || msg.conversationId, beeChatId);
  }

  /**
   * Get access token for HTTP API
   */
  private async getAccessToken(): Promise<string> {
    if (!this.config?.clientId || !this.config?.secret) {
      throw new Error('获取 accessToken 需要 clientId 和 secret');
    }

    const now = Date.now();
    
    // Check if cached token is still valid (refresh 60s early)
    if (this.accessToken && this.tokenExpiry > now + 60000) {
      this.log(`[Xiaomifeng Gateway] Using cached accessToken, expires in: ${Math.round((this.tokenExpiry - now) / 1000)}s`);
      return this.accessToken;
    }

    console.log('[Xiaomifeng Gateway] Getting new accessToken...');

    const tokenPayload = {
      appKey: this.config.clientId,
      appSecret: this.config.secret,
    };

    try {
      const response = await fetch(XiaomifengGateway.BEE_TOKEN_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(tokenPayload),
      });

      const responseText = await response.text();
      console.log('[Xiaomifeng Gateway] Token API Response:', responseText);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText}`);
      }

      const result = JSON.parse(responseText);
      
      // Parse response for accessToken and expiry
      const accessToken = result.data?.accessToken || result.accessToken || result.access_token;
      const expiresIn = result.data?.expireIn || result.data?.expiresIn || result.expireIn || result.expiresIn || result.expires_in || 7200;

      if (!accessToken) {
        throw new Error(`Failed to get accessToken: ${JSON.stringify(result)}`);
      }

      this.accessToken = accessToken;
      this.tokenExpiry = now + expiresIn * 1000;
      
      console.log(`[Xiaomifeng Gateway] Got accessToken, valid for: ${expiresIn}s`);
      return this.accessToken;

    } catch (error: any) {
      console.error('[Xiaomifeng Gateway] Failed to get accessToken:', error.message);
      throw error;
    }
  }

  /**
   * Send reply through Bee system via HTTP API
   * Automatically splits long messages into chunks (max 3000 characters each)
   */
  private async sendBeeReply(chatId: string, text: string): Promise<void> {
    if (!this.config?.clientId || !this.config?.secret) {
      throw new Error('HTTP API config incomplete, need clientId and secret');
    }

    // Split long message into chunks
    const chunks = splitMessageIntoChunks(text);
    
    if (chunks.length > 1) {
      console.log(`[Xiaomifeng Gateway] Message too long (${text.length} chars), splitting into ${chunks.length} chunks`);
    }

    // Get accessToken (auto-refresh) - only need to get once for all chunks
    const accessToken = await this.getAccessToken();

    // Send each chunk sequentially
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      const payload = {
        from: XiaomifengGateway.FIXED_HTTP_FROM,
        appKey: this.config.clientId,
        accessToken: accessToken,
        chatType: 'single',
        msgType: 'text',
        chatId: chatId,
        content: JSON.stringify({ text: chunk }),
      };

      const chunkInfo = chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length})` : '';
      console.log(`[Xiaomifeng Gateway] ========== HTTP Request Parameters${chunkInfo} ==========`);
      console.log('[Xiaomifeng Gateway] URL:', XiaomifengGateway.BEE_HTTP_API_URL);
      console.log('[Xiaomifeng Gateway] Method: POST');
      console.log('[Xiaomifeng Gateway] Payload:', JSON.stringify({
        from: payload.from,
        appKey: payload.appKey,
        accessToken: payload.accessToken ? `${payload.accessToken.substring(0, 8)}****` : '(empty)',
        chatType: payload.chatType,
        msgType: payload.msgType,
        chatId: payload.chatId,
        content: chunk.length > 100 ? chunk.substring(0, 100) + '...' : chunk,
        chunkLength: chunk.length,
      }, null, 2));
      console.log('[Xiaomifeng Gateway] =============================================');

      try {
        const response = await fetch(XiaomifengGateway.BEE_HTTP_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        const responseText = await response.text();
        console.log(`[Xiaomifeng Gateway] ========== HTTP Response${chunkInfo} ==========`);
        console.log('[Xiaomifeng Gateway] Status:', response.status, response.statusText);
        console.log('[Xiaomifeng Gateway] Response Body:', responseText);
        console.log('[Xiaomifeng Gateway] ==================================');

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${responseText}`);
        }

        let result;
        try {
          result = JSON.parse(responseText);
        } catch {
          result = responseText;
        }
        this.log(`[Xiaomifeng Gateway] HTTP reply sent successfully${chunkInfo}:`, result);
      } catch (error: any) {
        console.error(`[Xiaomifeng Gateway] Failed to send HTTP reply${chunkInfo}:`, error.message);
        throw error;
      }

      // Add a small delay between chunks to avoid rate limiting
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    if (chunks.length > 1) {
      console.log(`[Xiaomifeng Gateway] All ${chunks.length} chunks sent successfully`);
    }
  }

  /**
   * Send a notification message to the last known conversation
   */
  async sendNotification(text: string): Promise<void> {
    if (!this.lastConversation) {
      throw new Error('No conversation available for notification');
    }

    await this.sendBeeReply(this.lastConversation.conversationId, text);
    this.status.lastOutboundAt = Date.now();
  }
}