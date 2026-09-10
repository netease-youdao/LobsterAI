/** The local Gateway must route both approval kinds to the desktop operator connection. */
export const OPENCLAW_DESKTOP_GATEWAY_CAPS = ['tool-events', 'approvals'] as const;

/** Public task approval facts. The local request body and dispatch evidence never cross IPC. */
export interface ApprovalState {
  requestId: string;
  sessionId: string;
  runId: string | null;
  approvalVersion: string;
  operationDigest: string;
  title: string;
  summary: string;
  expiresAt: string | null;
  remoteAllowed: boolean;
  requiresLocalAction: boolean;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'superseded';
  resolvedAt: string | null;
  resolution: {
    phase: 'idle' | 'submitting' | 'unknown' | 'finished';
    source: 'desktop' | 'mobile' | 'system' | 'unknown' | null;
    confirmedDecision: 'approve' | 'deny' | null;
    confirmedAt: string | null;
  };
}

export interface ApprovalDecisionOptions {
  submissionId: string;
  source: 'desktop' | 'mobile' | 'system';
  expectedVersion?: string;
  operationDigest?: string;
  /** Recheck actor and, for mobile, the first dispatch execution permit. */
  beforeDispatch?: () => void | Promise<void>;
  /** Main-process-only synchronous hook consuming the first dispatch permit. */
  onDispatch?: () => void;
}

export interface ApprovalDecisionOutcome {
  kind: 'confirmed' | 'known_not_applied' | 'unknown';
  decision?: 'approve' | 'deny';
  reason?: string;
  state?: ApprovalState;
}

export interface ApprovalReconcileOptions { canProveNeverDispatched?: boolean }
export interface DualApprovalConfiguration { enabled: boolean; projectionSupported: boolean }
