export const IMPairingIpc = {
  List: 'im:pairing:list',
  Approve: 'im:pairing:approve',
  Reject: 'im:pairing:reject',
} as const;

export const OpenClawPairingMethod = {
  List: 'channels.pairing.list',
  Approve: 'channels.pairing.approve',
  Dismiss: 'channels.pairing.dismiss',
} as const;

export const IMPairingFailure = {
  Unavailable: 'imPairingGatewayUnavailable',
  InvalidTarget: 'imPairingInvalidTarget',
  NotFound: 'imPairingRequestNotFound',
  Ambiguous: 'imPairingCodeAmbiguous',
  InvalidResponse: 'imPairingInvalidResponse',
} as const;
export type IMPairingFailure = typeof IMPairingFailure[keyof typeof IMPairingFailure];

export interface IMPairingRequest {
  id: string;
  requestId: string;
  channel: string;
  accountId: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
}

export interface IMPairingAccount {
  channel: string;
  accountId: string;
  allowFrom: string[];
}

export interface IMPairingListResult {
  success: boolean;
  requests: IMPairingRequest[];
  accounts: IMPairingAccount[];
  /** Display-only union; each account's actual policy remains owned by OpenClaw. */
  allowFrom: string[];
  error?: string;
}
