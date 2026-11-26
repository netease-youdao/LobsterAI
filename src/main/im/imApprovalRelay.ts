// Relays DSH tool/file approval requests from active IM sessions to the
// originating IM chat so users can approve/deny from mobile (e.g. WeChat,
// Feishu, DingTalk) while keeping desktop modal resolution and timeout
// fail-closed guarantees in sync.

import {
  DSH_QUESTION_REQUEST_ID_PREFIX,
  DshApprovalPermissionAction,
} from '../../shared/dshEngine/hostConstants';
import { t } from '../i18n';
import type { PermissionRequest, PermissionResult } from '../libs/agentEngine/types';

export const ImApprovalDecision = {
  AllowOnce: 'allow-once',
  AllowSession: 'allow-session',
  Deny: 'deny',
} as const;
export type ImApprovalDecision =
  typeof ImApprovalDecision[keyof typeof ImApprovalDecision];

export const DEFAULT_IM_APPROVAL_TIMEOUT_MS = 300_000;
const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';
const MAX_ACTION_SUMMARY_CHARS = 200;
const MAX_REASON_CHARS = 240;

const ALLOW_ONCE_REPLIES = new Set([
  '1',
  'y',
  'yes',
  'ok',
  'okay',
  'allow',
  'allow once',
  'approve',
  '同意',
  '允许',
  '确认',
  '本次允许',
  '允许一次',
  '允许本次',
  '好',
  '好的',
  '好滴',
  '可以',
  '行',
  '通过',
  '准许',
]);

const ALLOW_SESSION_REPLIES = new Set([
  '2',
  'always',
  'allow always',
  'allow session',
  'always allow',
  '总是允许',
  '始终允许',
  '本次会话允许',
  '会话允许',
  '不再询问',
  '本会话不再询问',
]);

const DENY_REPLIES = new Set([
  '0',
  'n',
  'no',
  'deny',
  'reject',
  'cancel',
  'stop',
  '拒绝',
  '不允许',
  '不同意',
  '取消',
  '否',
  '不',
  '不要',
  '算了',
  '停止',
]);

export interface ActiveImApprovalRoute {
  sessionId: string;
  queueKey: string;
  platform: string;
  instanceId: string;
  chatId: string;
  chatType: 'direct' | 'group';
  requesterSenderId?: string;
  replyContext?: Record<string, unknown>;
}

export interface ImApprovalInboundCandidate {
  text: string;
  senderId?: string;
  chatType?: 'direct' | 'group';
  replyContext?: Record<string, unknown>;
  onReplyContextUpdated?: (replyContext: Record<string, unknown>) => void;
}

export interface ImApprovalReplyHandleResult {
  handled: boolean;
  ignoredUnauthorizedSender?: boolean;
  decision?: ImApprovalDecision;
  updatedReplyContext?: Record<string, unknown>;
}

export interface ImApprovalRelayRuntimePort {
  on(event: 'permissionRequest', listener: (sessionId: string, request: PermissionRequest) => void): unknown;
  on(event: 'permissionResolved', listener: (sessionId: string, requestId: string) => void): unknown;
  on(event: 'complete', listener: (sessionId: string) => void): unknown;
  on(event: 'error', listener: (sessionId: string, error: string) => void): unknown;
  on(event: 'sessionStopped', listener: (sessionId: string) => void): unknown;
  off(event: 'permissionRequest', listener: (sessionId: string, request: PermissionRequest) => void): unknown;
  off(event: 'permissionResolved', listener: (sessionId: string, requestId: string) => void): unknown;
  off(event: 'complete', listener: (sessionId: string) => void): unknown;
  off(event: 'error', listener: (sessionId: string, error: string) => void): unknown;
  off(event: 'sessionStopped', listener: (sessionId: string) => void): unknown;
  respondToPermission(requestId: string, result: PermissionResult): Promise<void> | void;
}

export interface ImApprovalRelayDeps {
  runtime: ImApprovalRelayRuntimePort;
  sendReply: (params: {
    platform: string;
    instanceId?: string;
    chatId: string;
    text: string;
    replyContext?: Record<string, unknown>;
  }) => Promise<unknown>;
  timeoutMs?: number;
}

