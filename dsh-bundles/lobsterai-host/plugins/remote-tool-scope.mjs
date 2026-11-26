// Session discovery and native subagent controllers bypass the scoped delegate_agent entry.
const localOnly = new Set([
  'workflow', 'subagent', 'subagent_fork', 'list_agents', 'wait_agent', 'send_message', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
  'lobster_agent_rules',
]);

export function remoteToolDenied(bound, toolName) {
  return Array.isArray(bound?.remoteAllowedAgentIds) && localOnly.has(toolName);
}
