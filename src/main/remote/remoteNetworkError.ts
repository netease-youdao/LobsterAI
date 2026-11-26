import { AuthRefreshFailureKind, AuthSessionStatus } from '../../shared/auth/constants';
import { AuthSessionRequestError } from '../libs/authSessionManager';
import { type RemoteNetworkFailure, remoteNetworkFailureValue } from './remoteNetworkProtocol';

export class RemoteNetworkError extends Error {
  constructor(readonly code: RemoteNetworkFailure) { super(code); this.name = 'RemoteNetworkError'; }
}
/** Unwrap only our authenticated transport boundary, never an arbitrary server/ACK error object. */
export function remoteTransportCause(error: unknown): unknown {
  return error instanceof AuthSessionRequestError && error.status === AuthSessionStatus.TemporarilyUnavailable
    && error.failureKind === AuthRefreshFailureKind.Network && error.originalError !== undefined ? error.originalError : error;
}
export function remoteNetworkFailureCode(error: unknown): RemoteNetworkFailure | null {
  const cause = remoteTransportCause(error);
  if (cause instanceof RemoteNetworkError) return cause.code;
  // Plain local Errors from older/injected transports retain their exact finite identity. A RemoteApiError is excluded.
  return cause instanceof Error && cause.constructor === Error ? remoteNetworkFailureValue(cause.message) : null;
}
const systemCodes = new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','ERR_INVALID_URL',
  'UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET']);
/** Fixed diagnostics only; originalError/cause may contain URLs, tokens and machine paths. */
export function remoteTransportErrorMetadata(error: unknown): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (error instanceof AuthSessionRequestError) {
    if (Object.values(AuthSessionStatus).some(value => value === error.status)) metadata.authStatus = error.status;
    if (Object.values(AuthRefreshFailureKind).some(value => value === error.failureKind)) metadata.authFailureKind = error.failureKind;
  }
  const failure = remoteNetworkFailureCode(error);
  if (failure) metadata.transportFailure = failure;
  const cause = remoteTransportCause(error);
  if (cause !== error && cause instanceof Error) {
    metadata.transportErrorType = ['Error','TypeError','AbortError','TimeoutError','RemoteNetworkError'].includes(cause.name) ? cause.name : 'Error';
  }
  const value = cause as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof value?.code === 'string' && systemCodes.has(value.code) ? value.code
    : typeof value?.cause?.code === 'string' && systemCodes.has(value.cause.code) ? value.cause.code : null;
  if (code) metadata.transportSystemCode = code;
  return metadata;
}
