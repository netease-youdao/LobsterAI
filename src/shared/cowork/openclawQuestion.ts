/** OpenClaw's native ask_user contract, independent of the AskUserQuestion plugin. */
export const OpenClawQuestion = {
  ToolName: 'ask_user',
  RequestIdPrefix: 'openclaw-question:',
  Requested: 'question.requested',
  Resolved: 'question.resolved',
  List: 'question.list',
  Get: 'question.get',
  Resolve: 'question.resolve',
} as const;

export const OpenClawQuestionStatus = {
  Pending: 'pending',
  Answered: 'answered',
  Cancelled: 'cancelled',
  Expired: 'expired',
} as const;
export type OpenClawQuestionStatus = typeof OpenClawQuestionStatus[keyof typeof OpenClawQuestionStatus];

export interface OpenClawQuestionItem {
  questionId: string;
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
  isOther?: boolean;
}

export interface OpenClawQuestionRecord {
  id: string;
  questions: OpenClawQuestionItem[];
  sessionKey: string;
  runId?: string;
  expiresAtMs: number;
  status: OpenClawQuestionStatus;
}

export type OpenClawQuestionAnswers = Record<string, string[]>;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

/** Validate only ordinary ask_user questions; secret-store prompts have a separate contract. */
export function parseOpenClawQuestionRecord(value: unknown): OpenClawQuestionRecord | null {
  if (!isRecord(value)
    || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.sessionKey !== 'string' || !value.sessionKey.trim()
    || typeof value.expiresAtMs !== 'number' || !Number.isFinite(value.expiresAtMs)
    || !Object.values(OpenClawQuestionStatus).includes(value.status as OpenClawQuestionStatus)
    || !Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 3) {
    return null;
  }
  const questions: OpenClawQuestionItem[] = [];
  const ids = new Set<string>();
  for (const question of value.questions) {
    if (!isRecord(question)
      || typeof question.questionId !== 'string' || !/^[a-z][a-z0-9_]*$/.test(question.questionId)
      || ids.has(question.questionId)
      || typeof question.question !== 'string' || !question.question.trim()
      || typeof question.header !== 'string'
      || question.isSecret === true || question.secretStore !== undefined
      || !Array.isArray(question.options) || question.options.length === 1 || question.options.length > 4) {
      return null;
    }
    const options: OpenClawQuestionItem['options'] = [];
    for (const option of question.options) {
      if (!isRecord(option) || typeof option.label !== 'string' || !option.label.trim()
        || options.some((existing) => existing.label === option.label)) return null;
      options.push({
        label: option.label,
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
      });
    }
    ids.add(question.questionId);
    questions.push({
      questionId: question.questionId,
      question: question.question,
      header: question.header,
      options,
      multiSelect: question.multiSelect === true,
      isOther: question.isOther === true,
    });
  }
  return {
    id: value.id,
    sessionKey: value.sessionKey,
    ...(typeof value.runId === 'string' ? { runId: value.runId } : {}),
    expiresAtMs: value.expiresAtMs,
    status: value.status as OpenClawQuestionStatus,
    questions,
  };
}

/** Preserve stable IDs and original option labels, including punctuation and multi-select values. */
export function parseOpenClawQuestionAnswers(
  questions: OpenClawQuestionItem[],
  value: unknown,
): OpenClawQuestionAnswers | null {
  if (!isRecord(value) || Object.keys(value).length !== questions.length) return null;
  const answers: OpenClawQuestionAnswers = {};
  for (const question of questions) {
    const values = value[question.questionId];
    if (!Array.isArray(values) || values.length < 1
      || (!question.multiSelect && values.length !== 1)
      || values.some((answer) => typeof answer !== 'string' || !answer.trim())
      || new Set(values).size !== values.length) return null;
    if (question.options.length > 0 && !question.isOther
      && values.some((answer) => !question.options.some((option) => option.label === answer))) return null;
    answers[question.questionId] = [...values] as string[];
  }
  return answers;
}
