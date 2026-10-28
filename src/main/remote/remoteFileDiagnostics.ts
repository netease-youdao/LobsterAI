import { createHash } from 'crypto';

import { enqueueRemoteLog } from './remoteLogSink';

/** Local diagnostics only. Callers pass fixed labels, IDs and counts, never paths or raw errors. */
export function remoteFileDiagnostic(stage: string, fields: Record<string, string | number | boolean | null | undefined>): void {
  try { enqueueRemoteLog('debug', '[RemoteFileDiagnostic]', { stage, ...fields }); }
  catch { /* Diagnostics must never affect delivery. */ }
}

export function remoteFileDiagnosticKey(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 16);
}

export type DeliveryRejectionDiagnostic = (reason: string) => void;
export function reportDeliveryRejection(report: DeliveryRejectionDiagnostic | undefined, reason: string): null {
  try { report?.(reason); } catch { /* Optional diagnostics cannot change file admission. */ }
  return null;
}
