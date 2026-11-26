import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test } from 'vitest';

const OPS_RPC_HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/ops-rpc-helpers.mjs'),
).href;
const PERSONA_HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/persona-helpers.mjs'),
).href;
const TOOL_DISCLOSURE_HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/tool-disclosure-helpers.mjs'),
).href;

describe('DSH host bundle side-chat helpers', () => {
  test('mergeBoundSessionContext preserves and updates sideChat boolean', async () => {
    const { mergeBoundSessionContext } = await import(OPS_RPC_HELPERS_URL);

    const enabled = mergeBoundSessionContext({}, { sideChat: true, agentId: 'main' });
    expect(enabled.context.sideChat).toBe(true);

    const preserved = mergeBoundSessionContext(enabled.context, { workspaceDir: '/tmp/work' });
    expect(preserved.context.sideChat).toBe(true);

    const promoted = mergeBoundSessionContext(preserved.context, { sideChat: false });
    expect(promoted.context.sideChat).toBe(false);
  });

  test('SIDE_CHAT_RUNTIME_CONTEXT_PROMPT instructs soft-read-only isolation', async () => {
    const { SIDE_CHAT_RUNTIME_CONTEXT_PROMPT } = await import(PERSONA_HELPERS_URL);

    expect(SIDE_CHAT_RUNTIME_CONTEXT_PROMPT).toContain('side conversation');
    expect(SIDE_CHAT_RUNTIME_CONTEXT_PROMPT).toContain('reference context');
    expect(SIDE_CHAT_RUNTIME_CONTEXT_PROMPT).toContain('Sub-agents');
    expect(SIDE_CHAT_RUNTIME_CONTEXT_PROMPT).toContain('non-mutating');
  });

  test('evaluateSideChatToolGuard blocks subagent, delegation, and schedule tools only in side chats', async () => {
    const { evaluateSideChatToolGuard, SIDE_CHAT_BLOCKED_TOOL_NAMES } = await import(
      TOOL_DISCLOSURE_HELPERS_URL
    );

    for (const toolName of SIDE_CHAT_BLOCKED_TOOL_NAMES) {
      expect(evaluateSideChatToolGuard(toolName, false)).toBeUndefined();
      const decision = evaluateSideChatToolGuard(toolName, true);
      expect(decision).toBeDefined();
      expect(decision?.info.code).toBe('SIDE_CHAT_TOOL_BLOCKED');
    }

    expect(evaluateSideChatToolGuard('read_file', true)).toBeUndefined();
    expect(evaluateSideChatToolGuard('grep', true)).toBeUndefined();
    expect(evaluateSideChatToolGuard('bash', true)).toBeUndefined();
  });
});
