const errorNames = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError', 'AuthSessionRequestError']);
const transportCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'ABORT_ERR', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARGUMENT', 'ERR_HTTP_INVALID_HEADER_VALUE', 'ERR_INVALID_CHAR',
  'ERR_NETWORK', 'ERR_FAILED', 'ERR_ABORTED',
]);
const netCode = /^net::ERR_[A-Z0-9_]{1,64}$/u;

function errorMetadata(error: unknown): { errorName: string; errorCode: string | null } {
  let current = error, errorName = 'Error', errorCode: string | null = null;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth++) {
    const value = current as Record<string, unknown>;
    if (typeof value.name === 'string' && errorNames.has(value.name)) errorName = value.name;
    if (typeof value.code === 'string' && (transportCodes.has(value.code) || netCode.test(value.code))) errorCode = value.code;
    else if (typeof value.message === 'string' && netCode.test(value.message)) errorCode = value.message;
    current = value.originalError ?? value.cause;
  }
  return { errorName, errorCode };
}

/** File part diagnostics only: never log URLs, headers, bodies, filenames or raw errors. */
export async function requestRemoteFilePart(pathname: string, init: RequestInit, send: () => Promise<Response>): Promise<Response> {
  const route = /^\/(?:api\/remote\/v1\/)?(artifact-uploads|input-assets)\/([A-Za-z0-9_-]{1,64})\/parts\/(\d{1,10})$/u.exec(pathname);
  if (init.method !== 'PUT' || !route) return send();
  const metadata = { kind: route[1], assetId: route[2], partNo: Number(route[3]), method: 'PUT',
    requestBytes: init.body instanceof ArrayBuffer ? init.body.byteLength : null };
  const startedAt = Date.now();
  console.debug('[RemoteFileSync] Part request started', metadata);
  try {
    const response = await send();
    const result = { ...metadata, elapsedMs: Math.max(0, Date.now() - startedAt), status: response.status };
    if (response.ok) console.debug('[RemoteFileSync] Part request completed', result);
    else console.warn('[RemoteFileSync] Part request failed', result);
    return response;
  } catch (error) {
    console.warn('[RemoteFileSync] Part request failed', { ...metadata, elapsedMs: Math.max(0, Date.now() - startedAt),
      status: null, ...errorMetadata(error) });
    throw error;
  }
}
