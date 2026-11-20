// Wires Electron Main's local callback bridge inside `DshHostManager` to:
// 1. Built-in `LobsterMemoryService` tools (`lobster_memory_search`,
//    `lobster_memory_get`, `lobster_memory_save`)
// 2. Pluggable native host tool providers (Office, In-App Browser, Credentials,
//    Computer Use, Media Generation, Decision)
// 3. `tools/pre-execute` approval policy evaluation combining `commandSafety.ts`,
//    session `executionMode`, and persistent `allow-always` rules.

import type { LobsterMemoryService } from '../../memory/lobsterMemoryService';
import { getCommandDangerLevel, isDangerousCommand } from '../commandSafety';
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

export interface ApprovalAllowRulePort {
  isToolAllowedAlways(params: {
    toolName: string;
    args: unknown;
    sessionId?: string;
    agentId: string;
  }): boolean;
}

export interface HostToolProvider {
  listDescriptors(): DshHostToolDescriptor[];
  execute(
    toolName: string,
    args: Record<string, unknown>,
    context: { sessionId?: string; agentId: string; coworkSessionId?: string; callId?: string },
  ): Promise<unknown>;
}

const SHELL_TOOL_NAMES = new Set(['bash', 'pwsh', 'shell', 'exec', 'terminal_exec']);

function extractShellCommand(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  if (typeof record.command === 'string') return record.command;
  if (typeof record.cmd === 'string') return record.cmd;
  if (typeof record.script === 'string') return record.script;
  return '';
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
  const command = isShellTool ? extractShellCommand(request.args) : '';

  if (command) {
    const danger = getCommandDangerLevel(command);
    // High-severity destructive shell commands always require explicit confirmation
    // (never silently auto-approved, even under auto mode or allow-always).
    if (danger.level === 'destructive') {
      return {
        kind: 'ask',
        reason: `Destructive command requires confirmation (${danger.reason}): ${command.slice(0, 160)}`,
      };
    }
    if (isDangerousCommand(command) && request.executionMode !== 'auto') {
      return {
        kind: 'ask',
        reason: `Potentially dangerous command requires confirmation (${danger.reason}): ${command.slice(0, 160)}`,
      };
    }
  }

  // Persisted allow-always rules short-circuit DSH's interactive prompt.
  if (
    allowRules?.isToolAllowedAlways({
      toolName,
      args: request.args,
      sessionId: request.sessionId,
      agentId: request.agentId,
    })
  ) {
    return { kind: 'allow' };
  }

  // Auto execution mode approves non-destructive calls directly.
  if (request.executionMode === 'auto') {
    return { kind: 'allow' };
  }

  return { kind: 'passthrough' };
}

/**
 * Bind `LobsterMemoryService`, native host tool providers, and approval
 * policy evaluation onto a `DshHostManager`.
 */
export function wireDshHostBridge(options: {
  hostManager: Pick<
    DshHostManager,
    'registerBridgeToolHandler' | 'setFallbackBridgeToolHandler' | 'setApprovalEvaluator' | 'syncHostTools'
  >;
  memoryService: LobsterMemoryService;
  allowRules?: ApprovalAllowRulePort;
  toolProviders?: HostToolProvider[];
}): {
  syncDynamicHostTools: () => Promise<Record<string, unknown>>;
  dispose: () => void;
} {
  const { hostManager, memoryService, allowRules } = options;
  const providers = options.toolProviders ?? [];
  const disposers: Array<() => void> = [];

  // 1. Built-in Memory tools backed by LobsterMemoryService (Markdown + FTS5).
  const registerMemory = (name: string, handler: DshBridgeToolHandler) => {
    disposers.push(hostManager.registerBridgeToolHandler(name, handler));
  };

  registerMemory(BUILTIN_MEMORY_TOOL_NAMES.Search, (req) => {
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

  registerMemory(BUILTIN_MEMORY_TOOL_NAMES.Get, (req) => {
    const relPath = typeof req.args.path === 'string' ? req.args.path : 'MEMORY.md';
    const startLine = typeof req.args.startLine === 'number' ? req.args.startLine : 1;
    const endLine = typeof req.args.endLine === 'number' ? req.args.endLine : undefined;
    const lineCount = endLine !== undefined && endLine >= startLine ? endLine - startLine + 1 : 80;
    const text = memoryService.readMemorySnippet(req.agentId, relPath, startLine, lineCount) ?? '';
    return { path: relPath, text };
  });

  registerMemory(BUILTIN_MEMORY_TOOL_NAMES.Save, (req) => {
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
