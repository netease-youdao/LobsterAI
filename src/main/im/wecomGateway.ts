/**
 * WeCom Gateway (企业微信)
 * Manages WebSocket connection via @wecom/aibot-node-sdk
 */

import { EventEmitter } from 'events';
import {
  WecomConfig,
  WecomGatewayStatus,
  IMMessage,
  DEFAULT_WECOM_STATUS,
} from './types';

/** Message deduplication cache: messageId -> timestamp */
const processedMessages = new Map<string, number>();

/** Message deduplication TTL (5 minutes) */
const MESSAGE_DEDUP_TTL = 5 * 60 * 1000;

export class WecomGateway extends EventEmitter {
  private wsClient: any = null;
  private config: WecomConfig | null = null;
  private status: WecomGatewayStatus = { ...DEFAULT_WECOM_STATUS };
  private onMessageCallback?: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>;
  private log: (...args: any[]) => void = () => {};

  // Last conversation info for proactive notifications
  private lastConversation: {
    chatId: string;
    chatType: 'single' | 'group';
  } | null = null;

  constructor() {
    super();
  }

  /**
   * Get current gateway status
   */
  getStatus(): WecomGatewayStatus {
    return { ...this.status };
  }

  /**
   * Check if gateway is connected
   */
  isConnected(): boolean {
    return this.status.connected;
  }

  /**
   * Check if gateway has a pending reconnection
   */
  isReconnecting(): boolean {
    // The SDK handles reconnection internally
    return false;
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
    if (this.config && !this.status.connected && !this.wsClient) {
      this.log('[WeCom Gateway] External reconnection trigger');
      this.start(this.config).catch((err) => {
        console.error('[WeCom Gateway] Reconnection failed:', err.message);
      });
    }
  }

