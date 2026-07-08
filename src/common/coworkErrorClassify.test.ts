import { expect,test } from 'vitest';

import { classifyErrorKey, isLobsterAIQuotaExhaustedError } from './coworkErrorClassify';

const classifyError = (error: string) => classifyErrorKey(error) ?? error;

// ==================== Auth errors ====================

test('auth: Anthropic authentication_error', () => {
  expect(classifyError('authentication_error')).toBe('coworkErrorAuthInvalid');
});

test('auth: DeepSeek authentication_fails', () => {
  expect(classifyError('authentication_fails')).toBe('coworkErrorAuthInvalid');
});

test('auth: OpenAI api key not valid', () => {
  expect(classifyError('Incorrect API key provided: sk-xxx. You can find your API key at https://platform.openai.com/account/api-keys.')).toBe('coworkErrorAuthInvalid');
});

test('auth: OpenAI api_key invalid', () => {
  expect(classifyError('api_key is invalid')).toBe('coworkErrorAuthInvalid');
});

test('auth: Gemini PERMISSION_DENIED', () => {
  expect(classifyError('PERMISSION_DENIED: API key not valid')).toBe('coworkErrorAuthInvalid');
});

test('auth: HTTP 401', () => {
  expect(classifyError('Request failed with status 401')).toBe('coworkErrorAuthInvalid');
});

test('auth: remote MCP ApiKey expired or inactive', () => {
  expect(classifyError('ApiKey is expired, deleted, or user is inactive')).toBe('coworkErrorAuthInvalid');
});

test('auth: unauthorized', () => {
  expect(classifyError('Unauthorized access')).toBe('coworkErrorAuthInvalid');
});

test('auth: OAuth token expired', () => {
  expect(classifyError('token has expired')).toBe('coworkErrorOAuthInvalid');
});

test('auth: invalid authorization method', () => {
  expect(classifyError('invalid authorization method')).toBe('coworkErrorOAuthInvalid');
});

test('auth: provider names containing oauth are not enough to classify auth failure', () => {
  expect(classifyError('Unknown model: qwen-oauth/qwen3.6-plus')).toBe('Unknown model: qwen-oauth/qwen3.6-plus');
});

test('auth: provider model access denied', () => {
  expect(classifyError('403 您无权访问glm-x-preview。')).toBe('coworkErrorModelAccessDenied');
});

test('auth: auth scope maps to model access denied', () => {
  expect(classifyError('providerRuntimeFailureKind=auth_scope')).toBe('coworkErrorModelAccessDenied');
});

// ==================== Billing errors ====================

test('billing: DeepSeek insufficient_balance', () => {
  expect(classifyError('insufficient_balance: Your account does not have enough balance')).toBe('coworkErrorInsufficientBalance');
});

test('billing: OpenAI insufficient_quota', () => {
  expect(classifyError('You exceeded your current quota, please check your plan and billing details. insufficient_quota')).toBe('coworkErrorInsufficientBalance');
});

test('billing: LobsterAI free quota exhausted', () => {
  expect(classifyError('免费额度已用完，请升级套餐')).toBe('coworkErrorQuotaExhausted');
});

test('billing: LobsterAI daily free quota code exhausted', () => {
  expect(classifyError('{"error":{"message":"今日免费额度已用完","code":40200}}')).toBe('coworkErrorQuotaExhausted');
});

test('billing: LobsterAI free quota code exhausted', () => {
  expect(classifyError('{"error":{"message":"免费额度已用完，请升级套餐","code":40201}}')).toBe('coworkErrorQuotaExhausted');
});

test('billing: LobsterAI monthly credits exhausted', () => {
  expect(classifyError('本月积分已用完')).toBe('coworkErrorQuotaExhausted');
});

test('billing: LobsterAI monthly quota JSON payload', () => {
  expect(classifyError('{"type":"error","error":{"type":"proxy_error","message":"本月积分已用完","code":40202}}')).toBe('coworkErrorQuotaExhausted');
});

