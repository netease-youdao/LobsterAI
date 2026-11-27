/**
 * @lobsterai/dsh-bundle — Progressive On-Demand Tool Disclosure Plugin
 *
 * Keeps initial LLM turns slim by gating LobsterAI's 5 heavy built-in MCP tool
 * groups (`computer-use`, `browser`, `word`, `excel`, `ppt` — ~41 tools / 37k
 * chars) behind DSH's native per-agent `agent.ctx.tools.restrict({ deny })`
 * until the task actually needs them.
 *
 * A capability group unlocks automatically (and stays unlocked for the session
 * to preserve prompt/KV cache stability) when ANY of these occur:
 * 1. The model calls `lobster_enable_tools({ capabilities: [...] })`.
 * 2. A matching skill is loaded via DSH's `skill` tool or `/skill` gesture
 *    (`docx` -> `word`, `xlsx` -> `excel`, `pptx` -> `ppt`,
 *     `computer-use` -> `computer-use`).
 * 3. LobsterAI pre-unlocks it via `bindSessionContext.unlockedCapabilities`
 *    (e.g. user selected a matching skill or attached browser annotations).
 * 4. A resumed session's logged `requestHeader().tools` already admitted tools
 *    from that group, or a parent agent already unlocked it before delegating.
 *
 * User-installed custom/marketplace MCP servers are never gated.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { isUserMcpToolDenied } from './mcp-tool-filter-helpers.mjs';
import { getHostState, resolveSessionContext } from './shared-state.mjs';
import {
  collectAdmittedCapabilitiesFromTools,
  computeCombinedDeniedTools,
  evaluateSideChatToolGuard,
  GOAL_TOOL_NAMES,
  groupMountedProgressiveTools,
  hasAdmittedGoalTools,
  hasAnyProgressiveToolMounted,
  listMountedToolsForCapability,
  normalizeCapabilityIds,
  PROGRESSIVE_CAPABILITY_IDS,
  PROGRESSIVE_TOOL_GROUPS,
  renderEnableToolsOutput,
  resolveCapabilityForSkillName,
} from './tool-disclosure-helpers.mjs';

export const name = 'lobster-tool-disclosure';
export const inject = ['tools', 'agents'];

const ENABLE_TOOLS_NAME = 'lobster_enable_tools';
const ASK_USER_QUESTION = 'ask_user_question';
const GOAL_TOOL_NAME_SET = new Set(GOAL_TOOL_NAMES);

const CAPABILITY_SUMMARY = PROGRESSIVE_TOOL_GROUPS
  .map((g) => `${g.id}（${g.label}）`)
  .join('、');

export function apply(ctx) {
  const state = getHostState(ctx);
  /** @type {Map<string, { agent: any, unlocked: Set<string>, disposeRestriction: (() => void) | null, lastDenyKey: string }>} */
  const tracked = new Map();
  let reconciling = false;

  function collectInitialUnlocked(agent) {
    const unlocked = new Set();

    // 1. Keep any capability already present in the session's logged request header.
    const headerTools = agent?.session?.requestHeader?.()?.tools;
    for (const cap of collectAdmittedCapabilitiesFromTools(headerTools)) {
      unlocked.add(cap);
    }

    // 2. Apply capabilities pre-unlocked via `bindSessionContext` or bound agent's `hostCapabilities`.
    const sid = agent?.id || agent?.session?.id;
    const bound = resolveSessionContext(ctx, state, sid);
    if (bound && Array.isArray(bound.unlockedCapabilities)) {
      for (const cap of normalizeCapabilityIds(bound.unlockedCapabilities)) {
        unlocked.add(cap);
      }
    }
    const agentSpec = bound?.agentId ? state.agents?.get?.(bound.agentId) : undefined;
    if (agentSpec && Array.isArray(agentSpec.hostCapabilities)) {
      for (const cap of normalizeCapabilityIds(agentSpec.hostCapabilities)) {
        unlocked.add(cap);
      }
    }

    // 3. Inherit parent session's unlocked capabilities for native subagents.
    const header = agent?.session?.header;
    if (header?.origin === 'subagent' && typeof header.parentSession === 'string') {
      const parentRecord = tracked.get(header.parentSession);
      if (parentRecord) {
        for (const cap of parentRecord.unlocked) {
          unlocked.add(cap);
        }
      }
    }

    return unlocked;
  }

  function ensureRecord(agent) {
    const sid = agent?.id || agent?.session?.id;
    if (!sid || !agent?.ctx?.tools) return null;
    let record = tracked.get(sid);
    if (!record || record.agent !== agent) {
      if (record?.disposeRestriction) {
        try {
          record.disposeRestriction();
        } catch {
          // Ignore disposal errors on stale agent contexts.
        }
      }
      record = {
        agent,
        unlocked: collectInitialUnlocked(agent),
        disposeRestriction: null,
        lastDenyKey: '',
      };
      tracked.set(sid, record);
    }
    return record;
  }

  function reconcileAgent(agent) {
    const record = ensureRecord(agent);
    if (!record) return;

    // Pull in any newly bound pre-unlocked capabilities from `bindSessionContext` or agent spec.
    const sid = agent.id || agent.session?.id;
    const bound = resolveSessionContext(ctx, state, sid);
    if (bound && Array.isArray(bound.unlockedCapabilities)) {
      for (const cap of normalizeCapabilityIds(bound.unlockedCapabilities)) {
        record.unlocked.add(cap);
      }
    }
    const agentSpec = bound?.agentId ? state.agents?.get?.(bound.agentId) : undefined;
    if (agentSpec && Array.isArray(agentSpec.hostCapabilities)) {
      for (const cap of normalizeCapabilityIds(agentSpec.hostCapabilities)) {
        record.unlocked.add(cap);
      }
    }

    let restrictableNames;
    try {
      restrictableNames = ctx.tools.view(agent).restrictableNames;
    } catch {
      return;
    }

    const denyList = computeCombinedDeniedTools(
      restrictableNames,
      record.unlocked,
      state.mcpToolFilters,
      state.mcpRegisteredServers,
    );
    if (bound?.userQuestionsDisabled && restrictableNames.has(ASK_USER_QUESTION)) {
      denyList.push(ASK_USER_QUESTION);
    }
    const headerTools = agent?.session?.requestHeader?.()?.tools;
    const goalToolsAdmitted = bound?.goalToolsEnabled === true || hasAdmittedGoalTools(headerTools);
    if (!goalToolsAdmitted) {
      for (const goalTool of GOAL_TOOL_NAMES) {
        if (restrictableNames.has(goalTool)) {
          denyList.push(goalTool);
        }
      }
    }
    denyList.sort();
    const denyKey = denyList.join('\0');
    if (denyKey === record.lastDenyKey) return;

    reconciling = true;
    try {
      if (record.disposeRestriction) {
        try {
          record.disposeRestriction();
        } catch {
          // Agent context may already be disposing.
        }
        record.disposeRestriction = null;
        record.lastDenyKey = '';
      }
      if (denyList.length > 0) {
        record.disposeRestriction = agent.ctx.tools.restrict({ deny: denyList });
      }
      record.lastDenyKey = denyKey;
    } catch (error) {
      ctx.logger.warn(
        `[LobsterAI:ToolDisclosure] failed to reconcile restrictions for "${sid}": ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      reconciling = false;
    }
  }

  function reconcileAllAgents() {
    if (reconciling) return;
    const agents = ctx.get('agents');
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) {
        reconcileAgent(agent);
      }
    } else {
      for (const record of tracked.values()) {
        reconcileAgent(record.agent);
      }
    }
  }

  function unlockForAgent(agent, capabilityIds) {
    const record = ensureRecord(agent);
    if (!record) return [];
    const newlyUnlocked = [];
    for (const cap of normalizeCapabilityIds(capabilityIds)) {
      if (!record.unlocked.has(cap)) {
        record.unlocked.add(cap);
        newlyUnlocked.push(cap);
      }
    }
    if (newlyUnlocked.length > 0) {
      reconcileAgent(agent);
    }
    return newlyUnlocked;
  }

  state.reconcileToolDisclosure = (sessionId) => {
    const agent = sessionId ? ctx.get('agents')?.get(sessionId) : undefined;
    if (agent) {
      reconcileAgent(agent);
    } else {
      reconcileAllAgents();
    }
  };

  // Register lightweight on-demand capability unlock tool (only shown when at
  // least one built-in progressive MCP tool group is mounted, or already used).
  const enableToolsDisposer = ctx.tools.register(
    defineTool({
      name: ENABLE_TOOLS_NAME,
      description: `按需启用内置扩展工具组（启用后下一步即可直接调用对应工具）：${CAPABILITY_SUMMARY}。仅在当前任务需要时调用。`,
      parameters: {
        capabilities: {
          type: 'array',
          required: true,
          description: '需要启用的工具组名称列表。',
          items: {
            type: 'string',
            enum: [...PROGRESSIVE_CAPABILITY_IDS],
          },
        },
      },
      output: {
        schema: { type: 'json' },
        render: renderEnableToolsOutput,
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const agent = exec.agent;
        const requested = normalizeCapabilityIds(args?.capabilities);
        if (requested.length === 0) {
          throw new Error(`请至少指定一个有效工具组：${PROGRESSIVE_CAPABILITY_IDS.join(', ')}`);
        }

        const restrictableNames = agent
          ? ctx.tools.view(agent).restrictableNames
          : ctx.tools.view().restrictableNames;

        if (agent) {
          unlockForAgent(agent, requested);
        }

        const lines = [];
        /** @type {Record<string, string[]>} */
        const enabledTools = {};
        const unavailable = [];
        for (const cap of requested) {
          const tools = listMountedToolsForCapability(restrictableNames, cap)
            .filter((toolName) => !isUserMcpToolDenied(toolName, state.mcpToolFilters, state.mcpRegisteredServers));
          if (tools.length > 0) {
            enabledTools[cap] = tools;
            lines.push(`- ${cap} 已启用（${tools.length} 个工具）：${tools.join(', ')}`);
          } else {
            unavailable.push(cap);
            lines.push(`- ${cap} 当前未挂载对应服务，暂无可用工具。`);
          }
        }

        if (unavailable.length > 0) {
          const allowedNames = [...restrictableNames]
            .filter((toolName) => !isUserMcpToolDenied(toolName, state.mcpToolFilters, state.mcpRegisteredServers));
          const availableGroups = Object.keys(groupMountedProgressiveTools(allowedNames));
          if (availableGroups.length > 0) {
            lines.push(`当前可启用的工具组：${availableGroups.join(', ')}`);
          }
        }

        return {
          ok: Object.keys(enabledTools).length > 0,
          enabledTools,
          unavailable,
          text: `${lines.join('\n')}\n下一步可直接调用已启用的工具。`,
        };
      },
    }),
    {
      when: ({ agent }) => {
        if (!agent) return false;
        const headerTools = agent.session?.requestHeader?.()?.tools;
        if (Array.isArray(headerTools) && headerTools.some((t) => t?.name === ENABLE_TOOLS_NAME)) {
          return true;
        }
        try {
          const allowedNames = [...ctx.tools.view(agent).restrictableNames]
            .filter((toolName) => !isUserMcpToolDenied(toolName, state.mcpToolFilters, state.mcpRegisteredServers));
          return hasAnyProgressiveToolMounted(allowedNames);
        } catch {
          return false;
        }
      },
    },
  );

  // Also enforce session restrictions when a model or nested caller names a
  // tool directly, including tools admitted in a previous turn.
  const disposeToolGuard = ctx.tools.guard((exec) => {
    const toolName = exec?.name;
    const bound = resolveSessionContext(ctx, state, exec.agent?.id);
    const sideChatBlock = evaluateSideChatToolGuard(toolName, bound?.sideChat === true);
    if (sideChatBlock) {
      return sideChatBlock;
    }
    if (toolName === ASK_USER_QUESTION && bound?.userQuestionsDisabled) {
      return { reason: 'This session cannot receive interactive questions.' };
    }
    if (typeof toolName === 'string' && GOAL_TOOL_NAME_SET.has(toolName)) {
      const headerTools = exec.agent?.session?.requestHeader?.()?.tools;
      if (bound?.goalToolsEnabled !== true && !hasAdmittedGoalTools(headerTools)) {
        return { reason: 'Goal tools are only available when Goal mode is active (/goal or Goal button).' };
      }
    }
    if (
      typeof toolName !== 'string'
      || !isUserMcpToolDenied(toolName, state.mcpToolFilters, state.mcpRegisteredServers)
    ) {
      return undefined;
    }
    return {
      reason: `MCP tool "${toolName}" is disabled by the server's toolFilter policy.`,
      info: {
        name: 'McpToolFilterError',
        code: 'MCP_TOOL_FILTER_DENIED',
      },
    };
  });

  // Restrict locked progressive MCP tools when any agent is created or tools change.
  ctx.on('agent/created', ({ agent }) => {
    reconcileAgent(agent);
  });

  ctx.on('agent/disposed', ({ agent }) => {
    const sid = agent?.id || agent?.session?.id;
    if (!sid) return;
    const record = tracked.get(sid);
    if (record && record.agent === agent) {
      record.disposeRestriction = null;
      tracked.delete(sid);
    }
  });

  ctx.on('tools/change', () => {
    reconcileAllAgents();
  });

  // Auto-unlock matching capability group when the model loads a related skill.
  ctx.on('tools/result', (exec, result) => {
    if (!exec?.agent || exec.name !== 'skill' || result?.isError) return;
    const skillName = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments.name : undefined;
    const cap = resolveCapabilityForSkillName(skillName);
    if (cap) {
      unlockForAgent(exec.agent, [cap]);
    }
  });

  // Auto-unlock matching capability group when the user invokes `/skill-name`.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message' || event?.data?.source?.kind !== 'skill-invocation') return;
    const cap = resolveCapabilityForSkillName(event.data.source.name);
    if (!cap) return;
    const agent = ctx.agents.get(session.id);
    if (agent?.session === session) {
      unlockForAgent(agent, [cap]);
    }
  });

  // Apply restrictions to any already-running agents at plugin init time.
  reconcileAllAgents();

  ctx.effect(() => () => {
    disposeToolGuard();
    enableToolsDisposer();
    for (const record of tracked.values()) {
      if (record.disposeRestriction) {
        try {
          record.disposeRestriction();
        } catch {
          // ignore
        }
      }
    }
    tracked.clear();
    state.reconcileToolDisclosure = null;
    state.pluginsReady.toolDisclosure = false;
  }, 'lobster-tool-disclosure cleanup');

  state.pluginsReady.toolDisclosure = true;
}
