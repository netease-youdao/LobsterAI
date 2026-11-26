export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

export type PendingApprovalEntry = {
  requestId: string;
  sessionId: string;
  kind: 'exec' | 'plugin';
  allowedDecisions?: ApprovalDecision[];
  /** When true, use 'allow-always' decision so OpenClaw adds the command to its allowlist. */
  allowAlways?: boolean;
};

export type ExecApprovalRequest = {
  [key: string]: unknown;
  command?: string;
  cwd?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  agentId?: string | null;
};

export type PluginApprovalRequest = {
  [key: string]: unknown;
  pluginId?: string | null;
  title?: string;
  description?: string;
  severity?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  allowedDecisions?: string[] | null;
  agentId?: string | null;
  sessionKey?: string | null;
};

