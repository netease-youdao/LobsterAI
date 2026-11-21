/**
 * Pure helpers for `@lobsterai/dsh-bundle` multi-agent collaboration & delegation.
 * Zero DSH peer imports so Vitest can test all policy, anti-cycle, naming, and
 * prompt-formatting rules directly in Node.
 */

export const DELEGATE_AGENT_TOOL_NAME = 'delegate_agent';
export const LIST_COLLABORATORS_TOOL_NAME = 'list_collaborator_agents';
export const DELEGATE_MAX_DEPTH = 2;
export const MAX_INLINE_COLLABORATORS = 20;

const DSH_AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOT_RESERVED_NAME = 'lead';
const MAX_DESC_CHARS = 120;
const MAX_SKILLS_PER_LINE = 6;

export function isValidDshAgentName(value) {
  return typeof value === 'string' && DSH_AGENT_NAME_RE.test(value) && value !== ROOT_RESERVED_NAME;
}

/**
 * Resolve the ordered list of enabled LobsterAI agents that `currentAgentId`
 * is permitted to delegate to, excluding itself and any ancestor agent in the
 * current delegation chain (preventing direct and indirect cycles).
 */
export function resolveCollaborators(agentsMap, agentOrder, currentAgentId, ancestorAgentIds = new Set()) {
  if (!agentsMap || typeof agentsMap.get !== 'function' || agentsMap.size === 0) return [];
  const normalizedCurrent = typeof currentAgentId === 'string' && currentAgentId.trim().length > 0
    ? currentAgentId.trim()
    : 'main';
  const currentSpec = agentsMap.get(normalizedCurrent);
  const mode = currentSpec?.collaborationMode === 'allowlist' || currentSpec?.collaborationMode === 'disabled'
    ? currentSpec.collaborationMode
    : 'all';

  if (mode === 'disabled') return [];

  const allowSet = mode === 'allowlist'
    ? new Set(Array.isArray(currentSpec?.allowAgentIds) ? currentSpec.allowAgentIds : [])
    : null;
  if (allowSet && allowSet.size === 0) return [];

  const blocked = new Set(ancestorAgentIds);
  blocked.add(normalizedCurrent);

  const orderedIds = Array.isArray(agentOrder) && agentOrder.length > 0
    ? agentOrder
    : [...agentsMap.keys()];

  const result = [];
  const seen = new Set();
  for (const id of orderedIds) {
    if (seen.has(id) || blocked.has(id)) continue;
    const spec = agentsMap.get(id);
    if (!spec || spec.enabled === false) continue;
    if (allowSet && !allowSet.has(spec.id)) continue;
    seen.add(id);
    result.push(spec);
  }
  return result;
}

/**
 * Resolve model-supplied `agent_id` against the allowed collaborator roster.
 * Exact ID matches first; if a model passes an agent's display name (e.g.
 * "博客自动发布") and it uniquely matches one allowed collaborator, resolve it.
 */
export function resolveTargetAgentInput(collaborators, rawAgentId) {
  const query = typeof rawAgentId === 'string' ? rawAgentId.trim() : '';
  if (!query) {
    return { ok: false, error: 'agent_id must be a non-empty string.' };
  }

  const exactId = collaborators.find((agent) => agent.id === query);
  if (exactId) return { ok: true, agent: exactId };

  const lowered = query.toLowerCase();
  const ciIdMatches = collaborators.filter((agent) => agent.id.toLowerCase() === lowered);
  if (ciIdMatches.length === 1) return { ok: true, agent: ciIdMatches[0] };

  const exactNameMatches = collaborators.filter((agent) => agent.name === query);
  if (exactNameMatches.length === 1) return { ok: true, agent: exactNameMatches[0] };
  if (exactNameMatches.length > 1) {
    return {
      ok: false,
      error: `Multiple collaborator agents share the name "${query}". Pass an exact agent_id: ${exactNameMatches.map((a) => a.id).join(', ')}`,
    };
  }

  const ciNameMatches = collaborators.filter((agent) => agent.name.toLowerCase() === lowered);
  if (ciNameMatches.length === 1) return { ok: true, agent: ciNameMatches[0] };
  if (ciNameMatches.length > 1) {
    return {
      ok: false,
      error: `Multiple collaborator agents match "${query}". Pass an exact agent_id: ${ciNameMatches.map((a) => a.id).join(', ')}`,
    };
  }

  const available = collaborators.map((agent) => `${agent.id} (${agent.name})`).join(', ');
  return {
    ok: false,
    error: available
      ? `Agent "${query}" is not available for delegation from this agent (either not found, disabled, not allowed, or already in the current delegation ancestry). Available agents: ${available}`
      : `Agent "${query}" cannot be delegated: no collaborator agents are currently available from this agent.`,
  };
}

