/** Keep settings documents out of ordinary chat storage, events, and remote session projections. */
export const AgentSettingsPrivateTool = 'lobsterai_agent_settings';
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sections = new Set(['model', 'collaboration', 'identity', 'memory', 'userProfile']);
const statuses = new Set(['prepared', 'applied', 'rejected', 'reconciling', 'no_change', 'succeeded', 'unknown']);
const changes = new Set(['append', 'replace_selection', 'replace_all', 'clear']);
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value);
export const isAgentSettingsPrivateTool = (value: unknown): boolean => typeof value === 'string' && value.trim().toLowerCase() === AgentSettingsPrivateTool;
function decoded(value: unknown): Record<string, unknown> {
  if (typeof value === 'string' && value.length <= 262144) {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  const raw = object(value);
  if (Array.isArray(raw.content)) {
    const text = raw.content.find(entry => object(entry).type === 'text');
    if (text) return decoded(object(text).text);
  }
  return raw;
}
export function agentSettingsPublicInput(value: unknown): Record<string, unknown> {
  const raw = decoded(value), safe: Record<string, unknown> = { settingsContentOmitted: true };
  if (raw.action === 'read' || raw.action === 'update') safe.action = raw.action;
  if (typeof raw.section === 'string' && sections.has(raw.section)) safe.section = raw.section;
  if (typeof raw.changeKind === 'string' && changes.has(raw.changeKind)) safe.changeKind = raw.changeKind;
  return safe;
}
export function agentSettingsPublicResult(value: unknown): Record<string, unknown> {
  const raw = decoded(value), safe: Record<string, unknown> = { settingsContentOmitted: true };
  if (typeof raw.section === 'string' && sections.has(raw.section)) safe.section = raw.section;
  if (opaque(raw.revision)) safe.revision = raw.revision;
  if (typeof raw.status === 'string' && statuses.has(raw.status)) safe.status = raw.status;
  if (raw.effect === 'future_safe_boundary') safe.effect = raw.effect;
  if (typeof raw.reason === 'string' && /^[A-Z][A-Z_]{1,79}$/u.test(raw.reason)) safe.reason = raw.reason;
  return safe;
}
export function sanitizeAgentSettingsToolEvent(value: Record<string, unknown>): Record<string, unknown> {
  // Construct a new envelope, so deltas, selections, diffs and future opaque fields cannot bypass redaction.
  const safe: Record<string, unknown> = { phase: value.phase, toolCallId: value.toolCallId, name: AgentSettingsPrivateTool,
    isError: value.isError === true, args: agentSettingsPublicInput(value.args) };
  for (const field of ['result', 'partialResult']) if (value[field] !== undefined) {
    safe[field] = { content: [{ type: 'text', text: JSON.stringify(agentSettingsPublicResult(value[field])) }],
      isError: object(value[field]).isError === true };
  }
  return safe;
}
function toolId(raw: Record<string, unknown>): string | null {
  const metadata = object(raw.metadata);
  for (const value of [metadata.toolUseId, raw.toolCallId, raw.tool_call_id, raw.toolUseId, raw.tool_use_id, raw.id]) if (typeof value === 'string' && value.length <= 256) return value;
  return null;
}
function toolName(raw: Record<string, unknown>): unknown {
  const metadata = object(raw.metadata), fn = object(raw.function);
  return raw.toolName ?? raw.tool_name ?? raw.name ?? metadata.toolName ?? fn.name;
}
export function agentSettingsToolCallIds(messages: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  const visit = (raw: Record<string, unknown>): void => {
    if (isAgentSettingsPrivateTool(toolName(raw))) { const id = toolId(raw); if (id) ids.add(id); }
    for (const field of ['content', 'tool_calls']) if (Array.isArray(raw[field])) for (const entry of raw[field] as unknown[]) {
      const block = object(entry); if (isAgentSettingsPrivateTool(toolName(block))) { const id = toolId(block); if (id) ids.add(id); }
    }
  };
  for (const message of messages) visit(object(message));
  return ids;
}
export function sanitizeAgentSettingsHistory(messages: unknown[], existingIds: ReadonlySet<string> = new Set()): unknown[] {
  const known = new Set([...existingIds, ...agentSettingsToolCallIds(messages)]);
  return messages.map(message => {
    const raw = object(message), role = (typeof raw.role === 'string' ? raw.role : typeof raw.type === 'string' ? raw.type : '').toLowerCase(), id = toolId(raw);
    if (['toolresult', 'tool_result', 'tool'].includes(role) && (isAgentSettingsPrivateTool(toolName(raw)) || id && known.has(id))) {
      const safe: Record<string, unknown> = { role: raw.role, type: raw.type, toolName: AgentSettingsPrivateTool,
        toolCallId: id, content: [{ type: 'text', text: JSON.stringify(agentSettingsPublicResult(raw)) }], isError: raw.isError === true };
      for (const key of ['id', 'timestamp', 'createdAt']) if (typeof raw[key] === 'number' || opaque(raw[key])) safe[key] = raw[key];
      return safe;
    }
    let changed = false;
    const safe = { ...raw };
    for (const field of ['content', 'tool_calls']) {
      if (!Array.isArray(raw[field])) continue;
      safe[field] = (raw[field] as unknown[]).map(entry => {
        const block = object(entry);
        if (!isAgentSettingsPrivateTool(toolName(block))) return entry;
        changed = true;
        const args = agentSettingsPublicInput(block.arguments ?? block.args ?? block.input ?? object(block.function).arguments);
        const result: Record<string, unknown> = { id: toolId(block), type: block.type, name: AgentSettingsPrivateTool, arguments: args };
        if (block.input !== undefined) result.input = args;
        if (block.args !== undefined) result.args = args;
        if (block.function !== undefined) result.function = { name: AgentSettingsPrivateTool, arguments: JSON.stringify(args) };
        return result;
      });
    }
    return changed ? safe : message;
  });
}
