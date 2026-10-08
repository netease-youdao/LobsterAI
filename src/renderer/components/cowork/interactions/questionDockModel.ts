import { ASK_USER_QUESTION_TOOL_NAME } from '../../../../shared/cowork/constants';
import {
  OpenClawQuestion,
  OpenClawQuestionStatus,
  parseOpenClawQuestionRecord,
} from '../../../../shared/cowork/openclawQuestion';
import type { CoworkPermissionRequest, CoworkPermissionResult } from '../../../types/cowork';

/**
 * Where a docked question comes from. The two sources share the dock UI but
 * answer over different wire contracts:
 * - Native: OpenClaw `ask_user`, answered as questionId -> string[] through
 *   `openclawQuestionController`. Every question must be answered; skipping
 *   is not part of the protocol.
 * - Plugin: the `AskUserQuestion` extension, answered as question text ->
 *   '|||'-joined labels plus an explicit `skippedQuestionIds` list.
 */
export const QuestionSource = { Native: 'native', Plugin: 'plugin' } as const;
export type QuestionSource = typeof QuestionSource[keyof typeof QuestionSource];

export interface DockQuestionOption { id: string; label: string; description?: string }
export interface DockQuestion {
  id: string;
  title: string;
  options: DockQuestionOption[];
  multiSelect: boolean;
  /** Whether a typed answer is accepted next to (or instead of) the options. */
  allowFreeText: boolean;
}
export interface QuestionDraft {
  step: number;
  answers: Record<string, string[]>;
  freeText: Record<string, string>;
  skipped: string[];
  collapsed?: boolean;
  actionId?: string;
}
export interface DockRequest {
  key: string;
  sessionId: string;
  requestId: string;
  source: QuestionSource;
  questions: DockQuestion[];
  expiresAt?: number;
  permission: CoworkPermissionRequest;
}

export const emptyQuestionDraft = (): QuestionDraft => ({ step: 0, answers: {}, freeText: {}, skipped: [] });

const MULTI_ANSWER_SEPARATOR = '|||';

const pluginQuestionId = (question: Record<string, unknown>, index: number): string =>
  String(question.questionId ?? question.id ?? `question-${index + 1}`);

/**
 * Build the dock view of a permission request, or null when the request is
 * not a question the dock can render (approvals, secret prompts, malformed
 * payloads). Anything that returns null keeps using the global modal.
 */
export function permissionDockRequest(permission: CoworkPermissionRequest): DockRequest | null {
  const native = permission.toolName === OpenClawQuestion.ToolName;
  if (!native && permission.toolName !== ASK_USER_QUESTION_TOOL_NAME) return null;
  const record = native ? parseOpenClawQuestionRecord(permission.toolInput) : null;
  if (native && (!record || record.status !== OpenClawQuestionStatus.Pending)) return null;
  const raw: unknown = record?.questions ?? permission.toolInput?.questions;
  if (!Array.isArray(raw)) return null;
  const questions: DockQuestion[] = [];
  for (let index = 0; index < raw.length; index++) {
    const question = raw[index] as Record<string, unknown> | null;
    if (!question || typeof question.question !== 'string' || !question.question.trim()
      || question.isSecret || question.secretStore || question.inputType === 'password') return null;
    const id = pluginQuestionId(question, index);
    if (questions.some((previous) => previous.id === id)) return null;
    const options = (Array.isArray(question.options) ? question.options : [])
      .filter((option): option is { label: string; description?: string } => (
        !!option && typeof option === 'object' && typeof (option as { label?: unknown }).label === 'string'
      ))
      .map((option) => ({ id: option.label, label: option.label, description: option.description }));
    if (options.some((option, optionIndex) => options.findIndex((other) => other.id === option.id) !== optionIndex)) return null;
    const allowFreeText = native ? question.isOther === true || options.length === 0 : true;
    if (!options.length && !allowFreeText) return null;
    questions.push({ id, title: question.question, multiSelect: question.multiSelect === true, options, allowFreeText });
  }
  if (!questions.length) return null;
  return {
    key: `${permission.sessionId}:${permission.requestId}`,
    sessionId: permission.sessionId,
    requestId: permission.requestId,
    source: native ? QuestionSource.Native : QuestionSource.Plugin,
    questions,
    ...(record ? { expiresAt: record.expiresAtMs } : {}),
    permission,
  };
}

/** True when the dock (not the global modal) presents this request. */
export const isQuestionDockRequest = (permission: CoworkPermissionRequest): boolean =>
  permissionDockRequest(permission) !== null;

export const questionResolved = (draft: QuestionDraft, id: string): boolean =>
  Boolean(draft.skipped.includes(id) || draft.answers[id]?.length || draft.freeText[id]?.trim());

/** Translate the dock draft into the wire shape each source expects. */
export function permissionDockAnswer(request: DockRequest, draft: QuestionDraft): CoworkPermissionResult {
  if (request.source === QuestionSource.Native) {
    // Same payload as CoworkNativeQuestionModal: a typed answer is one more value.
    const answers: Record<string, string[]> = {};
    for (const question of request.questions) {
      const extra = draft.freeText[question.id]?.trim();
      answers[question.id] = [...(draft.answers[question.id] ?? []), ...(extra ? [extra] : [])];
    }
    return { behavior: 'allow', updatedInput: { answers } };
  }
  const answers: Record<string, string> = {};
  const skippedQuestionIds: string[] = [];
  for (const question of request.questions) {
    if (draft.skipped.includes(question.id)) {
      skippedQuestionIds.push(question.id);
      continue;
    }
    const extra = draft.freeText[question.id]?.trim();
    answers[question.title] = [...(draft.answers[question.id] ?? []), ...(extra ? [extra] : [])].join(MULTI_ANSWER_SEPARATOR);
  }
  return { behavior: 'allow', updatedInput: { ...request.permission.toolInput, answers, skippedQuestionIds } };
}
