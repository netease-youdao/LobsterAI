import assert from 'node:assert/strict';
import test from 'node:test';

// Mirror the ERROR_RULES from src/renderer/services/cowork.ts
// so we can test the regex patterns without importing renderer code.
const ERROR_RULES = [
  [/authentication[_ ](error|fails?)|api[_ ]key.*(invalid|expired|not[_ ]valid)|invalid.*api.*key|incorrect.*api.*key|unauthorized|PERMISSION_DENIED|\b401\b/i, 'coworkErrorAuthInvalid'],
  [/\b429\b|rate[_ ]limit|too many requests|overloaded|RESOURCE_EXHAUSTED/i, 'coworkErrorRateLimit'],
  [/insufficient.*(balance|quota|credits)|billing|quota[_ ]exceeded|Arrearage|account.*not.*in.*good.*standing|余额不足|\b402\b/i, 'coworkErrorInsufficientBalance'],
  [/input.*too.*long|context.*length.*exceeded|range of input length|\b413\b|payload.*too.*large|request.*entity.*too.*large|max[_ ]tokens/i, 'coworkErrorInputTooLong'],
  [/could not process pdf/i, 'coworkErrorCouldNotProcessPdf'],
  [/model.*not.*(found|exist)/i, 'coworkErrorModelNotFound'],
  [/gateway.*disconnect|client disconnected/i, 'coworkErrorGatewayDisconnected'],
  [/service restart/i, 'coworkErrorServiceRestart'],
  [/gateway.*draining|draining.*restart/i, 'coworkErrorGatewayDraining'],
  [/DataInspectionFailed|content.*(review|filter)|审核未通过|未通过.*审核|inappropriate.*content|\b451\b|flagged.*input/i, 'coworkErrorContentFiltered'],
  [/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|could not connect|connection.*refused|network.*error/i, 'coworkErrorNetworkError'],
  [/internal.server.error|bad.gateway|service.unavailable|\b50[023]\b/i, 'coworkErrorServerError'],
];

const classifyError = (error) => {
  for (const [pattern, key] of ERROR_RULES) {
    if (pattern.test(error)) return key;
  }
  return error;
};

// ==================== Auth errors ====================

test('auth: Anthropic authentication_error', () => {
  assert.equal(classifyError('authentication_error'), 'coworkErrorAuthInvalid');
});

test('auth: DeepSeek authentication_fails', () => {
  assert.equal(classifyError('authentication_fails'), 'coworkErrorAuthInvalid');
});

test('auth: OpenAI api key not valid', () => {
  assert.equal(classifyError('Incorrect API key provided: sk-xxx. You can find your API key at https://platform.openai.com/account/api-keys.'), 'coworkErrorAuthInvalid');
});

test('auth: OpenAI api_key invalid', () => {
  assert.equal(classifyError('api_key is invalid'), 'coworkErrorAuthInvalid');
});

test('auth: Gemini PERMISSION_DENIED', () => {
  assert.equal(classifyError('PERMISSION_DENIED: API key not valid'), 'coworkErrorAuthInvalid');
});

test('auth: HTTP 401', () => {
  assert.equal(classifyError('Request failed with status 401'), 'coworkErrorAuthInvalid');
});

test('auth: unauthorized', () => {
  assert.equal(classifyError('Unauthorized access'), 'coworkErrorAuthInvalid');
});

// ==================== Billing errors ====================

test('billing: DeepSeek insufficient_balance', () => {
  assert.equal(classifyError('insufficient_balance: Your account does not have enough balance'), 'coworkErrorInsufficientBalance');
});

test('billing: OpenAI insufficient_quota', () => {
  assert.equal(classifyError('You exceeded your current quota, please check your plan and billing details. insufficient_quota'), 'coworkErrorInsufficientBalance');
});

test('billing: OpenRouter insufficient credits', () => {
  assert.equal(classifyError('insufficient credits'), 'coworkErrorInsufficientBalance');
});

test('billing: Qwen Arrearage', () => {
  assert.equal(classifyError('Arrearage'), 'coworkErrorInsufficientBalance');
});

test('billing: StepFun 余额不足', () => {
  assert.equal(classifyError('账户余额不足，请充值后重试'), 'coworkErrorInsufficientBalance');
});

test('billing: HTTP 402', () => {
  assert.equal(classifyError('Request failed with status 402'), 'coworkErrorInsufficientBalance');
});

// ==================== Input too long ====================

test('input: context length exceeded', () => {
  assert.equal(classifyError("This model's maximum context length is 8192 tokens. context length exceeded"), 'coworkErrorInputTooLong');
});

test('input: input too long', () => {
  assert.equal(classifyError('input too long, please reduce your input'), 'coworkErrorInputTooLong');
});

test('input: Qwen Range of input length', () => {
  assert.equal(classifyError('Range of input length should be [1, 6000]'), 'coworkErrorInputTooLong');
});

