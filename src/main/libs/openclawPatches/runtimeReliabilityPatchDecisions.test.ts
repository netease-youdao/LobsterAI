import { describe, test } from 'vitest';

import { expectCurrentOpenClawPatchMissing } from './patchTestUtils';

describe('runtime reliability OpenClaw patch decisions', () => {
  test('does not carry chat image attachment size patch because LobsterAI configures OpenClaw mediaMaxMb', () => {
    expectCurrentOpenClawPatchMissing('openclaw-chat-send-image-attachment-30mb.patch');
  });

  test('does not carry memory atomic reindex retry patch because OpenClaw 6.1 retries transient file errors upstream', () => {
    expectCurrentOpenClawPatchMissing('openclaw-memory-atomic-reindex-ebusy-retry.patch');
  });

  test('does not carry MCP stdio process tree kill patch because OpenClaw 6.1 has native process-tree cleanup', () => {
    expectCurrentOpenClawPatchMissing('openclaw-mcp-stdio-process-tree-kill.patch');
  });
});
