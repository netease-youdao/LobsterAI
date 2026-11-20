import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DshPermissionPreset } from '../../../shared/dshEngine/hostConstants';
import { LobsterMemoryService } from '../../memory/lobsterMemoryService';
import { LobsterScheduler } from '../../scheduledTask/lobsterScheduler';
import { detectDisallowedOfficeGuiLaunch } from '../commandSafety';
import {
  buildApprovalScopeKey,
  BUILTIN_MEMORY_TOOL_NAMES,
  BUILTIN_SCHEDULE_TOOL_NAME,
  evaluateDshToolApproval,
  LobsterScheduleAction,
  wireDshHostBridge,
} from './dshHostBridgeWiring';
import type {
  DshBridgeApprovalEvaluator,
  DshBridgeToolHandler,
} from './dshHostManager';

const cleanupPaths: string[] = [];
const openServices: LobsterMemoryService[] = [];
const openDbs: Database.Database[] = [];

afterEach(() => {
  while (openServices.length > 0) openServices.pop()!.close();
  while (openDbs.length > 0) openDbs.pop()!.close();
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

  test('denies desktop Office GUI launch commands even under danger-full-access preset', () => {
    const blockedCommands = [
      'osascript -e \'tell application "Keynote" to open POSIX file "/tmp/deck.pptx"\'',
      'open -a /Applications/wpsoffice.app "/tmp/report.docx"',
      'open -a "Microsoft PowerPoint" deck.pptx',
      '/Applications/wpsoffice.app/Contents/MacOS/wpsoffice --headless --convert-to pdf a.docx',
      'soffice report.docx',
      'start "" WINWORD.EXE report.docx',
    ];
    for (const command of blockedCommands) {
      expect(detectDisallowedOfficeGuiLaunch(command).matched).toBe(true);
      const decision = evaluateDshToolApproval({
        toolName: 'bash',
        args: { command },
        agentId: 'main',
        permissionPreset: DshPermissionPreset.FullAccess,
      });
      expect(decision.kind).toBe('deny');
    }

    const allowedCommands = [
      'soffice --headless --convert-to pdf report.docx --outdir /tmp',
      'which soffice libreoffice pdftoppm',
      'node scripts/preview_html.js slides/ --out preview.jpg',
      'python3 build_doc.py',
      'ls /Applications',
    ];
    for (const command of allowedCommands) {
      expect(detectDisallowedOfficeGuiLaunch(command).matched).toBe(false);
      const decision = evaluateDshToolApproval({
        toolName: 'bash',
        args: { command },
        agentId: 'main',
        permissionPreset: DshPermissionPreset.FullAccess,
      });
      expect(decision.kind).toBe('allow');
    }
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

  test('executes lobster_schedule CRUD via LobsterScheduler and triggers onScheduleMutated', async () => {
    const workspacesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-bridge-sched-'));
    cleanupPaths.push(workspacesDir);
    const memoryService = new LobsterMemoryService(workspacesDir);
    openServices.push(memoryService);

    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    openDbs.push(db);
    const scheduler = new LobsterScheduler({ db });

    const handlers = new Map<string, DshBridgeToolHandler>();
    const onScheduleMutated = vi.fn();
    const wired = wireDshHostBridge({
      hostManager: {
        registerBridgeToolHandler: (name, fn) => {
          handlers.set(name, fn);
          return () => handlers.delete(name);
        },
        setFallbackBridgeToolHandler: () => undefined,
        setApprovalEvaluator: () => undefined,
        syncHostTools: async () => ({ ok: true }),
      },
      memoryService,
      scheduler,
      onScheduleMutated,
    });

    const schedHandler = handlers.get(BUILTIN_SCHEDULE_TOOL_NAME)!;
    expect(schedHandler).toBeDefined();

    // Empty list does not trigger mutation broadcast.
    const emptyList = await schedHandler({
      toolName: BUILTIN_SCHEDULE_TOOL_NAME,
      args: { action: LobsterScheduleAction.List },
      agentId: 'main',
    }) as { ok: boolean; tasks: unknown[]; text: string };
    expect(emptyList.ok).toBe(true);
    expect(emptyList.tasks).toHaveLength(0);
    expect(onScheduleMutated).toHaveBeenCalledTimes(0);

    // Create a cron task.
    const created = await schedHandler({
      toolName: BUILTIN_SCHEDULE_TOOL_NAME,
      args: {
        action: LobsterScheduleAction.Create,
        name: '每日早报',
        prompt: '汇总今日科技新闻',
        scheduleKind: 'cron',
        cronExpr: '0 9 * * *',
        tz: 'Asia/Shanghai',
      },
      agentId: 'main',
    }) as { ok: boolean; task: { id: string; name: string; enabled: boolean }; text: string };
    expect(created.ok).toBe(true);
    expect(created.task.name).toBe('每日早报');
    expect(created.task.enabled).toBe(true);
    expect(onScheduleMutated).toHaveBeenCalledTimes(1);

    // Update timezone only without repeating cronExpr.
    const updated = await schedHandler({
      toolName: BUILTIN_SCHEDULE_TOOL_NAME,
      args: {
        action: LobsterScheduleAction.Update,
        taskId: created.task.id,
        tz: 'UTC',
      },
      agentId: 'main',
    }) as { ok: boolean; task: { schedule: { kind: string; expr: string; tz?: string } } };
    expect(updated.task.schedule).toEqual({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' });
    expect(onScheduleMutated).toHaveBeenCalledTimes(2);

    // Toggle pause.
    const paused = await schedHandler({
      toolName: BUILTIN_SCHEDULE_TOOL_NAME,
      args: {
        action: LobsterScheduleAction.Toggle,
        taskId: created.task.id,
        enabled: false,
      },
      agentId: 'main',
    }) as { ok: boolean; task: { enabled: boolean } };
    expect(paused.task.enabled).toBe(false);
    expect(onScheduleMutated).toHaveBeenCalledTimes(3);

    // Create an every task and validate past one-shot `at` rejection.
    const everyRes = await schedHandler({
      toolName: BUILTIN_SCHEDULE_TOOL_NAME,
      args: {
        action: LobsterScheduleAction.Create,
        name: '巡检',
        prompt: '检查服务状态',
        scheduleKind: 'every',
        everyMinutes: 15,
      },
      agentId: 'main',
    }) as { ok: boolean; task: { id: string } };
    expect(everyRes.ok).toBe(true);
    expect(onScheduleMutated).toHaveBeenCalledTimes(4);

    expect(() => schedHandler({
      toolName: BUILTIN_SCHEDULE_TOOL_NAME,
      args: {
        action: LobsterScheduleAction.Create,
        name: '过期提醒',
        prompt: '测试',
        scheduleKind: 'at',
        at: '2020-01-01T00:00:00Z',
      },
      agentId: 'main',
    })).toThrow(/晚于当前时间/);

    // Delete both tasks.
    await schedHandler({
      toolName: BUILTIN_SCHEDULE_TOOL_NAME,
      args: { action: LobsterScheduleAction.Delete, taskId: created.task.id },
      agentId: 'main',
    });
    await schedHandler({
      toolName: BUILTIN_SCHEDULE_TOOL_NAME,
      args: { action: LobsterScheduleAction.Delete, taskId: everyRes.task.id },
      agentId: 'main',
    });
    expect(scheduler.listTasks()).toHaveLength(0);
    expect(onScheduleMutated).toHaveBeenCalledTimes(6);

    wired.dispose();
  });
});
