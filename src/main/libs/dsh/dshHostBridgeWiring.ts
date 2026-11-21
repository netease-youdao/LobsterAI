// Wires Electron Main's local callback bridge inside `DshHostManager` to:
// 1. Built-in `LobsterMemoryService` tools (`lobster_memory_search`,
//    `lobster_memory_get`, `lobster_memory_save`) and `LobsterScheduler`
//    (`lobster_schedule`)
// 2. Pluggable native host tool providers (Office, In-App Browser, Credentials,
//    Computer Use, Media Generation, Decision)
// 3. `tools/pre-execute` approval policy evaluation combining `commandSafety.ts`,
//    session `executionMode`, and persistent `allow-always` rules.

import {
  DeliveryMode,
  PayloadKind,
  ScheduleKind,
  SessionTarget,
  WakeMode,
} from '../../../scheduledTask/constants';
import type { Schedule, ScheduledTask, ScheduledTaskInput } from '../../../scheduledTask/types';
import { DSH_SKILL_INSTALL_TOOL, DshPermissionPreset, DshSkillInstallAction } from '../../../shared/dshEngine/hostConstants';
import { t } from '../../i18n';
import type { LobsterMemoryService } from '../../memory/lobsterMemoryService';
import type { LobsterScheduler } from '../../scheduledTask/lobsterScheduler';
import {
  detectDisallowedOfficeGuiLaunch,
  getCommandDangerLevel,
  isDangerousCommand,
} from '../commandSafety';
import type {
  DshBridgeApprovalDecision,
  DshBridgeApprovalEvaluateRequest,
  DshBridgeToolHandler,
  DshHostManager,
  DshHostToolDescriptor,
} from './dshHostManager';

export const BUILTIN_MEMORY_TOOL_NAMES = {
  Search: 'lobster_memory_search',
  Get: 'lobster_memory_get',
  Save: 'lobster_memory_save',
} as const;

export const BUILTIN_SCHEDULE_TOOL_NAME = 'lobster_schedule' as const;

export const LobsterScheduleAction = {
  List: 'list',
  Create: 'create',
  Update: 'update',
  Toggle: 'toggle',
  Delete: 'delete',
} as const;
export type LobsterScheduleAction = typeof LobsterScheduleAction[keyof typeof LobsterScheduleAction];

export type LobsterSchedulerBridgePort = Pick<
  LobsterScheduler,
  'listTasks' | 'getTask' | 'createTask' | 'updateTask' | 'toggleTask' | 'deleteTask'
>;

export interface ApprovalAllowRulePort {
  isToolAllowedAlways(params: {
    toolName: string;
    args: unknown;
    sessionId?: string;
    coworkSessionId?: string;
    agentId: string;
    scopeKey?: string;
  }): boolean;
}

export interface HostToolProvider {
  listDescriptors(): DshHostToolDescriptor[];
  execute(
    toolName: string,
    args: Record<string, unknown>,
    context: { sessionId?: string; agentId: string; coworkSessionId?: string; callId?: string; signal?: AbortSignal },
  ): Promise<unknown>;
}

const SHELL_TOOL_NAMES = new Set(['bash', 'pwsh', 'shell', 'exec', 'terminal_exec']);

export function extractShellCommandFromArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  if (typeof record.command === 'string') return record.command;
  if (typeof record.cmd === 'string') return record.cmd;
  if (typeof record.script === 'string') return record.script;
  return '';
}

export function buildApprovalScopeKey(
  toolName: string,
  args: unknown,
  dangerReason?: string,
): string {
  const normalizedTool = toolName.trim().toLowerCase() || 'tool';
  if (SHELL_TOOL_NAMES.has(normalizedTool)) {
    const resolvedReason = dangerReason
      || (() => {
        const command = extractShellCommandFromArgs(args);
        return command ? getCommandDangerLevel(command).reason : '';
      })();
    return resolvedReason ? `shell:${resolvedReason}` : 'shell:exec';
  }
  return `tool:${normalizedTool}`;
}

/**
 * Pure approval evaluator for DSH's `tools/pre-execute` waterfall.
 */
