// Pure helpers for translating external DSH session events and summaries into
// idempotent Cowork messages and session metadata.
//
// Zero Electron imports — directly unit-testable under Node Vitest.

import { createHash } from 'crypto';
import * as path from 'path';

import { AgentId } from '../../../shared/agent/constants';
import { CoworkSessionSource } from '../../../shared/cowork/constants';
import type { CoworkMessage } from '../../coworkStore';
import { record } from '../dsh/dshSubagentHistory';

export const DshExternalMessagePartKind = {
  User: 'user',
  Thinking: 'thinking',
  Assistant: 'assistant',
  ToolUse: 'tool_use',
  ToolResult: 'tool_result',
} as const;
export type DshExternalMessagePartKind =
  typeof DshExternalMessagePartKind[keyof typeof DshExternalMessagePartKind];

export const DshDurableEventType = {
  UserMessage: 'user/message',
  AssistantMessage: 'assistant/message',
  ToolCall: 'tool/call',
  ToolResult: 'tool/result',
  SessionTitle: 'session/title',
  TurnStart: 'turn/start',
  TurnEnd: 'turn/end',
} as const;
export type DshDurableEventType =
  typeof DshDurableEventType[keyof typeof DshDurableEventType];

export interface DshWireImageRef {
  attachmentId?: string;
  mediaType?: string;
  name?: string;
  data?: string;
  raw: Record<string, unknown>;
}

export interface DshWireFileRef {
  name?: string;
  path?: string;
  mediaType?: string;
}

export interface TranslatedExternalMessage {
  id: string;
  type: CoworkMessage['type'];
  content: string;
  timestamp: number;
  metadata: Record<string, unknown>;
  dshSeq: number;
  rpcId?: string;
  imageRefs?: DshWireImageRef[];
  fileRefs?: DshWireFileRef[];
}

export type TranslatedDshDurableEvent =
  | { kind: 'messages'; seq: number; messages: TranslatedExternalMessage[] }
  | { kind: 'title'; seq: number; title: string }
  | { kind: 'turnStart'; seq: number }
  | { kind: 'turnEnd'; seq: number; error: string | null; aborted: boolean }
  | { kind: 'ignore'; seq: number };

export interface DshExternalSessionSummaryLike {
  sessionId: string;
  updatedAt?: number;
  running?: boolean;
  blank?: boolean;
  parentSessionId?: string;
  origin?: string;
  cwd?: string;
  projections?: {
    asOfSeq?: number;
    values?: Record<string, unknown>;
  };
}

export interface ExternalCwdAgentCandidate {
  id: string;
  workingDirectory?: string | null;
  enabled?: boolean;
}

const MAX_DERIVED_TITLE_LENGTH = 60;

/**
 * Generates a deterministic RFC-4122-shaped UUIDv5-style identifier for an
 * externally ingested DSH event part so replays and reconnects are strictly
 * idempotent locally and across future cloud sync.
 */
export function buildExternalDshMessageId(
  dshSessionId: string,
  seq: number,
  partKind: DshExternalMessagePartKind,
): string {
  const hash = createHash('sha256')
    .update(`lobsterai:dsh-external:${dshSessionId}:${seq}:${partKind}`)
    .digest();
  // Set version 5 nibble & RFC 4122 variant bits for valid UUID formatting.
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Deterministic W3C 32-hex trace ID matching `deriveExternalTurnTraceId` in
 * `dsh-bundles/lobsterai-host/plugins/ops-rpc-helpers.mjs`, allowing
 * `OpenClawTokenProxy`, `lobsterai-server` credit ledger, and
 * `CoworkTurnUsageService` to correlate externally driven DSH turns.
 */
export function deriveExternalTurnTraceId(dshSessionId: string, seq: number): string | null {
  const sid = dshSessionId.trim();
  if (!sid || !Number.isInteger(seq) || seq < 0) return null;
  const hex = createHash('sha256')
    .update(`lobsterai:dsh-external-trace:${sid}:${seq}`)
    .digest('hex')
    .slice(0, 32);
  return /^0+$/.test(hex) ? `1${hex.slice(1)}` : hex;
}

export function extractExternalTextFromBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type?: string; text?: string } => Boolean(block && typeof block === 'object'))
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join('');
}

export function extractExternalReasoningFromBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type?: string; text?: string; thinking?: string } => Boolean(block && typeof block === 'object'))
    .filter((block) => block.type === 'reasoning' || block.type === 'thinking')
    .map((block) => (typeof block.text === 'string' ? block.text : typeof block.thinking === 'string' ? block.thinking : ''))
    .filter(Boolean)
    .join('');
}

