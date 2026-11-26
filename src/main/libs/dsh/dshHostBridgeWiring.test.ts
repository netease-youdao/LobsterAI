import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PayloadKind } from '../../../scheduledTask/constants';
import { DECISION_EVALUATE_TOOL_NAME, DecisionModelProvider } from '../../../shared/decisionModel/constants';
import { DSH_SKILL_INSTALL_TOOL, DshPermissionPreset, DshSkillInstallAction } from '../../../shared/dshEngine/hostConstants';
import { LobsterMemoryService, WorkspaceFileName } from '../../memory/lobsterMemoryService';
import { MemoryScope } from '../../memory/projectMemoryScope';
import { LobsterScheduler } from '../../scheduledTask/lobsterScheduler';
import { detectDisallowedOfficeGuiLaunch } from '../commandSafety';
import { type DecisionModelConfig, DEFAULT_DECISION_MODEL_CONFIG } from '../decisionModelConfig';
import { createDshDecisionToolProvider } from './dshDecisionTool';
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
  DshHostToolDescriptor,
} from './dshHostManager';

const cleanupPaths: string[] = [];
const openServices: LobsterMemoryService[] = [];
const openDbs: Database.Database[] = [];

test('skill installation respects the desktop permission preset, allow-session rules, and read-only inspect', () => {
  const req = { toolName: DSH_SKILL_INSTALL_TOOL, args: { action: DshSkillInstallAction.Install }, agentId: 'main' };
  const allowSkillRule = {
    isToolAllowedAlways: (p: { scopeKey?: string }) => p.scopeKey === `tool:${DSH_SKILL_INSTALL_TOOL}`,
  };
  expect(evaluateDshToolApproval({ ...req, permissionPreset: DshPermissionPreset.ReadOnly }).kind).toBe('deny');
  // ReadOnly strictly denies skill installs even if an allow-session rule exists.
  expect(evaluateDshToolApproval({ ...req, permissionPreset: DshPermissionPreset.ReadOnly }, allowSkillRule).kind).toBe('deny');
  expect(evaluateDshToolApproval({ ...req, permissionPreset: DshPermissionPreset.WorkspaceWrite }).kind).toBe('ask');
  // "Allow for this session" short-circuits repeated skill install prompts under WorkspaceWrite.
  expect(evaluateDshToolApproval({ ...req, permissionPreset: DshPermissionPreset.WorkspaceWrite }, allowSkillRule).kind).toBe('allow');
  expect(evaluateDshToolApproval({ ...req, permissionPreset: DshPermissionPreset.FullAccess }).kind).toBe('allow');
  expect(evaluateDshToolApproval({
    ...req, args: { action: DshSkillInstallAction.Inspect }, permissionPreset: DshPermissionPreset.ReadOnly,
  }).kind).toBe('passthrough');
});

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

  test('never bypasses caution approvals or sandbox checks based on stale legacy executionMode=auto', () => {
    // Safe commands pass through to DSH's own sandbox/approval pipeline rather than short-circuiting.
    expect(
      evaluateDshToolApproval({
        toolName: 'bash',
        args: { command: 'ls -la' },
        agentId: 'main',
        executionMode: 'auto',
        permissionPreset: DshPermissionPreset.WorkspaceWrite,
      }),
    ).toEqual({ kind: 'passthrough' });

    // Caution commands MUST still prompt under workspace-write and read-only even when legacy executionMode is 'auto'.
    for (const preset of [DshPermissionPreset.WorkspaceWrite, DshPermissionPreset.ReadOnly]) {
      expect(
        evaluateDshToolApproval({
          toolName: 'bash',
          args: { command: 'rm /tmp/demo.txt' },
          agentId: 'main',
          executionMode: 'auto',
          permissionPreset: preset,
        }).kind,
      ).toBe('ask');

      expect(
        evaluateDshToolApproval({
          toolName: 'bash',
          args: { command: 'git push origin main' },
          agentId: 'main',
          executionMode: 'auto',
          permissionPreset: preset,
        }).kind,
      ).toBe('ask');
    }

    // Explicit allow-always rule still allows covered tools.
    expect(
      evaluateDshToolApproval(
        {
          toolName: 'edit',
          args: { path: 'a.ts' },
          agentId: 'main',
          executionMode: 'local',
          permissionPreset: DshPermissionPreset.WorkspaceWrite,
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

    // Create a cron task: binds trusted session workspaceDir and ignores model-supplied workingDirectory.
    const created = await schedHandler({
      toolName: BUILTIN_SCHEDULE_TOOL_NAME,
      args: {
        action: LobsterScheduleAction.Create,
        name: '每日早报',
        prompt: '汇总今日科技新闻',
        scheduleKind: 'cron',
        cronExpr: '0 9 * * *',
        tz: 'Asia/Shanghai',
        workingDirectory: path.join(workspacesDir, 'ignored-model-argument'),
      },
      agentId: 'main',
      workspaceDir: `  ${workspacesDir}  `,
    }) as { ok: boolean; task: { id: string; name: string; enabled: boolean }; text: string };
    expect(created.ok).toBe(true);
    expect(created.task.name).toBe('每日早报');
    expect(created.task.enabled).toBe(true);
    expect(created.text).toContain(workspacesDir);
    expect(scheduler.getTask(created.task.id)?.payload).toEqual({
      kind: PayloadKind.AgentTurn,
      message: '汇总今日科技新闻',
      workingDirectory: workspacesDir,
    });
    expect(onScheduleMutated).toHaveBeenCalledTimes(1);

    // Simulate UI setting model + timeoutSeconds on the task, then updating prompt from another workspace.
    scheduler.updateTask(created.task.id, {
      payload: {
        kind: PayloadKind.AgentTurn,
        message: '汇总今日科技新闻',
        model: 'lobsterai-server/deepseek-flash',
        timeoutSeconds: 180,
      },
    });
    expect(scheduler.getTask(created.task.id)?.payload).toEqual({
      kind: PayloadKind.AgentTurn,
      message: '汇总今日科技新闻',
      model: 'lobsterai-server/deepseek-flash',
      timeoutSeconds: 180,
      workingDirectory: workspacesDir,
    });

    // Replacing prompt + timezone from another workspace retains workingDirectory, model, and timeoutSeconds.
    const updated = await schedHandler({
      toolName: BUILTIN_SCHEDULE_TOOL_NAME,
      args: {
        action: LobsterScheduleAction.Update,
        taskId: created.task.id,
        prompt: '汇总今日科技新闻并附上出处',
        tz: 'UTC',
      },
      agentId: 'main',
      workspaceDir: path.join(workspacesDir, 'other-workspace'),
    }) as { ok: boolean; task: { schedule: { kind: string; expr: string; tz?: string } } };
    expect(updated.task.schedule).toEqual({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' });
    expect(scheduler.getTask(created.task.id)?.payload).toEqual({
      kind: PayloadKind.AgentTurn,
      message: '汇总今日科技新闻并附上出处',
      model: 'lobsterai-server/deepseek-flash',
      timeoutSeconds: 180,
      workingDirectory: workspacesDir,
    });
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

  test('enforces project scope, global preference sharing, expert isolation, and memoryEnabled toggle in memory tools', async () => {
    const workspacesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-bridge-scope-'));
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-bridge-proj-a-'));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-bridge-proj-b-'));
    cleanupPaths.push(workspacesDir, projA, projB);

    const memoryService = new LobsterMemoryService(workspacesDir);
    openServices.push(memoryService);

    let memoryFlag = true;
    const handlers = new Map<string, DshBridgeToolHandler>();
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
      isMemoryEnabled: () => memoryFlag,
    });

    const save = handlers.get(BUILTIN_MEMORY_TOOL_NAMES.Save)!;
    const search = handlers.get(BUILTIN_MEMORY_TOOL_NAMES.Search)!;
    const get = handlers.get(BUILTIN_MEMORY_TOOL_NAMES.Get)!;

    // Main saves global preference + main-only Project A entry.
    await save({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Save,
      args: { content: 'Global pref: always answer with concise bullets', scope: MemoryScope.Global },
      agentId: 'main',
      workspaceDir: projA,
    });
    await save({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Save,
      args: { content: 'Main Project A secret flag', scope: MemoryScope.Project },
      agentId: 'main',
      workspaceDir: projA,
    });

    // Expert A saves a project-scoped memory in Project A and a private global memory.
    const savedProjA = await save({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Save,
      args: { content: 'Project A test command is pnpm test:alpha', scope: MemoryScope.Project },
      agentId: 'expert-a',
      workspaceDir: projA,
    }) as { ok: boolean; scope: string; projectKey?: string };
    expect(savedProjA.ok).toBe(true);
    expect(savedProjA.scope).toBe(MemoryScope.Project);
    expect(savedProjA.projectKey).toMatch(/^path:/);

    await save({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Save,
      args: { content: 'Expert A private codename FALCON', scope: MemoryScope.Global },
      agentId: 'expert-a',
      workspaceDir: projA,
    });

    // Raw file on disk carries the <!-- project: ... --> tag.
    const rawExpertA = memoryService.readWorkspaceFile('expert-a', WorkspaceFileName.Memory);
    expect(rawExpertA).toContain('<!-- project:');

    // Expert A in Project A recalls Project A convention + global pref + FALCON.
    const searchAInA = await search({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Search,
      args: { query: 'pnpm test:alpha' },
      agentId: 'expert-a',
      workspaceDir: projA,
    }) as { hits: unknown[]; text: string };
    expect(searchAInA.hits).toHaveLength(1);
    expect(searchAInA.text).not.toContain('<!-- project:');

    // Expert A in Project B does NOT see Project A convention, but DOES see global pref & FALCON.
    const searchAInB = await search({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Search,
      args: { query: 'pnpm test:alpha' },
      agentId: 'expert-a',
      workspaceDir: projB,
    }) as { hits: unknown[] };
    expect(searchAInB.hits).toHaveLength(0);

    const searchGlobalFromExpA = await search({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Search,
      args: { query: 'concise bullets' },
      agentId: 'expert-a',
      workspaceDir: projB,
    }) as { hits: unknown[]; text: string };
    expect(searchGlobalFromExpA.hits).toHaveLength(1);
    expect(searchGlobalFromExpA.text).toContain('[global/MEMORY.md:');

    // Expert A can read global/MEMORY.md (global entries only, never main's Project A secret).
    const globalGet = await get({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Get,
      args: { path: 'global/MEMORY.md' },
      agentId: 'expert-a',
      workspaceDir: projB,
    }) as { text: string };
    expect(globalGet.text).toContain('concise bullets');
    expect(globalGet.text).not.toContain('Main Project A secret flag');

    // Expert A reading own MEMORY.md in Project B does NOT leak Project A convention.
    const ownGetInB = await get({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Get,
      args: { path: 'MEMORY.md' },
      agentId: 'expert-a',
      workspaceDir: projB,
    }) as { text: string };
    expect(ownGetInB.text).toContain('FALCON');
    expect(ownGetInB.text).not.toContain('pnpm test:alpha');

    // Expert B sees global pref, NEVER Expert A's FALCON.
    const searchExpBFalcon = await search({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Search,
      args: { query: 'FALCON' },
      agentId: 'expert-b',
      workspaceDir: projA,
    }) as { hits: unknown[] };
    expect(searchExpBFalcon.hits).toHaveLength(0);

    // Disabling memoryEnabled disables search, get, and save without mutating disk.
    memoryFlag = false;
    const disabledSearch = await search({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Search,
      args: { query: 'FALCON' },
      agentId: 'expert-a',
      workspaceDir: projA,
    }) as { hits: unknown[]; disabled?: boolean };
    expect(disabledSearch.disabled).toBe(true);
    expect(disabledSearch.hits).toHaveLength(0);

    const disabledSave = await save({
      toolName: BUILTIN_MEMORY_TOOL_NAMES.Save,
      args: { content: 'Should not be persisted when disabled' },
      agentId: 'expert-a',
      workspaceDir: projA,
    }) as { ok: boolean; disabled?: boolean };
    expect(disabledSave.ok).toBe(false);
    expect(disabledSave.disabled).toBe(true);
    expect(memoryService.readWorkspaceFile('expert-a', WorkspaceFileName.Memory)).not.toContain(
      'Should not be persisted when disabled',
    );

    wired.dispose();
  });

  test('hot-syncs conditional decision_evaluate provider on enable and disable without restart', async () => {
    const workspacesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-bridge-decision-'));
    cleanupPaths.push(workspacesDir);
    const memoryService = new LobsterMemoryService(workspacesDir);
    openServices.push(memoryService);

    let config: DecisionModelConfig = { ...DEFAULT_DECISION_MODEL_CONFIG };
    let fallback: DshBridgeToolHandler | null = null;
    const syncedToolLists: DshHostToolDescriptor[][] = [];

    const wired = wireDshHostBridge({
      hostManager: {
        registerBridgeToolHandler: () => () => undefined,
        setFallbackBridgeToolHandler: (fn) => {
          fallback = fn;
        },
        setApprovalEvaluator: () => undefined,
        syncHostTools: async (tools) => {
          syncedToolLists.push(tools);
          return { dynamicTools: tools.map(t => t.name) };
        },
      },
      memoryService,
      toolProviders: [
        createDshDecisionToolProvider({
          getConfig: () => config,
          fetch: async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              model: 'jev-test',
              answers: { q1: { type: 'noul', noul: 0.92 } },
            }),
          }),
        }),
      ],
    });

    // 1. Disabled: syncDynamicHostTools registers nothing and fallback rejects decision_evaluate.
    await wired.syncDynamicHostTools();
    expect(syncedToolLists[0]).toEqual([]);
    await expect(
      fallback!({ toolName: DECISION_EVALUATE_TOOL_NAME, args: {}, agentId: 'main' }),
    ).rejects.toThrow(/No native host tool provider registered/);

    // 2. Enabled: syncDynamicHostTools registers decision_evaluate and fallback dispatches it.
    config = {
      enabled: true,
      provider: DecisionModelProvider.Compatible,
      endpoint: 'http://127.0.0.1:41999/v1/systemone',
      apiKey: 'secret-key',
      apiKeys: { [DecisionModelProvider.Compatible]: 'secret-key' },
    };
    await wired.syncDynamicHostTools();
    expect(syncedToolLists[1].map(t => t.name)).toEqual([DECISION_EVALUATE_TOOL_NAME]);

    const evalRes = await fallback!({
      toolName: DECISION_EVALUATE_TOOL_NAME,
      args: {
        state: 'Hot-sync test',
        questions: [{ id: 'q1', type: 'boolean', instructions: 'Active?' }],
      },
      agentId: 'main',
      coworkSessionId: 'cw-1',
      callId: 'call-1',
    }) as { content: Array<{ text: string }> };
    expect(JSON.parse(evalRes.content[0].text)).toMatchObject({
      status: 'ok',
      answers: { q1: { type: 'boolean', probability: 0.92 } },
    });

    // 3. Disabled again: syncDynamicHostTools removes decision_evaluate from descriptors & routing map.
    config = { ...config, enabled: false };
    await wired.syncDynamicHostTools();
    expect(syncedToolLists[2]).toEqual([]);
    await expect(
      fallback!({ toolName: DECISION_EVALUATE_TOOL_NAME, args: {}, agentId: 'main' }),
    ).rejects.toThrow(/No native host tool provider registered/);

    wired.dispose();
  });
});
