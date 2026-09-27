import {
  DecisionModelErrorCode,
  DecisionModelProvider,
  type DecisionModelTestResult,
} from '../../shared/decisionModel/constants';
import { type DecisionModelConfig, isValidDecisionEndpoint } from './decisionModelConfig';

export const TYPESAFE_SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
// TypeSafe and System One-compatible endpoints resolve the moving alias.
// OpenRouter has no redirecting "latest" slug, so it is pinned there.
export const JEV_LATEST_MODEL = 'jev-latest';
export const OPENROUTER_JEV_MODEL = 'typesafe/jev-1.13';

// OpenRouter attributes requests to the calling app through these headers.
const OPENROUTER_APP_REFERER = 'https://lobsterai.youdao.com';
const OPENROUTER_APP_TITLE = 'LobsterAI';

export const DEFAULT_DECISION_TIMEOUT_MS = 30_000;
const CONNECTION_TEST_TIMEOUT_MS = 20_000;
const ERROR_DETAIL_MAX_CHARS = 300;

export const DecisionLimits = {
  MaxQuestions: 200,
  MaxQuestionIdLength: 128,
  MinChoiceOptions: 2,
  MaxChoiceOptions: 255,
  MinScoreLevels: 2,
  MaxScoreLevels: 10,
  MaxRequestChars: 200_000,
} as const;

export const DecisionQuestionType = {
  Boolean: 'boolean',
  Choice: 'choice',
  Score: 'score',
} as const;
export type DecisionQuestionType = typeof DecisionQuestionType[keyof typeof DecisionQuestionType];

// TypeSafe wire names; "noul" is its yes/no probability primitive.
const WireQuestionType = {
  Noul: 'noul',
  Choice: 'choice',
  Score: 'score',
} as const;

// OpenRouter requires both sides of a yes/no rubric once one is given.
const NOUL_TRUE_FALLBACK = 'Yes, this holds.';
const NOUL_FALSE_FALLBACK = 'No, this does not hold.';

export interface DecisionChoiceOption {
  name: string;
  description?: string;
}

interface DecisionQuestionBase {
  id: string;
  instructions: string;
}

export type DecisionQuestion =
  | (DecisionQuestionBase & { type: typeof DecisionQuestionType.Boolean; trueCriteria?: string; falseCriteria?: string })
  | (DecisionQuestionBase & { type: typeof DecisionQuestionType.Choice; options: DecisionChoiceOption[] })
  | (DecisionQuestionBase & { type: typeof DecisionQuestionType.Score; levels: string[] });

export type DecisionState = string | Record<string, unknown> | unknown[];

export interface DecisionEvaluateInput {
  state: DecisionState;
  questions: DecisionQuestion[];
}

export type DecisionAnswer =
  | { type: 'boolean'; probability: number }
  | { type: 'choice'; choice: string; confidence: number | null; probabilities: Record<string, number> | null }
  | { type: 'score'; score: number; level: string; confidence: number | null; probabilities: Record<string, number> | null }
  | { type: 'invalid'; reason: string };

export interface DecisionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface DecisionEvaluateResult {
  provider: DecisionModelProvider;
  model: string;
  elapsedMs: number;
  usage: DecisionUsage;
  answers: Record<string, DecisionAnswer>;
}

export class DecisionModelError extends Error {
  readonly code: DecisionModelErrorCode;
  readonly status?: number;

  constructor(code: DecisionModelErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'DecisionModelError';
    this.code = code;
    this.status = status;
  }
}

export interface DecisionHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface DecisionHttpResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export type DecisionFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<DecisionHttpResponse>;