export function extractExternalAttachmentsFromBlocks(content: unknown): {
  imageRefs: DshWireImageRef[];
  fileRefs: DshWireFileRef[];
} {
  const imageRefs: DshWireImageRef[] = [];
  const fileRefs: DshWireFileRef[] = [];
  if (!Array.isArray(content)) return { imageRefs, fileRefs };

  for (const item of content) {
    const block = record(item);
    const blockType = typeof block.type === 'string' ? block.type : '';
    if (blockType === 'image') {
      const attachmentObj = record(block.attachment);
      const attachmentId =
        (typeof block.attachmentId === 'string' && block.attachmentId.trim())
        || (typeof attachmentObj.attachmentId === 'string' && attachmentObj.attachmentId.trim())
        || undefined;
      const mediaType =
        (typeof block.mediaType === 'string' && block.mediaType.trim())
        || (typeof block.mimeType === 'string' && block.mimeType.trim())
        || (typeof attachmentObj.mediaType === 'string' && attachmentObj.mediaType.trim())
        || undefined;
      const name =
        (typeof block.name === 'string' && block.name.trim())
        || (typeof attachmentObj.name === 'string' && attachmentObj.name.trim())
        || undefined;
      const data = typeof block.data === 'string' && block.data.trim() ? block.data.trim() : undefined;
      if (attachmentId || data) {
        imageRefs.push({
          ...(attachmentId ? { attachmentId } : {}),
          ...(mediaType ? { mediaType } : {}),
          ...(name ? { name } : {}),
          ...(data ? { data } : {}),
          raw: Object.keys(attachmentObj).length > 0 ? attachmentObj : block,
        });
      }
    } else if (blockType === 'file') {
      const fileObj = record(block.file);
      const filePath =
        (typeof block.path === 'string' && block.path.trim())
        || (typeof fileObj.path === 'string' && fileObj.path.trim())
        || undefined;
      const name =
        (typeof block.name === 'string' && block.name.trim())
        || (typeof fileObj.name === 'string' && fileObj.name.trim())
        || (filePath ? path.basename(filePath) : undefined);
      const mediaType =
        (typeof block.mediaType === 'string' && block.mediaType.trim())
        || (typeof fileObj.mediaType === 'string' && fileObj.mediaType.trim())
        || undefined;
      if (name || filePath) {
        fileRefs.push({
          ...(name ? { name } : {}),
          ...(filePath ? { path: filePath } : {}),
          ...(mediaType ? { mediaType } : {}),
        });
      }
    }
  }

  return { imageRefs, fileRefs };
}

function parseToolArgsSafe(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { raw };
    }
  }
  return {};
}

export function extractExternalStreamChunkDelta(chunk: Record<string, unknown> | undefined): string {
  if (!chunk) return '';
  if (typeof chunk.text === 'string') return chunk.text;
  if (typeof chunk.delta === 'string') return chunk.delta;
  return '';
}

export function isExternalFailedAssistantOutcome(outcome: unknown): boolean {
  if (!outcome || typeof outcome !== 'object') return false;
  const rec = outcome as { kind?: unknown; eventType?: unknown };
  if (rec.kind === 'abandoned') return true;
  return rec.kind === 'committed' && rec.eventType === 'assistant/attempt';
}

export function extractExternalTurnEndError(reason: unknown): string | null {
  if (!reason || typeof reason !== 'object') return null;
  const rec = reason as {
    kind?: unknown;
    error?: { message?: unknown; code?: unknown } | string;
  };
  if (rec.kind !== 'error') return null;
  if (typeof rec.error === 'string' && rec.error.trim()) {
    return rec.error.trim();
  }
  if (rec.error && typeof rec.error === 'object') {
    if (typeof rec.error.message === 'string' && rec.error.message.trim()) {
      return rec.error.message.trim();
    }
    if (typeof rec.error.code === 'string' && rec.error.code.trim()) {
      return rec.error.code.trim();
    }
  }
  return 'Agent turn failed';
}

export function isExternalAbortedTurnEndReason(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const { kind } = reason as { kind?: unknown };
  return kind === 'aborted' || kind === 'interrupted';
}