test('billing: detects LobsterAI quota exhausted for proxy helpers', () => {
  expect(isLobsterAIQuotaExhaustedError('monthly credits exhausted')).toBe(true);
  expect(isLobsterAIQuotaExhaustedError('Request failed with status 402')).toBe(false);
});

test('billing: OpenRouter insufficient credits', () => {
  expect(classifyError('insufficient credits')).toBe('coworkErrorInsufficientBalance');
});

test('billing: Qwen Arrearage', () => {
  expect(classifyError('Arrearage')).toBe('coworkErrorInsufficientBalance');
});

test('billing: StepFun 余额不足', () => {
  expect(classifyError('账户余额不足，请充值后重试')).toBe('coworkErrorInsufficientBalance');
});

test('billing: HTTP 402', () => {
  expect(classifyError('Request failed with status 402')).toBe('coworkErrorInsufficientBalance');
});

// ==================== Input too long ====================

test('input: context length exceeded', () => {
  expect(classifyError("This model's maximum context length is 8192 tokens. context length exceeded")).toBe('coworkErrorInputTooLong');
});

test('input: input too long', () => {
  expect(classifyError('input too long, please reduce your input')).toBe('coworkErrorInputTooLong');
});

test('input: Qwen Range of input length', () => {
  expect(classifyError('Range of input length should be [1, 6000]')).toBe('coworkErrorInputTooLong');
});

test('input: HTTP 413', () => {
  expect(classifyError('Request failed with status 413')).toBe('coworkErrorInputTooLong');
});

test('input: payload too large', () => {
  expect(classifyError('payload too large')).toBe('coworkErrorInputTooLong');
});

test('input: max_tokens', () => {
  expect(classifyError('max_tokens exceeded')).toBe('coworkErrorInputTooLong');
});

// ==================== PDF ====================

test('pdf: could not process pdf', () => {
  expect(classifyError('Could not process PDF file')).toBe('coworkErrorCouldNotProcessPdf');
});

// ==================== Model not found ====================

test('model: model not found', () => {
  expect(classifyError('model not found: gpt-5')).toBe('coworkErrorModelNotFound');
});

test('model: Qwen Model not exist', () => {
  expect(classifyError('Model not exist')).toBe('coworkErrorModelNotFound');
});

test('model: Ollama model xxx not found', () => {
  expect(classifyError("model 'llama3' not found")).toBe('coworkErrorModelNotFound');
});

// ==================== Gateway / connection ====================

test('gateway: chat send payload too large', () => {
  expect(classifyError('chat.send payload too large: estimated 38128542 bytes exceeds safe limit 30932992 bytes')).toBe('coworkErrorMessageTooLarge');
});

test('gateway: max payload exceeded', () => {
  expect(classifyError('[ws] error conn=abc remote=127.0.0.1: Max payload size exceeded')).toBe('coworkErrorMessageTooLarge');
});

test('gateway: websocket 1009 close', () => {
  expect(classifyError('gateway closed (1009):')).toBe('coworkErrorMessageTooLarge');
});

test('gateway: message too big', () => {
  expect(classifyError('WebSocket message too big')).toBe('coworkErrorMessageTooLarge');
});

test('gateway: disconnect', () => {
  expect(classifyError('gateway disconnected unexpectedly')).toBe('coworkErrorGatewayDisconnected');
});

test('gateway: client disconnected', () => {
  expect(classifyError('client disconnected')).toBe('coworkErrorGatewayDisconnected');
});

test('gateway: session patch timeout before send', () => {
  expect(classifyError('gateway request timeout for sessions.patch')).toBe('coworkGatewaySessionSyncTimeout');
});

test('gateway: service restart', () => {
  expect(classifyError('service restart in progress')).toBe('coworkErrorServiceRestart');
});

test('gateway: draining', () => {
  expect(classifyError('gateway draining for restart')).toBe('coworkErrorGatewayDraining');
});

