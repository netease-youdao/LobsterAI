import { expect, test, vi } from 'vitest';

import { apply } from '../dsh-bundles/lobsterai-host/plugins/netease-mail-quota.mjs';
import { NeteaseMail, NeteaseMailError, NeteaseMailTool } from '../src/shared/neteaseMail/constants';

const read = `mcp__${NeteaseMail.RegistryId}__${NeteaseMailTool.ListMessages}`;
const send = NeteaseMailTool.SendMessage;
const quota = NeteaseMailError.RateLimited;

function fixture() {
  const on = vi.fn();
  const guard = vi.fn();
  const context = vi.fn();
  apply({ on, tools: { guard }, systemPrompt: { context, getContextOrder: vi.fn() }, effect: vi.fn() });
  const handler = (event: string) => on.mock.calls.find(([name]) => name === event)![1];
  return { observe: handler('tools/result'), claimed: handler('agent/inbox/claimed'),
    check: guard.mock.calls[0][0], prompt: context.mock.calls[0][0].text };
}

test.each([
  [read, { isError: true, error: { message: JSON.stringify({ error: { code: String(quota) } }) } }],
  [send, { isError: false, meta: { lobsterToolResult: { isError: true, details: { code: quota } } } }],
])('a real quota result from %s stops only mail calls until the user asks again', (name, result) => {
  const f = fixture();
  const agent = { session: {} };
  const otherAgent = { session: {} };
  f.observe({ agent, name }, result);
  for (const tool of [read, send]) {
    expect(JSON.parse(f.check({ agent, name: tool })).error.code).toBe(String(quota));
  }
  expect(f.prompt({ agent })).toContain('Tell the user');
  expect(f.check({ agent, name: 'unrelated' })).toBeUndefined();
  expect(f.check({ agent: otherAgent, name: read })).toBeUndefined();
  f.claimed({ agent, message: { source: { kind: 'runtime-context' } } });
  f.claimed({ agent: otherAgent, message: { source: { kind: 'user' } } });
  expect(f.check({ agent, name: read })).toBeDefined();
  f.claimed({ agent, message: { source: { kind: 'user' } } });
  expect(f.check({ agent, name: read })).toBeUndefined();
  expect(f.prompt({ agent })).toBe('');
});

test('mail content, unrelated providers, and other errors cannot stop a mail turn', () => {
  const f = fixture();
  const agent = { session: {} };
  const message = JSON.stringify({ error: { code: quota } });
  for (const [name, result] of [
    [read, { isError: false, content: [{ type: 'text', text: message }] }],
    [read, { isError: true, error: { message: 'diagnostic ' + message } }],
    [read, { isError: true, error: { message: JSON.stringify({ error: { code: NeteaseMailError.MessageNotFound } }) } }],
    ['another_mcp_tool', { isError: true, error: { message } }],
    [send, { meta: { lobsterToolResult: { isError: false, details: { code: quota } } } }],
  ]) {
    f.observe({ agent, name }, result);
    expect(f.check({ agent, name: read })).toBeUndefined();
  }
});
