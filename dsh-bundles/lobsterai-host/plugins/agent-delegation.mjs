/**
 * @lobsterai/dsh-bundle — Cross-Agent Collaboration & Specialist Delegation Plugin
 *
 * Bridges LobsterAI's configured specialist Agent roster (`state.agents`) directly
 * onto DSH's native `ctx.subagents` runtime (`provider: 'spawn'`):
 * 1. Injects a compact collaborator roster into runtime context so an agent can
 *    discover other enabled LobsterAI agents immediately (zero discovery turn).
 * 2. Registers `delegate_agent`, which pre-reserves `childId`, binds the target
 *    agent's identity (`state.delegatedChildAgents`) + persists it via Electron
 *    Main's local bridge for cold resume, preflights any explicit target model
 *    route, and starts a native continuable DSH subagent (`maxDepth: 2`).
 * 3. Registers `list_collaborator_agents` only when the roster exceeds the
 *    inline cap (> 20 collaborators).
 */

import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  DELEGATE_AGENT_TOOL_NAME,
  DELEGATE_MAX_DEPTH,
  deriveDelegationChildName,
  formatCollaboratorRosterPrompt,
  LIST_COLLABORATORS_TOOL_NAME,
  MAX_INLINE_COLLABORATORS,
  resolveCollaboratorDescription,
  resolveCollaborators,
  resolveTargetAgentInput,
} from './agent-delegation-helpers.mjs';
import { callLobsterBridge, getHostState, resolveSessionContext, resolveSessionId } from './shared-state.mjs';

export const name = 'lobster-agent-delegation';
export const inject = ['tools', 'subagents', 'systemPrompt', 'agents'];

const SUBAGENT_BINDING_BRIDGE_PATH = '/dsh-bridge/subagent-binding';
const DEFAULT_AGENT_ID = 'main';

