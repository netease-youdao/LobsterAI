import { Type } from '@sinclair/typebox';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

import { isLobsterAiDesktopSessionKey } from './sessionKey';

/**
 * LobsterDecision plugin for OpenClaw (experimental).
 *
 * Registers `decision_evaluate`, which asks the decision model configured in
 * LobsterAI (TypeSafe Jev) typed questions about some content. Jev returns
 * probabilities instead of text, in well under a second and at a tiny cost,
 * so the agent can classify, triage, or score many items in one call. The
 * tool calls back into LobsterAI over the loopback bridge; the API key and
 * provider routing stay in the LobsterAI main process.
 */

type PluginConfig = {
  callbackUrl: string;
  secret: string;
  requestTimeoutMs: number;
};

type DecisionToolRequest = {
  args: Record<string, unknown>;
  context: {
    sessionKey: string;
    toolCallId: string;
  };
};

type DecisionToolResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
};

const TOOL_NAME = 'decision_evaluate';

const DEFAULT_TIMEOUT_MS = 45_000;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const parsePluginConfig = (value: unknown): PluginConfig => {
  const raw = isRecord(value) ? value : {};
  return {
    callbackUrl: typeof raw.callbackUrl === 'string' ? raw.callbackUrl.trim() : '',
    secret: typeof raw.secret === 'string' ? raw.secret.trim() : '',
    requestTimeoutMs: typeof raw.requestTimeoutMs === 'number' && raw.requestTimeoutMs >= 1000
      ? raw.requestTimeoutMs
      : DEFAULT_TIMEOUT_MS,
  };
};

const ChoiceOptionSchema = Type.Object({
  name: Type.String({ minLength: 1, description: 'Option key; returned as the answer when chosen.' }),
  description: Type.Optional(Type.String({ description: 'What this option means.' })),
});

const QuestionSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    maxLength: 128,
    description: 'Unique key for this question; its answer comes back under this key (e.g. "r12_topic").',
  }),
  type: Type.Union([
    Type.Literal('boolean'),
    Type.Literal('choice'),
    Type.Literal('score'),
  ], {
    description: 'boolean: probability the statement is true. choice: pick one of `options`. score: position on the ordered `levels` rubric.',
  }),
  instructions: Type.String({
    minLength: 1,
    description: 'The question. Ask one judgment a knowledgeable person could make in a second.',
  }),
  options: Type.Optional(Type.Array(ChoiceOptionSchema, {
    minItems: 2,
    maxItems: 255,
    description: 'choice only: the options to pick from.',
  })),
  levels: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    minItems: 2,
    maxItems: 10,
    description: 'score only: rubric levels ordered from lowest to highest.',
  })),
  trueCriteria: Type.Optional(Type.String({ description: 'boolean only: what counts as yes.' })),
  falseCriteria: Type.Optional(Type.String({ description: 'boolean only: what counts as no.' })),
});

const DecisionEvaluateSchema = Type.Object({
  state: Type.Union([
    Type.String(),
    Type.Record(Type.String(), Type.Unknown()),
    Type.Array(Type.Unknown()),
  ], {
    description: 'The content or shared context to judge: text, or a JSON object/array whose fields the questions can refer to by name.',
  }),
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: 200,
    description: 'Questions answered together in one request (up to 200).',
  }),
});

const TOOL_DESCRIPTION = [
  'Judge content with a fast decision model (TypeSafe Jev). It returns typed answers with probabilities instead of text, usually in under a second and at a tiny cost.',
  'Use it to classify, triage, filter, rank, or check many items in one call: keep shared context in `state` (the task, the rubric, background) and give each item its own question that quotes the item,',
  'e.g. {"id":"r12","type":"choice","instructions":"Review: \\"Arrived late and broken.\\" Which problem does it report?","options":[{"name":"shipping"},{"name":"quality"},{"name":"none"}]}.',
  'boolean answers are the probability that the statement is true (near 0.5 means unsure); choice answers include a confidence; score answers give the position on `levels`.',
  'Ask one judgment per question. Do not use it for arithmetic, counting, dates, or writing text; do that yourself.',
  'Answers of type "invalid" failed validation, so judge those items yourself, and tell the user about low-confidence results.',
].join(' ');

const countQuestions = (args: Record<string, unknown>): number => (
  Array.isArray(args.questions) ? args.questions.length : 0
);

async function callDecisionBridge(
  config: PluginConfig,
  request: DecisionToolRequest,
  signal?: AbortSignal,
): Promise<DecisionToolResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    const response = await fetch(config.callbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mcp-bridge-secret': config.secret,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.trim() ? JSON.parse(text) : null;
    } catch {
      // Fall through to the HTTP error below.
    }
    // The bridge answers failures with a tool result too; pass those through.
    if (isRecord(parsed) && Array.isArray(parsed.content)) {
      return parsed as DecisionToolResponse;
    }
    throw new Error(`Decision callback HTTP ${response.status}: ${text.trim().slice(0, 200) || response.statusText}`);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        content: [{
          type: 'text',
          text: signal?.aborted ? 'The decision request was cancelled.' : 'The decision model request timed out.',
        }],
        isError: true,
      };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

const plugin = {
  id: 'lobster-decision',
  name: 'LobsterDecision',
  description: 'Experimental decision model tool (TypeSafe Jev) powered by LobsterAI.',
  configSchema: {
    parse(value: unknown): PluginConfig {
      return parsePluginConfig(value);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    if (!config.callbackUrl || !config.secret) {
      api.logger.info('[lobster-decision] skipped: callbackUrl or secret not configured.');
      return;
    }

    api.registerTool((ctx) => {
      // Desktop sessions only while the feature is experimental; IM channel
      // sessions never see the tool.
      const sessionKey = ctx.sessionKey ?? '';
      if (!isLobsterAiDesktopSessionKey(sessionKey)) {
        return null;
      }

      return {
        name: TOOL_NAME,
        label: 'Jev Decision',
        description: TOOL_DESCRIPTION,
        parameters: DecisionEvaluateSchema,
        async execute(id: string, params: unknown, signal?: AbortSignal) {
          const args = isRecord(params) ? params : {};
          const startedAt = Date.now();
          try {
            const result = await callDecisionBridge(config, {
              args,
              context: { sessionKey, toolCallId: id },
            }, signal);
            api.logger.info(`[lobster-decision] ${TOOL_NAME} completed: toolCallId=${id} questions=${countQuestions(args)} elapsedMs=${Date.now() - startedAt} isError=${result.isError === true}`);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.logger.info(`[lobster-decision] ${TOOL_NAME} failed: toolCallId=${id} error=${message}`);
            return { content: [{ type: 'text', text: `Decision model call failed: ${message}` }], isError: true };
          }
        },
      };
    });

    api.logger.info(`[lobster-decision] registered ${TOOL_NAME} tool factory.`);
  },
};

export default plugin;
