import { Type } from '@sinclair/typebox';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

import { isAskUserQuestionCandidateSessionKey } from './sessionKey';

/**
 * AskUserQuestion plugin for OpenClaw.
 *
 * Registers a structured tool that lets the model ask the user a question
 * with predefined options (single/multi select). The tool pauses execution
 * and waits for the user's response via an HTTP callback to LobsterAI.
 *
 * It backs delete confirmations and choice questions on the LobsterAI desktop
 * app without relying on OpenClaw's exec.approval mechanism. LobsterAI denies
 * OpenClaw's native ask_user, so this is the only question tool.
 */

type PluginConfig = {
  callbackUrl: string;
  secret: string;
};

type QuestionOption = {
  label: string;
  description?: string;
};

type Question = {
  /** Optional stable identifier; defaults to `question-<n>` by position. */
  id?: string;
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};

type AskUserInput = {
  questions: Question[];
};

type AskUserCallbackInput = AskUserInput & {
  sessionKey?: string;
};

type AskUserResponse = {
  behavior: 'allow' | 'deny';
  answers?: Record<string, string>;
  /** Questions the user explicitly skipped; they carry neither an answer nor approval. */
  skippedQuestionIds?: string[];
};

// Mirrors ASK_USER_QUESTION_TIMEOUT_MS (src/shared/cowork/constants.ts), plus
// a grace period so LobsterAI's own timeout answers first. LobsterAI sends the
// response headers at once and whitespace keepalives, so fetch's 5-minute
// header/body timeouts do not cut a long wait short.
const DEFAULT_TIMEOUT_MS = 15 * 60_000 + 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const parsePluginConfig = (value: unknown): PluginConfig => {
  const raw = isRecord(value) ? value : {};
  return {
    callbackUrl: typeof raw.callbackUrl === 'string' ? raw.callbackUrl.trim() : '',
    secret: typeof raw.secret === 'string' ? raw.secret.trim() : '',
  };
};

const QuestionOptionSchema = Type.Object({
  label: Type.String({ description: 'Display text for this option (1-5 words).' }),
  description: Type.Optional(Type.String({ description: 'Explanation of what this option means.' })),
});

const questionId = (question: Question, index: number): string =>
  question.id ?? `question-${index + 1}`;

const QuestionSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, description: 'Stable identifier for this question.' })),
  question: Type.String({ description: 'The question to ask. Should be clear and end with a question mark.' }),
  header: Type.Optional(Type.String({ description: 'Short label displayed as a tag (max 12 chars). Examples: "Auth method", "Confirm".' })),
  options: Type.Array(QuestionOptionSchema, {
    minItems: 2,
    maxItems: 4,
    description: 'Available choices (2-4 options).',
  }),
  multiSelect: Type.Optional(Type.Boolean({ description: 'Allow selecting multiple options.' })),
});

const AskUserQuestionSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: 4,
    description: 'Questions to ask the user (1-4 questions).',
  }),
});

