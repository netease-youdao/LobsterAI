import { Type } from '@sinclair/typebox';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

/**
 * AskUserQuestion plugin for OpenClaw.
 *
 * Registers a structured tool that lets the model ask the user a question
 * with predefined options (single/multi select). The tool pauses execution
 * and waits for the user's response via an HTTP callback to LobsterAI.
 *
 * This enables delete-confirmation modals on the LobsterAI desktop app
 * without relying on OpenClaw's exec.approval mechanism.
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
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};

type AskUserInput = {
  questions: Question[];
};

type AskUserResponse = {
  behavior: 'allow' | 'deny';
  answers?: Record<string, string>;
};

const DEFAULT_TIMEOUT_MS = 120_000;

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

const QuestionSchema = Type.Object({
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
  input: AskUserInput,
): Promise<AskUserResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

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

    const parsed = JSON.parse(text);
    return {
      behavior: parsed?.behavior === 'allow' ? 'allow' : 'deny',
      answers: isRecord(parsed?.answers) ? parsed.answers as Record<string, string> : undefined,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { behavior: 'deny' };
    }
    throw error;
  } finally {
    clearTimeout(timer);
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

    // Use a factory so the tool is only available for desktop (webchat) sessions.
    // IM channel sessions (qqbot, dingtalk, weixin, feishu, etc.) get null → tool hidden.
    api.registerTool((ctx) => {
      // Only enable for LobsterAI desktop sessions (sessionKey starts with 'agent:main:lobsterai:').
      // IM channel sessions (dingtalk, qqbot, weixin, feishu, wecom, etc.) should not have this tool
      // so the model executes delete commands directly without confirmation on IM.
      const sessionKey = ctx.sessionKey ?? '';
      const isLocalDesktop = sessionKey.startsWith('agent:main:lobsterai:');
      if (!isLocalDesktop) {
        return null;
      }

      return {
        name: 'AskUserQuestion',
        label: 'Ask User Question',
        description: [
        'Ask the user a question with predefined options and wait for their response.',
        'Use this tool BEFORE executing any delete operation (rm, trash, rmdir, unlink, git clean).',
        'The user will see a confirmation dialog with the options you provide.',
        'Do NOT use this tool for non-delete commands.',
      ].join(' '),
      parameters: AskUserQuestionSchema,
      async execute(_id: string, params: unknown) {
        const input = params as AskUserInput;
        if (!input?.questions?.length) {
          return {
            content: [{ type: 'text', text: 'No questions provided.' }],
            isError: true,
          };
        }

        try {
          const response = await askUser(config, input);

          if (response.behavior === 'deny') {
            return {
              content: [{ type: 'text', text: 'User denied the operation.' }],
            };
          }

          const answerLines = response.answers
            ? Object.entries(response.answers)
                .map(([q, a]) => `${q}: ${a}`)
                .join('\n')
            : 'User approved.';

          return {
            content: [{ type: 'text', text: answerLines }],
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