export function translateDshDurableEvent(
  dshSessionId: string,
  event: Record<string, unknown>,
): TranslatedDshDurableEvent {
  const seq = typeof event.seq === 'number' && Number.isInteger(event.seq) ? event.seq : -1;
  if (seq < 0) return { kind: 'ignore', seq: -1 };

  const evType = typeof event.type === 'string' ? event.type : '';
  const data = record(event.data);
  const timestamp =
    typeof event.time === 'number' && Number.isFinite(event.time) && event.time > 0
      ? event.time
      : Date.now();

  switch (evType) {
    case DshDurableEventType.UserMessage: {
      // Only mirror genuine user-authored prompts (`source.kind === 'user'`),
      // skipping internal goal-loop, subagent-settlement, and synthetic system messages.
      const source = record(data.source);
      if (source.kind !== 'user') {
        return { kind: 'ignore', seq };
      }
      // Skip non-append replacement records so compaction/rewrite doesn't duplicate prompts.
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') {
        return { kind: 'ignore', seq };
      }
      const messageObj = record(data.message);
      const rawContent = messageObj.content ?? data.content;
      const text = extractExternalTextFromBlocks(rawContent).trim();
      const { imageRefs, fileRefs } = extractExternalAttachmentsFromBlocks(rawContent);
      const fallbackFileText = !text && fileRefs.length > 0
        ? fileRefs.map((ref) => (ref.path ? `[${ref.name || path.basename(ref.path)}](${ref.path})` : (ref.name ?? ''))).filter(Boolean).join('\n')
        : '';
      const finalText = text || fallbackFileText;
      if (!finalText && imageRefs.length === 0) {
        return { kind: 'ignore', seq };
      }
      const rpcId = typeof source.rpcId === 'string' && source.rpcId.trim()
        ? source.rpcId.trim()
        : undefined;
      const traceId = deriveExternalTurnTraceId(dshSessionId, seq);
      return {
        kind: 'messages',
        seq,
        messages: [
          {
            id: buildExternalDshMessageId(dshSessionId, seq, DshExternalMessagePartKind.User),
            type: 'user',
            content: finalText,
            timestamp,
            dshSeq: seq,
            ...(rpcId ? { rpcId } : {}),
            ...(imageRefs.length > 0 ? { imageRefs } : {}),
            ...(fileRefs.length > 0 ? { fileRefs } : {}),
            metadata: {
              seq,
              dshSessionId,
              externalSource: CoworkSessionSource.DshExternal,
              ...(traceId ? { llmTrace: { traceId, startedAt: timestamp } } : {}),
              ...(rpcId ? { dshRpcId: rpcId } : {}),
              ...(fileRefs.length > 0
                ? {
                    filePaths: fileRefs
                      .map((ref) => ref.path)
                      .filter((p): p is string => typeof p === 'string' && p.length > 0),
                  }
                : {}),
            },
          },
        ],
      };
    }

    case DshDurableEventType.ToolCall: {
      const callId = String(data.callId ?? buildExternalDshMessageId(dshSessionId, seq, DshExternalMessagePartKind.ToolUse));
      const toolName = String(data.name ?? 'tool');
      const toolInput = parseToolArgsSafe(data.arguments);
      return {
        kind: 'messages',
        seq,
        messages: [
          {
            id: buildExternalDshMessageId(dshSessionId, seq, DshExternalMessagePartKind.ToolUse),
            type: 'tool_use',
            content: toolName,
            timestamp,
            dshSeq: seq,
            metadata: {
              toolUseId: callId,
              toolName,
              toolInput,
              seq,
              dshSessionId,
              externalSource: CoworkSessionSource.DshExternal,
            },
          },
        ],
      };
    }

    case DshDurableEventType.ToolResult: {
      const messageObj = record(data.message);
      const callId = String(messageObj.callId ?? messageObj.toolCallId ?? data.callId ?? '');
      const text = extractExternalTextFromBlocks(messageObj.content ?? data.content);
      const resultMeta = record(data.meta);
      const hostResult = record(resultMeta.lobsterToolResult);
      const isError = Boolean(hostResult.isError || messageObj.isError || data.isError);
      return {
        kind: 'messages',
        seq,
        messages: [
          {
            id: buildExternalDshMessageId(dshSessionId, seq, DshExternalMessagePartKind.ToolResult),
            type: 'tool_result',
            content: text,
            timestamp,
            dshSeq: seq,
            metadata: {
              toolUseId: callId,
              isError,
              ...(hostResult.details ? { toolResultDetails: record(hostResult.details) } : {}),
              seq,
              dshSessionId,
              externalSource: CoworkSessionSource.DshExternal,
            },
          },
        ],
      };
    }

    case DshDurableEventType.AssistantMessage: {
      const messageObj = record(data.message);
      const rawContent = messageObj.content ?? data.content;
      const thinking = extractExternalReasoningFromBlocks(rawContent);
      const text = extractExternalTextFromBlocks(rawContent);
      const messages: TranslatedExternalMessage[] = [];
      if (thinking) {
        messages.push({
          id: buildExternalDshMessageId(dshSessionId, seq, DshExternalMessagePartKind.Thinking),
          type: 'assistant',
          content: thinking,
          timestamp,
          dshSeq: seq,
          metadata: {
            isThinking: true,
            isStreaming: false,
            seq,
            dshSessionId,
            externalSource: CoworkSessionSource.DshExternal,
          },
        });
      }
      if (text) {
        messages.push({
          id: buildExternalDshMessageId(dshSessionId, seq, DshExternalMessagePartKind.Assistant),
          type: 'assistant',
          content: text,
          timestamp,
          dshSeq: seq,
          metadata: {
            isStreaming: false,
            seq,
            dshSessionId,
            externalSource: CoworkSessionSource.DshExternal,
          },
        });
      }
      if (messages.length === 0) return { kind: 'ignore', seq };
      return { kind: 'messages', seq, messages };
    }

    case DshDurableEventType.SessionTitle: {
      const title = typeof data.title === 'string' ? data.title.trim() : '';
      return title ? { kind: 'title', seq, title } : { kind: 'ignore', seq };
    }

    case DshDurableEventType.TurnStart:
      return { kind: 'turnStart', seq };

    case DshDurableEventType.TurnEnd:
      return {
        kind: 'turnEnd',
        seq,
        error: extractExternalTurnEndError(data.reason),
        aborted: isExternalAbortedTurnEndReason(data.reason),
      };

    default:
      return { kind: 'ignore', seq };
  }
}

