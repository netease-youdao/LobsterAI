import { test, expect } from 'vitest';
import { classifyErrorKey } from './coworkErrorClassify';

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

test('auth: unauthorized', () => {
  expect(classifyError('Unauthorized access')).toBe('coworkErrorAuthInvalid');
});

// ==================== Billing errors ====================

test('billing: DeepSeek insufficient_balance', () => {
  expect(classifyError('insufficient_balance: Your account does not have enough balance')).toBe('coworkErrorInsufficientBalance');
});

test('billing: OpenAI insufficient_quota', () => {
  expect(classifyError('You exceeded your current quota, please check your plan and billing details. insufficient_quota')).toBe('coworkErrorInsufficientBalance');
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

test('gateway: disconnect', () => {
  expect(classifyError('gateway disconnected unexpectedly')).toBe('coworkErrorGatewayDisconnected');
});

test('gateway: client disconnected', () => {
  expect(classifyError('client disconnected')).toBe('coworkErrorGatewayDisconnected');
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