export interface EvaluateDecisionOptions {
  fetch: DecisionFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

type ParseResult = { ok: true; input: DecisionEvaluateInput } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const roundProbability = (value: number): number => Number(value.toFixed(4));

function parseQuestion(raw: unknown, index: number): DecisionQuestion | string {
  const label = `questions[${index}]`;
  if (!isRecord(raw)) return `${label} must be an object.`;
  const id = readText(raw.id);
  if (!id) return `${label}.id is required.`;
  if (id.length > DecisionLimits.MaxQuestionIdLength) {
    return `${label}.id is longer than ${DecisionLimits.MaxQuestionIdLength} characters.`;
  }
  const instructions = readText(raw.instructions);
  if (!instructions) return `${label}.instructions is required.`;

  switch (raw.type) {
    case DecisionQuestionType.Boolean: {
      const trueCriteria = readText(raw.trueCriteria);
      const falseCriteria = readText(raw.falseCriteria);
      return {
        id,
        type: DecisionQuestionType.Boolean,
        instructions,
        ...(trueCriteria ? { trueCriteria } : {}),
        ...(falseCriteria ? { falseCriteria } : {}),
      };
    }
    case DecisionQuestionType.Choice: {
      if (!Array.isArray(raw.options)) return `${label}.options is required for choice questions.`;
      if (raw.options.length < DecisionLimits.MinChoiceOptions || raw.options.length > DecisionLimits.MaxChoiceOptions) {
        return `${label}.options must have between ${DecisionLimits.MinChoiceOptions} and ${DecisionLimits.MaxChoiceOptions} entries.`;
      }
      const names = new Set<string>();
      const options: DecisionChoiceOption[] = [];
      for (const option of raw.options) {
        // Tolerate plain strings, which models sometimes send for options.
        const name = isRecord(option) ? readText(option.name) : readText(option);
        if (!name) return `${label}.options entries need a name.`;
        if (names.has(name)) return `${label}.options has a duplicate name "${name}".`;
        names.add(name);
        const description = isRecord(option) ? readText(option.description) : '';
        options.push(description ? { name, description } : { name });
      }
      return { id, type: DecisionQuestionType.Choice, instructions, options };
    }
    case DecisionQuestionType.Score: {
      if (!Array.isArray(raw.levels)) return `${label}.levels is required for score questions.`;
      const levels = raw.levels.map(readText);
      if (levels.length < DecisionLimits.MinScoreLevels || levels.length > DecisionLimits.MaxScoreLevels) {
        return `${label}.levels must have between ${DecisionLimits.MinScoreLevels} and ${DecisionLimits.MaxScoreLevels} entries.`;
      }
      if (levels.some(level => !level)) return `${label}.levels entries must be non-empty text.`;
      if (new Set(levels).size !== levels.length) return `${label}.levels must be distinct.`;
      return { id, type: DecisionQuestionType.Score, instructions, levels };
    }
    default:
      return `${label}.type must be "boolean", "choice", or "score".`;
  }
}

export function parseDecisionEvaluateInput(args: unknown): ParseResult {
  const fail = (error: string): ParseResult => ({ ok: false, error });
  if (!isRecord(args)) return fail('arguments must be an object with "state" and "questions".');

  const { state } = args;
  if (typeof state === 'string') {
    if (!state.trim()) return fail('"state" must not be empty.');
  } else if (!isRecord(state) && !Array.isArray(state)) {
    return fail('"state" must be text, a JSON object, or a JSON array.');
  }

  if (!Array.isArray(args.questions) || args.questions.length === 0) {
    return fail('"questions" must be a non-empty array.');
  }
  if (args.questions.length > DecisionLimits.MaxQuestions) {
    return fail(`at most ${DecisionLimits.MaxQuestions} questions are allowed per call; split the work into several calls.`);
  }

  const ids = new Set<string>();
  const questions: DecisionQuestion[] = [];
  for (const [index, raw] of args.questions.entries()) {
    const question = parseQuestion(raw, index);
    if (typeof question === 'string') return fail(question);
    if (ids.has(question.id)) return fail(`duplicate question id "${question.id}".`);
    ids.add(question.id);
    questions.push(question);
  }
  return { ok: true, input: { state: state as DecisionState, questions } };
}

function toWireQuestion(question: DecisionQuestion): Record<string, unknown> {
  switch (question.type) {
    case DecisionQuestionType.Boolean:
      return {
        type: WireQuestionType.Noul,
        instructions: question.instructions,
        ...(question.trueCriteria || question.falseCriteria
          ? {
              criteria: {
                true: question.trueCriteria || NOUL_TRUE_FALLBACK,
                false: question.falseCriteria || NOUL_FALSE_FALLBACK,
              },
            }
          : {}),
      };
    case DecisionQuestionType.Choice:
      return {
        type: WireQuestionType.Choice,
        instructions: question.instructions,
        // OpenRouter rejects null criteria values, so a bare option describes itself.
        criteria: Object.fromEntries(question.options.map(option => [option.name, option.description ?? option.name])),
      };
    case DecisionQuestionType.Score:
      return {
        type: WireQuestionType.Score,
        instructions: question.instructions,
        criteria: question.levels,
      };
  }
}

export function buildDecisionRequest(config: DecisionModelConfig, input: DecisionEvaluateInput): DecisionHttpRequest {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };
  let url = config.endpoint;
  let model = JEV_LATEST_MODEL;
  if (config.provider === DecisionModelProvider.OpenRouter) {
    url = OPENROUTER_DECISIONS_URL;
    model = OPENROUTER_JEV_MODEL;
    headers['HTTP-Referer'] = OPENROUTER_APP_REFERER;
    headers['X-Title'] = OPENROUTER_APP_TITLE;
  } else if (config.provider === DecisionModelProvider.TypeSafe) {
    url = TYPESAFE_SYSTEM_ONE_URL;
  }
  const questions = Object.fromEntries(input.questions.map(question => [question.id, toWireQuestion(question)]));
  return { url, headers, body: JSON.stringify({ model, state: input.state, questions }) };
}