test('input: HTTP 413', () => {
  assert.equal(classifyError('Request failed with status 413'), 'coworkErrorInputTooLong');
});

test('input: payload too large', () => {
  assert.equal(classifyError('payload too large'), 'coworkErrorInputTooLong');
});

test('input: max_tokens', () => {
  assert.equal(classifyError('max_tokens exceeded'), 'coworkErrorInputTooLong');
});

// ==================== PDF ====================

test('pdf: could not process pdf', () => {
  assert.equal(classifyError('Could not process PDF file'), 'coworkErrorCouldNotProcessPdf');
});

// ==================== Model not found ====================

test('model: model not found', () => {
  assert.equal(classifyError('model not found: gpt-5'), 'coworkErrorModelNotFound');
});

test('model: Qwen Model not exist', () => {
  assert.equal(classifyError('Model not exist'), 'coworkErrorModelNotFound');
});

test('model: Ollama model xxx not found', () => {
  assert.equal(classifyError("model 'llama3' not found"), 'coworkErrorModelNotFound');
});

// ==================== Gateway / connection ====================

test('gateway: disconnect', () => {
  assert.equal(classifyError('gateway disconnected unexpectedly'), 'coworkErrorGatewayDisconnected');
});

test('gateway: client disconnected', () => {
  assert.equal(classifyError('client disconnected'), 'coworkErrorGatewayDisconnected');
});

test('gateway: service restart', () => {
  assert.equal(classifyError('service restart in progress'), 'coworkErrorServiceRestart');
});

test('gateway: draining', () => {
  assert.equal(classifyError('gateway draining for restart'), 'coworkErrorGatewayDraining');
});

// ==================== Content moderation ====================

test('content: Qwen DataInspectionFailed', () => {
  assert.equal(classifyError('DataInspectionFailed'), 'coworkErrorContentFiltered');
});

test('content: content filter', () => {
  assert.equal(classifyError('content filter triggered'), 'coworkErrorContentFiltered');
});

test('content: 审核未通过', () => {
  assert.equal(classifyError('审核未通过'), 'coworkErrorContentFiltered');
});

test('content: StepFun HTTP 451', () => {
  assert.equal(classifyError('Request failed with status 451'), 'coworkErrorContentFiltered');
});

test('content: inappropriate content', () => {
  assert.equal(classifyError('inappropriate content detected'), 'coworkErrorContentFiltered');
});

// ==================== Rate limit ====================

test('rate: HTTP 429', () => {
  assert.equal(classifyError('Request failed with status 429'), 'coworkErrorRateLimit');
});

test('rate: rate_limit', () => {
  assert.equal(classifyError('rate_limit exceeded'), 'coworkErrorRateLimit');
});

test('rate: too many requests', () => {
  assert.equal(classifyError('Too many requests, please slow down'), 'coworkErrorRateLimit');
});

test('rate: Anthropic overloaded', () => {
  assert.equal(classifyError('overloaded_error: Overloaded'), 'coworkErrorRateLimit');
});

test('rate: Gemini RESOURCE_EXHAUSTED', () => {
  assert.equal(classifyError('RESOURCE_EXHAUSTED: quota exceeded'), 'coworkErrorRateLimit');
});

// ==================== Network errors ====================

test('network: ECONNREFUSED', () => {
  assert.equal(classifyError('connect ECONNREFUSED 127.0.0.1:443'), 'coworkErrorNetworkError');
});

test('network: ENOTFOUND', () => {
  assert.equal(classifyError('getaddrinfo ENOTFOUND api.example.com'), 'coworkErrorNetworkError');
});

test('network: ETIMEDOUT', () => {
  assert.equal(classifyError('connect ETIMEDOUT 1.2.3.4:443'), 'coworkErrorNetworkError');
});

test('network: could not connect', () => {
  assert.equal(classifyError('could not connect to server'), 'coworkErrorNetworkError');
});

// ==================== Server errors ====================

test('server: internal server error', () => {
  assert.equal(classifyError('Internal Server Error'), 'coworkErrorServerError');
});

test('server: bad gateway', () => {
  assert.equal(classifyError('Bad Gateway'), 'coworkErrorServerError');
});

test('server: HTTP 500', () => {
  assert.equal(classifyError('Request failed with status 500'), 'coworkErrorServerError');
});

test('server: HTTP 502', () => {
  assert.equal(classifyError('Request failed with status 502'), 'coworkErrorServerError');
});

test('server: HTTP 503', () => {
  assert.equal(classifyError('Request failed with status 503'), 'coworkErrorServerError');
});

// ==================== Unrecognized errors (passthrough) ====================

test('unknown: returns original error string', () => {
  const msg = 'Something completely unexpected happened';
  assert.equal(classifyError(msg), msg);
});

test('unknown: empty string', () => {
  assert.equal(classifyError(''), '');
});
