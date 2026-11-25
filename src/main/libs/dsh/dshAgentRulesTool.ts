import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { normalizeAgentSummaryDescription } from '../../../shared/agent/description';
import {
  AGENT_RULES_LIMITS,
  DSH_AGENT_RULES_TOOL,
  DshAgentRulesAction,
  DshAgentRulesMode,
} from '../../../shared/dshEngine/hostConstants';
import type { Agent, UpdateAgentRequest } from '../../coworkStore';
import { AgentPersonaFile, writeAgentPersonaFiles } from '../agentPersonaFiles';
import type { HostToolProvider } from './dshHostBridgeWiring';
import type { DshHostToolDescriptor } from './dshHostManager';

export interface AgentRulesToolOptions {
  getAgent: (agentId: string) => Agent | null;
  updateAgent: (agentId: string, updates: UpdateAgentRequest) => Agent | null;
  resolveWorkspaceDir: (agentId: string) => string;
  onAgentUpdated?: (info: {
    agentId: string;
    previousAgent: Agent;
    updatedAgent: Agent;
    updates: UpdateAgentRequest;
  }) => void;
}

function readOptionalWorkspaceFile(workspaceDir: string, fileName: AgentPersonaFile): string | null {
  const filePath = path.join(workspaceDir, fileName);
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function normalizeMultilineRules(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim();
}

function resolveCurrentRules(workspaceDir: string, agent: Agent): {
  rules: string;
  identity: string;
} {
  const diskSoul = readOptionalWorkspaceFile(workspaceDir, AgentPersonaFile.Soul);
  const diskIdentity = readOptionalWorkspaceFile(workspaceDir, AgentPersonaFile.Identity);
  return {
    rules: normalizeMultilineRules(diskSoul ?? agent.systemPrompt ?? ''),
    identity: normalizeMultilineRules(diskIdentity ?? agent.identity ?? ''),
  };
}

function parseSaveMode(raw: unknown): DshAgentRulesMode {
  if (raw === undefined || raw === null || raw === '') {
    return DshAgentRulesMode.Replace;
  }
  if (raw === DshAgentRulesMode.Replace || raw === DshAgentRulesMode.Append) {
    return raw;
  }
  throw new Error(`Invalid mode "${String(raw)}". Use "${DshAgentRulesMode.Replace}" or "${DshAgentRulesMode.Append}".`);
}

function mergeRules(existing: string, incoming: string, mode: DshAgentRulesMode): string {
  if (mode === DshAgentRulesMode.Replace || !existing) {
    return incoming;
  }
  if (existing === incoming || existing.includes(incoming)) {
    return existing;
  }
  return `${existing}\n\n${incoming}`;
}

export const dshAgentRulesToolDescriptor: DshHostToolDescriptor = {
  name: DSH_AGENT_RULES_TOOL,
  description: [
    'Read or save THIS agent\'s own durable role, persona, output style, and working guidelines (`SOUL.md` + Agent Settings -> Role & Rules).',
    'Changes are strictly isolated to the current agent and persist even if the user switches working directories.',
    'Always use this tool (instead of creating or editing `AGENTS.md` / `CLAUDE.md` in the working directory) when saving an agent\'s own working guidelines, so other agents sharing the same default folder are never affected.',
    'Call `action: "read"` first before updating existing rules, and call `action: "save"` only after confirming the guidelines with the user.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: Object.values(DshAgentRulesAction),
        description: '"read" to inspect this agent\'s current rules and description; "save" to persist updated rules.',
      },
      rules: {
        type: 'string',
        description: 'Markdown text of this agent\'s role, workflow, and output guidelines (required for action="save").',
      },
      mode: {
        type: 'string',
        enum: Object.values(DshAgentRulesMode),
        description: 'For action="save": "replace" overwrites SOUL.md (default, preferred after reading); "append" adds new rules to the end.',
      },
      description: {
        type: 'string',
        description: 'Optional concise one-line summary of what this agent does (recommended when the agent currently has no description).',
      },
    },
  },
};

export function createDshAgentRulesProvider(options: AgentRulesToolOptions): HostToolProvider {
  return {
    listDescriptors: () => [dshAgentRulesToolDescriptor],
    async execute(toolName, args, context) {
      if (toolName !== DSH_AGENT_RULES_TOOL) {
        throw new Error(`Unexpected tool: ${toolName}`);
      }
      const agentId = typeof context.agentId === 'string' && context.agentId.trim()
        ? context.agentId.trim()
        : '';
      if (!agentId) {
        throw new Error('A bound agent context is required.');
      }

      const agent = options.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent "${agentId}" was not found.`);
      }

      const workspaceDir = options.resolveWorkspaceDir(agentId);
      const action = typeof args.action === 'string' ? args.action.trim() : '';

      if (action === DshAgentRulesAction.Read) {
        const { rules, identity } = resolveCurrentRules(workspaceDir, agent);
        const sections = [
          `Agent: ${agent.name} (${agent.id})`,
          `Description: ${agent.description?.trim() || '(empty)'}`,
          `SOUL.md (Role & Rules):\n${rules || '(empty)'}`,
          ...(identity ? [`IDENTITY.md:\n${identity}`] : []),
        ];
        return {
          ok: true,
          action: DshAgentRulesAction.Read,
          agentId: agent.id,
          agentName: agent.name,
          description: agent.description ?? '',
          rules,
          identity,
          text: sections.join('\n\n'),
        };
      }

      if (action !== DshAgentRulesAction.Save) {
        throw new Error(`Unsupported action "${action}". Use "${DshAgentRulesAction.Read}" or "${DshAgentRulesAction.Save}".`);
      }

      if (typeof args.rules !== 'string' || !args.rules.trim()) {
        throw new Error('`rules` must be a non-empty string when action is "save".');
      }
      const incomingRules = normalizeMultilineRules(args.rules);
      const mode = parseSaveMode(args.mode);
      const { rules: existingRules } = resolveCurrentRules(workspaceDir, agent);
      const nextRules = mergeRules(existingRules, incomingRules, mode);

      if (nextRules.length > AGENT_RULES_LIMITS.MaxRulesChars) {
        throw new Error(
          `Agent rules exceed the ${AGENT_RULES_LIMITS.MaxRulesChars} character limit (${nextRules.length} chars). Please make the guidelines more concise.`,
        );
      }

      const normalizedDescription = typeof args.description === 'string' && args.description.trim()
        ? normalizeAgentSummaryDescription(args.description)
        : '';
      const updates: UpdateAgentRequest = {
        systemPrompt: nextRules,
        ...(normalizedDescription ? { description: normalizedDescription } : {}),
      };

      // Write SOUL.md atomically first so disk errors never leave SQLite out of sync.
      writeAgentPersonaFiles(workspaceDir, { systemPrompt: nextRules });

      const updatedAgent = options.updateAgent(agentId, updates);
      if (!updatedAgent) {
        throw new Error(`Failed to persist rules for agent "${agentId}".`);
      }

      options.onAgentUpdated?.({
        agentId: updatedAgent.id,
        previousAgent: agent,
        updatedAgent,
        updates,
      });

      return {
        ok: true,
        action: DshAgentRulesAction.Save,
        mode,
        agentId: updatedAgent.id,
        agentName: updatedAgent.name,
        description: updatedAgent.description ?? '',
        rulesLength: nextRules.length,
        text: `Saved role & rules to "${updatedAgent.name}" (${AgentPersonaFile.Soul}, ${nextRules.length} chars). These rules apply only to this agent across any working directory and can be edited anytime in Agent Settings.`,
      };
    },
  };
}