  /**
   * Start WeCom gateway
   */
  async start(config: WecomConfig): Promise<void> {
    if (this.wsClient) {
      throw new Error('WeCom gateway already running');
    }
    this.config = config;

    if (!config.enabled) {
      console.log('[WeCom Gateway] WeCom is disabled in config');
      return;
    }

    if (!config.botId || !config.secret) {
      throw new Error('WeCom botId 和 secret 必填');
    }

    this.log = config.debug ? console.log.bind(console) : () => {};
    console.log('[WeCom Gateway] Starting with @wecom/aibot-node-sdk...');

    try {
      const { WSClient, generateReqId } = await import('@wecom/aibot-node-sdk');

      this.wsClient = new WSClient({
        botId: config.botId,
        secret: config.secret,
        maxReconnectAttempts: -1,
      });

      // Connection events
      this.wsClient.on('authenticated', () => {
        console.log('[WeCom Gateway] Authenticated successfully');
        this.status.connected = true;
        this.status.lastError = null;
        this.status.startedAt = Date.now();
        this.status.botId = config.botId;
        this.emit('connected');
        this.emit('status');
      });

      this.wsClient.on('disconnected', (reason: string) => {
        console.log('[WeCom Gateway] Disconnected:', reason);
        this.status.connected = false;
        this.status.lastError = reason || 'Disconnected';
        this.emit('disconnected');
        this.emit('status');
      });

      this.wsClient.on('error', (error: Error) => {
        console.error('[WeCom Gateway] Error:', error.message);
        this.status.lastError = error.message;
        this.emit('error', error);
        this.emit('status');
      });

      this.wsClient.on('reconnecting', (attempt: number) => {
        this.log('[WeCom Gateway] Reconnecting, attempt:', attempt);
      });

      // Text message handler
      this.wsClient.on('message.text', async (data: any) => {
        const { body, headers } = data;
        await this.handleTextMessage(body, headers, generateReqId);
      });

      // Voice message handler (transcribed text)
      this.wsClient.on('message.voice', async (data: any) => {
        const { body, headers } = data;
        if (body?.voice?.content) {
          // Treat voice transcription as text
          const textBody = {
            ...body,
            text: { content: body.voice.content },
          };
          await this.handleTextMessage(textBody, headers, generateReqId);
        }
      });

      // Connect
      this.wsClient.connect();

      // Initialize status
      this.status = {
        connected: false,
        startedAt: null,
        lastError: null,
        botId: config.botId,
        lastInboundAt: null,
        lastOutboundAt: null,
      };

      this.log('[WeCom Gateway] Gateway initialized, waiting for authentication...');
    } catch (error: any) {
      this.cleanup();
      this.status = { ...DEFAULT_WECOM_STATUS };
      this.status.lastError = error.message;
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop WeCom gateway
   */
  async stop(): Promise<void> {
    if (!this.wsClient) {
      this.log('[WeCom Gateway] Not running');
      return;
    }

    this.log('[WeCom Gateway] Stopping...');

    try {
      this.wsClient.disconnect();
    } catch (e) {
      // Ignore disconnect errors
    }

    this.cleanup();
    this.status = { ...DEFAULT_WECOM_STATUS };

    this.log('[WeCom Gateway] Stopped');
    this.emit('disconnected');
  }

  /**
   * Clean up internal references
   */
  private cleanup(): void {
    if (this.wsClient) {
      try {
        this.wsClient.removeAllListeners();
      } catch (_) { /* ignore */ }
    }
    this.wsClient = null;
  }

  /**
   * Handle incoming text message
   */
  private async handleTextMessage(
    body: any,
    headers: any,
    generateReqId: (prefix: string) => string
  ): Promise<void> {
    try {
      const msgId = String(body.msgid || '');
      const senderId = body.from?.userid || '';
      const content = body.text?.content || '';
      const chatType = body.chattype || 'single';
      const chatId = body.chatid || senderId;

      if (!content.trim()) {
        this.log('[WeCom Gateway] Ignoring empty message');
        return;
      }

      // Deduplication
      if (this.isMessageProcessed(msgId)) {
        this.log(`[WeCom Gateway] Duplicate message ignored: ${msgId}`);
        return;
      }

      this.log('[WeCom Gateway] Received text message:', JSON.stringify({
        msgId,
        senderId,
        chatType,
        content: content.substring(0, 100),
      }, null, 2));

      const message: IMMessage = {
        platform: 'wecom',
        messageId: msgId,
        conversationId: chatId,
        senderId,
        content,
        chatType: chatType === 'single' ? 'direct' : 'group',
        timestamp: body.create_time ? body.create_time * 1000 : Date.now(),
      };

      this.status.lastInboundAt = Date.now();

      // Save last conversation for notifications
      this.lastConversation = { chatId, chatType };

      // Create reply function using streaming reply
      const replyFn = async (text: string) => {
        this.log('[WeCom Gateway] Sending reply via replyStream');
        try {
          const streamId = generateReqId('stream');
          await this.wsClient.replyStream(
            { headers },
            streamId,
            text,
            true // finish=true, send as single complete message
          );
          this.status.lastOutboundAt = Date.now();
        } catch (err: any) {
          console.error('[WeCom Gateway] Failed to send reply:', err.message);
          throw err;
        }
      };

      this.emit('message', message);

      if (this.onMessageCallback) {
        try {
          await this.onMessageCallback(message, replyFn);
        } catch (error: any) {
          console.error(`[WeCom Gateway] Error in message callback: ${error.message}`);
          try {
            await replyFn(`处理消息时出错: ${error.message}`);
          } catch (replyError: any) {
            console.error(`[WeCom Gateway] Failed to send error reply: ${replyError.message}`);
          }
        }
      }
    } catch (err: any) {
      console.error(`[WeCom Gateway] Error handling text message: ${err.message}`);
    }
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
   * Send a notification message to the last known conversation
   */
  async sendNotification(text: string): Promise<void> {
    if (!this.wsClient || !this.lastConversation) {
      throw new Error('No conversation available for notification');
    }

    await this.wsClient.sendMessage(this.lastConversation.chatId, {
      msgtype: 'markdown',
      markdown: { content: text },
    });
    this.status.lastOutboundAt = Date.now();
  }

  /**
   * Send notification with media (falls back to text for WeCom)
   */
  async sendNotificationWithMedia(text: string): Promise<void> {
    await this.sendNotification(text);
  }

  /**
   * Get notification target for persistence
   */
  getNotificationTarget(): any {
    return this.lastConversation ? { ...this.lastConversation } : null;
  }

  /**
   * Set notification target from persistence
   */
  setNotificationTarget(target: any): void {
    if (target?.chatId) {
      this.lastConversation = {
        chatId: target.chatId,
        chatType: target.chatType || 'single',
      };
    }
  }
}