function readProbabilities(
  value: unknown,
  keys: string[],
  labelFor: (key: string) => string = key => key,
): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const probabilities: Record<string, number> = {};
  for (const key of keys) {
    const probability = value[key];
    // A partial distribution is reported as absent rather than padded.
    if (!isProbability(probability)) return null;
    probabilities[labelFor(key)] = roundProbability(probability);
  }
  return probabilities;
}

const readConfidence = (value: unknown): number | null => (isProbability(value) ? roundProbability(value) : null);

const invalidAnswer = (reason: string): DecisionAnswer => ({ type: 'invalid', reason });

export function normalizeDecisionAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer {
  if (!isRecord(raw)) return invalidAnswer('missing answer');
  switch (question.type) {
    case DecisionQuestionType.Boolean: {
      if (raw.type !== WireQuestionType.Noul && raw.type !== DecisionQuestionType.Boolean) {
        return invalidAnswer(`expected a yes/no answer, got "${String(raw.type)}"`);
      }
      const probability = raw.noul ?? raw.probability;
      return isProbability(probability)
        ? { type: 'boolean', probability: roundProbability(probability) }
        : invalidAnswer('the yes/no answer has no probability');
    }
    case DecisionQuestionType.Choice: {
      if (raw.type !== WireQuestionType.Choice) return invalidAnswer(`expected a choice answer, got "${String(raw.type)}"`);
      const names = question.options.map(option => option.name);
      if (typeof raw.choice !== 'string' || !names.includes(raw.choice)) {
        return invalidAnswer('the chosen option is not one of the options asked about');
      }
      return {
        type: 'choice',
        choice: raw.choice,
        confidence: readConfidence(raw.confidence),
        probabilities: readProbabilities(raw.probabilities, names),
      };
    }
    case DecisionQuestionType.Score: {
      if (raw.type !== WireQuestionType.Score) return invalidAnswer(`expected a score answer, got "${String(raw.type)}"`);
      const maxIndex = question.levels.length - 1;
      const tolerance = 0.001;
      if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)
        || raw.score < -tolerance || raw.score > maxIndex + tolerance) {
        return invalidAnswer('the score is outside the rubric');
      }
      const score = Math.min(maxIndex, Math.max(0, raw.score));
      return {
        type: 'score',
        score: Number(score.toFixed(2)),
        level: question.levels[Math.round(score)],
        confidence: readConfidence(raw.confidence),
        probabilities: readProbabilities(
          raw.probabilities,
          question.levels.map((_, index) => String(index)),
          key => question.levels[Number(key)],
        ),
      };
    }
  }
}

const readCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

function readUsage(value: unknown): DecisionUsage {
  const usage = isRecord(value) ? value : {};
  const cost = usage.cost;
  return {
    inputTokens: readCount(usage.input_tokens),
    outputTokens: readCount(usage.output_tokens),
    costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}

const redactSecret = (text: string, secret: string): string =>
  secret ? text.split(secret).join('***') : text;

const summarizeErrorBody = (text: string, apiKey: string): string =>
  redactSecret(text, apiKey).replace(/\s+/g, ' ').trim().slice(0, ERROR_DETAIL_MAX_CHARS);

function errorForStatus(status: number, detail: string, provider: DecisionModelProvider): DecisionModelError {
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401 || status === 403) {
    return new DecisionModelError(DecisionModelErrorCode.Unauthorized, `The API key was rejected (HTTP ${status})${suffix}`, status);
  }
  if (status === 402) {
    return new DecisionModelError(DecisionModelErrorCode.InsufficientCredits, `The provider account has insufficient credits (HTTP 402)${suffix}`, status);
  }
  if (status === 429) {
    return new DecisionModelError(DecisionModelErrorCode.RateLimited, `The decision model is rate limited (HTTP 429)${suffix}`, status);
  }
  if (status === 408 || status === 504 || status === 524) {
    return new DecisionModelError(DecisionModelErrorCode.Timeout, `The decision model timed out (HTTP ${status})${suffix}`, status);
  }
  if (status === 400 || status === 413 || status === 422) {
    return new DecisionModelError(DecisionModelErrorCode.InvalidInput, `The decision model rejected the request (HTTP ${status})${suffix}`, status);
  }
  if (status === 404 && provider === DecisionModelProvider.Compatible) {
    return new DecisionModelError(DecisionModelErrorCode.InvalidEndpoint, `The endpoint was not found (HTTP 404)${suffix}`, status);
  }
  return new DecisionModelError(DecisionModelErrorCode.UpstreamError, `The decision model failed (HTTP ${status})${suffix}`, status);
}

