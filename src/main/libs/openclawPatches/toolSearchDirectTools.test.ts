import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

describe('Tool Search patches (pinned tools, threshold, tool_call result projection)', () => {
  test('accepts tools.toolSearch.direct and minDeferredChars in the strict config schema', () => {
    // LobsterAI writes these keys; a runtime without them rejects the whole config.
    expectPatchContains('openclaw-tool-search-direct-tools.patch', [
      'direct: z.array(z.string()).optional(),',
      'minDeferredChars: z.number().int().nonnegative().optional(),',
      '"tools.toolSearch.direct":',
      '"tools.toolSearch.minDeferredChars":',
    ]);
  });

  test('pins named or server-prefixed tools, MCP included, only when the name is unique', () => {
    // LobsterAI pins its Office editor MCP servers by `server__*` prefix.
    expectPatchContains('openclaw-tool-search-direct-tools.patch', [
      'export function createOperatorPinnedToolMatcher(',
      'uniqueNames.has(tool.name) &&',
      'operatorDirectToolNames: toolSearchConfig.directToolNames,',
      'does not pin a duplicated name, so a lookalike cannot take its place',
      'keeps implicitly required names OpenClaw-only',
    ]);
  });

  test('skips compaction when the deferred remainder is below the threshold', () => {
    expectPatchContains('openclaw-tool-search-direct-tools.patch', [
      'if (params.minDeferredChars && deferredChars < params.minDeferredChars) {',
      'skips compaction when the deferred schemas fall below minDeferredChars',
    ]);
  });

  test('returns only the tool identity and native images from tool_call results', () => {
    // Echoing the catalog entry cost 1–5k characters per call, and serialized
    // screenshots reached the model as ~13k tokens of truncated base64 text.
    expectPatchContains('openclaw-tool-call-result-projection.patch', [
      '{ tool: { id: callResult.tool.id, name: callResult.tool.name }, result: textOnlyResult },',
      'function splitToolCallResultImages(result: AgentToolResult<unknown>)',
      'returns native image blocks from a deferred native tool ($name)',
    ]);
  });
});
