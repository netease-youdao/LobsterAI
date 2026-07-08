import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

describe('openclaw-mcp-shared-runtime.patch', () => {
  test('shares MCP runtimes by config fingerprint across sessions', () => {
    expectPatchContains('openclaw-mcp-shared-runtime.patch', [
      'const runtimesByFingerprint = new Map<string, SessionMcpRuntime>();',
      'const refsByFingerprint = new Map<string, Set<string>>();',
      'const fingerprintBySessionId = new Map<string, string>();',
      'shares MCP runtimes across sessions with identical MCP config fingerprints',
      'releases the old shared runtime when a session moves to a new MCP fingerprint',
    ]);
  });
});
