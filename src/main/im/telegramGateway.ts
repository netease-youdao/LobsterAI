/**
 * Telegram Gateway
 * Manages Telegram bot using polling mode with grammy
 * Supports text messages and media (photo, video, audio, voice, document, sticker)
 */

import { EventEmitter } from 'events';
import { Bot, InputFile, type BotError, type Context } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';
import * as fs from 'fs';
import * as path from 'path';
import {
  TelegramConfig,
  TelegramGatewayStatus,
  IMMessage,
  IMMediaAttachment,
  DEFAULT_TELEGRAM_STATUS,
} from './types';
import { extractMediaFromMessage, cleanupOldMediaFiles } from './telegramMedia';
import { parseMediaMarkers } from './dingtalkMediaParser';
import { fetchWithSystemProxy } from './http';

/**
 * Custom fetch wrapper that uses Node.js native AbortController
 * instead of the abort-controller polyfill.
 *
 * This is needed because:
 * 1. grammy uses abort-controller polyfill to create AbortSignal
 * 2. node-fetch checks signal via `proto.constructor.name === 'AbortSignal'`
 * 3. After esbuild bundling, the polyfill's class name may be mangled
 * 4. This causes "Expected signal to be an instanceof AbortSignal" error
 *
 * Solution: Create a new native AbortController and link it to grammy's signal
 */
async function grammyFetch(url: string, options: RequestInit = {}): Promise<Response> {
  // If there's a signal from grammy, create a native AbortController
  // and link the abort event
  if (options.signal) {
    const grammySignal = options.signal;
    const nativeController = new AbortController();

    // If already aborted, abort immediately
    if (grammySignal.aborted) {
      nativeController.abort();
    } else {
      // Link grammy's signal to native controller
      grammySignal.addEventListener('abort', () => {
        nativeController.abort();
      });
    }

    // Replace the signal with native one
    options = { ...options, signal: nativeController.signal };
  }

  return fetchWithSystemProxy(url, options);
}

// 媒体组缓冲接口
interface MediaGroupBuffer {
  messages: IMMessage[];
  ctx: Context;  // 保存第一条消息的 ctx 用于回复
  timeout: NodeJS.Timeout;
}

export class TelegramGateway extends EventEmitter {
  private bot: Bot | null = null;
  private runner: RunnerHandle | null = null;
  private config: TelegramConfig | null = null;
  private status: TelegramGatewayStatus = { ...DEFAULT_TELEGRAM_STATUS };
  private onMessageCallback?: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>;
  private lastChatId: number | null = null;

  // 媒体组缓冲 Map (mediaGroupId -> buffer)
  private mediaGroupBuffers: Map<string, MediaGroupBuffer> = new Map();
  private readonly MEDIA_GROUP_TIMEOUT = 500;  // 500ms 缓冲窗口