function toAsciiSlugCandidate(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || UUID_PREFIX_RE.test(trimmed)) return '';
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!normalized || normalized === ROOT_RESERVED_NAME || !/^[a-z]/.test(normalized)) return '';
  const bounded = normalized.slice(0, 28).replace(/-+$/g, '');
  return bounded.length >= 2 && bounded !== ROOT_RESERVED_NAME ? bounded : '';
}

/**
 * Derive a DSH-compliant subagent tree name (`^[a-z][a-z0-9-]{0,31}$`, != `lead`).
 * Explicit caller names are validated strictly; omitted names derive a readable
 * ASCII slug when available or fall back to `undefined` (DSH auto `agent-N`).
 */
export function deriveDelegationChildName(targetAgent, takenNames = new Set(), requestedName) {
  if (requestedName !== undefined) {
    const trimmed = typeof requestedName === 'string' ? requestedName.trim() : '';
    if (!isValidDshAgentName(trimmed)) {
      return {
        ok: false,
        error: `Invalid subagent name "${trimmed}". Use 1-32 lower-case letters, digits, or hyphens starting with a letter, and not "${ROOT_RESERVED_NAME}".`,
      };
    }
    return { ok: true, name: trimmed, explicit: true };
  }

  const base = toAsciiSlugCandidate(targetAgent?.presetId)
    || toAsciiSlugCandidate(targetAgent?.id)
    || toAsciiSlugCandidate(targetAgent?.name);
  if (!base) {
    return { ok: true, name: undefined, explicit: false };
  }
  if (!takenNames.has(base)) {
    return { ok: true, name: base, explicit: false };
  }
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const candidate = `${base.slice(0, 31 - String(suffix).length)}-${suffix}`;
    if (isValidDshAgentName(candidate) && !takenNames.has(candidate)) {
      return { ok: true, name: candidate, explicit: false };
    }
  }
  return { ok: true, name: undefined, explicit: false };
}

function truncateLine(text, maxChars) {
  if (typeof text !== 'string') return '';
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatAgentRow(agent) {
  const parts = [`- \`${agent.id}\` (${agent.name})`];
  const desc = truncateLine(agent.description || '', MAX_DESC_CHARS);
  if (desc) parts.push(`: ${desc}`);
  const skills = Array.isArray(agent.skillSummaries) ? agent.skillSummaries : [];
  if (skills.length > 0) {
    const names = skills.slice(0, MAX_SKILLS_PER_LINE).map((s) => s.name || s.id);
    const more = skills.length > MAX_SKILLS_PER_LINE ? ` +${skills.length - MAX_SKILLS_PER_LINE}` : '';
    parts.push(` [skills: ${names.join(', ')}${more}]`);
  }
  return parts.join('');
}

/**
 * Format compact runtime context advertising available LobsterAI collaborator
 * agents and clearly distinguishing `delegate_agent` from stock `subagent`.
 */
export function formatCollaboratorRosterPrompt(collaborators, options = {}) {
  if (!Array.isArray(collaborators) || collaborators.length === 0) return '';
  const maxInline = typeof options.maxInline === 'number' && options.maxInline > 0
    ? options.maxInline
    : MAX_INLINE_COLLABORATORS;

  const shown = collaborators.slice(0, maxInline);
  const lines = [
    '## Available Specialist Agents for Collaboration',
    'You can delegate tasks to the configured LobsterAI specialist agents below using `delegate_agent`.',
    'Unlike `subagent` / `subagent_fork` (which spawn copies of yourself with your own persona and skills), `delegate_agent` starts an independent subagent running as that specialist — with its own workspace persona, long-term memory (`MEMORY.md`), skills, working directory, and configured model.',
    'When the user asks to hand off work to one of these agents or a task matches a specialist\'s domain, call `delegate_agent` with its `agent_id` and a complete self-contained `prompt` (include absolute file paths and all relevant context, since the specialist does not see this conversation). After delegating, end your turn when only waiting remains; the runtime automatically delivers the specialist\'s completion result, and you can send follow-ups via `send_message`.',
    '',
    ...shown.map(formatAgentRow),
  ];

  if (collaborators.length > maxInline) {
    lines.push(
      '',
      `(${collaborators.length - maxInline} more collaborator agents omitted; call \`${LIST_COLLABORATORS_TOOL_NAME}\` to inspect the full list.)`,
    );
  }
  return lines.join('\n');
}