interface PendingImApproval {
  requestId: string;
  sessionId: string;
  queueKey: string;
  request: PermissionRequest;
  route: ActiveImApprovalRoute;
  timer: ReturnType<typeof setTimeout>;
}

function truncateInline(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

/**
 * Parse a user's IM text reply into a structured approval decision, or `null`
 * when the text is not a recognized approval keyword.
 */
export function parseImApprovalReply(text: string): ImApprovalDecision | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/^[[\](（【\s]+/, '')
    .replace(/[.!?。！？~～\]）)】\s]+$/, '')
    .replace(/\s+/g, ' ');
  if (!normalized) return null;
  if (ALLOW_ONCE_REPLIES.has(normalized)) return ImApprovalDecision.AllowOnce;
  if (ALLOW_SESSION_REPLIES.has(normalized)) return ImApprovalDecision.AllowSession;
  if (DENY_REPLIES.has(normalized)) return ImApprovalDecision.Deny;
  return null;
}

/**
 * Extract a concise human-readable action summary and optional reason from a
 * DSH/Cowork `PermissionRequest` for mobile IM presentation.
 */
export function formatImApprovalActionSummary(
  request: PermissionRequest,
): { action: string; reason?: string } {
  const toolName = readNonEmptyString(request.toolName) || 'tool';
  const input = (request.toolInput && typeof request.toolInput === 'object')
    ? request.toolInput
    : {};

  const command = readNonEmptyString(input.command)
    || readNonEmptyString(input.cmd)
    || readNonEmptyString(input.script);
  const filePath = readNonEmptyString(input.filePath)
    || readNonEmptyString(input.file_path)
    || readNonEmptyString(input.path)
    || readNonEmptyString(input.target_path);
  const description = readNonEmptyString(input.description);
  const displayReason = readNonEmptyString(input.displayReason) || readNonEmptyString(input.reason);

  let action: string;
  if (command) {
    action = `${toolName}: ${truncateInline(command, MAX_ACTION_SUMMARY_CHARS)}`;
  } else if (filePath) {
    action = `${toolName}: ${truncateInline(filePath, MAX_ACTION_SUMMARY_CHARS)}`;
  } else if (description) {
    action = `${toolName}: ${truncateInline(description, MAX_ACTION_SUMMARY_CHARS)}`;
  } else {
    action = toolName;
  }

  const trimmedReason = displayReason ? truncateInline(displayReason, MAX_REASON_CHARS) : '';
  const reason = trimmedReason && trimmedReason !== action ? trimmedReason : undefined;
  return { action, ...(reason ? { reason } : {}) };
}

export function formatImApprovalPrompt(
  request: PermissionRequest,
  timeoutMs: number,
): string {
  const { action, reason } = formatImApprovalActionSummary(request);
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const lines = [
    t('imApprovalPromptHeader'),
    '',
    t('imApprovalActionLabel', { action }),
  ];
  if (reason) {
    lines.push(t('imApprovalReasonLabel', { reason }));
  }
  lines.push(
    '',
    t('imApprovalReplyHint'),
    '',
    t('imApprovalTimeoutFooter', { seconds }),
  );
  return lines.join('\n');
}

function isQuestionRequest(request: PermissionRequest): boolean {
  return (
    request.requestId.startsWith(DSH_QUESTION_REQUEST_ID_PREFIX)
    || request.toolName === ASK_USER_QUESTION_TOOL_NAME
  );
}

export class ImApprovalRelay {
  private readonly deps: ImApprovalRelayDeps;
  private readonly timeoutMs: number;
  private readonly activeRoutesBySession = new Map<string, ActiveImApprovalRoute>();
  private readonly pendingByQueue = new Map<string, PendingImApproval>();
  private readonly pendingByRequestId = new Map<string, PendingImApproval>();
  private readonly resolvedInternally = new Set<string>();

  private readonly onPermissionRequest = (sessionId: string, request: PermissionRequest) => {
    this.handlePermissionRequest(sessionId, request);
  };

