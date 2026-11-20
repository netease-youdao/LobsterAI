import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DshPermissionPreset } from '../../../shared/dshEngine/hostConstants';
import { LobsterMemoryService } from '../../memory/lobsterMemoryService';
import {
  buildApprovalScopeKey,
  BUILTIN_MEMORY_TOOL_NAMES,
  evaluateDshToolApproval,
  wireDshHostBridge,
} from './dshHostBridgeWiring';
import type {
  DshBridgeApprovalEvaluator,
  DshBridgeToolHandler,
} from './dshHostManager';

const cleanupPaths: string[] = [];
const openServices: LobsterMemoryService[] = [];

afterEach(() => {
  while (openServices.length > 0) openServices.pop()!.close();
  while (cleanupPaths.length > 0) fs.rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
});

describe('evaluateDshToolApproval', () => {
  test('always asks on destructive shell commands even in auto mode', () => {
    const decision = evaluateDshToolApproval({
      toolName: 'bash',
      args: { command: 'rm -rf /tmp/something' },
      agentId: 'main',
      executionMode: 'auto',
    });
    expect(decision.kind).toBe('ask');
  });

  test('allows safe commands in auto mode or when covered by allow-always rule', () => {
    expect(
      evaluateDshToolApproval({
        toolName: 'bash',
        args: { command: 'ls -la' },
        agentId: 'main',
        executionMode: 'auto',
      }),
    ).toEqual({ kind: 'allow' });

    expect(
      evaluateDshToolApproval(
        {
          toolName: 'edit',
          args: { path: 'a.ts' },
          agentId: 'main',
          executionMode: 'default',
        },
        { isToolAllowedAlways: () => true },
      ),
    ).toEqual({ kind: 'allow' });
  });

  test('bypasses all confirmation prompts under DSH danger-full-access preset', () => {
    expect(
      evaluateDshToolApproval({
        toolName: 'bash',
        args: { command: 'git push origin main' },
        agentId: 'main',
        permissionPreset: DshPermissionPreset.FullAccess,
      }),
    ).toEqual({ kind: 'allow' });

    expect(
      evaluateDshToolApproval({
        toolName: 'bash',
        args: { command: 'rm -rf /tmp/build' },
        agentId: 'main',
        permissionPreset: DshPermissionPreset.FullAccess,
      }),
    ).toEqual({ kind: 'allow' });
  });

  test('honors session allow-rule before moderate caution commands like git push', () => {
    const scopeKey = buildApprovalScopeKey('bash', { command: 'git push origin main' });
    expect(scopeKey).toBe('shell:git-push');

    expect(
      evaluateDshToolApproval(
        {
          toolName: 'bash',
          args: { command: 'git push origin main' },
          agentId: 'main',
          permissionPreset: DshPermissionPreset.WorkspaceWrite,
        },
        {
          isToolAllowedAlways: (p) => p.scopeKey === 'shell:git-push',
        },
      ),
    ).toEqual({ kind: 'allow' });
  });
});

describe('wireDshHostBridge', () => {
  test('executes built-in memory tools and dynamic provider tools through the bridge', async () => {
    const workspacesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-bridge-wire-'));
    cleanupPaths.push(workspacesDir);
    const memoryService = new LobsterMemoryService(workspacesDir);
    openServices.push(memoryService);

    const handlers = new Map<string, DshBridgeToolHandler>();
    let fallback: DshBridgeToolHandler | null = null;
    let evaluator: DshBridgeApprovalEvaluator | null = null;
    const syncHostTools = vi.fn(async () => ({ ok: true }));

    const wired = wireDshHostBridge({
      hostManager: {
        registerBridgeToolHandler: (name, fn) => {
          handlers.set(name, fn);
          return () => handlers.delete(name);
        },
        setFallbackBridgeToolHandler: (fn) => {
          fallback = fn;
        },
        setApprovalEvaluator: (fn) => {
          evaluator = fn;
        },
        syncHostTools,
      },
      memoryService,
      toolProviders: [
        {
          listDescriptors: () => [
            {
              name: 'lobster_office_edit',
              description: 'Edit Word document',
              inputSchema: { type: 'object', properties: { file: { type: 'string' } } },
            },
          ],
          execute: async (toolName, args) => ({ ran: toolName, file: args.file }),
        },
      ],
    });

    await wired.syncDynamicHostTools();
    expect(syncHostTools).toHaveBeenCalledTimes(1);

    // Save + search via built-in memory tool handlers.
    const saveRes = await handlers.get(BUILTIN_MEMORY_TOOL_NAMES.Save)!({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Save,
      args: { content: 'User prefers dark mode and concise diffs.' },
      agentId: 'main',
    });
    expect((saveRes as { ok: boolean }).ok).toBe(true);

    const searchRes = await handlers.get(BUILTIN_MEMORY_TOOL_NAMES.Search)!({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Search,
      args: { query: 'dark mode' },
      agentId: 'main',
    });
    expect((searchRes as { hits: unknown[] }).hits.length).toBeGreaterThan(0);

    // Dynamic provider dispatch via fallback handler.
    const dynRes = await fallback!({
      toolName: 'lobster_office_edit',
      args: { file: 'report.docx' },
      agentId: 'main',
    });
    expect(dynRes).toEqual({ ran: 'lobster_office_edit', file: 'report.docx' });
    expect(evaluator).not.toBeNull();

    wired.dispose();
  });
});
