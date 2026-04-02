/**
 * IM Cowork Handler
 * Adapter that enables IM (DingTalk/Feishu/Telegram) to use CoworkRuntime for tool-enabled AI execution
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { CoworkRuntime, PermissionRequest } from '../libs/agentEngine/types';
import type { CoworkStore, CoworkMessage } from '../coworkStore';
import type { IMStore } from './imStore';
import type { IMMessage, Platform, IMMediaAttachment, IMSessionMapping } from './types';
import { buildIMMediaInstruction } from './imMediaInstruction';
import { analyzeIMReply, DEFAULT_IM_EMPTY_REPLY } from './imReplyGuard';
import {
  isReminderSystemTurn,
  type IMScheduledTaskCreationResult,
  type IMScheduledTaskRequestDetector,
  type ParsedIMScheduledTaskRequest,
} from './imScheduledTaskHandler';
import { buildScheduledTaskEnginePrompt } from '../../scheduledTask/enginePrompt';
import { t } from '../i18n';

interface MessageAccumulator {
  messages: CoworkMessage[];
  resolve?: (text: string) => void;
  reject?: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
  backgroundDelivery?: {
    conversationId: string;
    platform: Platform;
  };
}

interface PendingIMPermission {
  key: string;
  sessionId: string;
  request: PermissionRequest;
  conversationId: string;
  platform: Platform;
  createdAt: number;
  timeoutId?: NodeJS.Timeout;
}

const PERMISSION_CONFIRM_TIMEOUT_MS = 60_000;
const ACCUMULATOR_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const IM_ALLOW_RESPONSE_RE = /^(允许|同意|yes|y)$/i;
const IM_DENY_RESPONSE_RE = /^(拒绝|不同意|no|n)$/i;
const IM_ALLOW_OPTION_LABEL = '允许本次操作';

export interface IMCoworkHandlerOptions {
  coworkRuntime: CoworkRuntime;
  coworkStore: CoworkStore;
  imStore: IMStore;
  getSkillsPrompt?: () => Promise<string | null>;
  detectScheduledTaskRequest?: IMScheduledTaskRequestDetector;
  createScheduledTask?: (params: {
    sessionId: string;
    message: IMMessage;
    request: ParsedIMScheduledTaskRequest;
  }) => Promise<IMScheduledTaskCreationResult>;
  sendAsyncReply?: (platform: Platform, conversationId: string, text: string) => Promise<boolean>;
}

export class IMCoworkHandler extends EventEmitter {
  private coworkRuntime: CoworkRuntime;
  private coworkStore: CoworkStore;
  private imStore: IMStore;
  private getSkillsPrompt?: () => Promise<string | null>;
  private detectScheduledTaskRequest?: IMScheduledTaskRequestDetector;
  private createScheduledTask?: (params: {
    sessionId: string;
    message: IMMessage;
    request: ParsedIMScheduledTaskRequest;
  }) => Promise<IMScheduledTaskCreationResult>;
  private sendAsyncReply?: (platform: Platform, conversationId: string, text: string) => Promise<boolean>;

  // Track active sessions' message accumulation
  private messageAccumulators: Map<string, MessageAccumulator> = new Map();

  // Track which sessions are created by IM (to filter events)
  private imSessionIds: Set<string> = new Set();
  private sessionConversationMap: Map<string, { conversationId: string; platform: Platform }> = new Map();
  private pendingPermissionByConversation: Map<string, PendingIMPermission> = new Map();
  private readonly onMessage = this.handleMessage.bind(this);
  private readonly onMessageUpdate = this.handleMessageUpdate.bind(this);
  private readonly onPermissionRequest = this.handlePermissionRequest.bind(this);
  private readonly onComplete = this.handleComplete.bind(this);
  private readonly onError = this.handleError.bind(this);

  constructor(options: IMCoworkHandlerOptions) {
    super();
    this.coworkRuntime = options.coworkRuntime;
    this.coworkStore = options.coworkStore;
    this.imStore = options.imStore;
    this.getSkillsPrompt = options.getSkillsPrompt;
    this.detectScheduledTaskRequest = options.detectScheduledTaskRequest;
    this.createScheduledTask = options.createScheduledTask;
    this.sendAsyncReply = options.sendAsyncReply;

    this.initializeMappedSessions();
    this.setupEventListeners();
  }

  private initializeMappedSessions(): void {
    for (const mapping of this.imStore.listSessionMappings()) {
      const session = this.coworkStore.getSession(mapping.coworkSessionId);
      if (!session) {
        continue;
      }
      this.trackSessionMapping(mapping);
    }
  }

  private trackSessionMapping(mapping: IMSessionMapping): void {
    this.imSessionIds.add(mapping.coworkSessionId);
    this.sessionConversationMap.set(mapping.coworkSessionId, {
      conversationId: mapping.imConversationId,
      platform: mapping.platform,
    });
  }

  private ensureTrackedSession(sessionId: string): boolean {
    if (this.imSessionIds.has(sessionId)) {
      return true;
    }

    const mapping = this.imStore.getSessionMappingByCoworkSessionId(sessionId);
    if (!mapping) {
      return false;
    }

    this.trackSessionMapping(mapping);
    return true;
  }

  /**
   * Set up event listeners for CoworkRuntime
   */
  private setupEventListeners(): void {
    this.coworkRuntime.on('message', this.onMessage);
    this.coworkRuntime.on('messageUpdate', this.onMessageUpdate);
    this.coworkRuntime.on('permissionRequest', this.onPermissionRequest);
    this.coworkRuntime.on('complete', this.onComplete);
    this.coworkRuntime.on('error', this.onError);
  }

  /**
   * Process an incoming IM message using CoworkRuntime
   */
  async processMessage(message: IMMessage): Promise<string> {
    const pendingPermissionReply = await this.handlePendingPermissionReply(message);
    if (pendingPermissionReply !== null) {
      return pendingPermissionReply;
    }

    try {
      return await this.processMessageInternal(message, false);
    } catch (error) {
      if (!this.isSessionNotFoundError(error)) {
        if (this.shouldRetryWithFreshSession(error, message)) {
          console.warn(
            `[IMCoworkHandler] Detected recoverable API 400 for ${message.platform}:${message.conversationId}, recreating session and retrying once`
          );
          return this.processMessageInternal(message, true);
        }
        throw error;
      }

      console.warn(
        `[IMCoworkHandler] Cowork session mapping is stale for ${message.platform}:${message.conversationId}, recreating session`
      );
      return this.processMessageInternal(message, true);
    }
  }

  private async processMessageInternal(message: IMMessage, forceNewSession: boolean): Promise<string> {
    const coworkSessionId = await this.getOrCreateCoworkSession(
      message.conversationId,
      message.platform,
      forceNewSession,
      message.senderId,
      message
    );
    this.sessionConversationMap.set(coworkSessionId, {
      conversationId: message.conversationId,
      platform: message.platform,
    });

    const formattedContent = this.formatMessageWithMedia(message);
    const directScheduledTaskRequest = this.createScheduledTask && this.detectScheduledTaskRequest
      ? await this.detectScheduledTaskRequest(message)
      : null;

    if (directScheduledTaskRequest && this.createScheduledTask) {
      return this.handleDirectScheduledTaskRequest(
        coworkSessionId,
        message,
        formattedContent,
        directScheduledTaskRequest
      );
    }

    const responsePromise = this.createAccumulatorPromise(coworkSessionId);

    // Start or continue session
    const isActive = this.coworkRuntime.isSessionActive(coworkSessionId);
    const systemPrompt = await this.buildSystemPromptWithSkills();
    const hasAvailableSkills = systemPrompt.includes('<available_skills>');
    const session = this.coworkStore.getSession(coworkSessionId);
    if (session && session.systemPrompt !== systemPrompt) {
      // Claude resume sessions may ignore updated system prompt.
      // Reset claudeSessionId so this turn starts a fresh SDK session with new prompt.
      this.coworkStore.updateSession(coworkSessionId, {
        systemPrompt,
        claudeSessionId: null,
      });
      console.log('[IMCoworkHandler] System prompt changed, reset claudeSessionId for IM session', JSON.stringify({
        coworkSessionId,
        platform: message.platform,
      }));
    }
    if (!hasAvailableSkills) {
      console.warn('[IMCoworkHandler] Skills auto-routing prompt missing for current IM turn');
    }

    // 打印完整的输入消息日志
    console.log(`[IMCoworkHandler] 处理消息:`, JSON.stringify({
      platform: message.platform,
      conversationId: message.conversationId,
      coworkSessionId,
      isActive,
      originalContent: message.content,
      formattedContent,
      attachments: message.attachments,
      hasAvailableSkills,
    }, null, 2));

    const onSessionStartError = (error: unknown) => {
      this.rejectAccumulator(
        coworkSessionId,
        error instanceof Error ? error : new Error(String(error))
      );
    };

    if (isActive) {
      this.coworkRuntime.continueSession(coworkSessionId, formattedContent, { systemPrompt })
        .catch(onSessionStartError);
    } else {
      this.coworkRuntime.startSession(coworkSessionId, formattedContent, {
        workspaceRoot: session?.cwd,
        confirmationMode: 'text',
        systemPrompt,
      }).catch(onSessionStartError);
    }

    return responsePromise;
  }

  /**
   * Get or create a Cowork session for an IM conversation
   */
  private async getOrCreateCoworkSession(
    imConversationId: string,
    platform: Platform,
    forceNewSession: boolean = false,
    senderId?: string,
    message?: IMMessage
  ): Promise<string> {
    if (forceNewSession) {
      const stale = this.imStore.getSessionMapping(imConversationId, platform);
      if (stale) {
        this.imStore.deleteSessionMapping(imConversationId, platform);
        this.imSessionIds.delete(stale.coworkSessionId);
        this.sessionConversationMap.delete(stale.coworkSessionId);
        this.clearPendingPermissionsBySessionId(stale.coworkSessionId);
        this.coworkRuntime.stopSession(stale.coworkSessionId);
      }
    }

    // Check existing mapping
    const existing = forceNewSession ? null : this.imStore.getSessionMapping(imConversationId, platform);
    if (existing) {
      const session = this.coworkStore.getSession(existing.coworkSessionId);
      if (!session) {
        console.warn(
          `[IMCoworkHandler] Found stale mapping for ${platform}:${imConversationId}, session ${existing.coworkSessionId} is missing`
        );
        this.imStore.deleteSessionMapping(imConversationId, platform);
        this.imSessionIds.delete(existing.coworkSessionId);
        this.sessionConversationMap.delete(existing.coworkSessionId);
        this.clearPendingPermissionsBySessionId(existing.coworkSessionId);
        this.coworkRuntime.stopSession(existing.coworkSessionId);
      } else {
        this.imStore.updateSessionLastActive(imConversationId, platform);
        this.trackSessionMapping(existing);
        return existing.coworkSessionId;
      }
    }

    // Create new Cowork session
    return this.createCoworkSessionForConversation(imConversationId, platform, senderId, message);
  }

  private async createCoworkSessionForConversation(
    imConversationId: string,
    platform: Platform,
    senderId?: string,
    message?: IMMessage
  ): Promise<string> {
    // Create new Cowork session
    const config = this.coworkStore.getConfig();
    const title = this.buildSessionTitle(platform, imConversationId, senderId, message);
    const systemPrompt = await this.buildSystemPromptWithSkills();

    const selectedWorkspaceRoot = (config.workingDirectory || '').trim();
    if (!selectedWorkspaceRoot) {
      throw new Error('IM 工作目录未配置，请先在应用中选择任务目录。');
    }
    const resolvedWorkspaceRoot = path.resolve(selectedWorkspaceRoot);
    if (!fs.existsSync(resolvedWorkspaceRoot) || !fs.statSync(resolvedWorkspaceRoot).isDirectory()) {
      throw new Error(`IM 工作目录不存在或无效: ${resolvedWorkspaceRoot}`);
    }

    // Resolve the agent bound to this platform
    const imSettings = this.imStore.getIMSettings();
    const agentId = imSettings.platformAgentBindings?.[platform] || 'main';

    const session = this.coworkStore.createSession(
      title,
      resolvedWorkspaceRoot,
      systemPrompt,
      config.executionMode || 'local',
      [],
      agentId
    );

    // Save mapping
    const mapping = this.imStore.createSessionMapping(imConversationId, platform, session.id);
    this.trackSessionMapping(mapping);

    return session.id;
  }

  /**
   * Build a human-readable session title based on platform and sender identity.
   *
   * NIM title rules:
   *   - P2P direct:  "云信-P2P-{senderName|senderId}"
   *   - Team group:  "云信-群聊-{groupName|teamId}"
   *   - QChat:       "云信-圈组-{groupName|channelId}"
   *
   * Other platforms use the original "IM-{platform}-{timestamp}" style.
   */
  private buildSessionTitle(
    platform: Platform,
    _imConversationId: string,
    senderId?: string,
    message?: IMMessage
  ): string {
    if (platform === 'nim') {
      const nimLabel = t('channelPrefixNim');
      if (message?.chatSubType === 'qchat') {
        const channelLabel = message.groupName || _imConversationId;
        return `${nimLabel}-${t('nimQChat')}-${channelLabel}`;
      }
      if (message?.chatType === 'group') {
        const groupLabel = message.groupName || senderId || _imConversationId;
        return `${nimLabel}-${t('nimGroup')}-${groupLabel}`;
      }
      const peerLabel = message?.senderName || senderId || _imConversationId;
      return `${nimLabel}-P2P-${peerLabel}`;
    }
    return `IM-${platform}-${Date.now()}`;
  }

  private async buildSystemPromptWithSkills(): Promise<string> {
    const config = this.coworkStore.getConfig();
    const imSettings = this.imStore.getIMSettings();
    const systemPrompt = config.systemPrompt || '';
    const scheduledTaskPrompt = buildScheduledTaskEnginePrompt(config.agentEngine);

    // Build media instruction for IM media sending capability
    const mediaInstruction = buildIMMediaInstruction(imSettings);

    const sections: string[] = [];
    if (systemPrompt) {
      sections.push(systemPrompt);
    }

    if (imSettings.skillsEnabled && this.getSkillsPrompt) {
      const skillsPrompt = await this.getSkillsPrompt();
      if (skillsPrompt) {
        sections.push(skillsPrompt);
      }
    }

    if (scheduledTaskPrompt) {
      sections.push(scheduledTaskPrompt);
    }

    // Append media instruction at the end so it's always present
    if (mediaInstruction) {
      sections.push(mediaInstruction);
    }

    return sections.join('\n\n');
  }

  private async handleDirectScheduledTaskRequest(
    sessionId: string,
    message: IMMessage,
    formattedContent: string,
    request: ParsedIMScheduledTaskRequest,
  ): Promise<string> {
    const toolUseId = `cron:${Date.now()}`;

    this.coworkStore.addMessage(sessionId, {
      type: 'user',
      content: formattedContent,
      metadata: {},
    });
    this.coworkStore.addMessage(sessionId, {
      type: 'tool_use',
      content: 'Using tool: cron',
      metadata: {
        toolName: 'cron',
        toolUseId,
        toolInput: {
          action: 'add',
          job: {
            name: request.taskName,
            schedule: {
              kind: 'at',
              at: request.scheduleAt,
            },
            payload: {
              kind: 'systemEvent',
              text: request.payloadText,
            },
            sessionTarget: 'main',
            enabled: true,
          },
        },
      },
    });

    try {
      const created = await this.createScheduledTask!({
        sessionId,
        message,
        request,
      });
      const toolResultText = JSON.stringify(created);
      this.coworkStore.addMessage(sessionId, {
        type: 'tool_result',
        content: toolResultText,
        metadata: {
          toolUseId,
          toolResult: toolResultText,
          isError: false,
        },
      });
      this.coworkStore.addMessage(sessionId, {
        type: 'assistant',
        content: request.confirmationText,
        metadata: {},
      });
      console.log('[IMCoworkHandler] Created IM scheduled task via cron.add', JSON.stringify({
        sessionId,
        platform: message.platform,
        conversationId: message.conversationId,
        taskId: created.id,
        taskName: created.name,
        scheduleAt: created.scheduleAt,
      }));
      return request.confirmationText;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.coworkStore.addMessage(sessionId, {
        type: 'tool_result',
        content: errorMessage,
        metadata: {
          toolUseId,
          toolResult: errorMessage,
          error: errorMessage,
          isError: true,
        },
      });
      const reply = `定时任务创建失败：${errorMessage}`;
      this.coworkStore.addMessage(sessionId, {
        type: 'assistant',
        content: reply,
        metadata: {},
      });
      console.warn('[IMCoworkHandler] Failed to create IM scheduled task via cron.add', JSON.stringify({
        sessionId,
        platform: message.platform,
        conversationId: message.conversationId,
        error: errorMessage,
      }));
      return reply;
    }
  }

  private isSessionNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /^Session\s.+\snot found$/i.test(message.trim());
  }

  private isRecoverableApi400Error(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (!message.includes('400')) {
      return false;
    }

    return (
      message.includes('api error')
      || message.includes('bad_response_status_code')
      || message.includes('invalid chat setting')
      || message.includes('signature: field required')
    );
  }

  private shouldRetryWithFreshSession(error: unknown, message: IMMessage): boolean {
    if (!this.isRecoverableApi400Error(error)) {
      return false;
    }

    const mapping = this.imStore.getSessionMapping(message.conversationId, message.platform);
    if (!mapping) {
      return false;
    }

    const session = this.coworkStore.getSession(mapping.coworkSessionId);
    return Boolean(session?.claudeSessionId);
  }

  /**
   * Handle message event from CoworkRuntime
   */
  private handleMessage(sessionId: string, message: CoworkMessage): void {
    // Only process messages from IM sessions
    const tracked = this.ensureTrackedSession(sessionId);
    console.log('[IMCoworkHandler:handleMessage] sessionId:', sessionId, 'tracked:', tracked, 'messageType:', message.type);
    if (!tracked) return;

    const accumulator = this.messageAccumulators.get(sessionId) ?? this.ensureBackgroundAccumulator(sessionId);
    console.log('[IMCoworkHandler:handleMessage] accumulator exists:', !!accumulator, 'backgroundDelivery:', !!(accumulator as any)?.backgroundDelivery);
    if (accumulator) {
      accumulator.messages.push(message);
    }
  }

  /**
   * Handle message update event (streaming content)
   */
  private handleMessageUpdate(sessionId: string, messageId: string, content: string): void {
    // Only process updates from IM sessions
    if (!this.ensureTrackedSession(sessionId)) return;

    const accumulator = this.messageAccumulators.get(sessionId);
    if (accumulator) {
      // Update the message content in the accumulator
      const existingIndex = accumulator.messages.findIndex(m => m.id === messageId);
      if (existingIndex >= 0) {
        accumulator.messages[existingIndex].content = content;
      }
    }
  }

  private createConversationKey(conversationId: string, platform: Platform): string {
    return `${platform}:${conversationId}`;
  }

  private createAccumulatorPromise(sessionId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const existingAccumulator = this.messageAccumulators.get(sessionId);
      if (existingAccumulator) {
        if (existingAccumulator.timeoutId) {
          clearTimeout(existingAccumulator.timeoutId);
        }
        this.messageAccumulators.delete(sessionId);
        existingAccumulator.reject?.(new Error('Replaced by a newer IM request'));
      }

      const timeoutId = setTimeout(() => {
        const accumulator = this.messageAccumulators.get(sessionId);
        if (accumulator && accumulator.timeoutId === timeoutId) {
          const partialReply = this.formatReply(sessionId, accumulator.messages);
          this.cleanupAccumulator(sessionId);
          if (partialReply && partialReply !== '处理完成，但没有生成回复。') {
            accumulator.resolve?.(partialReply + '\n\n[处理超时，以上为部分结果]');
          } else {
            accumulator.reject?.(new Error('处理超时，请稍后重试'));
          }
        }
      }, ACCUMULATOR_TIMEOUT_MS);

      // Set up message accumulator
      this.messageAccumulators.set(sessionId, {
        messages: [],
        resolve,
        reject,
        timeoutId,
      });
    });
  }

  private ensureBackgroundAccumulator(sessionId: string): MessageAccumulator | null {
    const conversation = this.sessionConversationMap.get(sessionId);
    if (!conversation) {
      return null;
    }

    const existing = this.messageAccumulators.get(sessionId);
    if (existing) {
      return existing;
    }

    const timeoutId = setTimeout(() => {
      const accumulator = this.messageAccumulators.get(sessionId);
      if (!accumulator?.backgroundDelivery || accumulator.timeoutId !== timeoutId) {
        return;
      }
      this.cleanupAccumulator(sessionId);
    }, ACCUMULATOR_TIMEOUT_MS);

    const nextAccumulator: MessageAccumulator = {
      messages: [],
      timeoutId,
      backgroundDelivery: {
        conversationId: conversation.conversationId,
        platform: conversation.platform,
      },
    };
    this.messageAccumulators.set(sessionId, nextAccumulator);
    return nextAccumulator;
  }

  private rejectAccumulator(sessionId: string, error: Error): void {
    const accumulator = this.messageAccumulators.get(sessionId);
    if (!accumulator) return;
    this.cleanupAccumulator(sessionId);
    accumulator.reject?.(error);
  }

  private clearPendingPermissionByKey(key: string): PendingIMPermission | null {
    const pending = this.pendingPermissionByConversation.get(key);
    if (!pending) return null;

    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingPermissionByConversation.delete(key);
    return pending;
  }

  private clearPendingPermissionsBySessionId(sessionId: string): void {
    const keysToRemove: string[] = [];
    this.pendingPermissionByConversation.forEach((pending, key) => {
      if (pending.sessionId === sessionId) {
        keysToRemove.push(key);
      }
    });
    keysToRemove.forEach((key) => this.clearPendingPermissionByKey(key));
  }

  private buildIMPermissionPrompt(request: PermissionRequest): string {
    const questions = Array.isArray(request.toolInput?.questions)
      ? (request.toolInput.questions as Array<Record<string, unknown>>)
      : [];
    const firstQuestion = questions[0];
    const questionText = typeof firstQuestion?.question === 'string'
      ? firstQuestion.question
      : '';

    return [
      `检测到需要安全确认的操作（工具: ${request.toolName}）。`,
      questionText ? `说明: ${questionText}` : '说明: 当前操作涉及删除或访问任务目录外路径。',
      '请在 60 秒内回复“允许”或“拒绝”。',
    ].join('\n');
  }

  private buildAllowPermissionResult(request: PermissionRequest): PermissionResult {
    if (request.toolName !== 'AskUserQuestion') {
      return {
        behavior: 'allow',
        updatedInput: request.toolInput,
      };
    }

    const input = request.toolInput && typeof request.toolInput === 'object'
      ? { ...(request.toolInput as Record<string, unknown>) }
      : {};
    const rawQuestions = Array.isArray(input.questions)
      ? (input.questions as Array<Record<string, unknown>>)
      : [];

    const answers: Record<string, string> = {};
    rawQuestions.forEach((question) => {
      const questionTitle = typeof question?.question === 'string' ? question.question : '';
      if (!questionTitle) return;
      const options = Array.isArray(question?.options)
        ? (question.options as Array<Record<string, unknown>>)
        : [];
      const preferredOption = options.find((option) => {
        const label = typeof option?.label === 'string' ? option.label : '';
        return label.includes(IM_ALLOW_OPTION_LABEL);
      });
      const fallbackOption = options[0];
      const selectedLabel = typeof preferredOption?.label === 'string'
        ? preferredOption.label
        : (typeof fallbackOption?.label === 'string' ? fallbackOption.label : IM_ALLOW_OPTION_LABEL);
      answers[questionTitle] = selectedLabel;
    });

    return {
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers,
      },
    };
  }

  private async handlePendingPermissionReply(message: IMMessage): Promise<string | null> {
    const key = this.createConversationKey(message.conversationId, message.platform);
    const pending = this.pendingPermissionByConversation.get(key);
    if (!pending) return null;

    const normalizedReply = message.content
      .trim()
      .replace(/[。！!,.，\s]+$/g, '');
    if (!normalizedReply) {
      return '当前有待确认操作，请回复“允许”或“拒绝”（60 秒内）。';
    }

    if (!this.coworkRuntime.isSessionActive(pending.sessionId)) {
      this.clearPendingPermissionByKey(key);
      return '该确认请求已过期，请重新发送任务。';
    }

    if (IM_DENY_RESPONSE_RE.test(normalizedReply)) {
      this.clearPendingPermissionByKey(key);
      this.coworkRuntime.respondToPermission(pending.request.requestId, {
        behavior: 'deny',
        message: 'Operation denied by IM user confirmation.',
      });
      return '已拒绝本次操作，任务未继续执行。';
    }

    if (!IM_ALLOW_RESPONSE_RE.test(normalizedReply)) {
      return '当前有待确认操作，请回复“允许”或“拒绝”（60 秒内）。';
    }

    this.clearPendingPermissionByKey(key);
    const responsePromise = this.createAccumulatorPromise(pending.sessionId);
    this.coworkRuntime.respondToPermission(
      pending.request.requestId,
      this.buildAllowPermissionResult(pending.request)
    );
    return responsePromise;
  }

  /**
   * Handle permission request in IM mode with explicit user confirmation.
   */
  private handlePermissionRequest(sessionId: string, request: PermissionRequest): void {
    // Only process permission requests from IM sessions
    if (!this.ensureTrackedSession(sessionId)) return;
    const conversation = this.sessionConversationMap.get(sessionId);
    if (!conversation) {
      this.coworkRuntime.respondToPermission(request.requestId, {
        behavior: 'deny',
        message: 'IM session mapping missing for permission request.',
      });
      return;
    }

    const key = this.createConversationKey(conversation.conversationId, conversation.platform);
    const existingPending = this.clearPendingPermissionByKey(key);
    if (existingPending) {
      this.coworkRuntime.respondToPermission(existingPending.request.requestId, {
        behavior: 'deny',
        message: 'Superseded by a newer permission request.',
      });
    }

    const timeoutId = setTimeout(() => {
      const currentPending = this.pendingPermissionByConversation.get(key);
      if (!currentPending || currentPending.request.requestId !== request.requestId) {
        return;
      }
      this.clearPendingPermissionByKey(key);
      this.coworkRuntime.respondToPermission(request.requestId, {
        behavior: 'deny',
        message: 'Permission request timed out after 60s',
      });
    }, PERMISSION_CONFIRM_TIMEOUT_MS);

    this.pendingPermissionByConversation.set(key, {
      key,
      sessionId,
      request,
      conversationId: conversation.conversationId,
      platform: conversation.platform,
      createdAt: Date.now(),
      timeoutId,
    });

    const accumulator = this.messageAccumulators.get(sessionId);
    if (accumulator) {
      const confirmationPrompt = this.buildIMPermissionPrompt(request);
      this.cleanupAccumulator(sessionId);
      accumulator.resolve?.(confirmationPrompt);
    }
  }

  /**
   * Handle session complete event
   */
  private handleComplete(sessionId: string): void {
    // Only process complete events from IM sessions
    const tracked = this.ensureTrackedSession(sessionId);
    console.log('[IMCoworkHandler:handleComplete] sessionId:', sessionId, 'tracked:', tracked, 'hasAccumulator:', this.messageAccumulators.has(sessionId));
    if (!tracked) return;

    this.clearPendingPermissionsBySessionId(sessionId);
    const accumulator = this.messageAccumulators.get(sessionId);
    if (!accumulator) {
      return;
    }

    // Use reconciled messages from the store (authoritative after reconcileWithHistory)
    // instead of accumulator messages which may be stale streaming snapshots.
    // Fall back to accumulator messages if the store has none (e.g. timeout path).
    const session = this.coworkStore.getSession(sessionId);
    const storeMessages = session?.messages ?? [];
    const messages = storeMessages.length > 0 ? storeMessages : accumulator.messages;

    // For cron-triggered background deliveries (scheduled task executions),
    // skip the reminder guard — the assistant text IS the scheduled reminder
    // itself, not a promise to create one.
    const replyText = accumulator.backgroundDelivery
      ? this.formatReplyRaw(messages)
      : this.formatReply(sessionId, messages);

    console.log(`[IMCoworkHandler] 会话完成:`, JSON.stringify({
      sessionId,
      messageCount: messages.length,
      replyLength: replyText.length,
      reply: replyText,
      backgroundDelivery: accumulator.backgroundDelivery ?? null,
      usedStoreMessages: storeMessages.length > 0,
    }, null, 2));

    this.cleanupAccumulator(sessionId);

    if (accumulator.backgroundDelivery) {
      if (!this.sendAsyncReply || !replyText || replyText === '处理完成，但没有生成回复。') {
        console.warn('[IMCoworkHandler] cannot send async IM reminder reply', replyText);
        return;
      }
      if (!isReminderSystemTurn(messages)) {
        console.log('[IMCoworkHandler] not a reminder system turn, skipping async reply');
        return;
      }
      void this.sendAsyncReply(
        accumulator.backgroundDelivery.platform,
        accumulator.backgroundDelivery.conversationId,
        replyText,
      ).then((sent) => {
        if (!sent) {
          console.warn('[IMCoworkHandler] Failed to relay async IM reminder reply', JSON.stringify({
            sessionId,
            platform: accumulator.backgroundDelivery?.platform,
            conversationId: accumulator.backgroundDelivery?.conversationId,
          }));
        }
      }).catch((error) => {
        console.error('[IMCoworkHandler] Async IM reminder reply failed:', error);
      });
      return;
    }

    accumulator.resolve?.(replyText);
  }

  /**
   * Handle session error event
   */
  private handleError(sessionId: string, error: string): void {
    // Only process error events from IM sessions
    if (!this.ensureTrackedSession(sessionId)) return;

    this.clearPendingPermissionsBySessionId(sessionId);
    const accumulator = this.messageAccumulators.get(sessionId);
    if (accumulator) {
      this.cleanupAccumulator(sessionId);
      accumulator.reject?.(new Error(error));
    }
  }

  /**
   * Clean up accumulator
   */
  private cleanupAccumulator(sessionId: string): void {
    const accumulator = this.messageAccumulators.get(sessionId);
    if (accumulator?.timeoutId) {
      clearTimeout(accumulator.timeoutId);
    }
    this.messageAccumulators.delete(sessionId);
  }

  /**
   * Extract raw assistant text from accumulated messages, bypassing the
   * reminder-commitment guard.  Used for cron-triggered background deliveries
   * where the reply IS the scheduled reminder, not a promise to create one.
   */
  private formatReplyRaw(messages: CoworkMessage[]): string {
    const parts: string[] = [];
    for (const message of messages) {
      if (message.type === 'assistant' && message.content && !message.metadata?.isThinking) {
        const text = message.content.trim();
        if (text) parts.push(text);
      }
    }
    return parts.join('\n\n') || DEFAULT_IM_EMPTY_REPLY;
  }

  /**
   * Format accumulated messages into a reply string
   */
  private formatReply(sessionId: string, messages: CoworkMessage[]): string {
    const analysis = analyzeIMReply(messages);

    if (analysis.guardApplied) {
      console.warn('[IMCoworkHandler] Guarded misleading reminder reply without successful cron.add', JSON.stringify({
        sessionId,
        attemptedCronAdds: analysis.attemptedCronAdds,
        successfulCronAdds: analysis.successfulCronAdds,
        lastCronAddError: analysis.lastCronAddError,
        assistantText: analysis.assistantText,
      }));
    }

    return analysis.text;
  }

  /**
   * Format message content with media attachment information
   * Appends media metadata to content so AI can access the files
   */
  private formatMessageWithMedia(message: IMMessage): string {
    // POPO's moltbot-popo plugin converts newlines to HTML break tags (<br />),
    // causing raw <br /> to appear in the AI conversation instead of actual line breaks.
    let content = message.platform === 'popo'
      ? message.content.replace(/<br\s*\/?>/gi, '\n')
      : message.content;

    if (message.attachments && message.attachments.length > 0) {
      const mediaInfo = message.attachments.map((att: IMMediaAttachment) => {
        const parts = [`类型: ${att.type}`, `路径: ${att.localPath}`];
        if (att.fileName) parts.push(`文件名: ${att.fileName}`);
        if (att.mimeType) parts.push(`MIME: ${att.mimeType}`);
        if (att.width && att.height) parts.push(`尺寸: ${att.width}x${att.height}`);
        if (att.duration) parts.push(`时长: ${att.duration}秒`);
        if (att.fileSize) parts.push(`大小: ${(att.fileSize / 1024).toFixed(1)}KB`);
        return `- ${parts.join(', ')}`;
      }).join('\n');

      content = content
        ? `${content}\n\n[附件信息]\n${mediaInfo}`
        : `[附件信息]\n${mediaInfo}`;
    }

    return content;
  }

  /**
   * Cleanup when handler is destroyed
   */
  destroy(): void {
    // Clear all pending accumulators
    this.messageAccumulators.forEach((accumulator) => {
      if (accumulator.timeoutId) {
        clearTimeout(accumulator.timeoutId);
      }
      accumulator.reject(new Error('Handler destroyed'));
    });
    this.messageAccumulators.clear();
    this.imSessionIds.clear();
    this.sessionConversationMap.clear();

    this.pendingPermissionByConversation.forEach((pending) => {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
    });
    this.pendingPermissionByConversation.clear();

    // Remove event listeners
    this.coworkRuntime.off('message', this.onMessage);
    this.coworkRuntime.off('messageUpdate', this.onMessageUpdate);
    this.coworkRuntime.off('permissionRequest', this.onPermissionRequest);
    this.coworkRuntime.off('complete', this.onComplete);
    this.coworkRuntime.off('error', this.onError);
  }
}