// ==================== Content moderation ====================

test('content: Qwen DataInspectionFailed', () => {
  expect(classifyError('DataInspectionFailed')).toBe('coworkErrorContentFiltered');
});

test('content: content filter', () => {
  expect(classifyError('content filter triggered')).toBe('coworkErrorContentFiltered');
});

test('content: 审核未通过', () => {
  expect(classifyError('审核未通过')).toBe('coworkErrorContentFiltered');
});

test('content: StepFun HTTP 451', () => {
  expect(classifyError('Request failed with status 451')).toBe('coworkErrorContentFiltered');
});

test('content: inappropriate content', () => {
  expect(classifyError('inappropriate content detected')).toBe('coworkErrorContentFiltered');
});

// ==================== Rate limit ====================

test('rate: HTTP 429', () => {
  expect(classifyError('Request failed with status 429')).toBe('coworkErrorRateLimit');
});

test('rate: rate_limit', () => {
  expect(classifyError('rate_limit exceeded')).toBe('coworkErrorRateLimit');
});

test('rate: too many requests', () => {
  expect(classifyError('Too many requests, please slow down')).toBe('coworkErrorRateLimit');
});

test('rate: Anthropic overloaded', () => {
  expect(classifyError('overloaded_error: Overloaded')).toBe('coworkErrorRateLimit');
});

test('rate: Gemini RESOURCE_EXHAUSTED', () => {
  expect(classifyError('RESOURCE_EXHAUSTED: quota exceeded')).toBe('coworkErrorRateLimit');
});

// ==================== Network errors ====================

test('network: ECONNREFUSED', () => {
  expect(classifyError('connect ECONNREFUSED 127.0.0.1:443')).toBe('coworkErrorNetworkError');
});

test('network: ENOTFOUND', () => {
  expect(classifyError('getaddrinfo ENOTFOUND api.example.com')).toBe('coworkErrorNetworkError');
});

test('network: ETIMEDOUT', () => {
  expect(classifyError('connect ETIMEDOUT 1.2.3.4:443')).toBe('coworkErrorNetworkError');
});

test('network: could not connect', () => {
  expect(classifyError('could not connect to server')).toBe('coworkErrorNetworkError');
});

test('network: MiniMax undici fetch connect timeout', () => {
  expect(classifyError(
    '[provider-transport-fetch] [model-fetch] error provider=minimax api=openai-completions '
    + 'model=MiniMax-M2.7 elapsedMs=10552 name=TypeError code=undefined '
    + 'causeName=ConnectTimeoutError causeCode=UND_ERR_CONNECT_TIMEOUT message=fetch failed',
  )).toBe('coworkErrorNetworkError');
});

test('network: provider network request failed', () => {
  expect(classifyError('Network request failed while calling provider')).toBe('coworkErrorNetworkError');
});

test('network: socket hang up', () => {
  expect(classifyError('request failed: socket hang up')).toBe('coworkErrorNetworkError');
});

// ==================== Server errors ====================

test('server: internal server error', () => {
  expect(classifyError('Internal Server Error')).toBe('coworkErrorServerError');
});

test('server: bad gateway', () => {
  expect(classifyError('Bad Gateway')).toBe('coworkErrorServerError');
});

test('server: HTTP 500', () => {
  expect(classifyError('Request failed with status 500')).toBe('coworkErrorServerError');
});

test('server: HTTP 502', () => {
  expect(classifyError('Request failed with status 502')).toBe('coworkErrorServerError');
});

test('server: HTTP 503', () => {
  expect(classifyError('Request failed with status 503')).toBe('coworkErrorServerError');
});

// ==================== Unrecognized errors (passthrough) ====================

test('unknown: returns original error string', () => {
  const msg = 'Something completely unexpected happened';
  expect(classifyError(msg)).toBe(msg);
});

test('unknown: empty string', () => {
  expect(classifyError('')).toBe('');
});
