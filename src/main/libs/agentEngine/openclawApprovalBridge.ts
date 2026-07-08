import { getCommandDangerLevel, isDeleteCommand } from '../commandSafety';
import { parseChannelSessionKey } from '../openclawChannelSessionSync';
import type { PermissionRequest, PermissionResult } from './types';

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

export type PendingApprovalEntry = {
  requestId: string;
  sessionId: string;
  kind: 'exec' | 'plugin';
  allowedDecisions?: ApprovalDecision[];
  /** When true, use 'allow-always' decision so OpenClaw adds the command to its allowlist. */
  allowAlways?: boolean;
};

type ExecApprovalRequest = {
  command?: string;
  cwd?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  agentId?: string | null;
};

type ExecApprovalRequestedPayload = {
  id?: string;
  request?: ExecApprovalRequest;
};

type PluginApprovalRequest = {
  pluginId?: string | null;
  title?: string;
  description?: string;
  severity?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  allowedDecisions?: string[] | null;
  agentId?: string | null;
  sessionKey?: string | null;
};

type PluginApprovalRequestedPayload = {
  id?: string;
  request?: PluginApprovalRequest;
};

export type ParsedExecApprovalRequest = {
  requestId: string;
  request: ExecApprovalRequest;
  sessionKey: string;
  command: string;
  shouldAutoApprove: boolean;
};

export type ParsedPluginApprovalRequest = {
  requestId: string;
  request: PluginApprovalRequest;
  sessionKey: string;
  allowedDecisions?: ApprovalDecision[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const isApprovalDecision = (value: unknown): value is ApprovalDecision => (
  value === 'allow-once' || value === 'allow-always' || value === 'deny'
);

const normalizeApprovalDecisions = (value: unknown): ApprovalDecision[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const decisions: ApprovalDecision[] = [];
  for (const item of value) {
    if (isApprovalDecision(item) && !decisions.includes(item)) {
      decisions.push(item);
    }
  }
  return decisions.length > 0 ? decisions : undefined;
};

export const parseExecApprovalRequestedPayload = (payload: unknown): ParsedExecApprovalRequest | null => {
  if (!isRecord(payload)) return null;
  const typedPayload = payload as ExecApprovalRequestedPayload;
  const requestId = typeof typedPayload.id === 'string' ? typedPayload.id.trim() : '';
  if (!requestId) return null;
  if (!typedPayload.request || !isRecord(typedPayload.request)) return null;

  const request = typedPayload.request;
  const sessionKey = typeof request.sessionKey === 'string' ? request.sessionKey.trim() : '';
  const command = typeof request.command === 'string' ? request.command : '';
  return {
    requestId,
    request,
    sessionKey,
    command,
    shouldAutoApprove: parseChannelSessionKey(sessionKey) !== null || !isDeleteCommand(command),
  };
};

export const parsePluginApprovalRequestedPayload = (payload: unknown): ParsedPluginApprovalRequest | null => {
  if (!isRecord(payload)) return null;
  const typedPayload = payload as PluginApprovalRequestedPayload;
  const requestId = typeof typedPayload.id === 'string' ? typedPayload.id.trim() : '';
  if (!requestId) return null;
  if (!typedPayload.request || !isRecord(typedPayload.request)) return null;

  const request = typedPayload.request;
  const sessionKey = typeof request.sessionKey === 'string' ? request.sessionKey.trim() : '';
  return {
    requestId,
    request,
    sessionKey,
    allowedDecisions: normalizeApprovalDecisions(request.allowedDecisions),
  };
};

export const parseApprovalResolvedPayload = (payload: unknown): string | null => {
  if (!isRecord(payload)) return null;
  const requestId = typeof payload.id === 'string' ? payload.id.trim() : '';
  return requestId || null;
};

export const buildExecApprovalPermissionRequest = (
  requestId: string,
  request: ExecApprovalRequest,
  command: string,
): PermissionRequest => {
  const { level: dangerLevel, reason: dangerReason } = getCommandDangerLevel(command);

  return {
    requestId,
    toolName: 'Bash',
    toolInput: {
      command,
      dangerLevel,
      dangerReason,
      cwd: request.cwd ?? null,
      host: request.host ?? null,
      security: request.security ?? null,
      ask: request.ask ?? null,
      resolvedPath: request.resolvedPath ?? null,
      sessionKey: request.sessionKey ?? null,
      agentId: request.agentId ?? null,
    },
    toolUseId: requestId,
  };
};

export const buildPluginApprovalPermissionRequest = (
  requestId: string,
  request: PluginApprovalRequest,
  allowedDecisions?: ApprovalDecision[],
): PermissionRequest => ({
  requestId,
  toolName: request.toolName?.trim() || request.pluginId?.trim() || 'PluginApproval',
  toolInput: {
    approvalKind: 'plugin',
    title: request.title ?? null,
    description: request.description ?? null,
    severity: request.severity ?? null,
    pluginId: request.pluginId ?? null,
    toolName: request.toolName ?? null,
    toolCallId: request.toolCallId ?? null,
    allowedDecisions: allowedDecisions ?? null,
    sessionKey: request.sessionKey ?? null,
    agentId: request.agentId ?? null,
  },
  toolUseId: request.toolCallId ?? requestId,
});

export const resolveApprovalDecision = (
  pending: PendingApprovalEntry,
  result: PermissionResult,
): ApprovalDecision => {
  if (result.behavior !== 'allow') return 'deny';
  const allowed = pending.allowedDecisions;
  if (pending.allowAlways && (!allowed || allowed.includes('allow-always'))) {
    return 'allow-always';
  }
  if (!allowed || allowed.includes('allow-once')) {
    return 'allow-once';
  }
  if (allowed.includes('allow-always')) {
    return 'allow-always';
  }
  return 'deny';
};

export const getApprovalResolveMethod = (pending: PendingApprovalEntry): 'exec.approval.resolve' | 'plugin.approval.resolve' => (
  pending.kind === 'plugin' ? 'plugin.approval.resolve' : 'exec.approval.resolve'
);
