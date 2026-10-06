import {
  buildSelectedTextPromptSection,
  type CoworkSelectedTextSnippet,
  type CoworkSelectedTextValidationResult,
  normalizeCoworkSelectedTextSnippets,
} from './selectedText';
import { stripNullChars } from './text';

export const CoworkBtwStatus = {
  Pending: 'pending',
  Answered: 'answered',
  Failed: 'failed',
  Stopped: 'stopped',
} as const;
export type CoworkBtwStatus = typeof CoworkBtwStatus[keyof typeof CoworkBtwStatus];

// BTW questions have no product-level character limit. Follow-up history stays
// bounded independently, while the runtime enforces the shared chat frame size.
export const COWORK_BTW_CONTEXT_MAX_CHARS = 16_000;
export const COWORK_BTW_EVENT_QUESTION_MAX_CHARS = 120_000;
export const COWORK_BTW_RESULT_MAX_CHARS = 120_000;
export const COWORK_BTW_IDENTIFIER_MAX_CHARS = 512;
export const COWORK_BTW_THREAD_ENTRY_LIMIT = 50;
export const COWORK_BTW_THREAD_CONTENT_MAX_CHARS = 500_000;
export const COWORK_BTW_EPHEMERAL_THREAD_LIMIT = 12;

export const CoworkBtwCommandValidationError = {
  EmptyQuestion: 'empty_question',
  MultilineUnsupported: 'multiline_unsupported',
} as const;
export type CoworkBtwCommandValidationError =
  typeof CoworkBtwCommandValidationError[keyof typeof CoworkBtwCommandValidationError];

export interface CoworkBtwEntry {
  runId: string;
  sessionId: string;
  question: string;
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  status: CoworkBtwStatus;
  answer?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface CoworkBtwThread {
  sessionId: string;
  isOpen: boolean;
  draft: string;
  selectedTextSnippets: CoworkSelectedTextSnippet[];
  entries: CoworkBtwEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface CoworkBtwSubmitRequest {
  sessionId: string;
  question: string;
  runId: string;
}

export interface CoworkBtwSubmitResponse {
  success: boolean;
  runId: string;
  error?: string;
}

export interface CoworkBtwAbortRequest {
  sessionId: string;
  runId: string;
}

export interface CoworkBtwAbortResponse {
  success: boolean;
  aborted: boolean;
  runId: string;
  error?: string;
}

export type CoworkBtwCommandParseResult =
  | { matched: false }
  | {
      matched: true;
      question: string;
      error?: CoworkBtwCommandValidationError;
    };

export const normalizeCoworkBtwQuestion = (value: string): string => (
  stripNullChars(value).trim()
);

export const normalizeCoworkBtwSelectedTextQuestion = (value: string): string => (
  normalizeCoworkBtwQuestion(value).replace(/\s+/g, ' ')
);

export const buildCoworkBtwComposerQuestion = (
  draft: string,
  selectedTextSnippets: CoworkSelectedTextSnippet[] = [],
): string => {
  const normalizedDraft = normalizeCoworkBtwQuestion(draft);
  const selectedTextSection = buildSelectedTextPromptSection(selectedTextSnippets);
  if (!selectedTextSection) return normalizedDraft;
  const question = normalizedDraft
    || 'Analyze the selected text excerpt and answer it directly if it contains a question.';
  return `${question}\n\n${selectedTextSection}`;
};

export const resolveCoworkBtwSelectedTextSnippets = (
  currentSnippets: CoworkSelectedTextSnippet[],
  incomingSnippets: CoworkSelectedTextSnippet[],
  shouldAppend: boolean,
): CoworkSelectedTextValidationResult => (
  normalizeCoworkSelectedTextSnippets([
    ...(shouldAppend ? currentSnippets : []),
    ...incomingSnippets,
  ])
);

const truncateBtwContextValue = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
};

export const buildCoworkBtwContextualQuestion = (
  entries: CoworkBtwEntry[],
  question: string,
): string => {
  const currentQuestion = normalizeCoworkBtwSelectedTextQuestion(question);
  if (!currentQuestion) return '';
  if (currentQuestion.length >= COWORK_BTW_CONTEXT_MAX_CHARS) {
    return currentQuestion;
  }

  const prefix = 'Continue this temporary side chat using the previous side-chat turns as context. '
    + 'Answer only the current question. Previous side-chat turns, oldest to newest: ';
  const suffix = ` Current question: ${JSON.stringify(currentQuestion)}`;
  const selectedTurns: string[] = [];
  // Walk backwards and stop as soon as the bounded context is full. This
  // avoids normalizing older, potentially large answers that cannot be sent.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.status !== CoworkBtwStatus.Answered
      || typeof entry.answer !== 'string'
      || entry.answer.length === 0
    ) {
      continue;
    }
    const previousTurn = {
      question: truncateBtwContextValue(
        normalizeCoworkBtwSelectedTextQuestion(buildCoworkBtwComposerQuestion(
          entry.question,
          entry.selectedTextSnippets,
        )),
        2_000,
      ),
      answer: truncateBtwContextValue(
        normalizeCoworkBtwSelectedTextQuestion(entry.answer),
        6_000,
      ),
    };
    if (!previousTurn.question || !previousTurn.answer) {
      continue;
    }
    const serializedTurn = JSON.stringify(previousTurn);
    const candidateTurns = [serializedTurn, ...selectedTurns];
    const candidate = `${prefix}[${candidateTurns.join(',')}]${suffix}`;
    if (candidate.length > COWORK_BTW_CONTEXT_MAX_CHARS) {
      break;
    }
    selectedTurns.unshift(serializedTurn);
  }

  if (selectedTurns.length === 0) {
    return currentQuestion;
  }
  return `${prefix}[${selectedTurns.join(',')}]${suffix}`;
};

export const createCoworkBtwRunId = (): string => (
  `btw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
);

export function parseCoworkBtwCommand(input: string): CoworkBtwCommandParseResult {
  const trimmedStart = input.trimStart();
  const match = /^\/(?:btw|side)(?=\s|$)/i.exec(trimmedStart);
  if (!match) {
    return { matched: false };
  }

  const rawQuestion = trimmedStart.slice(match[0].length);
  const question = normalizeCoworkBtwQuestion(rawQuestion);
  if (!question) {
    return {
      matched: true,
      question: '',
      error: CoworkBtwCommandValidationError.EmptyQuestion,
    };
  }
  if (/[\r\n]/.test(rawQuestion)) {
    return {
      matched: true,
      question,
      error: CoworkBtwCommandValidationError.MultilineUnsupported,
    };
  }
  return { matched: true, question };
}
