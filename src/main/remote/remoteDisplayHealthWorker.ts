import { collectRemoteDisplayHealth, RemoteDisplayHealthFailure, type RemoteDisplayHealthInput, RemoteDisplayHealthStatus } from './remoteDisplayHealth';
import { collectOwnershipContentSync, type OwnershipContentSyncInput } from './remoteOwnershipContentSync';

// This process has no writer, network or credential API. Its supervisor owns the hard deadline.
process.once('message', (request: { type?: string; jobId?: string; input?: RemoteDisplayHealthInput | OwnershipContentSyncInput }) => {
  const jobId = request.jobId;
  if (request.type !== 'remote.history.job' || typeof jobId !== 'string' || !/^[a-f0-9-]{36}$/u.test(jobId) || !request.input) {
    process.send?.({ jobId, error: RemoteDisplayHealthFailure.Unavailable }, () => process.exit(1));
    return;
  }
  try {
    const result = 'contentTaskId' in request.input ? collectOwnershipContentSync(request.input) : collectRemoteDisplayHealth(request.input);
    process.send?.({ jobId, result }, () => process.exit(0));
  } catch {
    process.send?.({ jobId, result: { status: RemoteDisplayHealthStatus.Unknown, observedAt: Date.now(), reason: RemoteDisplayHealthFailure.Unavailable } }, () => process.exit(1));
  }
});
