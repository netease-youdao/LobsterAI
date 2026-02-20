import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const proxyModule = require('../dist-electron/libs/coworkOpenAICompatProxy.js');
const testUtils = proxyModule.__openAICompatProxyTestUtils;

if (!testUtils?.findSSEPacketBoundary) {
  throw new Error('findSSEPacketBoundary is not available in __openAICompatProxyTestUtils');
}

test('findSSEPacketBoundary detects LF packet separator', () => {
  const boundary = testUtils.findSSEPacketBoundary('data: 1\n\ndata: 2\n\n');
  assert.ok(boundary);
  assert.equal(boundary.index, 7);
  assert.equal(boundary.separatorLength, 2);
});

test('findSSEPacketBoundary detects CRLF packet separator', () => {
  const boundary = testUtils.findSSEPacketBoundary('data: 1\r\n\r\ndata: 2\r\n\r\n');
  assert.ok(boundary);
  assert.equal(boundary.index, 7);
  assert.equal(boundary.separatorLength, 4);
});

test('findSSEPacketBoundary returns earliest separator in mixed input', () => {
  const boundary = testUtils.findSSEPacketBoundary('data: 1\r\n\r\ndata: 2\n\n');
  assert.ok(boundary);
  assert.equal(boundary.index, 7);
  assert.equal(boundary.separatorLength, 4);
});