export function evaluateDshToolApproval(
  request: DshBridgeApprovalEvaluateRequest,
  allowRules?: ApprovalAllowRulePort,
): DshBridgeApprovalDecision {
  const toolName = request.toolName.trim();
  const isShellTool = SHELL_TOOL_NAMES.has(toolName.toLowerCase());
  const command = isShellTool ? extractShellCommandFromArgs(request.args) : '';
  if (toolName === DSH_SKILL_INSTALL_TOOL && (request.args as { action?: unknown } | null)?.action === DshSkillInstallAction.Install) {
    if (request.permissionPreset === DshPermissionPreset.ReadOnly) return { kind: 'deny', reason: t('skillChatReadOnly') };
    if (request.permissionPreset !== DshPermissionPreset.FullAccess) return { kind: 'ask', reason: t('skillChatInstallPermission') };
  }

  // Never allow shell commands to pop up desktop Office GUI applications
  // (WPS / Keynote / Pages / Microsoft Office / non-headless soffice) even under
  // full-access mode — redirect the model cleanly without disturbing the user.
  if (command) {
    const officeGuiBlock = detectDisallowedOfficeGuiLaunch(command);
    if (officeGuiBlock.matched) {
      return {
        kind: 'deny',
        reason: officeGuiBlock.reason ?? '禁止启动桌面办公软件进行预览或转换。',
      };
    }
  }

  // Explicit DSH `danger-full-access` preset sets DSH approvalPolicy='never' and
  // bypasses all interactive popups so the user is never interrupted repeatedly.
  if (request.permissionPreset === DshPermissionPreset.FullAccess) {
    return { kind: 'allow' };
  }

  const danger = command ? getCommandDangerLevel(command) : { level: 'safe' as const, reason: '' };
  const scopeKey = buildApprovalScopeKey(toolName, request.args, danger.reason);

  // High-severity destructive shell commands require explicit confirmation unless
  // the user explicitly switched the session/default mode to `danger-full-access`.
  if (command && danger.level === 'destructive') {
    return {
      kind: 'ask',
      reason: `Destructive command requires confirmation (${danger.reason}): ${command.slice(0, 160)}`,
    };
  }

  // Session-level or persisted allow rules short-circuit repeated caution prompts
  // (e.g. git-push or file-delete after clicking "Don't ask again in this session").
  if (
    allowRules?.isToolAllowedAlways({
      toolName,
      args: request.args,
      sessionId: request.sessionId,
      coworkSessionId: request.coworkSessionId,
      agentId: request.agentId,
      scopeKey,
    })
  ) {
    return { kind: 'allow' };
  }

  if (request.executionMode === 'auto') {
    return { kind: 'allow' };
  }

  if (command && isDangerousCommand(command)) {
    return {
      kind: 'ask',
      reason: `Potentially dangerous command requires confirmation (${danger.reason}): ${command.slice(0, 160)}`,
    };
  }

  return { kind: 'passthrough' };
}

function resolveDefaultScheduleTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function formatScheduleSummary(schedule: Schedule): string {
  if (schedule.kind === ScheduleKind.Cron) {
    return `cron "${schedule.expr}"${schedule.tz ? ` (${schedule.tz})` : ''}`;
  }
  if (schedule.kind === ScheduleKind.Every) {
    const minutes = Math.max(1, Math.round(schedule.everyMs / 60_000));
    return `every ${minutes}m`;
  }
  return `at ${schedule.at}`;
}

function formatScheduledTaskLine(task: ScheduledTask): string {
  const status = task.enabled ? '启用' : '暂停';
  const nextRun = task.state.nextRunAtMs
    ? new Date(task.state.nextRunAtMs).toISOString()
    : '无';
  const promptText = task.payload.kind === PayloadKind.AgentTurn
    ? task.payload.message
    : task.payload.text;
  const preview = promptText.replace(/\s+/g, ' ').trim().slice(0, 80);
  return `- [${task.id}] ${task.name}（${status}）| ${formatScheduleSummary(task.schedule)} | 下次执行: ${nextRun} | 指令: ${preview}`;
}

