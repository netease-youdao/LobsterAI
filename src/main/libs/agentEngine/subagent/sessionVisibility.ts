/** Hide only proven same-agent spawn records; forks and delegated expert work stay visible. */
export const VISIBLE_COWORK_SESSION_SQL = `NOT EXISTS (
  SELECT 1 FROM subagent_runs r
  JOIN cowork_sessions parent ON parent.id = r.parent_session_id
  WHERE r.child_cowork_session_id = s.id
    AND s.parent_session_id = parent.id
    AND COALESCE(NULLIF(TRIM(s.agent_id), ''), 'main')
      = COALESCE(NULLIF(TRIM(parent.agent_id), ''), 'main')
)`;