  private readonly onPermissionResolved = (_sessionId: string, requestId: string) => {
    this.handlePermissionResolved(requestId);
  };

  private readonly onSessionEnded = (sessionId: string) => {
    this.clearPendingForSession(sessionId);
  };

  constructor(deps: ImApprovalRelayDeps) {
    this.deps = deps;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_IM_APPROVAL_TIMEOUT_MS;
    this.deps.runtime.on('permissionRequest', this.onPermissionRequest);
    this.deps.runtime.on('permissionResolved', this.onPermissionResolved);
    this.deps.runtime.on('complete', this.onSessionEnded);
    this.deps.runtime.on('error', this.onSessionEnded);
    this.deps.runtime.on('sessionStopped', this.onSessionEnded);
  }

  dispose(): void {
    this.deps.runtime.off('permissionRequest', this.onPermissionRequest);
    this.deps.runtime.off('permissionResolved', this.onPermissionResolved);
    this.deps.runtime.off('complete', this.onSessionEnded);
    this.deps.runtime.off('error', this.onSessionEnded);
    this.deps.runtime.off('sessionStopped', this.onSessionEnded);
    for (const pending of this.pendingByRequestId.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingByQueue.clear();
    this.pendingByRequestId.clear();
    this.activeRoutesBySession.clear();
    this.resolvedInternally.clear();
  }

  registerActiveRoute(route: ActiveImApprovalRoute): void {
    this.activeRoutesBySession.set(route.sessionId, { ...route });
  }

  unregisterActiveRoute(sessionId: string): void {
    this.activeRoutesBySession.delete(sessionId);
    this.clearPendingForSession(sessionId);
  }

  hasPendingApproval(queueKey: string): boolean {
    return this.pendingByQueue.has(queueKey);
  }

  async tryHandleInboundReply(
    queueKey: string,
    event: ImApprovalInboundCandidate,
  ): Promise<ImApprovalReplyHandleResult> {
    const pending = this.pendingByQueue.get(queueKey);
    if (!pending) {
      return { handled: false };
    }

    // In group chats, only the user who triggered the active turn may approve/deny it.
    if (
      pending.route.chatType === 'group'
      && pending.route.requesterSenderId
      && event.senderId
      && pending.route.requesterSenderId !== event.senderId
    ) {
      return { handled: false, ignoredUnauthorizedSender: true };
    }

    // Refresh replyContext (e.g. WeChat iLink context_token) synchronously BEFORE
    // unblocking the runtime turn so the final assistant reply uses the freshest token.
    if (event.replyContext) {
      pending.route.replyContext = event.replyContext;
      const activeRoute = this.activeRoutesBySession.get(pending.sessionId);
      if (activeRoute) {
        activeRoute.replyContext = event.replyContext;
      }
      event.onReplyContextUpdated?.(event.replyContext);
    }

    const decision = parseImApprovalReply(event.text);
    if (!decision) {
      await this.sendReplySafe(
        pending.route,
        t('imApprovalInvalidReplyReminder'),
      );
      return {
        handled: true,
        updatedReplyContext: pending.route.replyContext,
      };
    }

    this.removePending(pending);
    this.resolvedInternally.add(pending.requestId);

    // Send the acknowledgement BEFORE resuming the turn so the IM user never sees
    // the final assistant response arrive ahead of the approval confirmation ack.
    const ackText = decision === ImApprovalDecision.AllowSession
      ? t('imApprovalAllowedSessionAck')
      : decision === ImApprovalDecision.AllowOnce
        ? t('imApprovalAllowedOnceAck')
        : t('imApprovalDeniedAck');
    await this.sendReplySafe(pending.route, ackText);

    const permissionResult = this.buildPermissionResult(pending.request, decision);
    try {
      await this.deps.runtime.respondToPermission(pending.requestId, permissionResult);
    } catch (error) {
      console.warn(
        `[ImApprovalRelay] Failed to submit ${decision} for request=${pending.requestId}:`,
        error,
      );
    }

    return {
      handled: true,
      decision,
      updatedReplyContext: pending.route.replyContext,
    };
  }

  private buildPermissionResult(
    request: PermissionRequest,
    decision: ImApprovalDecision,
  ): PermissionResult {
    if (decision === ImApprovalDecision.AllowOnce) {
      return { behavior: 'allow' };
    }
    if (decision === ImApprovalDecision.AllowSession) {
      const scope = readNonEmptyString(request.toolInput?.approvalScopeKey);
      return {
        behavior: 'allow',
        updatedPermissions: [
          {
            type: DshApprovalPermissionAction.AllowSession,
            ...(scope ? { scope } : {}),
          },
        ],
      };
    }
    return {
      behavior: 'deny',
      message: t('imApprovalDeniedForModel'),
    };
  }

  private handlePermissionRequest(sessionId: string, request: PermissionRequest): void {
    if (!request?.requestId || isQuestionRequest(request)) {
      return;
    }
    const route = this.activeRoutesBySession.get(sessionId);
    if (!route) {
      return;
    }

    const existing = this.pendingByQueue.get(route.queueKey);
    if (existing) {
      this.removePending(existing);
      this.resolvedInternally.add(existing.requestId);
      void Promise.resolve(
        this.deps.runtime.respondToPermission(existing.requestId, {
          behavior: 'deny',
          message: t('imApprovalSupersededForModel'),
        }),
      ).catch((error) => {
        console.warn('[ImApprovalRelay] Failed to deny superseded approval:', error);
      });
    }

    const seconds = Math.max(1, Math.round(this.timeoutMs / 1000));
    const timer = setTimeout(() => {
      const current = this.pendingByRequestId.get(request.requestId);
      if (!current) return;
      this.removePending(current);
      this.resolvedInternally.add(request.requestId);
      void Promise.resolve(
        this.deps.runtime.respondToPermission(request.requestId, {
          behavior: 'deny',
          message: t('imApprovalTimedOutForModel', { seconds }),
        }),
      ).catch((error) => {
        console.warn('[ImApprovalRelay] Failed to deny timed-out approval:', error);
      });
      void this.sendReplySafe(current.route, t('imApprovalTimedOutNotice'));
    }, this.timeoutMs);
    timer.unref?.();

    const pending: PendingImApproval = {
      requestId: request.requestId,
      sessionId,
      queueKey: route.queueKey,
      request,
      route,
      timer,
    };
    this.pendingByQueue.set(route.queueKey, pending);
    this.pendingByRequestId.set(request.requestId, pending);

    console.log(
      `[ImApprovalRelay] Relaying approval request=${request.requestId} tool=${request.toolName} to ${route.platform}:${route.instanceId} chat=${route.chatId}`,
    );
    void this.sendReplySafe(route, formatImApprovalPrompt(request, this.timeoutMs));
  }

  private handlePermissionResolved(requestId: string): void {
    if (this.resolvedInternally.delete(requestId)) {
      return;
    }
    const pending = this.pendingByRequestId.get(requestId);
    if (!pending) {
      return;
    }
    this.removePending(pending);
    void this.sendReplySafe(pending.route, t('imApprovalResolvedOnDesktopNotice'));
  }

  private clearPendingForSession(sessionId: string): void {
    for (const pending of [...this.pendingByRequestId.values()]) {
      if (pending.sessionId === sessionId) {
        this.removePending(pending);
      }
    }
  }

  private removePending(pending: PendingImApproval): void {
    clearTimeout(pending.timer);
    if (this.pendingByQueue.get(pending.queueKey) === pending) {
      this.pendingByQueue.delete(pending.queueKey);
    }
    if (this.pendingByRequestId.get(pending.requestId) === pending) {
      this.pendingByRequestId.delete(pending.requestId);
    }
  }

  private async sendReplySafe(route: ActiveImApprovalRoute, text: string): Promise<void> {
    try {
      await this.deps.sendReply({
        platform: route.platform,
        instanceId: route.instanceId,
        chatId: route.chatId,
        text,
        replyContext: route.replyContext,
      });
    } catch (error) {
      console.warn(
        `[ImApprovalRelay] Failed to send message to ${route.platform}:${route.instanceId} chat=${route.chatId}:`,
        error,
      );
    }
  }
}