function parseScheduleFromArgs(
  args: Record<string, unknown>,
  existingSchedule?: Schedule,
): Schedule {
  const rawKind = typeof args.scheduleKind === 'string'
    ? args.scheduleKind.trim()
    : existingSchedule?.kind;

  if (rawKind === ScheduleKind.Cron) {
    const fallbackCron = existingSchedule?.kind === ScheduleKind.Cron ? existingSchedule : undefined;
    const expr = typeof args.cronExpr === 'string' && args.cronExpr.trim().length > 0
      ? args.cronExpr.trim()
      : (fallbackCron?.expr ?? '');
    if (!expr) {
      throw new Error('scheduleKind="cron" 时必须提供 5 段 cronExpr（如 "0 9 * * *"）');
    }
    const tz = typeof args.tz === 'string' && args.tz.trim().length > 0
      ? args.tz.trim()
      : (fallbackCron?.tz ?? resolveDefaultScheduleTimeZone());
    if (tz) {
      // Validate IANA timezone early so errors are clear.
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    }
    return {
      kind: ScheduleKind.Cron,
      expr,
      ...(tz ? { tz } : {}),
    };
  }

  if (rawKind === ScheduleKind.Every) {
    const fallbackMinutes = existingSchedule?.kind === ScheduleKind.Every
      ? existingSchedule.everyMs / 60_000
      : Number.NaN;
    const minutes = args.everyMinutes !== undefined
      ? (typeof args.everyMinutes === 'number' ? args.everyMinutes : Number(args.everyMinutes))
      : fallbackMinutes;
    if (!Number.isFinite(minutes) || minutes < 1) {
      throw new Error('scheduleKind="every" 时 everyMinutes 必须为不小于 1 的数字');
    }
    return {
      kind: ScheduleKind.Every,
      everyMs: Math.round(minutes * 60_000),
    };
  }

  if (rawKind === ScheduleKind.At) {
    const fallbackAt = existingSchedule?.kind === ScheduleKind.At ? existingSchedule.at : '';
    const at = typeof args.at === 'string' && args.at.trim().length > 0
      ? args.at.trim()
      : fallbackAt;
    const parsedMs = at ? Date.parse(at) : Number.NaN;
    if (!at || !Number.isFinite(parsedMs)) {
      throw new Error('scheduleKind="at" 时必须提供合法的 ISO 时间字符串（如 "2026-11-21T09:00:00+08:00"）');
    }
    if (parsedMs <= Date.now()) {
      throw new Error(`一次性定时时间 "${at}" 必须晚于当前时间`);
    }
    return {
      kind: ScheduleKind.At,
      at,
    };
  }

  throw new Error('scheduleKind 必须是 "cron"、"every" 或 "at"');
}

/**
 * Execute the built-in `lobster_schedule` host tool directly against
 * LobsterAI's SQLite-backed `LobsterScheduler`.
 */
