/**
 * Discord Gateway
 * Manages Discord bot using discord.js
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  Events,
  AttachmentBuilder,
  type Client as DiscordClient,
} from 'discord.js';
import {
  DiscordConfig,
  DiscordGatewayStatus,
  IMMessage,
  IMMediaAttachment,
  DEFAULT_DISCORD_STATUS,
} from './types';
import { parseMediaMarkers, stripMediaMarkers } from './dingtalkMediaParser';
import { downloadDiscordAttachment, mapDiscordContentType } from './discordMediaDownload';

export class DiscordGateway extends EventEmitter {
  private client: Client | null = null;
  private config: DiscordConfig | null = null;
  private status: DiscordGatewayStatus = { ...DEFAULT_DISCORD_STATUS };
  private onMessageCallback?: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>;
  private lastChannelId: string | null = null;
  private log: (...args: any[]) => void = () => {};

  constructor() {
    super();
  }

  /**
   * Get current gateway status
   */
  getStatus(): DiscordGatewayStatus {
    return { ...this.status };
  }

  /**
   * Check if gateway is connected
   */
  isConnected(): boolean {
    return this.status.connected;
  }

  /**
   * Public method for external reconnection triggers (e.g., network events)
   */
  reconnectIfNeeded(): void {
    if (!this.client && this.config) {
      this.log('[Discord Gateway] External reconnection trigger');
      this.start(this.config).catch((error) => {
        console.error('[Discord Gateway] Reconnection failed:', error.message);
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
   * Emit status change event for UI updates
   */
  private emitStatusChange(): void {
    this.emit('status', this.getStatus());
  }

  /**
   * Start Discord gateway
   */
  async start(config: DiscordConfig): Promise<void> {
    if (this.client) {
      this.log('[Discord Gateway] Already running, stopping first...');
      await this.stop();
    }

    if (!config.enabled) {
      this.log('[Discord Gateway] Discord is disabled in config');
      return;
    }

    if (!config.botToken) {
      throw new Error('Discord bot token is required');
    }

    // Store config for reconnection
    this.config = config;

    this.log = config.debug ? console.log.bind(console) : () => {};
    this.log('[Discord Gateway] Starting...');
    this.status = {
      connected: false,
      starting: true,
      startedAt: null,
      lastError: null,
      botUsername: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    };
    this.emitStatusChange();

    try {
      // Create client instance with required intents
      this.log('[Discord Gateway] 创建 Client 实例, intents: Guilds, GuildMessages, DirectMessages, MessageContent');
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [
          Partials.Channel, // Required for DM support
          Partials.Message,
        ],
      });

      // Register error handler
      this.log('[Discord Gateway] 注册事件处理器: Error, ClientReady, MessageCreate');
      this.client.on(Events.Error, (error: Error) => {
        console.error(`[Discord Gateway] Client error: ${error.message}`);
        this.status = {
          ...this.status,
          starting: false,
          lastError: error.message,
        };
        this.emitStatusChange();
        this.emit('error', error);
      });

      // Register ready handler
      this.client.once(Events.ClientReady, (readyClient: DiscordClient<true>) => {
        console.log(`[Discord Gateway] Connected as ${readyClient.user.tag}`);
        this.status = {
          connected: true,
          starting: false,
          startedAt: Date.now(),
          lastError: null,
          botUsername: readyClient.user.tag,
          lastInboundAt: null,
          lastOutboundAt: null,
        };
        this.emitStatusChange();
        this.emit('connected');
      });

      // Register message handler
      this.client.on(Events.MessageCreate, async (message: Message) => {
        await this.handleMessage(message);
      });

      // Login with bot token
      this.log('[Discord Gateway] 正在登录 Bot...');
      await this.client.login(config.botToken);
      this.log('[Discord Gateway] 登录请求已发送, 等待 ClientReady 事件...');

    } catch (error: any) {
      console.error(`[Discord Gateway] Failed to start: ${error.message}`);
      this.status = {
        connected: false,
        starting: false,
        startedAt: null,
        lastError: error.message,
        botUsername: null,
        lastInboundAt: null,
        lastOutboundAt: null,
      };
      this.emitStatusChange();
      this.client = null;
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop Discord gateway
   */
  async stop(): Promise<void> {
    if (!this.client) {
      this.log('[Discord Gateway] Not running');
      return;
    }

    this.log('[Discord Gateway] Stopping...');

    try {
      const client = this.client;
      this.client = null;

      // Destroy the client connection
      this.log('[Discord Gateway] 销毁 Client 连接...');
      client.destroy();

      this.status = {
        connected: false,
        starting: false,
        startedAt: null,
        lastError: null,
        botUsername: null,
        lastInboundAt: null,
        lastOutboundAt: null,
      };
      this.emitStatusChange();

      this.log('[Discord Gateway] Stopped');
      this.emit('disconnected');
    } catch (error: any) {
      console.error(`[Discord Gateway] Error stopping: ${error.message}`);
      this.status.lastError = error.message;
    }
  }

  /**
   * Handle incoming Discord message
   */
  private async handleMessage(message: Message): Promise<void> {
    try {
      // Ignore messages from bots (including self)
      if (message.author.bot) {
        return;
      }

      // Ignore empty messages (no text and no attachments)
      const hasAttachments = message.attachments && message.attachments.size > 0;
      if ((!message.content || message.content.trim() === '') && !hasAttachments) {
        return;
      }

      const isDM = !message.guild;
      const channelId = message.channel.id;
      const guildId = message.guild?.id;

      // In group chats, only respond to messages that mention the bot
      if (!isDM && this.client?.user) {
        const isMentioned = message.mentions.has(this.client.user.id);
        if (!isMentioned) {
          this.log('[Discord Gateway] Ignoring group message without bot mention');
          return;
        }
      }

      // Build conversation ID
      const conversationId = isDM ? `dm:${message.author.id}` : `guild:${guildId}:${channelId}`;

      // Build sender name
      const senderName = message.member?.displayName || message.author.displayName || message.author.username;
      const senderId = message.author.id;

      // Strip Discord mentions (<@123456789>, <@!123456789>, <#123456789>, <@&123456789>)
      const cleanedContent = (message.content || '')
        .replace(/<@!?\d+>/g, '') // User mentions
        .replace(/<#\d+>/g, '')   // Channel mentions
        .replace(/<@&\d+>/g, '')  // Role mentions
        .trim();

      // Ignore empty messages after stripping mentions (unless has attachments)
      if (!cleanedContent && !hasAttachments) {
        return;
      }

      // Download media attachments
      let attachments: IMMediaAttachment[] | undefined;
      if (hasAttachments) {
        attachments = [];
        for (const [, att] of message.attachments) {
          const result = await downloadDiscordAttachment(
            att.url,
            att.contentType || 'application/octet-stream',
            att.name || undefined
          );
          if (result) {
            attachments.push({
              type: mapDiscordContentType(att.contentType),
              localPath: result.localPath,
              mimeType: att.contentType || 'application/octet-stream',
              fileName: att.name || undefined,
              fileSize: result.fileSize,
              width: att.width || undefined,
              height: att.height || undefined,
            });
          }
        }
        if (attachments.length === 0) attachments = undefined;
      }

      // 打印完整的输入消息日志
      this.log(`[Discord] 收到消息:`, JSON.stringify({
        sender: senderName,
        senderId,
        conversationId,
        chatType: isDM ? 'direct' : 'group',
        messageId: message.id,
        content: cleanedContent,
        guildId: guildId || null,
        channelId,
        attachmentsCount: attachments?.length || 0,
      }, null, 2));

      // Create IMMessage
      const imMessage: IMMessage = {
        platform: 'discord',
        messageId: message.id,
        conversationId: conversationId,
        senderId: senderId,
        senderName: senderName,
        content: cleanedContent,
        chatType: isDM ? 'direct' : 'group',
        timestamp: message.createdTimestamp,
        attachments,
      };
      this.status.lastInboundAt = Date.now();

      // Create reply function with media support
      // Store last channel ID for notifications
      this.lastChannelId = channelId;

      const replyFn = async (text: string) => {
        // 打印完整的输出消息日志
        this.log(`[Discord] 发送回复:`, JSON.stringify({
          conversationId,
          replyLength: text.length,
          reply: text,
        }, null, 2));

        try {
          // Parse media markers from text
          const markers = parseMediaMarkers(text);
          const validFiles: Array<{ path: string; name?: string }> = [];

          this.log(`[Discord Gateway] 解析媒体标记:`, JSON.stringify({
            textLength: text.length,
            markersCount: markers.length,
            markers: markers.map(m => ({ type: m.type, path: m.path, name: m.name })),
          }));

          // Check which files exist
          for (const marker of markers) {
            // Expand ~ to home directory
            let filePath = marker.path;
            if (filePath.startsWith('~/')) {
              filePath = path.join(process.env.HOME || '', filePath.slice(2));
            }
            if (fs.existsSync(filePath)) {
              const stats = fs.statSync(filePath);
              this.log(`[Discord Gateway] 发现有效媒体文件:`, JSON.stringify({
                path: filePath,
                name: marker.name,
                type: marker.type,
                fileSize: stats.size,
                fileSizeKB: (stats.size / 1024).toFixed(1),
              }));
              validFiles.push({ path: filePath, name: marker.name });
            } else {
              console.warn(`[Discord Gateway] Media file not found: ${filePath}`);
            }
          }

          // Strip media markers from text if we have valid files
          const textContent = validFiles.length > 0 ? stripMediaMarkers(text, markers) : text;

          // Build attachments with custom names
          const attachments = validFiles.map(file => {
            const attachment = new AttachmentBuilder(file.path);
            if (file.name) {
              const ext = path.extname(file.path);
              attachment.setName(`${file.name}${ext}`);
            }
            return attachment;
          });

          this.log(`[Discord Gateway] 准备发送:`, JSON.stringify({
            textLength: textContent.length,
            attachmentsCount: attachments.length,
            attachmentNames: validFiles.map(f => f.name || path.basename(f.path)),
          }));

          // Split long messages (Discord limit is 2000 characters)
          const MAX_LENGTH = 1900; // Leave some margin

          if (textContent.length <= MAX_LENGTH) {
            // Send text with attachments in first message
            if (attachments.length > 0) {
              await message.reply({ content: textContent || undefined, files: attachments });
              this.log(`[Discord Gateway] 已发送文本+附件消息`);
            } else if (textContent) {
              await message.reply(textContent);
              this.log(`[Discord Gateway] 已发送纯文本消息`);
            }
          } else {
            // Split by newlines or by length
            const chunks = this.splitMessage(textContent, MAX_LENGTH);
            this.log(`[Discord Gateway] 消息过长，拆分为 ${chunks.length} 条`);
            for (let i = 0; i < chunks.length; i++) {
              if (i === 0) {
                // First message: reply with attachments
                if (attachments.length > 0) {
                  await message.reply({ content: chunks[i], files: attachments });
                } else {
                  await message.reply(chunks[i]);
                }
              } else {
                // Subsequent messages: just send text
                if ('send' in message.channel && typeof message.channel.send === 'function') {
                  await message.channel.send(chunks[i]);
                }
              }
            }
            this.log(`[Discord Gateway] 已发送全部 ${chunks.length} 条消息`);
          }
          this.status.lastOutboundAt = Date.now();
        } catch (replyError: any) {
          console.error(`[Discord Gateway] Failed to send reply: ${replyError.message}`);
        }
      };

      // Emit message event
      this.emit('message', imMessage);

      // Call message callback if set
      if (this.onMessageCallback) {
        try {
          await this.onMessageCallback(imMessage, replyFn);
        } catch (error: any) {
          console.error(`[Discord Gateway] Error in message callback: ${error.message}`);
          await replyFn(`处理消息时出错: ${error.message}`);
        }
      }
    } catch (error: any) {
      console.error(`[Discord Gateway] Error handling message: ${error.message}`);
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

      // Try to split at newline
      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // Try to split at space
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        // Force split at maxLength
        splitIndex = maxLength;
      }

      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).trim();
    }

    return chunks;
  }

  /**
   * Get the current notification target for persistence.
   */
  getNotificationTarget(): string | null {
    return this.lastChannelId;
  }

  /**
   * Restore notification target from persisted state.
   */
  setNotificationTarget(channelId: string): void {
    this.lastChannelId = channelId;
  }

  /**
   * Send a notification message to the last known channel.
   */
  async sendNotification(text: string): Promise<void> {
    if (!this.client || !this.lastChannelId) {
      throw new Error('No conversation available for notification');
    }
    this.log(`[Discord Gateway] 发送通知消息:`, JSON.stringify({
      channelId: this.lastChannelId,
      textLength: text.length,
      text,
    }));
    const channel = await this.client.channels.fetch(this.lastChannelId);
    if (channel && channel.isTextBased() && 'send' in channel) {
      await (channel as any).send(text);
      this.log(`[Discord Gateway] 通知消息已发送`);
      this.status.lastOutboundAt = Date.now();
    } else {
      throw new Error('Channel is not text-based or not accessible');
    }
  }

  /**
   * Send a notification message with media support to the last known channel.
   */
  async sendNotificationWithMedia(text: string): Promise<void> {
    if (!this.client || !this.lastChannelId) {
      throw new Error('No conversation available for notification');
    }

    const channel = await this.client.channels.fetch(this.lastChannelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error('Channel is not text-based or not accessible');
    }

    const markers = parseMediaMarkers(text);
    const validFiles: Array<{ path: string; name?: string }> = [];

    for (const marker of markers) {
      let filePath = marker.path;
      if (filePath.startsWith('~/')) {
        filePath = path.join(process.env.HOME || '', filePath.slice(2));
      }
      if (fs.existsSync(filePath)) {
        validFiles.push({ path: filePath, name: marker.name });
      } else {
        console.warn(`[Discord Gateway] Notification media file not found: ${filePath}`);
      }
    }

    const textContent = validFiles.length > 0 ? stripMediaMarkers(text, markers) : text;
    const attachments = validFiles.map(file => {
      const attachment = new AttachmentBuilder(file.path);
      if (file.name) {
        const ext = path.extname(file.path);
        attachment.setName(`${file.name}${ext}`);
      }
      return attachment;
    });

    const MAX_LENGTH = 1900;
    const chunks = this.splitMessage(textContent, MAX_LENGTH);

    for (let i = 0; i < chunks.length; i++) {
      if (i === 0 && attachments.length > 0) {
        await (channel as any).send({ content: chunks[i] || undefined, files: attachments });
      } else if (chunks[i]) {
        await (channel as any).send(chunks[i]);
      }
    }

    if (chunks.length === 0 && attachments.length > 0) {
      await (channel as any).send({ files: attachments });
    }

    this.status.lastOutboundAt = Date.now();
  }
}
