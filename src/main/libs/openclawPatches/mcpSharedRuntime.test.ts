import { describe, test } from 'vitest';

import {
  expectCurrentOpenClawPatchMissing,
  expectOpenClawSourceContains,
  isOpenClawSourceAvailable,
} from './patchTestUtils';

describe('OpenClaw MCP runtime sharing patch decisions', () => {
  test('drops cross-session runtime sharing because requester credentials are isolated in v2026.8.1', () => {
    expectCurrentOpenClawPatchMissing('openclaw-mcp-shared-runtime.patch');
  });

  test.skipIf(!isOpenClawSourceAvailable())('uses native requester-scoped idle eviction', () => {
    expectOpenClawSourceContains([
      {
        file: 'src/agents/agent-bundle-mcp-runtime.ts',
        snippets: ['Resolved per-requester url/headers; never logged/persisted as credentials'],
      },
      {
        file: 'src/agents/agent-bundle-mcp-manager-lifecycle.ts',
        snippets: ['Evict LRU zero-lease requester runtimes', 'idle runtime sweep failed'],
      },
      {
        file: 'src/agents/agent-bundle-mcp-runtime.test.ts',
        snippets: ['evicts LRU idle requester runtimes past the per-session cap'],
      },
    ]);
  });
});
