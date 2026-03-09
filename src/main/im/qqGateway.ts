/**
 * QQ Bot Gateway
 * Manages QQ bot using qq-official-bot SDK with WebSocket connection
 * Supports guild messages, group messages, direct messages, and private messages
 * Uses AppID + AppSecret (OAuth2 AccessToken) authentication
 */

import { EventEmitter } from 'events';
import {
  QQConfig,
  QQGatewayStatus,
  IMMessage,
  DEFAULT_QQ_STATUS,
} from './types';

export class QQGateway extends EventEmitter {
  private bot: any = null;
  private config: QQConfig | null = null;
  private status: QQGatewayStatus = { ...DEFAULT_QQ_STATUS };
  private onMessageCallback?: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>;
  private lastChannelId: string | null = null;
  private lastGuildId: string | null = null;
  private lastGroupId: string | null = null;

  constructor() {
    super();
  }

  /**
   * Get current gateway status
   */
  getStatus(): QQGatewayStatus {
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
    if (!this.bot && this.config) {
      console.log('[QQ Gateway] External reconnection trigger');
      this.start(this.config).catch((error) => {
        console.error('[QQ Gateway] Reconnection failed:', error.message);
      });
    }
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
   * Update config on a running gateway without restart
   */
  updateConfig(config: QQConfig): void {
    if (this.config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * Start QQ gateway with WebSocket connection
   */
  async start(config: QQConfig): Promise<void> {
    if (this.bot) {
      console.log('[QQ Gateway] Already running, stopping first...');
      await this.stop();
    }

    if (!config.enabled) {
      console.log('[QQ Gateway] QQ is disabled in config');
      return;
    }

    if (!config.appId || !config.appSecret) {
      throw new Error('QQ bot AppID and AppSecret are required');
    }

    this.config = config;
    const log = config.debug ? console.log : () => {};

    log('[QQ Gateway] Starting...');

    try {
      // Dynamic import to avoid loading the SDK when not needed
      const { Bot, ReceiverMode } = require('qq-official-bot');

      this.bot = new Bot({
        appid: config.appId,
        secret: config.appSecret,
        intents: [
          'PUBLIC_GUILD_MESSAGES',
          'DIRECT_MESSAGE',
          'GUILDS',
          'GUILD_MEMBERS',
          'GROUP_AT_MESSAGE_CREATE',
          'C2C_MESSAGE_CREATE',
        ],
        sandbox: false,
        removeAt: true,
        logLevel: 'warn',
        maxRetry: 10,
        mode: ReceiverMode.WEBSOCKET,
      });

      // Register event handlers before starting
      this.setupEventHandlers(log);

      // Start the bot (connects WebSocket and authenticates via AccessToken)
      await this.bot.start();

      this.status = {
        connected: true,
        startedAt: Date.now(),
        lastError: null,
        lastInboundAt: null,
        lastOutboundAt: null,
      };

      console.log('[QQ Gateway] Connected successfully');
      this.emit('connected');

    } catch (error: any) {
      console.error(`[QQ Gateway] Failed to start: ${error.message}`);
      this.status = {
        connected: false,
        startedAt: null,
        lastError: error.message,
        lastInboundAt: null,
        lastOutboundAt: null,
      };
      this.bot = null;
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Set up event handlers for the bot
   */
  private setupEventHandlers(log: (...args: any[]) => void): void {
    if (!this.bot) return;

    // Guild channel messages (public, requires @bot mention)
    this.bot.on('message.guild', async (event: any) => {
      log('[QQ Gateway] message.guild event:', event.channel_id, event.raw_message);
      await this.handleGuildMessage(event, log);
    });

    // Group messages (requires @bot mention)
    this.bot.on('message.group', async (event: any) => {
      log('[QQ Gateway] message.group event:', event.group_id, event.raw_message);
      await this.handleGroupMessage(event, log);
    });

    // Private messages (C2C friend messages and guild DMs)
    this.bot.on('message.private', async (event: any) => {
      log('[QQ Gateway] message.private event:', event.user_id, event.raw_message);
      await this.handlePrivateMessage(event, log);
    });
  }

  /**
   * Handle guild channel message
   */
  private async handleGuildMessage(event: any, log: (...args: any[]) => void): Promise<void> {
    try {
      const channelId = event.channel_id;
      const guildId = event.guild_id;
      const messageId = event.message_id || event.id;
      const senderId = event.sender?.user_id || event.user_id || 'unknown';
      const senderName = event.sender?.user_name || event.author?.username || 'Unknown';
      const content = event.raw_message || event.content || '';

      if (!content.trim()) return;

      // Store last channel for notifications
      this.lastChannelId = channelId;
      this.lastGuildId = guildId;

      log('[QQ Gateway] Guild message:', JSON.stringify({
        sender: senderName, senderId, channelId, guildId, content,
      }));

      const imMessage: IMMessage = {
        platform: 'qq',
        messageId,
        conversationId: channelId,
        senderId,
        senderName,
        content,
        chatType: 'group',
        timestamp: event.timestamp ? event.timestamp * 1000 : Date.now(),
      };

      this.status.lastInboundAt = Date.now();
      this.emit('message', imMessage);

      // Create reply function using event.reply()
      const replyFn = async (text: string) => {
        const chunks = this.splitMessage(text, 2000);
        for (const chunk of chunks) {
          await event.reply(chunk);
        }
        this.status.lastOutboundAt = Date.now();
      };

      if (this.onMessageCallback) {
        try {
          await this.onMessageCallback(imMessage, replyFn);
        } catch (error: any) {
          console.error(`[QQ Gateway] Error in message callback: ${error.message}`);
          await replyFn(`处理消息时出错: ${error.message}`);
        }
      }
    } catch (error: any) {
      console.error(`[QQ Gateway] Error handling guild message: ${error.message}`);
      this.status.lastError = error.message;
      this.emit('error', error);
    }
  }

  /**
   * Handle group message
   */
  private async handleGroupMessage(event: any, log: (...args: any[]) => void): Promise<void> {
    try {
      const groupId = event.group_id;
      const messageId = event.message_id || event.id;
      const senderId = event.sender?.user_id || event.user_id || 'unknown';
      const senderName = event.sender?.user_name || 'Unknown';
      const content = event.raw_message || event.content || '';

      if (!content.trim()) return;

      this.lastGroupId = groupId;

      log('[QQ Gateway] Group message:', JSON.stringify({
        sender: senderName, senderId, groupId, content,
      }));

      const imMessage: IMMessage = {
        platform: 'qq',
        messageId,
        conversationId: `group_${groupId}`,
        senderId,
        senderName,
        content,
        chatType: 'group',
        timestamp: event.timestamp ? event.timestamp * 1000 : Date.now(),
      };

      this.status.lastInboundAt = Date.now();
      this.emit('message', imMessage);

      const replyFn = async (text: string) => {
        const chunks = this.splitMessage(text, 2000);
        for (const chunk of chunks) {
          await event.reply(chunk);
        }
        this.status.lastOutboundAt = Date.now();
      };

      if (this.onMessageCallback) {
        try {
          await this.onMessageCallback(imMessage, replyFn);
        } catch (error: any) {
          console.error(`[QQ Gateway] Error in message callback: ${error.message}`);
          await replyFn(`处理消息时出错: ${error.message}`);
        }
      }
    } catch (error: any) {
      console.error(`[QQ Gateway] Error handling group message: ${error.message}`);
      this.status.lastError = error.message;
      this.emit('error', error);
    }
  }

  /**
   * Handle private message (C2C or guild DM)
   */
  private async handlePrivateMessage(event: any, log: (...args: any[]) => void): Promise<void> {
    try {
      const messageId = event.message_id || event.id;
      const senderId = event.sender?.user_id || event.user_id || 'unknown';
      const senderName = event.sender?.user_name || event.author?.username || 'Unknown';
      const content = event.raw_message || event.content || '';
      const subType = event.sub_type; // 'friend' or 'direct'

      if (!content.trim()) return;

      // For guild DM, store guild_id
      if (subType === 'direct' && event.guild_id) {
        this.lastGuildId = event.guild_id;
      }

      log('[QQ Gateway] Private message:', JSON.stringify({
        sender: senderName, senderId, subType, content,
      }));

      const imMessage: IMMessage = {
        platform: 'qq',
        messageId,
        conversationId: `dm_${senderId}`,
        senderId,
        senderName,
        content,
        chatType: 'direct',
        timestamp: event.timestamp ? event.timestamp * 1000 : Date.now(),
      };

      this.status.lastInboundAt = Date.now();
      this.emit('message', imMessage);

      const replyFn = async (text: string) => {
        const chunks = this.splitMessage(text, 2000);
        for (const chunk of chunks) {
          await event.reply(chunk);
        }
        this.status.lastOutboundAt = Date.now();
      };

      if (this.onMessageCallback) {
        try {
          await this.onMessageCallback(imMessage, replyFn);
        } catch (error: any) {
          console.error(`[QQ Gateway] Error in message callback: ${error.message}`);
          await replyFn(`处理消息时出错: ${error.message}`);
        }
      }
    } catch (error: any) {
      console.error(`[QQ Gateway] Error handling private message: ${error.message}`);
      this.status.lastError = error.message;
      this.emit('error', error);
    }
  }

  /**
   * Split long message into chunks
   */
  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = maxLength;
      }

      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).trim();
    }

    return chunks;
  }

  /**
   * Stop QQ gateway
   */
  async stop(): Promise<void> {
    if (!this.bot) {
      console.log('[QQ Gateway] Not running');
      return;
    }

    const log = this.config?.debug ? console.log : () => {};
    log('[QQ Gateway] Stopping...');

    try {
      if (this.bot && typeof this.bot.stop === 'function') {
        try {
          await this.bot.stop();
        } catch (e) {
          // Ignore stop errors
        }
      }
      this.bot = null;

      this.status = {
        connected: false,
        startedAt: null,
        lastError: null,
        lastInboundAt: null,
        lastOutboundAt: null,
      };

      log('[QQ Gateway] Stopped');
      this.emit('disconnected');
    } catch (error: any) {
      console.error(`[QQ Gateway] Error stopping: ${error.message}`);
      this.status.lastError = error.message;
    }
  }

  /**
   * Get notification target for persistence
   */
  getNotificationTarget(): { channelId?: string; guildId?: string; groupId?: string } | null {
    if (this.lastChannelId && this.lastGuildId) {
      return { channelId: this.lastChannelId, guildId: this.lastGuildId };
    }
    if (this.lastGroupId) {
      return { groupId: this.lastGroupId };
    }
    return null;
  }

  /**
   * Restore notification target from persisted state
   */
  setNotificationTarget(target: { channelId?: string; guildId?: string; groupId?: string }): void {
    if (target.channelId) this.lastChannelId = target.channelId;
    if (target.guildId) this.lastGuildId = target.guildId;
    if (target.groupId) this.lastGroupId = target.groupId;
  }

  /**
   * Send a notification message to the last known channel or group
   */
  async sendNotification(text: string): Promise<void> {
    if (!this.bot) {
      throw new Error('QQ bot not initialized');
    }

    const chunks = this.splitMessage(text, 2000);

    if (this.lastChannelId) {
      for (const chunk of chunks) {
        await this.bot.sendGuildMessage(this.lastChannelId, chunk);
      }
    } else if (this.lastGroupId) {
      for (const chunk of chunks) {
        await this.bot.sendGroupMessage(this.lastGroupId, chunk);
      }
    } else {
      throw new Error('No conversation available for notification');
    }

    this.status.lastOutboundAt = Date.now();
  }

  /**
   * Send a notification with media support (text only for now)
   */
  async sendNotificationWithMedia(text: string): Promise<void> {
    await this.sendNotification(text);
  }
}
