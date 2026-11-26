import { AsyncLocalStorage } from 'node:async_hooks';

import type { RemoteTelemetryRequestTracker } from './remoteTelemetry';

const requestContext = new AsyncLocalStorage<RemoteTelemetryRequestTracker>();

/** Auth retries inherit one logical request; physical sends are counted by the transport. */
export function withRemoteTelemetryRequest<T>(tracker: RemoteTelemetryRequestTracker, callback: () => T): T {
  return requestContext.run(tracker, callback);
}
export function currentRemoteTelemetryRequest(): RemoteTelemetryRequestTracker | undefined {
  return requestContext.getStore();
}