  // 定期清理任务
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
  }

  /**
   * Get current gateway status
   */
  getStatus(): TelegramGatewayStatus {
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
    if (!this.bot && this.config) {
      console.log('[Telegram Gateway] External reconnection trigger');
      this.start(this.config).catch((error) => {
        console.error('[Telegram Gateway] Reconnection failed:', error.message);
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
  updateConfig(config: TelegramConfig): void {
    if (this.config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * Start Telegram gateway with polling mode
   */
  async start(config: TelegramConfig): Promise<void> {
    if (this.bot) {
      console.log('[Telegram Gateway] Already running, stopping first...');
      await this.stop();
    }

    if (!config.enabled) {
      console.log('[Telegram Gateway] Telegram is disabled in config');
      return;
    }

    if (!config.botToken) {
      throw new Error('Telegram bot token is required');
    }

    this.config = config;
    const log = config.debug ? console.log : () => {};

    log('[Telegram Gateway] Starting...');

    try {
      // Create bot instance with custom fetch wrapper
      // The wrapper converts grammy's polyfill AbortSignal to native AbortSignal
      // to avoid "Expected signal to be an instanceof AbortSignal" errors
      this.bot = new Bot(config.botToken, {
        client: {
          // Use our custom fetch wrapper
          fetch: grammyFetch as any,
          // Increase API timeout to 60 seconds for file uploads (default is 500s which is too long)
          timeoutSeconds: 60,
        },
      });

      // Register error handler
      this.bot.catch((err: BotError) => {
        console.error(`[Telegram Gateway] Bot error: ${err.message}`);
        this.status.lastError = err.message;
        this.emit('error', err);
      });

      // Register message handler for ALL message types (text + media)
      this.bot.on('message', async (ctx: Context) => {
        await this.handleMessage(ctx);
      });

      // Get bot info to verify token and get username
      const botInfo = await this.bot.api.getMe();
      console.log(`[Telegram Gateway] Bot info: @${botInfo.username}`);

      // Start polling using grammyjs/runner for concurrent update processing
      this.runner = run(this.bot, {
        runner: {
          fetch: {
            timeout: 30,
          },
          silent: true,
          retryInterval: 'exponential',
        },
      });

      this.status = {
        connected: true,
        startedAt: Date.now(),
        lastError: null,
        botUsername: botInfo.username || null,
        lastInboundAt: null,
        lastOutboundAt: null,
      };

      // 启动时清理旧媒体文件
      cleanupOldMediaFiles(7);

      // 设置定期清理任务（每 24 小时）
      this.cleanupInterval = setInterval(() => {
        cleanupOldMediaFiles(7);
      }, 24 * 60 * 60 * 1000);

      console.log(`[Telegram Gateway] Connected successfully as @${botInfo.username}`);
      this.emit('connected');

    } catch (error: any) {
      console.error(`[Telegram Gateway] Failed to start: ${error.message}`);
      this.status = {
        connected: false,
        startedAt: null,
        lastError: error.message,
        botUsername: null,
        lastInboundAt: null,
        lastOutboundAt: null,
      };
      this.bot = null;
      this.runner = null;
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop Telegram gateway
   */
  async stop(): Promise<void> {
    if (!this.bot && !this.runner) {
      console.log('[Telegram Gateway] Not running');
      return;
    }

    const log = this.config?.debug ? console.log : () => {};
    log('[Telegram Gateway] Stopping...');

    try {
      // 清理定期任务
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }

      // 清理媒体组缓冲
      for (const [, buffer] of this.mediaGroupBuffers) {
        clearTimeout(buffer.timeout);
      }
      this.mediaGroupBuffers.clear();

      // Stop the runner first
      if (this.runner) {
        const runner = this.runner;
        this.runner = null;
        try {
          await runner.stop();
        } catch (e) {
          // Ignore stop errors
        }
      }

      // Clear bot reference
      this.bot = null;

      this.status = {
        connected: false,
        startedAt: null,
        lastError: null,
        botUsername: null,
        lastInboundAt: null,
        lastOutboundAt: null,
      };

      log('[Telegram Gateway] Stopped');
      this.emit('disconnected');
    } catch (error: any) {
      console.error(`[Telegram Gateway] Error stopping: ${error.message}`);
      this.status.lastError = error.message;
    }
  }

  /**
   * Handle incoming Telegram message (with media support)
   */
  private async handleMessage(ctx: Context): Promise<void> {
    try {
      const message = ctx.message;
      if (!message) return;

      // Ignore messages from the bot itself
      if (message.from?.is_bot) return;

      const chatId = message.chat.id;
      const chatType = message.chat.type;
      const isGroup = chatType === 'group' || chatType === 'supergroup';

      // Build sender info
      const senderName = message.from
        ? [message.from.first_name, message.from.last_name].filter(Boolean).join(' ').trim() || message.from.username
        : 'Unknown';
      const senderId = message.from?.id?.toString() || 'unknown';

      // Check allowed user IDs whitelist
      if (this.config?.allowedUserIds && this.config.allowedUserIds.length > 0) {
        const log = this.config?.debug ? console.log : () => {};
        log(`[Telegram] 白名单校验: senderId=${senderId}, allowedUserIds=${JSON.stringify(this.config.allowedUserIds)}`);
        if (!this.config.allowedUserIds.includes(senderId)) {
          console.log(`[Telegram] 消息被拒绝 - 发送者 ${senderId} (${senderName}) 不在白名单中`);
          return;
        }
        log(`[Telegram] 白名单校验通过: ${senderId} (${senderName})`);
      }

      // Extract text content (could be text or caption)
      const textContent = message.text || message.caption || '';

      // Extract media attachments
      const attachments = await extractMediaFromMessage(ctx);

      // Skip if no content and no attachments
      if (!textContent && attachments.length === 0) {
        return;
      }

      // Build content description for media
      let content = textContent;
      if (!content && attachments.length > 0) {
        // Generate descriptive content for media-only messages
        content = this.generateMediaDescription(attachments);
      }

      // 打印完整的输入消息日志
      console.log(`[Telegram] 收到消息:`, JSON.stringify({
        sender: senderName,
        senderId,
        chatId,
        chatType: isGroup ? 'group' : 'direct',
        content,
        attachments: attachments.length > 0 ? attachments : undefined,
        mediaGroupId: message.media_group_id,
      }, null, 2));

      // Create IMMessage
      const imMessage: IMMessage = {
        platform: 'telegram',
        messageId: message.message_id.toString(),
        conversationId: chatId.toString(),
        senderId: senderId,
        senderName: senderName,
        content: content,
        chatType: isGroup ? 'group' : 'direct',
        timestamp: message.date * 1000,
        attachments: attachments.length > 0 ? attachments : undefined,
        mediaGroupId: message.media_group_id,
      };

      // Handle media group (multiple photos/videos sent together)
      if (message.media_group_id) {
        await this.handleMediaGroup(imMessage, ctx);
        return;
      }

      // Process single message
      await this.processMessage(imMessage, ctx);

    } catch (error: any) {
      console.error(`[Telegram Gateway] Error handling message: ${error.message}`);
      this.status.lastError = error.message;
      this.emit('error', error);
    }
  }

  /**
   * Handle media group messages (buffer and merge)
   */
  private async handleMediaGroup(message: IMMessage, ctx: Context): Promise<void> {
    const log = this.config?.debug ? console.log : () => {};
    const groupId = message.mediaGroupId!;

    log(`[Telegram Gateway] 媒体组消息添加到缓冲: groupId=${groupId}`);

    let buffer = this.mediaGroupBuffers.get(groupId);

    if (buffer) {
      // Add to existing buffer
      buffer.messages.push(message);
      // Reset timeout
      clearTimeout(buffer.timeout);
      buffer.timeout = setTimeout(() => this.flushMediaGroup(groupId), this.MEDIA_GROUP_TIMEOUT);
    } else {
      // Create new buffer
      buffer = {
        messages: [message],
        ctx: ctx,
        timeout: setTimeout(() => this.flushMediaGroup(groupId), this.MEDIA_GROUP_TIMEOUT),
      };
      this.mediaGroupBuffers.set(groupId, buffer);
    }
  }

  /**
   * Flush media group buffer and process merged message
   */
  private async flushMediaGroup(groupId: string): Promise<void> {
    const log = this.config?.debug ? console.log : () => {};
    const buffer = this.mediaGroupBuffers.get(groupId);
    if (!buffer || buffer.messages.length === 0) return;

    this.mediaGroupBuffers.delete(groupId);

    // Sort messages by message_id to maintain order
    buffer.messages.sort((a, b) => parseInt(a.messageId) - parseInt(b.messageId));

    // Merge all messages into one
    const firstMessage = buffer.messages[0];
    const allAttachments: IMMediaAttachment[] = [];
    let content = '';

    for (const msg of buffer.messages) {
      if (msg.attachments) {
        allAttachments.push(...msg.attachments);
      }
      // Use first non-empty content (caption)
      if (msg.content && !content) {
        // Skip auto-generated descriptions
        if (!msg.content.startsWith('[图片') && !msg.content.startsWith('[视频') &&
            !msg.content.startsWith('[媒体组')) {
          content = msg.content;
        }
      }
    }

    // Generate content if still empty
    if (!content && allAttachments.length > 0) {
      content = `[媒体组: ${allAttachments.length} 个文件]`;
    }

    // Create merged message
    const mergedMessage: IMMessage = {
      ...firstMessage,
      content,
      attachments: allAttachments,
    };

    log(`[Telegram Gateway] 媒体组合并完成:`, JSON.stringify({
      groupId,
      messageCount: buffer.messages.length,
      attachmentsCount: allAttachments.length,
    }));

    await this.processMessage(mergedMessage, buffer.ctx);
  }

  /**
   * Process a single message (or merged media group)
   */
  private async processMessage(imMessage: IMMessage, ctx: Context): Promise<void> {
    const log = this.config?.debug ? console.log : () => {};
    this.status.lastInboundAt = Date.now();

    // Store last chat ID for notifications
    this.lastChatId = ctx.chat?.id ?? null;

    // Create reply function with media support
    const replyFn = async (text: string) => {
      // 打印完整的输出消息日志
      console.log(`[Telegram] 发送回复:`, JSON.stringify({
        conversationId: imMessage.conversationId,
        replyLength: text.length,
        reply: text,
      }, null, 2));

      try {
        // Parse media markers from text
        const markers = parseMediaMarkers(text);
        const validFiles: Array<{ path: string; name?: string; type: string }> = [];

        log(`[Telegram Gateway] 解析媒体标记:`, JSON.stringify({
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
            log(`[Telegram Gateway] 发现有效媒体文件:`, JSON.stringify({
              path: filePath,
              name: marker.name,
              type: marker.type,
              fileSize: stats.size,
              fileSizeKB: (stats.size / 1024).toFixed(1),
            }));
            validFiles.push({ path: filePath, name: marker.name, type: marker.type });
          } else {
            console.warn(`[Telegram Gateway] Media file not found: ${filePath}`);
          }
        }

        // Strip media markers from text if we have valid files
        // 注意：保留原始 markdown 文本，不移除媒体标记
        const textContent = text;

        // Send media files first (with retry logic)
        const MAX_RETRIES = 3;
        const RETRY_DELAY = 2000; // 2 seconds

        for (const file of validFiles) {
          const sendMedia = async (): Promise<boolean> => {
            // 使用 Buffer 而不是文件路径，避免 node-fetch 流式读取问题
            const fileBuffer = fs.readFileSync(file.path);
            const fileName = path.basename(file.path);
            const inputFile = new InputFile(fileBuffer, fileName);
            const ext = path.extname(file.path).toLowerCase();
            const startTime = Date.now();

            // Get chat info for logging
            const chatId = ctx.chat?.id;
            const replyToMessageId = ctx.message?.message_id;
            const botToken = this.config?.botToken || '';
            // 完整 URL（不脱敏，用于调试）

            // Choose appropriate send method based on file type
            if (file.type === 'image' || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
              log(`[Telegram Gateway] 调用 sendPhoto API:`, JSON.stringify({
                url: `https://api.telegram.org/bot${botToken}/sendPhoto`,
                method: 'POST',
                params: {
                  chat_id: chatId,
                  reply_to_message_id: replyToMessageId,
                  caption: file.name,
                  photo: `[Buffer: ${fileBuffer.length} bytes, fileName: ${fileName}]`,
                },
              }));
              const result = await ctx.replyWithPhoto(inputFile, {
                caption: file.name,
              });
              log(`[Telegram Gateway] sendPhoto 成功:`, JSON.stringify({
                messageId: result.message_id,
                chatId: result.chat.id,
                duration: Date.now() - startTime,
              }));
            } else if (file.type === 'video' || ['.mp4', '.mov', '.avi', '.webm'].includes(ext)) {
              log(`[Telegram Gateway] 调用 sendVideo API:`, JSON.stringify({
                url: `https://api.telegram.org/bot${botToken}/sendVideo`,
                method: 'POST',
                params: {
                  chat_id: chatId,
                  reply_to_message_id: replyToMessageId,
                  caption: file.name,
                  video: `[Buffer: ${fileBuffer.length} bytes, fileName: ${fileName}]`,
                },
              }));
              const result = await ctx.replyWithVideo(inputFile, {
                caption: file.name,
              });
              log(`[Telegram Gateway] sendVideo 成功:`, JSON.stringify({
                messageId: result.message_id,
                chatId: result.chat.id,
                duration: Date.now() - startTime,
              }));
            } else if (file.type === 'audio' || ['.mp3', '.ogg', '.wav', '.m4a', '.aac'].includes(ext)) {
              log(`[Telegram Gateway] 调用 sendAudio API:`, JSON.stringify({
                url: `https://api.telegram.org/bot${botToken}/sendAudio`,
                method: 'POST',
                params: {
                  chat_id: chatId,
                  reply_to_message_id: replyToMessageId,
                  caption: file.name,
                  title: file.name,
                  audio: `[Buffer: ${fileBuffer.length} bytes, fileName: ${fileName}]`,
                },
              }));
              const result = await ctx.replyWithAudio(inputFile, {
                caption: file.name,
                title: file.name,
              });
              log(`[Telegram Gateway] sendAudio 成功:`, JSON.stringify({
                messageId: result.message_id,
                chatId: result.chat.id,
                duration: Date.now() - startTime,
              }));
            } else {
              // Send as document for other file types
              log(`[Telegram Gateway] 调用 sendDocument API:`, JSON.stringify({
                url: `https://api.telegram.org/bot${botToken}/sendDocument`,
                method: 'POST',
                params: {
                  chat_id: chatId,
                  reply_to_message_id: replyToMessageId,
                  caption: file.name,
                  document: `[Buffer: ${fileBuffer.length} bytes, fileName: ${fileName}]`,
                },
              }));
              const result = await ctx.replyWithDocument(inputFile, {
                caption: file.name,
              });
              log(`[Telegram Gateway] sendDocument 成功:`, JSON.stringify({
                messageId: result.message_id,
                chatId: result.chat.id,
                duration: Date.now() - startTime,
              }));
            }
            return true;
          };

          // Try sending with retries
          let lastError: Error | null = null;
          const ext = path.extname(file.path).toLowerCase();
          const chatId = ctx.chat?.id;
          const replyToMessageId = ctx.message?.message_id;
          const botToken = this.config?.botToken || '';

          // Determine API method
          let apiMethod = 'sendDocument';
          if (file.type === 'image' || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
            apiMethod = 'sendPhoto';
          } else if (file.type === 'video' || ['.mp4', '.mov', '.avi', '.webm'].includes(ext)) {
            apiMethod = 'sendVideo';
          } else if (file.type === 'audio' || ['.mp3', '.ogg', '.wav', '.m4a', '.aac'].includes(ext)) {
            apiMethod = 'sendAudio';
          }

          // 完整 URL（不脱敏，用于调试）
          const fullUrl = `https://api.telegram.org/bot${botToken}/${apiMethod}`;

          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              const fileStats = fs.statSync(file.path);
              // 在每次尝试前打印详细的请求信息（显示完整 URL）
              console.log(`[Telegram Gateway] 发送媒体请求 (尝试 ${attempt}/${MAX_RETRIES}):`, JSON.stringify({
                url: fullUrl,
                method: 'POST',
                params: {
                  chat_id: chatId,
                  reply_to_message_id: replyToMessageId,
                  caption: file.name,
                },
                file: {
                  path: file.path,
                  name: file.name,
                  type: file.type,
                  fileSize: fileStats.size,
                  fileSizeKB: (fileStats.size / 1024).toFixed(1),
                  fileSizeMB: (fileStats.size / 1024 / 1024).toFixed(2),
                },
              }, null, 2));

              await sendMedia();
              lastError = null;
              break; // Success, exit retry loop
            } catch (mediaError: any) {
              lastError = mediaError;
              // 打印详细的失败信息（显示完整 URL）
              console.error(`[Telegram Gateway] 发送媒体失败 (尝试 ${attempt}/${MAX_RETRIES}):`, JSON.stringify({
                url: fullUrl,
                file: file.path,
                error: mediaError.message,
                errorName: mediaError.name,
                errorStack: mediaError.stack?.split('\n').slice(0, 3).join('\n'),
              }, null, 2));

              if (attempt < MAX_RETRIES) {
                console.log(`[Telegram Gateway] 等待 ${RETRY_DELAY}ms 后重试...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
              }
            }
          }

          if (lastError) {
            console.error(`[Telegram Gateway] 媒体发送最终失败 (${MAX_RETRIES}次尝试后):`, JSON.stringify({
              url: fullUrl,
              file: file.path,
              error: lastError.message,
            }));
          }
        }

        // Send text content
        if (textContent.trim()) {
          // Split long messages (Telegram limit is 4096 characters)
          const MAX_LENGTH = 4000;
          const chatId = ctx.chat?.id;
          const replyToMessageId = ctx.message?.message_id;
          const botToken = this.config?.botToken || '';
          // 完整 URL（不脱敏，用于调试）
          const fullUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

          if (textContent.length <= MAX_LENGTH) {
            const startTime = Date.now();
            log(`[Telegram Gateway] 调用 sendMessage API:`, JSON.stringify({
              url: fullUrl,
              method: 'POST',
              params: {
                chat_id: chatId,
                reply_to_message_id: replyToMessageId,
                text: textContent.slice(0, 100) + (textContent.length > 100 ? '...' : ''),
                textLength: textContent.length,
                parse_mode: 'Markdown',
              },
            }));
            try {
              const result = await ctx.reply(textContent, { parse_mode: 'Markdown' });
              log(`[Telegram Gateway] sendMessage 成功:`, JSON.stringify({
                messageId: result.message_id,
                chatId: result.chat.id,
                duration: Date.now() - startTime,
              }));
            } catch (mdError) {
              // Fallback to plain text if markdown fails
              log(`[Telegram Gateway] Markdown 解析失败，使用纯文本重试`);
              const result = await ctx.reply(textContent);
              log(`[Telegram Gateway] sendMessage (纯文本) 成功:`, JSON.stringify({
                messageId: result.message_id,
                chatId: result.chat.id,
                duration: Date.now() - startTime,
              }));
            }
          } else {
            // Split by newlines or by length
            const chunks = this.splitMessage(textContent, MAX_LENGTH);
            log(`[Telegram Gateway] 消息过长，拆分为 ${chunks.length} 条`);
            for (let i = 0; i < chunks.length; i++) {
              const chunk = chunks[i];
              const startTime = Date.now();
              log(`[Telegram Gateway] 调用 sendMessage API (分段 ${i + 1}/${chunks.length}):`, JSON.stringify({
                url: fullUrl,
                method: 'POST',
                params: {
                  chat_id: chatId,
                  reply_to_message_id: i === 0 ? replyToMessageId : undefined,
                  text: chunk.slice(0, 100) + (chunk.length > 100 ? '...' : ''),
                  chunkLength: chunk.length,
                  parse_mode: 'Markdown',
                },
              }));
              try {
                const result = await ctx.reply(chunk, { parse_mode: 'Markdown' });
                log(`[Telegram Gateway] sendMessage 成功 (分段 ${i + 1}/${chunks.length}):`, JSON.stringify({
                  messageId: result.message_id,
                  chatId: result.chat.id,
                  duration: Date.now() - startTime,
                }));
              } catch (mdError) {
                const result = await ctx.reply(chunk);
                log(`[Telegram Gateway] sendMessage (纯文本) 成功 (分段 ${i + 1}/${chunks.length}):`, JSON.stringify({
                  messageId: result.message_id,
                  chatId: result.chat.id,
                  duration: Date.now() - startTime,
                }));
              }
            }
            log(`[Telegram Gateway] 已发送全部 ${chunks.length} 条消息`);
          }
        }
        this.status.lastOutboundAt = Date.now();
      } catch (replyError: any) {
        console.error(`[Telegram Gateway] Failed to send reply: ${replyError.message}`);
      }
    };

    // Emit message event
    this.emit('message', imMessage);

    // Call message callback if set
    if (this.onMessageCallback) {
      try {
        await this.onMessageCallback(imMessage, replyFn);
      } catch (error: any) {
        console.error(`[Telegram Gateway] Error in message callback: ${error.message}`);
        await replyFn(`❌ 处理消息时出错: ${error.message}`);
      }
    }
  }

  /**
   * Generate description for media-only messages
   */
  private generateMediaDescription(attachments: IMMediaAttachment[]): string {
    if (attachments.length === 1) {
      const att = attachments[0];
      switch (att.type) {
        case 'image':
          return `[图片: ${att.localPath}]`;
        case 'video':
          return `[视频: ${att.fileName || att.localPath}]`;
        case 'audio':
          return `[音频: ${att.fileName || att.localPath}]`;
        case 'voice':
          return `[语音消息: ${att.localPath}]`;
        case 'document':
          return `[文件: ${att.fileName || att.localPath}]`;
        case 'sticker':
          return `[贴纸: ${att.localPath}]`;
        default:
          return `[媒体: ${att.localPath}]`;
      }
    }
    return `[媒体组: ${attachments.length} 个文件]`;
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
   * Send a notification message to the last known chat.
   */
  async sendNotification(text: string): Promise<void> {
    if (!this.bot || !this.lastChatId) {
      throw new Error('No conversation available for notification');
    }
    await this.bot.api.sendMessage(this.lastChatId, text);
    this.status.lastOutboundAt = Date.now();
  }
}
