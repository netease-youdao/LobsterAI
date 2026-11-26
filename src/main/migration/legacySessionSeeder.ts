// Offline Legacy OpenClaw -> DSH v4 JSONL-Zstd Session Seeder.
//
// Runs synchronously during `runLegacyOpenClawMigration` BEFORE `initStore()`
// and `createWindow()` so historical OpenClaw sessions are natively persisted
// in `<userData>/dsh-profile/sessions/` in DSH's canonical v4 Zstandard-framed
// JSONL format and bound via `cowork_sessions.claude_session_id = 'dsh:<id>'`.
//
// Zero Electron imports — uses only Node built-ins (`node:zlib`, `node:crypto`,
// `node:fs`, `node:path`) and `better-sqlite3`, so it stays fast, atomic, and
// directly unit/E2E testable under Node Vitest.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib';

import type Database from 'better-sqlite3';

import { stripNullChars } from '../../shared/cowork/text';
import {
  DSH_PROFILE_DIR_NAME,
  DSH_SESSION_ID_PREFIX,
} from '../../shared/dshEngine/hostConstants';
import {
  ContinuityCapsuleSource,
  type CoworkContinuityCapsule,
  formatCoworkContinuityCapsuleBridge,
} from '../libs/agentEngine/coworkContinuityCapsule';
import { TrustedWriteContext, withTrustedMigrationWrite } from './remoteWriteContext';

const DSH_SESSION_FORMAT_VERSION = 4;
const DSH_SESSION_LOG_FILENAME = `session.v${DSH_SESSION_FORMAT_VERSION}.jsonl.zstd`;
const LEGACY_MODEL_PROVIDER = 'legacy-openclaw';
const LEGACY_MODEL_FALLBACK = 'legacy-openclaw';
const MAX_SESSION_TITLE_BYTES = 200;
const ZSTD_CHECKSUM_OPTIONS = {
  params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
};

export interface LegacySessionMessageInput {
  id: string;
  type: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: number | null;
}

export interface LegacySessionSeedInput {
  dshSessionId: string;
  title?: string | null;
  cwd?: string | null;
  createdAt?: number | null;
  messages: readonly LegacySessionMessageInput[];
  continuityCapsule?: CoworkContinuityCapsule | null;
  createId?: () => string;
}

export interface DshV4HeaderLine {
  type: 'session';
  version: 4;
  id: string;
  createdAt: number;
  cwd?: string;
  isSeeded: false;
  delegationDepth: 0;
}

export interface DshV4SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  surfaceOp?: 'append';
  sourceEventSeqs?: number[];
}

export interface BuiltLegacySessionSeedLog {
  header: DshV4HeaderLine;
  events: DshV4SessionEvent[];
}

export interface LegacySessionSeedingResult {
  sessionsPreSeeded: number;
  sessionsPreservedForLazyBridge: number;
  createdSessionDirs: string[];
  errors: Array<{ sessionId: string; error: string }>;
}

/**
 * Encode one arbitrary session id as a safe single filesystem segment matching
 * `@deepseek-ai/dsh-session-persistence-jsonl`'s `encodeSegment`.
 */
export function encodeDshSessionSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return out;
}

/**
 * Build the filesystem-safe project directory key matching
 * `@deepseek-ai/dsh-session-persistence-jsonl`'s `projectKey`.
 */
export function buildDshProjectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

export function resolveDshSessionsRoot(userDataDir: string): string {
  return path.join(userDataDir, DSH_PROFILE_DIR_NAME, 'sessions');
}

export function resolveDshSessionDir(
  sessionsRoot: string,
  cwd: string | undefined,
  dshSessionId: string,
): string {
  const projectFolder = cwd !== undefined ? buildDshProjectKey(cwd) : '_no-cwd';
  return path.join(sessionsRoot, projectFolder, encodeDshSessionSegment(dshSessionId));
}

export function resolveDshSessionLogPath(
  sessionsRoot: string,
  cwd: string | undefined,
  dshSessionId: string,
): string {
  return path.join(resolveDshSessionDir(sessionsRoot, cwd, dshSessionId), DSH_SESSION_LOG_FILENAME);
}

function normalizeSafeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const floored = Math.floor(value);
    if (Number.isSafeInteger(floored) && floored >= 0) return floored;
  }
  return Math.max(0, Math.floor(fallback));
}

function normalizeAbsoluteCwd(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return path.isAbsolute(trimmed) ? trimmed : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = stripNullChars(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSessionTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const collapsed = stripNullChars(raw).replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  let bytes = 0;
  let out = '';
  for (const ch of collapsed) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > MAX_SESSION_TITLE_BYTES) break;
    out += ch;
    bytes += chBytes;
  }
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function serializeToolArguments(rawInput: unknown): string {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    try {
      return JSON.stringify(rawInput);
    } catch {
      return '{}';
    }
  }
  if (typeof rawInput === 'string') {
    const trimmed = stripNullChars(rawInput).trim();
    if (trimmed) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return JSON.stringify(parsed);
        }
      } catch {
        // Wrap non-JSON string input into a valid JSON object for strict parsers.
      }
      return JSON.stringify({ input: trimmed });
    }
  }
  return '{}';
}

function formatUserImageNotes(metadata: Record<string, unknown> | null | undefined): string[] {
  if (!metadata) return [];
  const notes: string[] = [];
  const seenPaths = new Set<string>();

  const historyRefs = metadata.historyImageReferences;
  if (Array.isArray(historyRefs)) {
    for (const ref of historyRefs) {
      if (!ref || typeof ref !== 'object') continue;
      const record = ref as Record<string, unknown>;
      const filePath = nonEmptyString(record.path);
      if (!filePath || seenPaths.has(filePath)) continue;
      seenPaths.add(filePath);
      const name = nonEmptyString(record.name) ?? path.basename(filePath);
      notes.push(`[Attached historical image: ${name} (${filePath}) — use read_image to inspect if needed]`);
    }
  }

  const localAttachments = metadata.localMediaAttachments;
  if (Array.isArray(localAttachments)) {
    for (const att of localAttachments) {
      if (!att || typeof att !== 'object') continue;
      const record = att as Record<string, unknown>;
      const filePath = nonEmptyString(record.localPath);
      if (!filePath || seenPaths.has(filePath)) continue;
      seenPaths.add(filePath);
      const name = nonEmptyString(record.name) ?? path.basename(filePath);
      notes.push(`[Attached local media: ${name} (${filePath})]`);
    }
  }

  return notes;
}

function formatUserMessageText(msg: LegacySessionMessageInput): string {
  const baseText = stripNullChars(typeof msg.content === 'string' ? msg.content : '').trim();
  const imageNotes = formatUserImageNotes(msg.metadata);
  if (imageNotes.length === 0) return baseText;
  if (!baseText) return imageNotes.join('\n');
  return `${baseText}\n\n${imageNotes.join('\n')}`;
}

function formatContinuityCapsulePrefix(capsule: CoworkContinuityCapsule | null | undefined): string {
  if (!capsule || typeof capsule !== 'object') return '';
  try {
    const normalized: CoworkContinuityCapsule = {
      version: 1,
      sessionId: typeof capsule.sessionId === 'string' ? capsule.sessionId : '',
      revision: typeof capsule.revision === 'number' ? capsule.revision : 1,
      updatedAt: typeof capsule.updatedAt === 'number' ? capsule.updatedAt : Date.now(),
      lastSource: capsule.lastSource ?? ContinuityCapsuleSource.PostRun,
      currentObjective: typeof capsule.currentObjective === 'string' ? capsule.currentObjective : '',
      recentUserRequests: Array.isArray(capsule.recentUserRequests) ? capsule.recentUserRequests : [],
      userConstraints: Array.isArray(capsule.userConstraints) ? capsule.userConstraints : [],
      decisions: Array.isArray(capsule.decisions) ? capsule.decisions : [],
      completedFacts: Array.isArray(capsule.completedFacts) ? capsule.completedFacts : [],
      recentActions: Array.isArray(capsule.recentActions) ? capsule.recentActions : [],
      touchedFiles: Array.isArray(capsule.touchedFiles) ? capsule.touchedFiles : [],
      keySymbols: Array.isArray(capsule.keySymbols) ? capsule.keySymbols : [],
      verification: Array.isArray(capsule.verification) ? capsule.verification : [],
      nextSteps: Array.isArray(capsule.nextSteps) ? capsule.nextSteps : [],
      recentFailures: Array.isArray(capsule.recentFailures) ? capsule.recentFailures : [],
      activeCapabilities: Array.isArray(capsule.activeCapabilities) ? capsule.activeCapabilities : [],
      openQuestions: Array.isArray(capsule.openQuestions) ? capsule.openQuestions : [],
    };
    const formatted = stripNullChars(formatCoworkContinuityCapsuleBridge(normalized)).trim();
    if (!formatted) return '';
    return `<previous_conversation_summary>\n${formatted}\n</previous_conversation_summary>`;
  } catch {
    return '';
  }
}

