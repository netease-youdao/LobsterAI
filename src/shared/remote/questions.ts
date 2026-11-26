import { RemoteCommandKind } from './constants';

/** Public ordinary user questions; secret-store prompts never use this contract. */
export const RemoteQuestion = { Capability: 'question_response_v1', ProjectionVersion: 5, Event: 'question.updated', Command: RemoteCommandKind.QuestionResponse, MaximumBytes: 32 * 1024, MaximumFormBytes: 14 * 1024, MaximumAnswerBytes: 16 * 1024 } as const;
export const RemoteQuestionStatus = { Pending: 'pending', Answered: 'answered', Cancelled: 'cancelled', Expired: 'expired', Unavailable: 'unavailable' } as const;
export const RemoteQuestionKind = { Native: 'native', Legacy: 'legacy' } as const;
export const RemoteQuestionAction = { Answer: 'answer', Cancel: 'cancel' } as const;
export const RemoteQuestionPhase = { Idle: 'idle', Submitting: 'submitting', Unknown: 'unknown', Finished: 'finished' } as const;
export const RemoteQuestionSource = { Desktop: 'desktop', Mobile: 'mobile', System: 'system', Unknown: 'unknown' } as const;
export const RemoteQuestionOutcome = { Confirmed: 'confirmed', KnownNotApplied: 'known_not_applied', Unknown: 'unknown' } as const;
export interface RemoteQuestionItem {
  questionId: string; header: string; question: string; options: Array<{ label: string; description?: string }>;
  multiSelect: boolean; isOther: boolean; allowSkip: boolean;
}
export type QuestionAnswers = Record<string, string[]>;
export type QuestionStatus = typeof RemoteQuestionStatus[keyof typeof RemoteQuestionStatus];
export interface RemoteQuestionState {
  questionId: string; runId: string; questionVersion: string; operationDigest: string; title: string;
  status: QuestionStatus; expiresAt: string; remoteAllowed: boolean; requiresLocalAction: boolean; allowCancel: boolean;
  questions: RemoteQuestionItem[];
  resolution: { phase: 'idle' | 'submitting' | 'unknown' | 'finished'; source: 'desktop' | 'mobile' | 'system' | 'unknown' | null;
    answeredAt: string | null; answers: QuestionAnswers | null };
}
export interface LocalQuestionState extends RemoteQuestionState { requestId: string; sessionId: string }
export interface QuestionResponse { action: 'answer' | 'cancel'; answers: QuestionAnswers }
export interface QuestionAdapterOutcome {
  kind: 'confirmed' | 'known_not_applied' | 'unknown'; status?: Exclude<QuestionStatus, 'pending'>;
  answers?: QuestionAnswers; reason?: string;
}
export interface QuestionDecisionOutcome extends QuestionAdapterOutcome { state?: LocalQuestionState }
export interface QuestionDecisionOptions {
  submissionId: string; source: 'desktop' | 'mobile'; expectedVersion?: string; operationDigest?: string;
  beforeDispatch?: () => void | Promise<void>; onDispatch?: () => void;
}
const bytes = (value: string): number => new TextEncoder().encode(value).length;
const text = (value: unknown, maximum: number, empty = false): value is string => typeof value === 'string' && (empty || !!value.trim()) && bytes(value) <= maximum;
export function parseRemoteQuestionItems(value: unknown): RemoteQuestionItem[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const result: RemoteQuestionItem[] = [], ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || item.isSecret === true || item.secretStore !== undefined
      || !text(item.questionId, 64) || !/^[a-z][a-z0-9_]*$/u.test(item.questionId) || ids.has(item.questionId)
      || !text(item.header, 80, true) || !text(item.question, 4000) || !Array.isArray(item.options) || item.options.length === 1 || item.options.length > 4) return null;
    const options: RemoteQuestionItem['options'] = [];
    for (const option of item.options) {
      if (!option || !text(option.label, 512) || options.some(existing => existing.label === option.label)
        || option.description !== undefined && !text(option.description, 2000, true)) return null;
      options.push({ label: option.label, ...(option.description !== undefined ? { description: option.description } : {}) });
    }
    ids.add(item.questionId);
    result.push({ questionId: item.questionId, header: item.header, question: item.question, options,
      multiSelect: item.multiSelect === true, isOther: item.isOther === true || !options.length, allowSkip: item.allowSkip === true });
  }
  return bytes(JSON.stringify(result)) <= RemoteQuestion.MaximumFormBytes ? result : null;
}
export function parseQuestionAnswers(questions: RemoteQuestionItem[], value: unknown): QuestionAnswers | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== questions.length) return null;
  const result: QuestionAnswers = {};
  for (const question of questions) {
    const answer = (value as Record<string, unknown>)[question.questionId];
    if (!Array.isArray(answer) || !answer.length && !question.allowSkip || !question.multiSelect && answer.length > 1
      || answer.length > question.options.length + 1 || answer.some(v => !text(v, 4000)) || new Set(answer).size !== answer.length) return null;
    const other = answer.filter(v => !question.options.some(option => option.label === v));
    if (other.length && !question.isOther || other.length > 1) return null;
    result[question.questionId] = [...answer];
  }
  return bytes(JSON.stringify(result)) <= RemoteQuestion.MaximumAnswerBytes ? result : null;
}