function isExistingDirectory(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return false;
  try {
    return existsSync(dirPath) && statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Collect LobsterAI agent IDs across the calling session and all its ancestors
 * to block self-delegation and A -> B -> A cycles.
 */
function collectAncestorAgentIds(ctx, state, agent) {
  const ancestorIds = new Set();
  const visitedSessions = new Set();
  let currentSessionId = resolveSessionId(agent);
  while (currentSessionId && !visitedSessions.has(currentSessionId)) {
    visitedSessions.add(currentSessionId);
    const bound = resolveSessionContext(ctx, state, currentSessionId);
    if (bound && typeof bound.agentId === 'string' && bound.agentId.trim().length > 0) {
      ancestorIds.add(bound.agentId.trim());
    }
    const header = ctx.get('agents')?.get(currentSessionId)?.session?.header;
    if (header?.origin === 'subagent' && typeof header.parentSession === 'string' && header.parentSession.length > 0) {
      currentSessionId = header.parentSession;
      continue;
    }
    const binding = state.delegatedChildAgents.get(currentSessionId);
    if (binding && typeof binding.parentDshSessionId === 'string' && binding.parentDshSessionId.length > 0) {
      currentSessionId = binding.parentDshSessionId;
      continue;
    }
    break;
  }
  return ancestorIds;
}

function getCurrentAgentId(ctx, state, agent) {
  const sessionId = resolveSessionId(agent);
  const bound = resolveSessionContext(ctx, state, sessionId);
  return bound && typeof bound.agentId === 'string' && bound.agentId.trim().length > 0
    ? bound.agentId.trim()
    : DEFAULT_AGENT_ID;
}

function collectTakenChildNames(parent) {
  const taken = new Set();
  const events = typeof parent?.session?.ownEvents === 'function'
    ? parent.session.ownEvents()
    : parent?.session?.events;
  if (Array.isArray(events)) {
    for (const ev of events) {
      if (ev?.type === 'subagent/catalog' && typeof ev?.data?.name === 'string') {
        taken.add(ev.data.name);
      }
    }
  }
  return taken;
}

function hasToolInRequestHeader(agent, toolName) {
  const headerTools = agent?.session?.requestHeader?.()?.tools;
  return Array.isArray(headerTools) && headerTools.some((t) => t?.name === toolName);
}

/**
 * Preflight a specialist agent's explicit LLM model route via DSH `ctx.llm`.
 * Retries without `reasoningEffort` if the model rejects the configured effort,
 * and falls back cleanly to `undefined` (inherit parent model) if the provider
 * or model is no longer available.
 */
async function resolveTargetAgentModelOptions(ctx, targetAgent, signal) {
  const sel = targetAgent?.modelSelection;
  if (!sel || typeof sel.provider !== 'string' || typeof sel.model !== 'string') {
    return undefined;
  }
  const provider = sel.provider.trim();
  const model = sel.model.trim();
  if (!provider || !model) return undefined;
  const effort = typeof sel.reasoningEffort === 'string' && sel.reasoningEffort.trim().length > 0
    ? sel.reasoningEffort.trim()
    : undefined;

  const llm = ctx.get('llm');
  if (!llm || typeof llm.resolveCallConfig !== 'function') {
    return {
      provider,
      model,
      ...(effort ? { reasoningEffort: effort } : {}),
    };
  }

  try {
    await llm.resolveCallConfig(
      { provider, model, ...(effort ? { reasoningEffort: effort } : {}) },
      signal,
    );
    return {
      provider,
      model,
      ...(effort ? { reasoningEffort: effort } : {}),
    };
  } catch (error) {
    if (effort) {
      try {
        await llm.resolveCallConfig({ provider, model }, signal);
        ctx.logger.warn(
          `[LobsterAI:AgentDelegation] target agent "${targetAgent.id}" reasoningEffort "${effort}" rejected for ${provider}/${model}; retrying without reasoningEffort`,
        );
        return { provider, model };
      } catch (fallbackErr) {
        ctx.logger.warn(
          `[LobsterAI:AgentDelegation] target agent "${targetAgent.id}" model ${provider}/${model} unavailable; falling back to parent model: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
        );
        return undefined;
      }
    }
    ctx.logger.warn(
      `[LobsterAI:AgentDelegation] target agent "${targetAgent.id}" model ${provider}/${model} unavailable; falling back to parent model: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

export function apply(ctx) {
  const state = getHostState(ctx);

  const getAvailableCollaboratorsForAgent = (agent) => {
    if (!agent) return [];
    const currentAgentId = getCurrentAgentId(ctx, state, agent);
    const ancestors = collectAncestorAgentIds(ctx, state, agent);
    const collaborators = resolveCollaborators(state.agents, state.agentOrder, currentAgentId, ancestors);
    const allowed = resolveSessionContext(ctx, state, resolveSessionId(agent))?.remoteAllowedAgentIds;
    return Array.isArray(allowed) ? collaborators.filter(target => allowed.includes(target.id)) : collaborators;
  };

  const delegateTool = defineTool({
    name: DELEGATE_AGENT_TOOL_NAME,
    description:
      'Delegate a self-contained task to another configured LobsterAI specialist agent '
      + '(running with that specialist\'s own workspace persona, long-term memory, skills, working directory, and model). '
      + 'Starts an independently managed continuable subagent and immediately returns its name. '
      + 'If you are still online when it finishes, the runtime automatically delivers its completion notice with its final answer. '
      + 'Use `send_message` to steer it while running or continue its conversation after it finishes.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'The `agent_id` of the target specialist agent from the Available Specialist Agents list.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-8 word) description of the delegated task for display, in the user\'s language.',
      },
      prompt: {
        type: 'string',
        required: true,
        description:
          'The complete, self-contained task for the target specialist agent. '
          + 'It does not see this conversation, so include absolute file paths and all required context.',
      },
      cwd: {
        type: 'string',
        description:
          'Optional initial working directory override. Omit to use the target agent\'s configured working directory (or inherit yours if unset).',
      },
      name: {
        type: 'string',
        description:
          'Optional unique name for this delegated run within your children: 1-32 lower-case letters, digits, or hyphens starting with a letter, other than `lead`.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          name: { type: 'string', required: true },
          childId: { type: 'string', required: true },
          agentId: { type: 'string', required: true },
          agentName: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `delegated task to specialist agent "${value.agentName}" (${value.agentId}) as subagent ${value.name}`,
      }],
      presentationMeta: (_args, value) => ({
        kind: value.kind,
        name: value.name,
        childId: value.childId,
        agentId: value.agentId,
      }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) {
        throw new Error('delegate_agent requires a calling agent (exec.agent was undefined)');
      }

      const depth = delegationDepthOf(parent);
      if (depth >= DELEGATE_MAX_DEPTH) {
        throw new Error(
          `Delegation depth ${depth + 1} exceeds maximum allowed cross-agent delegation depth (${DELEGATE_MAX_DEPTH}). Complete the task directly or report back to your parent agent.`,
        );
      }

      const collaborators = getAvailableCollaboratorsForAgent(parent);
      const targetResolution = resolveTargetAgentInput(collaborators, args.agent_id);
      if (!targetResolution.ok) {
        throw new Error(targetResolution.error);
      }
      const targetAgent = targetResolution.agent;

      const takenNames = collectTakenChildNames(parent);
      const nameResolution = deriveDelegationChildName(targetAgent, takenNames, args.name);
      if (!nameResolution.ok) {
        throw new Error(nameResolution.error);
      }

      const explicitCwd = typeof args.cwd === 'string' && args.cwd.trim().length > 0
        ? args.cwd.trim()
        : undefined;
      let resolvedCwd = explicitCwd;
      if (!resolvedCwd && typeof targetAgent.workingDirectory === 'string' && targetAgent.workingDirectory.trim().length > 0) {
        if (isExistingDirectory(targetAgent.workingDirectory.trim())) {
          resolvedCwd = targetAgent.workingDirectory.trim();
        } else {
          ctx.logger.warn(
            `[LobsterAI:AgentDelegation] target agent "${targetAgent.id}" workingDirectory does not exist: "${targetAgent.workingDirectory}"; inheriting parent cwd`,
          );
        }
      }

      const remoteScope = resolveSessionContext(ctx, state, resolveSessionId(parent));
      if (Array.isArray(remoteScope?.remoteAllowedAgentIds) && explicitCwd) throw new Error('Remote delegation requires an authorized agent workspace.');
      const targetModelOptions = await resolveTargetAgentModelOptions(ctx, targetAgent, exec.signal);
      exec.signal.throwIfAborted();

      const parentSessionId = resolveSessionId(parent);
      const parentBound = resolveSessionContext(ctx, state, parentSessionId);
      if (!getAvailableCollaboratorsForAgent(parent).some(target => target.id === targetAgent.id)) {
        throw new Error('The delegated agent is no longer available.');
      }
      const childId = randomUUID();

      state.delegatedChildAgents.set(childId, {
        targetAgentId: targetAgent.id,
        ...(parentBound?.remoteRequestId ? { remoteRequestId: parentBound.remoteRequestId } : {}),
        ...(parentSessionId ? { parentDshSessionId: parentSessionId } : {}),
        ...(parentBound?.coworkSessionId ? { rootCoworkSessionId: parentBound.coworkSessionId } : {}),
        ...(resolvedCwd ? { workspaceDir: resolvedCwd } : {}),
      });

      const persistBinding = async (action) => {
        const requireGuard = action === 'set' && Array.isArray(parentBound?.remoteAllowedAgentIds);
        if (requireGuard && (!state.bridgeUrl || !parentSessionId || !parentBound?.coworkSessionId || !parentBound?.remoteRequestId)) {
          throw new Error('Remote delegation guard unavailable.');
        }
        if (!state.bridgeUrl || !parentSessionId || !parentBound?.coworkSessionId) return;
        try {
          const reply = await callLobsterBridge(
            state,
            SUBAGENT_BINDING_BRIDGE_PATH,
            action === 'delete'
              ? { action: 'delete', childSessionId: childId }
              : {
                  action: 'set',
                  ...(requireGuard ? { remoteRequestId: parentBound.remoteRequestId } : {}),
                  childSessionId: childId,
                  parentDshSessionId: parentSessionId,
                  rootCoworkSessionId: parentBound.coworkSessionId,
                  targetAgentId: targetAgent.id,
                },
            action === 'delete' ? undefined : exec.signal,
          );
          if (reply.error === 'SETTINGS_OPERATION_PENDING') throw new Error(reply.error);
          if (requireGuard && (!reply.ok || reply.data?.ok !== true)) throw new Error('Remote delegation authorization failed.');
        } catch (error) {
          if (requireGuard || error?.message === 'SETTINGS_OPERATION_PENDING') throw error;
          ctx.logger.warn(
            `[LobsterAI:AgentDelegation] failed to ${action} durable subagent binding for "${childId}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      const startWithName = (candidateName) => ctx.subagents.startActivation({
        provider: 'spawn',
        childId,
        parent,
        label: args.description,
        ...(candidateName !== undefined ? { name: candidateName } : {}),
        ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
        prompt: [{ type: 'text', text: args.prompt }],
        ...(targetModelOptions !== undefined ? { agentOptions: targetModelOptions } : {}),
        maxDepth: DELEGATE_MAX_DEPTH,
        signal: exec.signal,
        delivery: 'parent',
      });

      try {
        await persistBinding('set');
        exec.signal.throwIfAborted();
        if (!getAvailableCollaboratorsForAgent(parent).some(target => target.id === targetAgent.id)) {
          throw new Error('The delegated agent is no longer available.');
        }
        let started;
        try {
          started = await startWithName(nameResolution.name);
        } catch (error) {
          const isDuplicateAutoName = !nameResolution.explicit
            && nameResolution.name !== undefined
            && error && typeof error === 'object'
            && error.code === 'DUPLICATE_AGENT_NAME';
          if (!isDuplicateAutoName) throw error;
          started = await startWithName(undefined);
        }

        return {
          kind: 'activation',
          name: started.name,
          childId: started.childId,
          agentId: targetAgent.id,
          agentName: targetAgent.name,
        };
      } catch (error) {
        state.delegatedChildAgents.delete(childId);
        await persistBinding('delete');
        throw error;
      }
    },
  });

  const listCollaboratorsTool = defineTool({
    name: LIST_COLLABORATORS_TOOL_NAME,
    description:
      'List all configured LobsterAI specialist agents that this agent is allowed to delegate tasks to via `delegate_agent`.',
    parameters: {},
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            agent_id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            description: { type: 'string' },
            skills: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      render: (_args, entries) => [{
        type: 'text',
        text: entries.length === 0
          ? 'No collaborator specialist agents are available.'
          : entries.map((e) => (
              `${e.agent_id} (${e.name})${e.description ? `: ${e.description}` : ''}${e.skills?.length ? ` [skills: ${e.skills.join(', ')}]` : ''}`
            )).join('\n'),
      }],
    },
    async execute(_args, exec) {
      const collaborators = getAvailableCollaboratorsForAgent(exec.agent);
      return collaborators.map((agent) => {
        const desc = resolveCollaboratorDescription(agent);
        return {
          agent_id: agent.id,
          name: agent.name,
          ...(desc ? { description: desc } : {}),
          ...(Array.isArray(agent.skillSummaries) && agent.skillSummaries.length > 0
            ? { skills: agent.skillSummaries.map((s) => s.name || s.id) }
            : {}),
        };
      });
    },
  });

  const disposeDelegateTool = ctx.tools.register(delegateTool, {
    when: ({ agent }) => {
      if (!agent) return false;
      if (hasToolInRequestHeader(agent, DELEGATE_AGENT_TOOL_NAME)) return true;
      if (!ctx.subagents.getProvider('spawn')) return false;
      if (delegationDepthOf(agent) >= DELEGATE_MAX_DEPTH) return false;
      return getAvailableCollaboratorsForAgent(agent).length > 0;
    },
  });

  const disposeListTool = ctx.tools.register(listCollaboratorsTool, {
    when: ({ agent }) => {
      if (!agent) return false;
      if (hasToolInRequestHeader(agent, LIST_COLLABORATORS_TOOL_NAME)) return true;
      if (!ctx.subagents.getProvider('spawn')) return false;
      if (delegationDepthOf(agent) >= DELEGATE_MAX_DEPTH) return false;
      return getAvailableCollaboratorsForAgent(agent).length > MAX_INLINE_COLLABORATORS;
    },
  });

  ctx.systemPrompt.context({
    name: 'lobsterai:collaborators',
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    interpolate: false,
    text: (assemblyCtx) => {
      const agent = assemblyCtx?.agent;
      if (!agent) return '';
      if (!ctx.subagents.getProvider('spawn')) return '';
      const depth = delegationDepthOf(agent);
      if (depth >= DELEGATE_MAX_DEPTH) {
        if (hasToolInRequestHeader(agent, DELEGATE_AGENT_TOOL_NAME)) {
          return `Cross-agent delegation depth for \`${DELEGATE_AGENT_TOOL_NAME}\`: current ${depth}, maximum ${DELEGATE_MAX_DEPTH}, remaining levels 0. Do not call \`${DELEGATE_AGENT_TOOL_NAME}\` at this depth; carry out the work directly.`;
        }
        return '';
      }
      const collaborators = getAvailableCollaboratorsForAgent(agent);
      return formatCollaboratorRosterPrompt(collaborators, { maxInline: MAX_INLINE_COLLABORATORS });
    },
  });

  ctx.effect(() => () => {
    disposeDelegateTool();
    disposeListTool();
    state.pluginsReady.agentDelegation = false;
  }, 'lobster-agent-delegation cleanup');

  state.pluginsReady.agentDelegation = true;
}
