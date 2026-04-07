import { test, expect } from 'vitest';
import {
  sanitizeUrlForApiProxyLog,
  responsePayloadByteLength,
} from './apiProxyLog';

test('sanitizeUrlForApiProxyLog strips query and hash', () => {
  expect(
    sanitizeUrlForApiProxyLog('https://api.example.com/v1/chat?key=secret#frag'),
  ).toBe('https://api.example.com/v1/chat');
});

test('sanitizeUrlForApiProxyLog returns placeholder for invalid input', () => {
  expect(sanitizeUrlForApiProxyLog('not-a-url')).toBe('(invalid-url)');
});

test('responsePayloadByteLength measures string utf8 bytes', () => {
  expect(responsePayloadByteLength('a')).toBe(1);
  expect(responsePayloadByteLength('é')).toBe(2);
});

test('responsePayloadByteLength measures json object', () => {
  expect(responsePayloadByteLength({ a: 1 })).toBeGreaterThan(0);
});
