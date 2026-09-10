import type { ApprovalDecisionOutcome } from '../../shared/cowork/approval';
import { remoteError } from './canonical';

/** Only explicit executor evidence can turn an approval attempt into not_applied. */
export class RemoteApprovalError extends Error {
  constructor(readonly outcome: ApprovalDecisionOutcome) { super(outcome.reason || 'Approval result is unknown'); }
}
export function approvalCommandError(reason = 'APPROVAL_STALE'): Omit<ReturnType<typeof remoteError>, 'reasonDetail'> & { reasonDetail: string } {
  const code = /EXPIRED|PERMIT_EXPIRED/u.test(reason) ? 47018 : /UNSUPPORTED|UNAVAILABLE|LOCAL_ONLY/u.test(reason) ? 47017 : 47007;
  return { ...remoteError(code, code === 47018 ? 'COMMAND_EXPIRED' : code === 47017 ? 'CAPABILITY_UNSUPPORTED' : 'APPROVAL_STALE', 'Approval is no longer available for this submission'), reasonDetail: reason };
}