export function executeLobsterScheduleTool(
  scheduler: LobsterSchedulerBridgePort,
  args: Record<string, unknown>,
  agentId: string,
): { ok: boolean; mutated: boolean; text: string; task?: ScheduledTask; tasks?: ScheduledTask[]; deletedId?: string } {
  const action = typeof args.action === 'string' ? args.action.trim() : '';

  switch (action) {
    case LobsterScheduleAction.List: {
      const tasks = scheduler.listTasks();
      if (tasks.length === 0) {
        return { ok: true, mutated: false, tasks: [], text: '当前没有定时任务。' };
      }
      return {
        ok: true,
        mutated: false,
        tasks,
        text: `共 ${tasks.length} 个定时任务：\n${tasks.map(formatScheduledTaskLine).join('\n')}`,
      };
    }

    case LobsterScheduleAction.Create: {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!name) throw new Error('创建定时任务时必须提供 name');
      if (!prompt) throw new Error('创建定时任务时必须提供 prompt');
      const schedule = parseScheduleFromArgs(args);
      const enabled = typeof args.enabled === 'boolean' ? args.enabled : true;
      const input: ScheduledTaskInput = {
        name,
        description: '',
        enabled,
        schedule,
        sessionTarget: SessionTarget.Isolated,
        wakeMode: WakeMode.Now,
        payload: {
          kind: PayloadKind.AgentTurn,
          message: prompt,
        },
        delivery: { mode: DeliveryMode.None },
        agentId: agentId || 'main',
      };
      const task = scheduler.createTask(input);
      return {
        ok: true,
        mutated: true,
        task,
        text: `已创建定时任务：\n${formatScheduledTaskLine(task)}`,
      };
    }

    case LobsterScheduleAction.Update: {
      const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
      if (!taskId) throw new Error('修改定时任务时必须提供 taskId');
      const existing = scheduler.getTask(taskId);
      if (!existing) throw new Error(`未找到 ID 为 "${taskId}" 的定时任务`);

      const patch: Partial<ScheduledTaskInput> = {};
      if (typeof args.name === 'string' && args.name.trim().length > 0) {
        patch.name = args.name.trim();
      }
      if (typeof args.prompt === 'string' && args.prompt.trim().length > 0) {
        patch.payload = { kind: PayloadKind.AgentTurn, message: args.prompt.trim() };
      }
      if (typeof args.enabled === 'boolean') {
        patch.enabled = args.enabled;
      }
      const hasScheduleChange = (
        typeof args.scheduleKind === 'string'
        || typeof args.cronExpr === 'string'
        || typeof args.tz === 'string'
        || args.everyMinutes !== undefined
        || typeof args.at === 'string'
      );
      if (hasScheduleChange) {
        patch.schedule = parseScheduleFromArgs(args, existing.schedule);
      }

      const updated = scheduler.updateTask(taskId, patch);
      if (!updated) throw new Error(`更新定时任务 "${taskId}" 失败`);
      return {
        ok: true,
        mutated: true,
        task: updated,
        text: `已更新定时任务：\n${formatScheduledTaskLine(updated)}`,
      };
    }

    case LobsterScheduleAction.Toggle: {
      const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
      if (!taskId) throw new Error('启停定时任务时必须提供 taskId');
      if (typeof args.enabled !== 'boolean') {
        throw new Error('启停定时任务时必须提供布尔值 enabled');
      }
      const updated = scheduler.toggleTask(taskId, args.enabled);
      if (!updated) throw new Error(`未找到 ID 为 "${taskId}" 的定时任务`);
      return {
        ok: true,
        mutated: true,
        task: updated,
        text: `已${args.enabled ? '启用' : '暂停'}定时任务：\n${formatScheduledTaskLine(updated)}`,
      };
    }

    case LobsterScheduleAction.Delete: {
      const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
      if (!taskId) throw new Error('删除定时任务时必须提供 taskId');
      const deleted = scheduler.deleteTask(taskId);
      if (!deleted) throw new Error(`未找到 ID 为 "${taskId}" 的定时任务`);
      return {
        ok: true,
        mutated: true,
        deletedId: taskId,
        text: `已删除定时任务 "${taskId}"。`,
      };
    }

    default:
      throw new Error(`不支持的定时任务操作 "${action}"，请使用 list / create / update / toggle / delete`);
  }
}

/**
 * Bind `LobsterMemoryService`, `LobsterScheduler`, native host tool providers,
 * and approval policy evaluation onto a `DshHostManager`.
 */
