export interface CoworkSessionDiagnosticsSessionRow {
  id: string;
  title: string;
  claude_session_id: string | null;
  status: string;
  pinned: number | null;
  pin_order: number | null;
  cwd: string | null;
  system_prompt: string | null;
  model_override: string | null;
  execution_mode: string | null;
  parent_session_id: string | null;
  forked_from_message_id: string | null;
  forked_at: number | null;
  fork_mode: string | null;
  fork_workspace_path: string | null;
  fork_git_branch: string | null;
  fork_git_base_ref: string | null;
  goal_json: string | null;
  active_skill_ids: string | null;
  agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface CoworkSessionDiagnosticsMessageRow {
  id: string;
  session_id: string;
  type: string;
  content: string;
  metadata: string | null;
  created_at: number;
  sequence: number | null;
}

export interface CoworkSessionDiagnosticsCapsuleRow {
  session_id: string;
  version: number;
  revision: number;
  capsule_json: string;
  updated_at: number;
  last_source: string;
  last_compacted_at: number | null;
}

export interface CoworkSessionDiagnosticsAgentSnapshot {
  id: string;
  name: string;
  model: string;
  source: string;
  presetId: string;
  isDefault: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CoworkSessionDiagnosticsData {
  session: CoworkSessionDiagnosticsSessionRow;
  messages: CoworkSessionDiagnosticsMessageRow[];
  capsule: CoworkSessionDiagnosticsCapsuleRow | null;
  agent: CoworkSessionDiagnosticsAgentSnapshot | null;
}
