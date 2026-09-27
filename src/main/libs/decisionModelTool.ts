import { DecisionModelErrorCode } from '../../shared/decisionModel/constants';
import {
  type DecisionAnswer,
  type DecisionFetch,
  DecisionModelError,
  evaluateDecision,
  parseDecisionEvaluateInput,
} from './decisionModelClient';
import { type DecisionModelConfig, isDecisionModelActive } from './decisionModelConfig';
import type { DecisionToolRequest, DecisionToolResponse } from './mcpBridgeServer';

export interface DecisionToolDeps {
  getConfig: () => DecisionModelConfig;
  fetch: DecisionFetch;
  timeoutMs?: number;
}

// Both UI languages, so the agent can quote whichever the user sees.
const SETTINGS_PATH = 'Settings → Experimental → Jev decision model (设置 → 实验功能 → Jev 判断模型)';

// Written for the agent: what to do next after each failure.
const FAILURE_GUIDANCE: Record<DecisionModelErrorCode, string> = {
  [DecisionModelErrorCode.MissingApiKey]: `Tell the user to add an API key under ${SETTINGS_PATH}.`,
  [DecisionModelErrorCode.InvalidEndpoint]: `Tell the user to fix the endpoint URL under ${SETTINGS_PATH}.`,
  [DecisionModelErrorCode.InvalidInput]: 'Fix the arguments as described and call the tool again.',
  [DecisionModelErrorCode.Unauthorized]: `The API key was rejected. Tell the user to check it under ${SETTINGS_PATH}.`,
  [DecisionModelErrorCode.InsufficientCredits]: 'The provider account is out of credits. Tell the user to top it up.',
  [DecisionModelErrorCode.RateLimited]: 'Wait a few seconds, then retry with fewer questions per call.',
  [DecisionModelErrorCode.Timeout]: 'Retry with fewer or shorter items per call.',
  [DecisionModelErrorCode.Cancelled]: 'The request was cancelled. Do not retry unless the user asks.',
  [DecisionModelErrorCode.Network]: 'Tell the user to check the network or proxy settings.',
  [DecisionModelErrorCode.UpstreamError]: 'Retry once, then fall back to judging the items yourself.',
  [DecisionModelErrorCode.InvalidResponse]: 'Retry once, then fall back to judging the items yourself.',
};

const DISABLED_GUIDANCE = `Tell the user to turn it on under ${SETTINGS_PATH}.`;

const toolText = (payload: Record<string, unknown>): DecisionToolResponse['content'] => (
  [{ type: 'text', text: JSON.stringify(payload) }]
);

function failure(errorCode: DecisionModelErrorCode, reason: string): DecisionToolResponse {
  return {
    content: toolText({ status: 'unavailable', errorCode, reason, guidance: FAILURE_GUIDANCE[errorCode] }),
    isError: true,
    details: { errorCode },
  };
}

const countInvalid = (answers: Record<string, DecisionAnswer>): number =>
  Object.values(answers).filter(answer => answer.type === 'invalid').length;

export async function handleDecisionToolRequest(
  request: DecisionToolRequest,
  deps: DecisionToolDeps,
  signal?: AbortSignal,
): Promise<DecisionToolResponse> {
  const config = deps.getConfig();
  if (!isDecisionModelActive(config)) {
    return {
      content: toolText({
        status: 'unavailable',
        reason: 'The Jev decision model is turned off or not configured in LobsterAI.',
        guidance: DISABLED_GUIDANCE,
      }),
      isError: true,
    };
  }

  const parsed = parseDecisionEvaluateInput(request.args);
  if (parsed.ok === false) {
    return failure(DecisionModelErrorCode.InvalidInput, `Invalid decision_evaluate arguments: ${parsed.error}`);
  }

  try {
    const result = await evaluateDecision(config, parsed.input, {
      fetch: deps.fetch,
      timeoutMs: deps.timeoutMs,
      signal,
    });
    const questionCount = parsed.input.questions.length;
    const invalidCount = countInvalid(result.answers);
    console.log(
      `[DecisionModel] evaluated ${questionCount} question(s) via ${result.provider} (${result.model}) `
      + `in ${result.elapsedMs}ms, invalid=${invalidCount}`,
    );
    return {
      content: toolText({ status: 'ok', ...result }),
      details: {
        provider: result.provider,
        model: result.model,
        elapsedMs: result.elapsedMs,
        questionCount,
        invalidCount,
        usage: result.usage,
      },
    };
  } catch (error) {
    const errorCode = error instanceof DecisionModelError ? error.code : DecisionModelErrorCode.UpstreamError;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[DecisionModel] evaluation failed (${errorCode}): ${message}`);
    return failure(errorCode, message);
  }
}
