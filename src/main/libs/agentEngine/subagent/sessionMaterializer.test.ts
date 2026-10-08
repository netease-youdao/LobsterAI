import { describe, expect, test, vi } from 'vitest';

import { SubagentSessionMaterializer } from './sessionMaterializer';

const createMaterializer = (overrides: Partial<ConstructorParameters<typeof SubagentSessionMaterializer>[0]> = {}) => {
  const store = {
    getAgent: vi.fn((agentId: string) => (agentId === 'product-analyst' ? { name: 'Product Analyst' } : null)),
    getSession: vi.fn((sessionId: string) => (
      sessionId === 'parent-main' ? { id: sessionId, agentId: 'main', status: 'running' } : null
    )),
    updateSession: vi.fn(),
    upsertSubagentChildSession: vi.fn((options: Record<string, unknown>) => ({
      id: options.id,
      agentId: options.agentId,
    })),
  };
  const deps = {
    store,
    rememberSessionKey: vi.fn(),
    markSessionHistoryUnsynced: vi.fn(),
    notifySessionsChanged: vi.fn(),
    emitSessionStatus: vi.fn(),
    emitComplete: vi.fn(),
    emitError: vi.fn(),
    resolveSessionIdBySessionKey: vi.fn(() => null),
    syncSessionHistory: vi.fn(async () => undefined),
    ...overrides,
  };
  return {
    deps,
    store,
    materializer: new SubagentSessionMaterializer(deps),
  };
};

describe('SubagentSessionMaterializer', () => {
  test.each(['subagent', 'dashboard'])('does not materialize self-target %s sessions', (kind) => {
    const { materializer } = createMaterializer();

    expect(materializer.shouldMaterialize({
      runId: 'call-self',
      parentSessionId: 'parent-main',
      childSessionKey: `agent:main:${kind}:self-1`,
      agentId: 'main',
      task: 'write essay',
      label: 'essay-writer-1',
      status: 'running',
      createdAt: 1,
    })).toBe(false);
  });

  test.each(['subagent', 'dashboard'])('preserves cross-agent %s delegation', (kind) => {
    const { materializer } = createMaterializer();
    expect(materializer.shouldMaterialize({
      runId: 'cross-agent', parentSessionId: 'parent-main',
      childSessionKey: `agent:writer:${kind}:child`, agentId: 'writer',
      task: 'review', label: null, status: 'running', createdAt: 1,
    })).toBe(true);
  });

  test.each([
    ['writer', false],
    ['main', true],
    ['reviewer', true],
  ] as const)('resolves a writer parent delegating to %s', (agentId, expected) => {
    const { materializer, store } = createMaterializer();
    store.getSession.mockReturnValue({ id: 'parent-writer', agentId: 'writer', status: 'running' });
    expect(materializer.shouldMaterialize({
      runId: 'delegate', parentSessionId: 'parent-writer',
      childSessionKey: `agent:${agentId}:dashboard:child`, agentId,
      task: 'review', label: null, status: 'running', createdAt: 1,
    })).toBe(expected);
  });

  test('materializes delegated subagent sessions and starts history sync', async () => {
    const { deps, store, materializer } = createMaterializer();

    materializer.materialize({
      runId: 'call-product',
      childCoworkSessionId: 'child-1',
      parentSessionId: 'parent-main',
      childSessionKey: 'agent:product-analyst:subagent:child-1',
      agentId: 'product-analyst',
      task: 'analyze product',
      label: 'analysis',
      status: 'running',
      createdAt: 1,
    });

    expect(store.upsertSubagentChildSession).toHaveBeenCalledWith(expect.objectContaining({
      id: 'child-1',
      parentSessionId: 'parent-main',
      childSessionKey: 'agent:product-analyst:subagent:child-1',
      agentId: 'product-analyst',
      title: 'analysis',
      task: 'analyze product',
      status: 'running',
      createdAt: 1,
    }));
    expect(deps.rememberSessionKey).toHaveBeenCalledWith('child-1', 'agent:product-analyst:subagent:child-1');
    expect(deps.markSessionHistoryUnsynced).toHaveBeenCalledWith('child-1');
    expect(deps.notifySessionsChanged).toHaveBeenCalledWith('child-1');
    await Promise.resolve();
    expect(deps.syncSessionHistory).toHaveBeenCalledWith('child-1', 'agent:product-analyst:subagent:child-1');
  });

  test('finalizes passive subagent sessions by local session mapping', () => {
    const { deps, store, materializer } = createMaterializer({
      resolveSessionIdBySessionKey: vi.fn(() => 'child-1'),
    });

    materializer.finalizePassive('agent:product-analyst:subagent:child-1', 'done');

    expect(store.updateSession).toHaveBeenCalledWith('child-1', { status: 'completed' });
    expect(deps.emitSessionStatus).toHaveBeenCalledWith('child-1', 'completed');
    expect(deps.emitComplete).toHaveBeenCalledWith('child-1', 'agent:product-analyst:subagent:child-1');
    expect(deps.notifySessionsChanged).toHaveBeenCalledWith('child-1');
  });
});