export function wireDshHostBridge(options: {
  hostManager: Pick<
    DshHostManager,
    'registerBridgeToolHandler' | 'setFallbackBridgeToolHandler' | 'setApprovalEvaluator' | 'syncHostTools'
  >;
  memoryService: LobsterMemoryService;
  scheduler?: LobsterSchedulerBridgePort;
  onScheduleMutated?: () => void;
  allowRules?: ApprovalAllowRulePort;
  toolProviders?: HostToolProvider[];
}): {
  syncDynamicHostTools: () => Promise<Record<string, unknown>>;
  dispose: () => void;
} {
  const { hostManager, memoryService, scheduler, onScheduleMutated, allowRules } = options;
  const providers = options.toolProviders ?? [];
  const disposers: Array<() => void> = [];

  // 1. Built-in Memory & Schedule tools backed by LobsterMemoryService and LobsterScheduler.
  const registerBuiltin = (name: string, handler: DshBridgeToolHandler) => {
    disposers.push(hostManager.registerBridgeToolHandler(name, handler));
  };

  registerBuiltin(BUILTIN_MEMORY_TOOL_NAMES.Search, (req) => {
    const query = typeof req.args.query === 'string' ? req.args.query : '';
    const limit = typeof req.args.limit === 'number' && req.args.limit > 0 ? req.args.limit : 8;
    const hits = memoryService.search(req.agentId, query, limit);
    return {
      query,
      hits,
      text: hits.length === 0
        ? `No memory matches found for "${query}".`
        : hits.map((h) => `[${h.relPath}:${h.lineStart}-${h.lineEnd}] ${h.snippet}`).join('\n\n'),
    };
  });

  registerBuiltin(BUILTIN_MEMORY_TOOL_NAMES.Get, (req) => {
    const relPath = typeof req.args.path === 'string' ? req.args.path : 'MEMORY.md';
    const startLine = typeof req.args.startLine === 'number' ? req.args.startLine : 1;
    const endLine = typeof req.args.endLine === 'number' ? req.args.endLine : undefined;
    const lineCount = endLine !== undefined && endLine >= startLine ? endLine - startLine + 1 : 80;
    const text = memoryService.readMemorySnippet(req.agentId, relPath, startLine, lineCount) ?? '';
    return { path: relPath, text };
  });

  registerBuiltin(BUILTIN_MEMORY_TOOL_NAMES.Save, (req) => {
    const content = typeof req.args.content === 'string' ? req.args.content.trim() : '';
    if (!content) {
      throw new Error('Memory content cannot be empty');
    }
    const target = req.args.target === 'daily' ? 'daily' : 'memory';
    if (target === 'daily') {
      const dateStr = typeof req.args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.args.date)
        ? req.args.date
        : undefined;
      const dateObj = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
      const savedPath = memoryService.appendDailyNote(req.agentId, content, dateObj);
      return { ok: true, target: 'daily', path: savedPath, text: `Saved daily note to ${savedPath}` };
    }
    const entry = memoryService.addMemory(req.agentId, content);
    return { ok: true, target: 'memory', entry, text: `Saved memory entry (${entry.id})` };
  });

  registerBuiltin(BUILTIN_SCHEDULE_TOOL_NAME, (req) => {
    if (!scheduler) {
      throw new Error('当前环境未启用 LobsterScheduler 定时任务服务');
    }
    const result = executeLobsterScheduleTool(scheduler, req.args, req.agentId);
    if (result.mutated) {
      onScheduleMutated?.();
    }
    return result;
  });

  // 2. Dynamic native host tool providers (Office, Browser, Credentials, CUA, Media, Decision).
  const providerByToolName = new Map<string, HostToolProvider>();
  const collectDescriptors = (): DshHostToolDescriptor[] => {
    providerByToolName.clear();
    const descriptors: DshHostToolDescriptor[] = [];
    for (const provider of providers) {
      for (const desc of provider.listDescriptors()) {
        if (!desc.name || providerByToolName.has(desc.name)) continue;
        providerByToolName.set(desc.name, provider);
        descriptors.push(desc);
      }
    }
    return descriptors;
  };

  collectDescriptors();

  hostManager.setFallbackBridgeToolHandler(async (req) => {
    const provider = providerByToolName.get(req.toolName);
    if (!provider) {
      throw new Error(`No native host tool provider registered for "${req.toolName}"`);
    }
    return provider.execute(req.toolName, req.args, {
      sessionId: req.sessionId,
      agentId: req.agentId,
      coworkSessionId: req.coworkSessionId,
      callId: req.callId,
      ...(req.signal ? { signal: req.signal } : {}),
    });
  });

  // 3. Tool pre-execute approval policy evaluator.
  hostManager.setApprovalEvaluator((req) => evaluateDshToolApproval(req, allowRules));

  return {
    syncDynamicHostTools: () => hostManager.syncHostTools(collectDescriptors()),
    dispose: () => {
      for (const d of disposers) d();
      hostManager.setFallbackBridgeToolHandler(null);
      hostManager.setApprovalEvaluator(null);
    },
  };
}