type AssistantContentBlock =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string };

interface PendingToolCall {
  callId: string;
  rawToolUseId?: string;
  name: string;
  argumentsJson: string;
  time: number;
  result?: {
    text: string;
    isError: boolean;
    time: number;
  };
}

interface StepDraft {
  blocks: Array<{ type: 'reasoning' | 'text'; text: string }>;
  calls: PendingToolCall[];
  receivedAnyResult: boolean;
  model: string | null;
  time: number;
}

interface TurnDraft {
  userText: string;
  userTime: number;
  steps: StepDraft[];
}

function createEmptyStep(time: number): StepDraft {
  return {
    blocks: [],
    calls: [],
    receivedAnyResult: false,
    model: null,
    time,
  };
}

/**
 * Convert legacy LobsterAI `cowork_messages` + optional continuity capsule into
 * a complete, DSH v4 relationship-valid session header + event log.
 *
 * Returns `null` when the session carries no conversational content and no
 * continuity capsule (e.g. an empty session with 0 messages).
 */
export function buildLegacySessionSeedLog(
  input: LegacySessionSeedInput,
): BuiltLegacySessionSeedLog | null {
  const createId = input.createId ?? randomUUID;
  const fallbackTime = normalizeSafeNonNegativeInt(input.createdAt, Date.now());
  const capsulePrefix = formatContinuityCapsulePrefix(input.continuityCapsule);

  const turns: TurnDraft[] = [];
  let currentTurn: TurnDraft | null = null;
  let currentStep: StepDraft | null = null;
  const usedCallIds = new Set<string>();
  let callCounter = 0;

  const flushStep = (): void => {
    if (!currentTurn || !currentStep) return;
    if (currentStep.blocks.length > 0 || currentStep.calls.length > 0) {
      currentTurn.steps.push(currentStep);
    }
    currentStep = null;
  };

  const ensureTurn = (time: number, syntheticUserText: string): TurnDraft => {
    if (!currentTurn) {
      currentTurn = {
        userText: syntheticUserText,
        userTime: time,
        steps: [],
      };
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  const ensureStep = (time: number): StepDraft => {
    ensureTurn(time, '[Historical session context]');
    if (!currentStep) {
      currentStep = createEmptyStep(time);
    }
    return currentStep;
  };

  for (const msg of input.messages) {
    const msgTime = normalizeSafeNonNegativeInt(msg.createdAt, fallbackTime);
    const meta = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : null;

    switch (msg.type) {
      case 'user': {
        flushStep();
        currentTurn = {
          userText: formatUserMessageText(msg),
          userTime: msgTime,
          steps: [],
        };
        turns.push(currentTurn);
        break;
      }

      case 'assistant': {
        const text = stripNullChars(typeof msg.content === 'string' ? msg.content : '');
        if (!text.trim()) break;
        const isThinking = meta?.isThinking === true;
        let step = ensureStep(msgTime);
        if (step.calls.length > 0) {
          flushStep();
          step = ensureStep(msgTime);
        }
        step.blocks.push({
          type: isThinking ? 'reasoning' : 'text',
          text,
        });
        const modelName = nonEmptyString(meta?.model);
        if (modelName) {
          step.model = modelName;
        }
        step.time = Math.max(step.time, msgTime);
        break;
      }

      case 'tool_use': {
        let step = ensureStep(msgTime);
        if (step.receivedAnyResult) {
          flushStep();
          step = ensureStep(msgTime);
        }
        const name = nonEmptyString(meta?.toolName) ?? nonEmptyString(msg.content) ?? 'tool';
        const argumentsJson = serializeToolArguments(meta?.toolInput);
        const rawToolUseId = nonEmptyString(meta?.toolUseId);
        let callId = rawToolUseId;
        if (!callId || usedCallIds.has(callId)) {
          do {
            callCounter += 1;
            callId = `legacy-call-${callCounter}`;
          } while (usedCallIds.has(callId));
        }
        usedCallIds.add(callId);
        step.calls.push({
          callId,
          rawToolUseId,
          name,
          argumentsJson,
          time: msgTime,
        });
        step.time = Math.max(step.time, msgTime);
        break;
      }

      case 'tool_result': {
        if (!currentStep || currentStep.calls.length === 0) {
          // Orphaned tool result without an advertised tool_use — skip safely so
          // DSH v4 relationship validation never sees an unadvertised tool lifecycle.
          break;
        }
        const rawToolUseId = nonEmptyString(meta?.toolUseId);
        const targetCall =
          (rawToolUseId
            ? currentStep.calls.find(
              (c) => !c.result && (c.rawToolUseId === rawToolUseId || c.callId === rawToolUseId),
            )
            : undefined)
          ?? currentStep.calls.find((c) => !c.result);
        if (!targetCall) break;

        const rawResult = typeof msg.content === 'string' && msg.content.length > 0
          ? msg.content
          : typeof meta?.toolResult === 'string'
            ? meta.toolResult
            : '';
        targetCall.result = {
          text: stripNullChars(rawResult),
          isError: Boolean(meta?.isError),
          time: msgTime,
        };
        currentStep.receivedAnyResult = true;
        break;
      }

      case 'system':
      default:
        // Skip transient UI system banners (e.g. model-change notices).
        break;
    }
  }

  flushStep();

  if (turns.length === 0) {
    if (!capsulePrefix) {
      return null;
    }
    turns.push({
      userText: capsulePrefix,
      userTime: fallbackTime,
      steps: [],
    });
  } else if (capsulePrefix) {
    const firstTurn = turns[0];
    firstTurn.userText = firstTurn.userText
      ? `${capsulePrefix}\n\n${firstTurn.userText}`
      : capsulePrefix;
  }

  const events: DshV4SessionEvent[] = [];
  let currentTime = normalizeSafeNonNegativeInt(turns[0]?.userTime, fallbackTime);

  const advanceTime = (candidate: number): number => {
    const safe = normalizeSafeNonNegativeInt(candidate, currentTime);
    if (safe > currentTime) currentTime = safe;
    return currentTime;
  };

  const pushEvent = (
    event: Omit<DshV4SessionEvent, 'seq' | 'time'>,
  ): number => {
    const seq = events.length;
    events.push({
      ...event,
      seq,
      time: currentTime,
    });
    return seq;
  };

  const normalizedTitle = normalizeSessionTitle(input.title);

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turnIndex + 1;
    const draft = turns[turnIndex];
    advanceTime(draft.userTime);

    pushEvent({ type: 'turn/start', data: { turn } });
    let stepNum = 1;
    pushEvent({ type: 'step/start', data: { turn, step: stepNum } });

    if (turn === 1) {
      // Empty system head holds surface node 0 so DSH replaces it with the live
      // system prompt on resume instead of appending a second system message.
      pushEvent({
        type: 'system/message',
        data: {
          turn,
          step: stepNum,
          message: {
            id: createId(),
            role: 'system',
            content: [],
            source: { kind: 'system-prompt' },
          },
        },
        surfaceOp: 'append',
      });
    }

    pushEvent({
      type: 'user/message',
      data: {
        id: createId(),
        role: 'user',
        content: [{ type: 'text', text: draft.userText }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    });

    for (let stepIdx = 0; stepIdx < draft.steps.length; stepIdx += 1) {
      const step = draft.steps[stepIdx];
      if (stepIdx > 0) {
        stepNum += 1;
        advanceTime(step.time);
        pushEvent({ type: 'step/start', data: { turn, step: stepNum } });
      } else {
        advanceTime(step.time);
      }

      const content: AssistantContentBlock[] = [
        ...step.blocks,
        ...step.calls.map((call): AssistantContentBlock => ({
          type: 'tool-call',
          id: call.callId,
          name: call.name,
          arguments: call.argumentsJson,
        })),
      ];

      pushEvent({
        type: 'assistant/message',
        data: {
          turn,
          step: stepNum,
          message: {
            id: createId(),
            role: 'assistant',
            content,
            source: {
              kind: 'model',
              provider: LEGACY_MODEL_PROVIDER,
              model: step.model ?? LEGACY_MODEL_FALLBACK,
            },
          },
          stream: [],
        },
        surfaceOp: 'append',
      });

      const callSeqs = step.calls.map((call) => {
        advanceTime(call.time);
        return pushEvent({
          type: 'tool/call',
          data: {
            turn,
            step: stepNum,
            callId: call.callId,
            name: call.name,
            arguments: call.argumentsJson,
          },
        });
      });

      for (let callIdx = 0; callIdx < step.calls.length; callIdx += 1) {
        const call = step.calls[callIdx];
        const callSeq = callSeqs[callIdx];
        const resultText = call.result
          ? call.result.text
          : '(Tool result was not recorded in legacy history.)';
        const isError = call.result ? call.result.isError : true;
        if (call.result) {
          advanceTime(call.result.time);
        }

        pushEvent({
          type: 'tool/result',
          data: {
            turn,
            step: stepNum,
            message: {
              id: createId(),
              role: 'tool',
              toolCallId: call.callId,
              source: { kind: 'tool', callId: call.callId },
              content: [{ type: 'text', text: resultText }],
              isError,
            },
          },
          surfaceOp: 'append',
          sourceEventSeqs: [callSeq],
        });
      }

      if (stepIdx < draft.steps.length - 1) {
        pushEvent({ type: 'step/end', data: { turn, step: stepNum } });
      }
    }

    pushEvent({ type: 'step/end', data: { turn, step: stepNum } });
    pushEvent({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });

    if (turn === 1 && normalizedTitle) {
      pushEvent({
        type: 'session/title',
        data: {
          title: normalizedTitle,
          messageSeqs: [],
          source: { kind: 'user' },
        },
      });
    }
  }

  const cwd = normalizeAbsoluteCwd(input.cwd);
  const header: DshV4HeaderLine = {
    type: 'session',
    version: DSH_SESSION_FORMAT_VERSION,
    id: input.dshSessionId,
    createdAt: events[0]?.time ?? fallbackTime,
    ...(cwd !== undefined ? { cwd } : {}),
    isSeeded: false,
    delegationDepth: 0,
  };

  return { header, events };
}

/**
 * Encode a DSH v4 header + event list into the exact 2-frame checksummed
 * Zstandard JSONL container expected by `@deepseek-ai/dsh-session-persistence-jsonl`:
 * - Frame 1: standalone header JSON line ending in `\n`
 * - Frame 2: newline-delimited event JSON lines ending in `\n` (omitted if empty)
 */
export function encodeDshV4SessionZstd(
  header: DshV4HeaderLine,
  events: readonly DshV4SessionEvent[],
): Buffer {
  const headerLine = `${JSON.stringify(header)}\n`;
  const headerFrame = zstdCompressSync(Buffer.from(headerLine, 'utf8'), ZSTD_CHECKSUM_OPTIONS);
  if (events.length === 0) {
    return headerFrame;
  }
  const bodyText = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  const bodyFrame = zstdCompressSync(Buffer.from(bodyText, 'utf8'), ZSTD_CHECKSUM_OPTIONS);
  return Buffer.concat([headerFrame, bodyFrame]);
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function getTableColumns(db: Database.Database, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) return new Set();
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((r) => String(r.name ?? '')).filter(Boolean));
}

function safeParseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isAlreadyDshSessionId(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || !value) return false;
  return value.startsWith(DSH_SESSION_ID_PREFIX) || value.startsWith('session-');
}

/**
 * Pre-seed all legacy OpenClaw sessions in `cowork_sessions` into DSH's native
 * v4 JSONL-Zstd session store (`<userData>/dsh-profile/sessions/...`) and bind
 * `cowork_sessions.claude_session_id = 'dsh:<id>'`.
 *
 * Empty sessions (0 messages & no continuity capsule) and any corrupted session
 * that fails conversion are safely left unbound so `dshRuntimeAdapter`'s Lazy
 * Context Bridge handles them as a fallback without aborting migration.
 */
export function seedLegacySessionsToDsh(options: {
  db: Database.Database;
  userDataDir: string;
  nowMs?: number;
}): LegacySessionSeedingResult {
  const { db, userDataDir } = options;
  const nowMs = options.nowMs ?? Date.now();
  const result: LegacySessionSeedingResult = {
    sessionsPreSeeded: 0,
    sessionsPreservedForLazyBridge: 0,
    createdSessionDirs: [],
    errors: [],
  };

  if (!tableExists(db, 'cowork_sessions')) {
    return result;
  }

  const sessionCols = getTableColumns(db, 'cowork_sessions');
  if (!sessionCols.has('id')) {
    return result;
  }

  const hasClaudeSessionId = sessionCols.has('claude_session_id');
  const legacyWhere = hasClaudeSessionId
    ? "WHERE claude_session_id IS NULL OR (claude_session_id NOT LIKE 'dsh:%' AND claude_session_id NOT LIKE 'session-%')"
    : '';

  // If we cannot bind `claude_session_id` or `cowork_messages` doesn't exist,
  // count legacy sessions as preserved for lazy bridge and exit cleanly.
  const msgCols = getTableColumns(db, 'cowork_messages');
  const canReadMessages =
    msgCols.has('id')
    && msgCols.has('session_id')
    && msgCols.has('type')
    && msgCols.has('content');

  if (!hasClaudeSessionId || !canReadMessages) {
    const countRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM cowork_sessions ${legacyWhere}`)
      .get() as { cnt: number };
    result.sessionsPreservedForLazyBridge = countRow.cnt;
    return result;
  }

  const selectSessionCols = [
    'id',
    'claude_session_id',
    sessionCols.has('title') ? 'title' : 'NULL AS title',
    sessionCols.has('cwd') ? 'cwd' : 'NULL AS cwd',
    sessionCols.has('created_at') ? 'created_at' : 'NULL AS created_at',
  ].join(', ');
  const sessionOrderBy = sessionCols.has('created_at') ? 'ORDER BY created_at ASC, id ASC' : 'ORDER BY id ASC';

  const legacySessions = db
    .prepare(`SELECT ${selectSessionCols} FROM cowork_sessions ${legacyWhere} ${sessionOrderBy}`)
    .all() as Array<{
      id: string;
      claude_session_id: string | null;
      title: string | null;
      cwd: string | null;
      created_at: number | null;
    }>;

  if (legacySessions.length === 0) {
    return result;
  }

  const selectMsgCols = [
    'id',
    'type',
    'content',
    msgCols.has('metadata') ? 'metadata' : 'NULL AS metadata',
    msgCols.has('created_at') ? 'created_at' : 'NULL AS created_at',
  ].join(', ');
  const msgOrderBy = msgCols.has('sequence') && msgCols.has('created_at')
    ? 'ORDER BY COALESCE(sequence, created_at) ASC, created_at ASC, ROWID ASC'
    : msgCols.has('sequence')
      ? 'ORDER BY COALESCE(sequence, 2147483647) ASC, ROWID ASC'
      : msgCols.has('created_at')
        ? 'ORDER BY created_at ASC, ROWID ASC'
        : 'ORDER BY ROWID ASC';

  const selectMessagesStmt = db.prepare(
    `SELECT ${selectMsgCols} FROM cowork_messages WHERE session_id = ? ${msgOrderBy}`,
  );

  const capsuleCols = getTableColumns(db, 'cowork_session_capsules');
  const selectCapsuleStmt =
    capsuleCols.has('session_id') && capsuleCols.has('capsule_json')
      ? db.prepare('SELECT capsule_json FROM cowork_session_capsules WHERE session_id = ?')
      : null;

  const updateSessionIdStmt = db.prepare(
    'UPDATE cowork_sessions SET claude_session_id = ? WHERE id = ?',
  );

  const sessionsRoot = resolveDshSessionsRoot(userDataDir);

  for (const session of legacySessions) {
    if (isAlreadyDshSessionId(session.claude_session_id)) {
      continue;
    }

    let createdDirForSession: string | null = null;
    try {
      const rawMessages = selectMessagesStmt.all(session.id) as Array<{
        id: string;
        type: string;
        content: string;
        metadata: string | null;
        created_at: number | null;
      }>;

      let continuityCapsule: CoworkContinuityCapsule | null = null;
      if (selectCapsuleStmt) {
        const capRow = selectCapsuleStmt.get(session.id) as { capsule_json?: string } | undefined;
        const parsedCap = safeParseJsonObject(capRow?.capsule_json);
        if (parsedCap) {
          continuityCapsule = parsedCap as unknown as CoworkContinuityCapsule;
        }
      }

      const dshSessionId = randomUUID();
      const messages: LegacySessionMessageInput[] = rawMessages.map((row) => ({
        id: row.id,
        type: row.type,
        content: row.content ?? '',
        metadata: safeParseJsonObject(row.metadata),
        createdAt: row.created_at,
      }));

      const built = buildLegacySessionSeedLog({
        dshSessionId,
        title: session.title,
        cwd: session.cwd,
        createdAt: session.created_at ?? nowMs,
        messages,
        continuityCapsule,
      });

      if (!built) {
        // Empty session (no convertible messages and no continuity capsule):
        // leave unbound so DSH creates a fresh session lazily if ever reopened.
        result.sessionsPreservedForLazyBridge += 1;
        continue;
      }

      const sessionDirPath = resolveDshSessionDir(sessionsRoot, built.header.cwd, dshSessionId);
      const logFilePath = resolveDshSessionLogPath(sessionsRoot, built.header.cwd, dshSessionId);
      const encoded = encodeDshV4SessionZstd(built.header, built.events);

      fs.mkdirSync(sessionDirPath, { recursive: true, mode: 0o700 });
      createdDirForSession = sessionDirPath;

      const tmpPath = `${logFilePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      fs.writeFileSync(tmpPath, encoded, { mode: 0o600 });
      fs.renameSync(tmpPath, logFilePath);

      const stat = fs.statSync(logFilePath);
      if (!stat.isFile() || stat.size === 0) {
        throw new Error(`Pre-seeded DSH session file failed verification at ${logFilePath}`);
      }

      withTrustedMigrationWrite(db, TrustedWriteContext.Session, () =>
        updateSessionIdStmt.run(`${DSH_SESSION_ID_PREFIX}${dshSessionId}`, session.id));
      result.createdSessionDirs.push(sessionDirPath);
      result.sessionsPreSeeded += 1;
    } catch (error) {
      if (createdDirForSession) {
        try {
          fs.rmSync(createdDirForSession, { recursive: true, force: true });
        } catch {
          // best-effort cleanup of failed session artifact
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[MigrationV2] Failed to pre-seed legacy session "${session.id}"; leaving for lazy bridge:`,
        message,
      );
      result.errors.push({ sessionId: session.id, error: message });
      result.sessionsPreservedForLazyBridge += 1;
    }
  }

  return result;
}