async function askUser(
  config: PluginConfig,
  input: AskUserCallbackInput,
  runSignal?: AbortSignal,
): Promise<AskUserResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  // A stopped run aborts the request, and LobsterAI closes the dialog when the
  // connection drops instead of leaving it up until its own timeout.
  const abortWithRun = () => controller.abort();
  if (runSignal?.aborted) controller.abort();
  else runSignal?.addEventListener('abort', abortWithRun, { once: true });

  try {
    const response = await fetch(config.callbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ask-user-secret': config.secret,
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`AskUserQuestion callback HTTP ${response.status}: ${text.trim() || response.statusText}`);
    }

    if (!text.trim()) {
      return { behavior: 'deny' };
    }

    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed.behavior !== 'allow') return { behavior: 'deny' };
    if (parsed.answers !== undefined && (!isRecord(parsed.answers)
      || Object.values(parsed.answers).some((answer) => typeof answer !== 'string'))) {
      throw new Error('AskUserQuestion callback returned invalid answers.');
    }
    const answers = parsed.answers as Record<string, string> | undefined;
    const skipped = parsed.skippedQuestionIds;
    const questionsById = new Map(input.questions.map((question, index) => [questionId(question, index), question]));
    if (skipped !== undefined && (!Array.isArray(skipped)
      || skipped.some((id) => typeof id !== 'string' || !questionsById.has(id))
      || new Set(skipped).size !== skipped.length)) {
      throw new Error('AskUserQuestion callback returned invalid skipped question IDs.');
    }
    for (const id of (skipped as string[] | undefined) ?? []) {
      const question = questionsById.get(id)!;
      if (answers && Object.prototype.hasOwnProperty.call(answers, question.question) && answers[question.question].trim()) {
        throw new Error('AskUserQuestion callback both answered and skipped the same question.');
      }
    }
    return {
      behavior: 'allow',
      ...(answers !== undefined ? { answers } : {}),
      ...(skipped !== undefined ? { skippedQuestionIds: skipped as string[] } : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { behavior: 'deny' };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    runSignal?.removeEventListener('abort', abortWithRun);
  }
}

const plugin = {
  id: 'ask-user-question',
  name: 'AskUserQuestion',
  description: 'Structured user confirmation tool for LobsterAI desktop.',
  configSchema: {
    parse(value: unknown): PluginConfig {
      return parsePluginConfig(value);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    if (!config.callbackUrl || !config.secret) {
      api.logger.info('[ask-user-question] skipped: callbackUrl or secret not configured.');
      return;
    }

    // Use a factory so the tool is only available for LobsterAI local-session candidates.
    // IM channel sessions (qqbot, dingtalk, weixin, feishu, etc.) get null → tool hidden.
    api.registerTool((ctx) => {
      // Enable for LobsterAI desktop sessions across agents and delegated child sessions.
      // IM channel sessions (dingtalk, qqbot, weixin, feishu, wecom, etc.) should not have this tool
      // so the model executes delete commands directly without confirmation on IM.
      const sessionKey = ctx.sessionKey ?? '';
      if (!isAskUserQuestionCandidateSessionKey(sessionKey)) {
        return null;
      }

      return {
        name: 'AskUserQuestion',
        label: 'Ask User Question',
        description: [
        'Ask the user one or more questions with predefined options and wait for their answers.',
        'Use it BEFORE executing any delete operation (rm, trash, rmdir, unlink, git clean), and when the user must choose between options (a framework, a file, a configuration, a scope).',
        'The user sees a question panel with the options you provide and may skip a question; a skipped question carries no answer or approval.',
        'Do not use it to confirm ordinary, non-destructive commands.',
      ].join(' '),
      parameters: AskUserQuestionSchema,
      async execute(_id: string, params: unknown, signal?: AbortSignal) {
        const input = params as AskUserInput;
        if (!input?.questions?.length) {
          return {
            content: [{ type: 'text', text: 'No questions provided.' }],
            isError: true,
          };
        }

        try {
          const response = await askUser(config, { ...input, sessionKey }, signal);

          if (response.behavior === 'deny') {
            return {
              content: [{ type: 'text', text: 'User denied the operation.' }],
            };
          }

          const answerLines = Object.entries(response.answers ?? {}).map(([q, a]) => `${q}: ${a}`);
          for (const [index, question] of input.questions.entries()) {
            if (response.skippedQuestionIds?.includes(questionId(question, index))) {
              answerLines.push(`${question.question}: (skipped by user; no answer or approval given)`);
            }
          }

          return {
            content: [{
              type: 'text',
              text: answerLines.join('\n') || 'No answers were provided; no user approval was given.',
            }],
            details: { answers: response.answers ?? {}, skippedQuestionIds: response.skippedQuestionIds ?? [] },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text', text: `AskUserQuestion failed: ${message}` }],
            isError: true,
          };
        }
      },
    };  // end of returned tool object
    });  // end of factory function passed to registerTool

    api.logger.info('[ask-user-question] registered AskUserQuestion tool factory.');
  },
};

export default plugin;