export function extractSessionTitleFromSummary(
  summary: DshExternalSessionSummaryLike | undefined,
): string | null {
  const raw = summary?.projections?.values?.title;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  return null;
}

export function truncateExternalSessionTitle(raw: string): string {
  const singleLine = raw.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '';
  if (singleLine.length <= MAX_DERIVED_TITLE_LENGTH) return singleLine;
  return `${singleLine.slice(0, MAX_DERIVED_TITLE_LENGTH - 1)}…`;
}

export function deriveExternalSessionTitle(options: {
  summary?: DshExternalSessionSummaryLike;
  translatedEvents?: readonly TranslatedDshDurableEvent[];
  fallbackTitle: string;
}): string {
  const fromSummary = extractSessionTitleFromSummary(options.summary);
  if (fromSummary) return truncateExternalSessionTitle(fromSummary);

  let latestTitle: string | null = null;
  let firstUserPrompt: string | null = null;
  for (const item of options.translatedEvents ?? []) {
    if (item.kind === 'title' && item.title.trim()) {
      latestTitle = item.title.trim();
    } else if (item.kind === 'messages' && !firstUserPrompt) {
      const userMsg = item.messages.find((msg) => msg.type === 'user' && msg.content.trim());
      if (userMsg) {
        firstUserPrompt = userMsg.content.trim();
      }
    }
  }
  if (latestTitle) return truncateExternalSessionTitle(latestTitle);
  if (firstUserPrompt) return truncateExternalSessionTitle(firstUserPrompt);
  return options.fallbackTitle;
}

function normalizePathForCompare(raw: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(raw.trim()).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInsideDir(target: string, dir: string, sep: string): boolean {
  if (target === dir) return true;
  const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  return target.startsWith(prefix);
}

/**
 * Matches an externally created DSH session's `cwd` against LobsterAI's
 * configured agents (exact working directory match first, then deepest
 * containing agent directory), falling back to `'main'`.
 */
export function resolveAgentIdForExternalCwd(
  cwd: string | null | undefined,
  agents: readonly ExternalCwdAgentCandidate[],
  platform: NodeJS.Platform = process.platform,
): string {
  if (typeof cwd !== 'string' || !cwd.trim()) return AgentId.Main;
  const target = normalizePathForCompare(cwd, platform);
  const sep = platform === 'win32' ? '\\' : '/';

  let bestAgentId: string | null = null;
  let bestDepth = -1;

  for (const agent of agents) {
    if (agent.enabled === false) continue;
    if (typeof agent.workingDirectory !== 'string' || !agent.workingDirectory.trim()) continue;
    const candidateDir = normalizePathForCompare(agent.workingDirectory, platform);
    if (!isPathInsideDir(target, candidateDir, sep)) continue;
    if (candidateDir === target) {
      // Prefer non-main specialist agent on exact tie, otherwise take immediately.
      if (agent.id !== AgentId.Main || bestAgentId === null) {
        bestAgentId = agent.id;
        bestDepth = Number.MAX_SAFE_INTEGER;
      }
      continue;
    }
    if (candidateDir.length > bestDepth) {
      bestDepth = candidateDir.length;
      bestAgentId = agent.id;
    }
  }

  return bestAgentId ?? AgentId.Main;
}

export function isEligibleExternalDshSummary(
  summary: DshExternalSessionSummaryLike | null | undefined,
): boolean {
  if (!summary || typeof summary.sessionId !== 'string' || !summary.sessionId.trim()) return false;
  if (summary.origin === 'subagent') return false;
  if (typeof summary.parentSessionId === 'string' && summary.parentSessionId.trim()) return false;
  return true;
}