export async function evaluateDecision(
  config: DecisionModelConfig,
  input: DecisionEvaluateInput,
  options: EvaluateDecisionOptions,
): Promise<DecisionEvaluateResult> {
  if (!config.apiKey) {
    throw new DecisionModelError(DecisionModelErrorCode.MissingApiKey, 'No API key is configured for the decision model.');
  }
  if (config.provider === DecisionModelProvider.Compatible && !isValidDecisionEndpoint(config.endpoint)) {
    throw new DecisionModelError(DecisionModelErrorCode.InvalidEndpoint, 'The decision model endpoint is not a valid http(s) URL.');
  }

  const request = buildDecisionRequest(config, input);
  if (request.body.length > DecisionLimits.MaxRequestChars) {
    throw new DecisionModelError(
      DecisionModelErrorCode.InvalidInput,
      `The request is too large (${request.body.length} characters, limit ${DecisionLimits.MaxRequestChars}); split the items into several calls.`,
    );
  }

  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  const controller = new AbortController();
  const abortState = { timedOut: false };
  const timer = setTimeout(() => {
    abortState.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
  }

  const transportError = (error: unknown): DecisionModelError => {
    if (abortState.timedOut) {
      return new DecisionModelError(DecisionModelErrorCode.Timeout, `The decision model did not respond within ${timeoutMs} ms.`);
    }
    if (controller.signal.aborted) {
      return new DecisionModelError(DecisionModelErrorCode.Cancelled, 'The decision request was cancelled.');
    }
    const message = error instanceof Error ? error.message : String(error);
    return new DecisionModelError(DecisionModelErrorCode.Network, `Could not reach the decision model: ${redactSecret(message, config.apiKey)}`);
  };

  const startedAt = now();
  try {
    let response: DecisionHttpResponse;
    let text: string;
    try {
      response = await options.fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      throw transportError(error);
    }

    if (!response.ok) {
      throw errorForStatus(response.status, summarizeErrorBody(text, config.apiKey), config.provider);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new DecisionModelError(DecisionModelErrorCode.InvalidResponse, 'The decision model returned a response that is not JSON.');
    }
    if (!isRecord(body) || !isRecord(body.answers)) {
      throw new DecisionModelError(DecisionModelErrorCode.InvalidResponse, 'The decision model response has no answers.');
    }
    const rawAnswers = body.answers;

    return {
      provider: config.provider,
      model: readText(body.model)
        || (config.provider === DecisionModelProvider.OpenRouter ? OPENROUTER_JEV_MODEL : JEV_LATEST_MODEL),
      elapsedMs: Math.max(0, Math.round(now() - startedAt)),
      usage: readUsage(body.usage),
      answers: Object.fromEntries(
        input.questions.map(question => [question.id, normalizeDecisionAnswer(question, rawAnswers[question.id])]),
      ),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

const CONNECTION_TEST_QUESTION_ID = 'connection_check';

const CONNECTION_TEST_INPUT: DecisionEvaluateInput = {
  state: 'LobsterAI is checking that the decision model is reachable.',
  questions: [{
    id: CONNECTION_TEST_QUESTION_ID,
    type: DecisionQuestionType.Boolean,
    instructions: 'Is this text a connectivity check?',
  }],
};

export async function testDecisionModelConnection(
  config: DecisionModelConfig,
  options: EvaluateDecisionOptions,
): Promise<DecisionModelTestResult> {
  try {
    const result = await evaluateDecision(config, CONNECTION_TEST_INPUT, {
      ...options,
      timeoutMs: options.timeoutMs ?? CONNECTION_TEST_TIMEOUT_MS,
    });
    if (result.answers[CONNECTION_TEST_QUESTION_ID]?.type !== DecisionQuestionType.Boolean) {
      return {
        ok: false,
        errorCode: DecisionModelErrorCode.InvalidResponse,
        error: 'The decision model returned an unexpected answer.',
      };
    }
    return { ok: true, model: result.model, elapsedMs: result.elapsedMs };
  } catch (error) {
    if (error instanceof DecisionModelError) {
      return { ok: false, errorCode: error.code, error: error.message };
    }
    return {
      ok: false,
      errorCode: DecisionModelErrorCode.UpstreamError,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
