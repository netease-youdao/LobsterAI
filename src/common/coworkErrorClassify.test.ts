/**
 * Unit tests for isFailoverEligibleError — the error classification helper
 * that determines whether a model failover should be attempted.
 *
 * Failover-eligible: rate limit, server error, network error, model not found,
 * gateway disconnected, service restart, gateway draining, unknown errors,
 * and unclassified errors.
 *
 * NOT eligible: auth errors (wrong API key), billing (insufficient balance),
 * input too long (same prompt will fail again), content filtered.
 */
import { test, expect } from 'vitest';
import { isFailoverEligibleError, classifyErrorKey } from './coworkErrorClassify';

// ---------------------------------------------------------------------------
// Eligible errors — failover SHOULD be attempted
// ---------------------------------------------------------------------------

test('rate limit (429) is eligible for failover', () => {
  expect(isFailoverEligibleError('Error: 429 Too Many Requests')).toBe(true);
  expect(isFailoverEligibleError('rate_limit_exceeded')).toBe(true);
  expect(isFailoverEligibleError('The server is overloaded')).toBe(true);
});

test('server error (500/502/503) is eligible for failover', () => {
  expect(isFailoverEligibleError('500 Internal Server Error')).toBe(true);
  expect(isFailoverEligibleError('502 Bad Gateway')).toBe(true);
  expect(isFailoverEligibleError('503 Service Unavailable')).toBe(true);
});

test('network error is eligible for failover', () => {
  expect(isFailoverEligibleError('ECONNREFUSED')).toBe(true);
  expect(isFailoverEligibleError('ETIMEDOUT')).toBe(true);
  expect(isFailoverEligibleError('Could not connect to the server')).toBe(true);
});

test('model not found is eligible for failover', () => {
  expect(isFailoverEligibleError('model "gpt-5" not found')).toBe(true);
});

test('gateway disconnected is eligible for failover', () => {
  expect(isFailoverEligibleError('gateway disconnect detected')).toBe(true);
});

test('service restart is eligible for failover', () => {
  expect(isFailoverEligibleError('service restart in progress')).toBe(true);
});

test('gateway draining is eligible for failover', () => {
  expect(isFailoverEligibleError('gateway draining for restart')).toBe(true);
});

test('unknown error is eligible for failover', () => {
  expect(isFailoverEligibleError('An unknown error occurred')).toBe(true);
});

test('unclassified error (no matching rule) is eligible for failover', () => {
  expect(isFailoverEligibleError('Something completely unexpected happened')).toBe(true);
  expect(classifyErrorKey('Something completely unexpected happened')).toBeNull();
});

// ---------------------------------------------------------------------------
// NOT eligible — failover should NOT be attempted
// ---------------------------------------------------------------------------

test('auth error (401) is NOT eligible for failover', () => {
  expect(isFailoverEligibleError('authentication_error: invalid API key')).toBe(false);
  expect(isFailoverEligibleError('401 Unauthorized')).toBe(false);
});

test('billing error (402) is NOT eligible for failover', () => {
  expect(isFailoverEligibleError('insufficient_balance')).toBe(false);
  expect(isFailoverEligibleError('402 quota exceeded')).toBe(false);
});

test('input too long is NOT eligible for failover', () => {
  expect(isFailoverEligibleError('input too long: context length exceeded')).toBe(false);
  expect(isFailoverEligibleError('413 Payload Too Large')).toBe(false);
});

test('content filtered is NOT eligible for failover', () => {
  expect(isFailoverEligibleError('DataInspectionFailed: content review failed')).toBe(false);
  expect(isFailoverEligibleError('451 inappropriate content')).toBe(false);
});

test('PDF processing failure is NOT eligible for failover', () => {
  expect(isFailoverEligibleError('could not process pdf')).toBe(false);
});
