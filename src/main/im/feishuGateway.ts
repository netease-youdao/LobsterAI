/**
 * Feishu/Lark Gateway
 * Manages WebSocket connection for receiving messages
 * Adapted from im-gateway for Electron main process
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
  FeishuConfig,
  FeishuGatewayStatus,
  FeishuMessageContext,
  IMMessage,
  IMMediaAttachment,
  DEFAULT_FEISHU_STATUS,
} from './types';
import {
  uploadImageToFeishu,
  uploadFileToFeishu,
  detectFeishuFileType,
  isFeishuImagePath,
  isFeishuAudioPath,
  resolveFeishuMediaPath,
  downloadFeishuMedia,
  getFeishuDefaultMimeType,
  mapFeishuMediaType,
} from './feishuMedia';
import { parseMediaMarkers } from './dingtalkMediaParser';
import { stringifyAsciiJson } from './jsonEncoding';
import { isSystemProxyEnabled, resolveSystemProxyUrl } from '../libs/systemProxy';

// Message deduplication cache
const processedMessages = new Map<string, number>();
const MESSAGE_DEDUP_TTL = 5 * 60 * 1000; // 5 minutes

// Feishu message event structure
interface FeishuMessageEvent {
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; user_id?: string };
      name: string;
    }>;
  };
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
    };
    sender_type: string;
  };
}

export class FeishuGateway extends EventEmitter {
  private wsClient: any = null;
  private restClient: any = null;
  private config: FeishuConfig | null = null;
  private status: FeishuGatewayStatus = { ...DEFAULT_FEISHU_STATUS };
  private botOpenId: string | null = null;
  private onMessageCallback?: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>;
  private lastChatId: string | null = null;
  private log: (...args: any[]) => void = () => {};

  constructor() {
    super();
  }

  /**
   * Get current gateway status
   */
  getStatus(): FeishuGatewayStatus {
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
    if (!this.wsClient && this.config) {
      this.log('[Feishu Gateway] External reconnection trigger');
      this.start(this.config).catch((error) => {
        console.error('[Feishu Gateway] Reconnection failed:', error.message);
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
   * Start Feishu gateway
   */
  async start(config: FeishuConfig): Promise<void> {
    if (this.wsClient) {
      throw new Error('Feishu gateway already running');
    }

    if (!config.enabled) {
      console.log('[Feishu Gateway] Feishu is disabled in config');
      return;
    }

    if (!config.appId || !config.appSecret) {
      throw new Error('Feishu appId and appSecret are required');
    }

    this.config = config;
    this.log = config.debug ? console.log.bind(console) : () => {};

    this.log('[Feishu Gateway] Starting WebSocket gateway...');

    try {
      // Dynamically import @larksuiteoapi/node-sdk
      const Lark = await import('@larksuiteoapi/node-sdk');

      // Resolve domain
      const domain = this.resolveDomain(config.domain, Lark);

      // Create REST client for sending messages
      this.restClient = new Lark.Client({
        appId: config.appId,
        appSecret: config.appSecret,
        appType: Lark.AppType.SelfBuild,
        domain,
      });

      // Probe bot info to get open_id
      const probeResult = await this.probeBot();
      if (!probeResult.ok) {
        throw new Error(`Failed to probe bot: ${probeResult.error}`);
      }

      this.botOpenId = probeResult.botOpenId || null;
      this.log(`[Feishu Gateway] Bot info: ${probeResult.botName} (${this.botOpenId})`);

      // Resolve proxy agent for WebSocket if system proxy is enabled
      let proxyAgent: any = undefined;
      if (isSystemProxyEnabled()) {
        const feishuTarget = domain === Lark.Domain.Feishu
          ? 'https://open.feishu.cn'
          : 'https://open.larksuite.com';
        const proxyUrl = await resolveSystemProxyUrl(feishuTarget);
        if (proxyUrl) {
          try {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            proxyAgent = new HttpsProxyAgent(proxyUrl);
            this.log(`[Feishu Gateway] Using proxy agent for WebSocket: ${proxyUrl}`);
          } catch (e: any) {
            console.warn(`[Feishu Gateway] Failed to create proxy agent: ${e.message}`);
          }
        }
      }

      // Create WebSocket client
      this.wsClient = new Lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        domain,
        loggerLevel: config.debug ? Lark.LoggerLevel.debug : Lark.LoggerLevel.info,
        agent: proxyAgent,
      });

      // Create event dispatcher
      const eventDispatcher = new Lark.EventDispatcher({
        encryptKey: config.encryptKey,
        verificationToken: config.verificationToken,
      });

      // Register event handlers
      eventDispatcher.register({
        'im.message.receive_v1': async (data: any) => {
          try {
            const event = data as FeishuMessageEvent;

            // Check for duplicate
            if (this.isMessageProcessed(event.message.message_id)) {
              this.log(`[Feishu Gateway] Duplicate message ignored: ${event.message.message_id}`);
              return;
            }

            const ctx = this.parseMessageEvent(event);
            await this.handleInboundMessage(ctx);
          } catch (err: any) {
            console.error(`[Feishu Gateway] Error handling message: ${err.message}`);
          }
        },
        'im.message.message_read_v1': async () => {
          // Ignore read receipts
        },
        'im.chat.member.bot.added_v1': async (data: any) => {
          this.log(`[Feishu Gateway] Bot added to chat ${data.chat_id}`);
        },
        'im.chat.member.bot.deleted_v1': async (data: any) => {
          this.log(`[Feishu Gateway] Bot removed from chat ${data.chat_id}`);
        },
      });

      // Start WebSocket client
      this.wsClient.start({ eventDispatcher });

      this.status = {
        connected: true,
        startedAt: new Date().toISOString(),
        botOpenId: this.botOpenId,
        error: null,
        lastInboundAt: null,
        lastOutboundAt: null,
      };

      this.log('[Feishu Gateway] WebSocket gateway started successfully');
      this.emit('connected');
    } catch (error: any) {
      this.wsClient = null;
      this.restClient = null;
      this.status = {
        connected: false,
        startedAt: null,
        botOpenId: null,
        error: error.message,
        lastInboundAt: null,
        lastOutboundAt: null,
      };
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop Feishu gateway
   */
  async stop(): Promise<void> {
    if (!this.wsClient) {
      this.log('[Feishu Gateway] Not running');
      return;
    }

    this.log('[Feishu Gateway] Stopping WebSocket gateway...');

    this.wsClient = null;
    this.restClient = null;
    this.config = null;
    this.status = {
      connected: false,
      startedAt: null,
      botOpenId: this.status.botOpenId,
      error: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    };

    this.log('[Feishu Gateway] WebSocket gateway stopped');
    this.emit('disconnected');
  }

  /**
   * Resolve domain to Lark SDK domain
   */
  private resolveDomain(domain: string, Lark: any): any {
    if (domain === 'lark') return Lark.Domain.Lark;
    if (domain === 'feishu') return Lark.Domain.Feishu;
    return domain.replace(/\/+$/, '');
  }

  /**
   * Probe bot info
   */
  private async probeBot(): Promise<{
    ok: boolean;
    error?: string;
    botName?: string;
    botOpenId?: string;
  }> {
    try {
      const response: any = await this.restClient.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });

      if (response.code !== 0) {
        return { ok: false, error: response.msg };
      }

      return {
        ok: true,
        botName: response.data?.app_name ?? response.data?.bot?.app_name,
        botOpenId: response.data?.open_id ?? response.data?.bot?.open_id,
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
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
    for (const [messageId, timestamp] of processedMessages) {
      if (now - timestamp > MESSAGE_DEDUP_TTL) {
        processedMessages.delete(messageId);
      }
    }
  }

  /**
   * Parse message content
   */
  private parseMessageContent(content: string, messageType: string): string {
    try {
      const parsed = JSON.parse(content);
      if (messageType === 'text') {
        return parsed.text || '';
      }
      if (messageType === 'post') {
        return this.parsePostContent(content);
      }
      // For media types, return descriptive text (media keys extracted in parseMessageEvent)
      if (messageType === 'image') return '[图片]';
      if (messageType === 'audio') return '[语音]';
      if (messageType === 'video' || messageType === 'media') return '[视频]';
      if (messageType === 'file') return parsed.file_name ? `[文件: ${parsed.file_name}]` : '[文件]';
      return content;
    } catch {
      return content;
    }
  }

  /**
   * Parse post (rich text) content
   */
  private parsePostContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      const title = parsed.title || '';
      const contentBlocks = parsed.content || [];
      let textContent = title ? `${title}\n\n` : '';

      for (const paragraph of contentBlocks) {
        if (Array.isArray(paragraph)) {
          for (const element of paragraph) {
            if (element.tag === 'text') {
              textContent += element.text || '';
            } else if (element.tag === 'a') {
              textContent += element.text || element.href || '';
            } else if (element.tag === 'at') {
              textContent += `@${element.user_name || element.user_id || ''}`;
            }
          }
          textContent += '\n';
        }
      }

      return textContent.trim() || '[富文本消息]';
    } catch {
      return '[富文本消息]';
    }
  }

  /**
   * Check if bot was mentioned
   */
  private checkBotMentioned(event: FeishuMessageEvent): boolean {
    const mentions = event.message.mentions ?? [];
    if (mentions.length === 0) return false;
    if (!this.botOpenId) return mentions.length > 0;
    return mentions.some((m) => m.id.open_id === this.botOpenId);
  }

  /**
   * Strip bot mention from text
   */
  private stripBotMention(text: string, mentions?: FeishuMessageEvent['message']['mentions']): string {
    if (!mentions || mentions.length === 0) return text;
    let result = text;
    for (const mention of mentions) {
      result = result.replace(new RegExp(`@${mention.name}\\s*`, 'g'), '').trim();
      result = result.replace(new RegExp(mention.key, 'g'), '').trim();
    }
    return result;
  }

  /**
   * Parse Feishu message event
   */
  private parseMessageEvent(event: FeishuMessageEvent): FeishuMessageContext {
    const messageType = event.message.message_type;
    const rawContent = this.parseMessageContent(event.message.content, messageType);
    const mentionedBot = this.checkBotMentioned(event);
    const content = this.stripBotMention(rawContent, event.message.mentions);

    // Extract media keys from content JSON for media message types
    let mediaKey: string | undefined;
    let mediaType: string | undefined;
    let mediaFileName: string | undefined;
    let mediaDuration: number | undefined;

    if (['image', 'file', 'audio', 'video', 'media'].includes(messageType)) {
      try {
        const parsed = JSON.parse(event.message.content);
        mediaType = messageType;

        if (messageType === 'image') {
          mediaKey = parsed.image_key;
        } else {
          // file, audio, video, media all use file_key
          mediaKey = parsed.file_key;
          mediaFileName = parsed.file_name;
          if (parsed.duration !== undefined) {
            mediaDuration = typeof parsed.duration === 'string'
              ? parseInt(parsed.duration, 10)
              : parsed.duration;
          }
        }
      } catch {
        // JSON parse failed, skip media extraction
      }
    }

    return {
      chatId: event.message.chat_id,
      messageId: event.message.message_id,
      senderId: event.sender.sender_id.user_id || event.sender.sender_id.open_id || '',
      senderOpenId: event.sender.sender_id.open_id || '',
      chatType: event.message.chat_type,
      mentionedBot,
      rootId: event.message.root_id,
      parentId: event.message.parent_id,
      content,
      contentType: messageType,
      mediaKey,
      mediaType,
      mediaFileName,
      mediaDuration,
    };
  }

  /**
   * Resolve receive_id_type
   */
  private resolveReceiveIdType(target: string): 'open_id' | 'user_id' | 'chat_id' {
    if (target.startsWith('ou_')) return 'open_id';
    if (target.startsWith('oc_')) return 'chat_id';
    return 'chat_id';
  }

  /**
   * Send text message
   */
  private async sendTextMessage(to: string, text: string, replyToMessageId?: string): Promise<void> {
    const receiveIdType = this.resolveReceiveIdType(to);
    const content = stringifyAsciiJson({ text });

    if (replyToMessageId) {
      const response = await this.restClient.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'text' },
      });

      if (response.code !== 0) {
        throw new Error(`Feishu reply failed: ${response.msg || `code ${response.code}`}`);
      }
      return;
    }

    const response = await this.restClient.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: to, content, msg_type: 'text' },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu send failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  /**
   * Build markdown card
   */
  private buildMarkdownCard(text: string): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      elements: [{ tag: 'markdown', content: text }],
    };
  }

  /**
   * Send card message
   */
  private async sendCardMessage(to: string, text: string, replyToMessageId?: string): Promise<void> {
    const receiveIdType = this.resolveReceiveIdType(to);
    const card = this.buildMarkdownCard(text);
    const content = stringifyAsciiJson(card);

    if (replyToMessageId) {
      const response = await this.restClient.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'interactive' },
      });

      if (response.code !== 0) {
        throw new Error(`Feishu card reply failed: ${response.msg || `code ${response.code}`}`);
      }
      return;
    }

    const response = await this.restClient.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: to, content, msg_type: 'interactive' },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu card send failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  /**
   * Send message (auto-select format based on config)
   */
  private async sendMessage(to: string, text: string, replyToMessageId?: string): Promise<void> {
    const renderMode = this.config?.renderMode || 'text';

    this.log(`[Feishu Gateway] 发送文本消息:`, JSON.stringify({
      to,
      renderMode,
      replyToMessageId,
      textLength: text.length,
    }));

    if (renderMode === 'card') {
      await this.sendCardMessage(to, text, replyToMessageId);
    } else {
      await this.sendTextMessage(to, text, replyToMessageId);
    }
  }

  /**
   * Send image message
   */
  private async sendImageMessage(to: string, imageKey: string, replyToMessageId?: string): Promise<void> {
    const receiveIdType = this.resolveReceiveIdType(to);
    const content = stringifyAsciiJson({ image_key: imageKey });

    this.log(`[Feishu Gateway] 发送图片消息:`, JSON.stringify({
      to,
      imageKey,
      receiveIdType,
      replyToMessageId,
    }));

    if (replyToMessageId) {
      const response = await this.restClient.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'image' },
      });
      if (response.code !== 0) {
        throw new Error(`Feishu image reply failed: ${response.msg || `code ${response.code}`}`);
      }
      return;
    }

    const response = await this.restClient.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: to, content, msg_type: 'image' },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu image send failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  /**
   * Send file message
   */
  private async sendFileMessage(to: string, fileKey: string, replyToMessageId?: string): Promise<void> {
    const receiveIdType = this.resolveReceiveIdType(to);
    const content = stringifyAsciiJson({ file_key: fileKey });

    this.log(`[Feishu Gateway] 发送文件消息:`, JSON.stringify({
      to,
      fileKey,
      receiveIdType,
      replyToMessageId,
    }));

    if (replyToMessageId) {
      const response = await this.restClient.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'file' },
      });
      if (response.code !== 0) {
        throw new Error(`Feishu file reply failed: ${response.msg || `code ${response.code}`}`);
      }
      return;
    }

    const response = await this.restClient.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: to, content, msg_type: 'file' },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu file send failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  /**
   * Send audio message
   */
  private async sendAudioMessage(to: string, fileKey: string, duration?: number, replyToMessageId?: string): Promise<void> {
    const receiveIdType = this.resolveReceiveIdType(to);
    const content = stringifyAsciiJson({
      file_key: fileKey,
      ...(duration !== undefined && { duration: Math.floor(duration).toString() })
    });

    this.log(`[Feishu Gateway] 发送音频消息:`, JSON.stringify({
      to,
      fileKey,
      duration,
      receiveIdType,
      replyToMessageId,
    }));

    if (replyToMessageId) {
      const response = await this.restClient.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'audio' },
      });
      if (response.code !== 0) {
        throw new Error(`Feishu audio reply failed: ${response.msg || `code ${response.code}`}`);
      }
      return;
    }

    const response = await this.restClient.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: to, content, msg_type: 'audio' },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu audio send failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  /**
   * Upload and send media from file path
   * @param customFileName - 从 Markdown 解析出的自定义文件名（如 [今日新闻](file.txt) 中的"今日新闻"）
   */
  private async uploadAndSendMedia(
    to: string,
    filePath: string,
    mediaType: 'image' | 'video' | 'audio' | 'file',
    replyToMessageId?: string,
    customFileName?: string
  ): Promise<void> {
    // Resolve path
    const absPath = resolveFeishuMediaPath(filePath);

    if (!fs.existsSync(absPath)) {
      console.warn(`[Feishu Gateway] File not found: ${absPath}`);
      return;
    }

    // 使用自定义文件名或从路径提取，保留原始扩展名
    const originalFileName = path.basename(absPath);
    const ext = path.extname(absPath);
    const fileName = customFileName ? `${customFileName}${ext}` : originalFileName;
    const fileStats = fs.statSync(absPath);

    this.log(`[Feishu Gateway] 上传媒体:`, JSON.stringify({
      absPath,
      mediaType,
      originalFileName,
      customFileName,
      fileName,
      fileSize: fileStats.size,
      fileSizeKB: (fileStats.size / 1024).toFixed(1),
    }));

    if (mediaType === 'image' || isFeishuImagePath(absPath)) {
      // Upload image
      this.log(`[Feishu Gateway] 开始上传图片: ${fileName}`);
      const result = await uploadImageToFeishu(this.restClient, absPath);
      this.log(`[Feishu Gateway] 图片上传结果:`, JSON.stringify(result));
      if (!result.success || !result.imageKey) {
        console.warn(`[Feishu Gateway] Image upload failed: ${result.error}`);
        return;
      }
      await this.sendImageMessage(to, result.imageKey, replyToMessageId);
    } else if (mediaType === 'audio' || isFeishuAudioPath(absPath)) {
      // Upload audio
      this.log(`[Feishu Gateway] 开始上传音频: ${fileName}`);
      const result = await uploadFileToFeishu(this.restClient, absPath, fileName, 'opus');
      this.log(`[Feishu Gateway] 音频上传结果:`, JSON.stringify(result));
      if (!result.success || !result.fileKey) {
        console.warn(`[Feishu Gateway] Audio upload failed: ${result.error}`);
        return;
      }
      await this.sendAudioMessage(to, result.fileKey, undefined, replyToMessageId);
    } else {
      // Upload as file (including video - Feishu video requires cover image, send as file for simplicity)
      this.log(`[Feishu Gateway] 开始上传文件: ${fileName}`);
      const fileType = detectFeishuFileType(fileName);
      this.log(`[Feishu Gateway] 检测到文件类型: ${fileType}`);
      const result = await uploadFileToFeishu(this.restClient, absPath, fileName, fileType);
      this.log(`[Feishu Gateway] 文件上传结果:`, JSON.stringify(result));
      if (!result.success || !result.fileKey) {
        console.warn(`[Feishu Gateway] File upload failed: ${result.error}`);
        return;
      }
      await this.sendFileMessage(to, result.fileKey, replyToMessageId);
    }
  }

  /**
   * Send message with media support - detects and uploads media from text
   */
  private async sendWithMedia(to: string, text: string, replyToMessageId?: string): Promise<void> {
    // Parse media markers from text
    const markers = parseMediaMarkers(text);

    this.log(`[Feishu Gateway] 解析媒体标记:`, JSON.stringify({
      to,
      replyToMessageId,
      textLength: text.length,
      markersCount: markers.length,
      markers: markers.map(m => ({ type: m.type, path: m.path, name: m.name })),
    }));

    if (markers.length === 0) {
      // No media, send as text/card
      await this.sendMessage(to, text, replyToMessageId);
      return;
    }

    // Upload and send each media
    for (const marker of markers) {
      try {
        this.log(`[Feishu Gateway] 处理媒体:`, JSON.stringify(marker));
        // 传递从 markdown 解析出的文件名
        await this.uploadAndSendMedia(to, marker.path, marker.type, replyToMessageId, marker.name);
      } catch (error: any) {
        console.error(`[Feishu Gateway] Failed to send media: ${error.message}`);
      }
    }

    // Send the text message (keep full text for context)
    await this.sendMessage(to, text, replyToMessageId);
  }

  /**
   * Handle inbound message
   */
  private async handleInboundMessage(ctx: FeishuMessageContext): Promise<void> {
    // In group chat, only respond when bot is mentioned
    if (ctx.chatType === 'group' && !ctx.mentionedBot) {
      this.log('[Feishu Gateway] Ignoring group message without bot mention');
      return;
    }

    // Download media attachments if present
    let attachments: IMMediaAttachment[] | undefined;
    if (ctx.mediaKey && ctx.mediaType && this.restClient) {
      try {
        const result = await downloadFeishuMedia(
          this.restClient,
          ctx.messageId,
          ctx.mediaKey,
          ctx.mediaType,
          ctx.mediaFileName
        );
        if (result) {
          attachments = [{
            type: mapFeishuMediaType(ctx.mediaType),
            localPath: result.localPath,
            mimeType: getFeishuDefaultMimeType(ctx.mediaType, ctx.mediaFileName),
            fileName: ctx.mediaFileName,
            fileSize: result.fileSize,
            duration: ctx.mediaDuration ? ctx.mediaDuration / 1000 : undefined,
          }];
        }
      } catch (err: any) {
        console.error(`[Feishu] 下载媒体失败: ${err.message}`);
      }
    }

    // Create IMMessage
    const message: IMMessage = {
      platform: 'feishu',
      messageId: ctx.messageId,
      conversationId: ctx.chatId,
      senderId: ctx.senderId,
      content: ctx.content,
      chatType: ctx.chatType === 'p2p' ? 'direct' : 'group',
      timestamp: Date.now(),
      attachments,
    };
    this.status.lastInboundAt = Date.now();

    // 打印完整的输入消息日志
    this.log(`[Feishu] 收到消息:`, JSON.stringify({
      sender: ctx.senderOpenId,
      senderId: ctx.senderId,
      chatId: ctx.chatId,
      chatType: ctx.chatType === 'p2p' ? 'direct' : 'group',
      messageId: ctx.messageId,
      contentType: ctx.contentType,
      content: ctx.content,
      mentionedBot: ctx.mentionedBot,
      rootId: ctx.rootId,
      parentId: ctx.parentId,
      mediaKey: ctx.mediaKey,
      mediaType: ctx.mediaType,
      attachmentsCount: attachments?.length || 0,
    }, null, 2));

    // Create reply function with media support
    const replyFn = async (text: string) => {
      // 打印完整的输出消息日志
      this.log(`[Feishu] 发送回复:`, JSON.stringify({
        conversationId: ctx.chatId,
        replyToMessageId: ctx.messageId,
        replyLength: text.length,
        reply: text,
      }, null, 2));

      await this.sendWithMedia(ctx.chatId, text, ctx.messageId);
      this.status.lastOutboundAt = Date.now();
    };

    // Store last chat ID for notifications
    this.lastChatId = ctx.chatId;

    // Emit message event
    this.emit('message', message);

    // Call message callback if set
    if (this.onMessageCallback) {
      try {
        await this.onMessageCallback(message, replyFn);
      } catch (error: any) {
        console.error(`[Feishu Gateway] Error in message callback: ${error.message}`);
        await replyFn(`抱歉，处理消息时出现错误：${error.message}`);
      }
    }
  }

  /**
   * Get the current notification target for persistence.
   */
  getNotificationTarget(): string | null {
    return this.lastChatId;
  }

  /**
   * Restore notification target from persisted state.
   */
  setNotificationTarget(chatId: string): void {
    this.lastChatId = chatId;
  }

  /**
   * Send a notification message to the last known chat.
   */
  async sendNotification(text: string): Promise<void> {
    if (!this.lastChatId || !this.restClient) {
      throw new Error('No conversation available for notification');
    }
    await this.sendMessage(this.lastChatId, text);
    this.status.lastOutboundAt = Date.now();
  }

  /**
   * Send a notification message with media support to the last known chat.
   */
  async sendNotificationWithMedia(text: string): Promise<void> {
    if (!this.lastChatId || !this.restClient) {
      throw new Error('No conversation available for notification');
    }
    await this.sendWithMedia(this.lastChatId, text, undefined);
    this.status.lastOutboundAt = Date.now();
  }
}
