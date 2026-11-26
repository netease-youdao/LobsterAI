import { buildManagedSessionKey } from '../../../shared/cowork/managedSessionKey';
import { DECISION_EVALUATE_TOOL_NAME } from '../../../shared/decisionModel/constants';
import { DecisionLimits, DecisionQuestionType } from '../decisionModelClient';
import { isDecisionModelActive } from '../decisionModelConfig';
import { type DecisionToolDeps, handleDecisionToolRequest } from '../decisionModelTool';
import type { HostToolProvider } from './dshHostBridgeWiring';
import type { DshHostToolDescriptor } from './dshHostManager';

// Exceeds DEFAULT_DECISION_TIMEOUT_MS (30s) so evaluateDecision returns
// structured timeout guidance before DSH aborts the host tool call.
export const DECISION_EVALUATE_TOOL_TIMEOUT_MS = 45_000;

export const DECISION_EVALUATE_TOOL_DESCRIPTION = [
  'Judge content with a fast decision model (TypeSafe Jev). It returns typed answers with probabilities instead of text, usually in under a second and at a tiny cost.',
  'Use it to classify, triage, filter, rank, or check many items in one call: keep shared context in `state` (the task, the rubric, background) and give each item its own question that quotes the item,',
  'e.g. {"id":"r12","type":"choice","instructions":"Review: \\"Arrived late and broken.\\" Which problem does it report?","options":[{"name":"shipping"},{"name":"quality"},{"name":"none"}]}.',
  'boolean answers are the probability that the statement is true (near 0.5 means unsure); choice answers include a confidence; score answers give the position on `levels`.',
  'Ask one judgment per question. Do not use it for arithmetic, counting, dates, or writing text; do that yourself.',
  'Answers of type "invalid" failed validation, so judge those items yourself, and tell the user about low-confidence results.',
].join(' ');

export const DECISION_EVALUATE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['state', 'questions'],
  properties: {
    state: {
      oneOf: [
        { type: 'string' },
        { type: 'object', additionalProperties: true },
        { type: 'array' },
      ],
      description: 'The content or shared context to judge: text, or a JSON object/array whose fields the questions can refer to by name.',
    },
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: DecisionLimits.MaxQuestions,
      description: 'Questions answered together in one request (up to 200).',
      items: {
        type: 'object',
        required: ['id', 'type', 'instructions'],
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: DecisionLimits.MaxQuestionIdLength,
            description: 'Unique key for this question; its answer comes back under this key (e.g. "r12_topic").',
          },
          type: {
            type: 'string',
            enum: [
              DecisionQuestionType.Boolean,
              DecisionQuestionType.Choice,
              DecisionQuestionType.Score,
            ],
            description: 'boolean: probability the statement is true. choice: pick one of `options`. score: position on the ordered `levels` rubric.',
          },
          instructions: {
            type: 'string',
            minLength: 1,
            description: 'The question. Ask one judgment a knowledgeable person could make in a second.',
          },
          options: {
            type: 'array',
            minItems: DecisionLimits.MinChoiceOptions,
            maxItems: DecisionLimits.MaxChoiceOptions,
            description: 'choice only: the options to pick from.',
            items: {
              type: 'object',
              required: ['name'],
              properties: {
                name: {
                  type: 'string',
                  minLength: 1,
                  description: 'Option key; returned as the answer when chosen.',
                },
                description: {
                  type: 'string',
                  description: 'What this option means.',
                },
              },
            },
          },
          levels: {
            type: 'array',
            minItems: DecisionLimits.MinScoreLevels,
            maxItems: DecisionLimits.MaxScoreLevels,
            description: 'score only: rubric levels ordered from lowest to highest.',
            items: {
              type: 'string',
              minLength: 1,
            },
          },
          trueCriteria: {
            type: 'string',
            description: 'boolean only: what counts as yes.',
          },
          falseCriteria: {
            type: 'string',
            description: 'boolean only: what counts as no.',
          },
        },
      },
    },
  },
};

export const DECISION_EVALUATE_TOOL_DESCRIPTOR: DshHostToolDescriptor = {
  name: DECISION_EVALUATE_TOOL_NAME,
  description: DECISION_EVALUATE_TOOL_DESCRIPTION,
  timeoutMs: DECISION_EVALUATE_TOOL_TIMEOUT_MS,
  isConcurrencySafe: true,
  inputSchema: DECISION_EVALUATE_INPUT_SCHEMA,
};

/**
 * Exposes `decision_evaluate` as a dynamic DSH host tool whenever the Jev
 * decision model is enabled and configured in LobsterAI.
 */
export function createDshDecisionToolProvider(deps: DecisionToolDeps): HostToolProvider {
  return {
    listDescriptors: () => (
      isDecisionModelActive(deps.getConfig()) ? [DECISION_EVALUATE_TOOL_DESCRIPTOR] : []
    ),
    async execute(toolName, args, context) {
      if (toolName !== DECISION_EVALUATE_TOOL_NAME) {
        throw new Error(`Unsupported decision model tool: "${toolName}"`);
      }
      const sessionKey = context.coworkSessionId?.trim()
        ? buildManagedSessionKey(context.coworkSessionId.trim(), context.agentId || 'main')
        : (context.sessionId?.trim() ?? '');
      return handleDecisionToolRequest(
        {
          args,
          context: {
            sessionKey,
            toolCallId: context.callId?.trim() ?? '',
          },
        },
        deps,
        context.signal,
      );
    },
  };
}
