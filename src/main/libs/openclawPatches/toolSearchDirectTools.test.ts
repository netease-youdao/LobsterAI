import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

describe('Tool Search patches (direct tools, slim tool_call envelope)', () => {
  test('accepts tools.toolSearch.direct in the strict config schema', () => {
    // LobsterAI writes this key; a runtime without it rejects the whole config.
    expectPatchContains('openclaw-tool-search-direct-tools.patch', [
      'direct: z.array(z.string()).optional(),',
      'direct?: string[];',
      '"tools.toolSearch.direct":',
    ]);
  });

  test('returns only the tool identity from structured tool_call results', () => {
    // Echoing the catalog entry on every deferred call ate 1–5k characters per call.
    expectPatchContains('openclaw-tool-call-slim-envelope.patch', [
      '{ tool: { id: callResult.tool.id, name: callResult.tool.name }, result: callResult.result },',
    ]);
  });

  test('pins configured names through the trusted direct-visibility gate', () => {
    expectPatchContains('openclaw-tool-search-direct-tools.patch', [
      '...readDirectToolNames(raw.direct),',
      'directToolNames: [...(toolSearchConfig.directToolNames ?? []), ...directToolNames],',
      'never promotes MCP tools through the direct list',
    ]);
  });
});
