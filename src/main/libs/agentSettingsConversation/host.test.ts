import { describe, expect, test, vi } from 'vitest';

import type { RemoteAgentSettingsProtocol } from '../../remote/remoteAgentSettingsProtocol';
import type { AgentSettingsService } from '../agentSettings/service';
import type { AgentSettingsContext, AgentSettingsProposal } from '../agentSettings/types';
import { AgentSettingsConversationHost } from './host';
import type { AgentSettingsRuntimeBridge } from './runtime';

function fixture() {
  const source = { agentId: 'main', sessionKey: 'agent:main:lobsterai:session', runId: 'gateway-run', toolCallId: 'tool', localSessionId: 'session', commandId: 'command', remoteRunId: 'remote-run', owner: { userId: 'user', scopeKey: 'scope' } };
  const context = { ...source, runId: source.remoteRunId, deviceId: 'desktop', dataSpaceId: 'space', dataGeneration: '1', accountEpoch: '1', source: 'conversation', bindingId: 'binding', bindingVersion: '1' } as unknown as AgentSettingsContext;
  const protocol = { accessForConversation: vi.fn(async () => ({ context })), prepareConversation: vi.fn(async () => ({})), acquirePermit: vi.fn(async () => ({ permitId: 'permit', startBefore: Date.now() + 5000 })), complete: vi.fn(async () => {}) };
  const runtime = { source: vi.fn(() => source), assertSource: vi.fn(), approve: vi.fn(async () => 'approval'), forget: vi.fn() };
  let host: AgentSettingsConversationHost;
  let proposal: AgentSettingsProposal;
  const service = { read: vi.fn(async () => ({ revision: 'revision', value: { text: 'before' } })),
    prepare: vi.fn(async (ctx: AgentSettingsContext, input: AgentSettingsProposal) => { proposal = input; await host.authorize(ctx, input, 'digest'); return { status: 'prepared', proposedDigest: 'digest' }; }),
    apply: vi.fn(async (_ctx: unknown, operationId: string, permit: () => Promise<unknown>) => { await permit(); return { operationId, section: 'memory', status: 'applied', revision: 'next' }; }),
    cancelPrepared: vi.fn(async () => ({ operationId: proposal.operationId, section: 'memory', status: 'rejected' })) };
  host = new AgentSettingsConversationHost({ service: service as unknown as AgentSettingsService, protocol: () => protocol as unknown as RemoteAgentSettingsProtocol, runtime: () => runtime as unknown as AgentSettingsRuntimeBridge });
  const request = { context: source, args: { action: 'update', section: 'memory', expectedRevision: 'revision', text: 'before plus', changeKind: 'append' } };
  return { host, service, protocol, runtime, request };
}

describe('settings conversation host failure boundaries', () => {
  test('a lost prepare response cancels only the locally prepared intent and never asks for a permit', async () => {
    const f = fixture(); f.protocol.prepareConversation.mockRejectedValue(new Error('SETTINGS_UNAVAILABLE'));
    const reply = await f.host.handle(f.request, new AbortController().signal);
    expect(f.service.cancelPrepared).toHaveBeenCalledOnce(); expect(f.protocol.acquirePermit).not.toHaveBeenCalled();
    expect(JSON.stringify(reply)).toContain('rejected'); expect(JSON.stringify(reply)).not.toContain('saved');
  });
  test('a lost result response never claims that the confirmed durable write did not happen', async () => {
    const f = fixture(); f.protocol.complete.mockRejectedValue(new Error('SETTINGS_UNAVAILABLE'));
    f.service.cancelPrepared.mockImplementation(async () => ({ operationId: 'op', section: 'memory', status: 'applied' }));
    const reply = await f.host.handle(f.request, new AbortController().signal);
    expect(JSON.stringify(reply)).toContain('applied'); expect(JSON.stringify(reply)).not.toContain('saved');
    await f.host.handle(f.request, new AbortController().signal);
    expect(f.service.apply).toHaveBeenCalledOnce();
  });
  test('a reused tool call with different content cannot execute a second change', async () => {
    const f = fixture(); await f.host.handle(f.request, new AbortController().signal);
    const reply = await f.host.handle({ ...f.request, args: { ...f.request.args, text: 'different' } }, new AbortController().signal);
    expect(JSON.stringify(reply)).toContain('SETTINGS_OPERATION_ID_CONFLICT'); expect(f.service.apply).toHaveBeenCalledOnce();
  });
  test('waits briefly for an approved control fact using the original operation and safe API reason', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.protocol.prepareConversation.mockRejectedValueOnce(Object.assign(new Error('Please refresh'), { data: { reason: 'SETTINGS_APPROVAL_REQUIRED' } }));
      const work = f.host.handle(f.request, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(201); await work;
      expect(f.protocol.prepareConversation).toHaveBeenCalledTimes(2);
      expect(f.protocol.prepareConversation.mock.calls[0]).toEqual(f.protocol.prepareConversation.mock.calls[1]);
      expect(f.runtime.approve).toHaveBeenCalledOnce(); expect(f.service.apply).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  test('waits for the trusted run fact before reading without creating a write operation', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.protocol.accessForConversation.mockRejectedValueOnce(Object.assign(new Error('Please refresh'), { data: { reason: 'CONVERSATION_SOURCE_INVALID' } }));
      const work = f.host.handle({ ...f.request, args: { action: 'read', section: 'memory' } }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(201); await work;
      expect(f.protocol.accessForConversation).toHaveBeenCalledTimes(2); expect(f.service.read).toHaveBeenCalledOnce();
      expect(f.service.prepare).not.toHaveBeenCalled(); expect(f.protocol.acquirePermit).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

});
