import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

describe('openclaw-chat-send-cwd-decoupling.patch', () => {
  test('allows chat.send to accept and forward cwd', () => {
    expectPatchContains('openclaw-chat-send-cwd-decoupling.patch', [
      'diff --git a/packages/gateway-protocol/src/schema/logs-chat.ts',
      'ChatSendParamsSchema',
      'cwd: Type.Optional(Type.String())',
      'diff --git a/src/gateway/server-methods/chat-send-request.ts',
      'cwd?: string;',
      'diff --git a/src/gateway/server-methods/chat-send-agent-dispatch.ts',
      'cwd: normalizeOptionalText(p.cwd)',
    ]);
  });

  test('adds protocol validator coverage for chat.send cwd', () => {
    expectPatchContains('openclaw-chat-send-cwd-decoupling.patch', [
      'diff --git a/packages/gateway-protocol/src/index.test.ts',
      'cwd: "/tmp/work"',
    ]);
  });
});
