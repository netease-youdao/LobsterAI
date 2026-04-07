/**
 * Safe logging for api:fetch / api:stream — avoids writing credentials or response
 * bodies to electron-log at info level.
 */

export function sanitizeUrlForApiProxyLog(urlString: string): string {
  try {
    const u = new URL(urlString);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(invalid-url)';
  }
}

export function responsePayloadByteLength(data: string | object): number {
  if (typeof data === 'string') {
    return Buffer.byteLength(data, 'utf8');
  }
  try {
    return Buffer.byteLength(JSON.stringify(data), 'utf8');
  } catch {
    return 0;
  }
}

export function logApiProxyRequestDebug(
  method: string,
  urlString: string,
  headers: Record<string, string>,
  body: string | undefined,
): void {
  const safeUrl = sanitizeUrlForApiProxyLog(urlString);
  const bodyBytes = body != null ? Buffer.byteLength(body, 'utf8') : 0;
  console.debug(
    `[ApiProxy] Starting ${method} request to ${safeUrl} with ${Object.keys(headers).length} request headers and a ${bodyBytes}-byte body`,
  );
}

export function logApiProxyResponseDebug(
  method: string,
  urlString: string,
  status: number,
  statusText: string,
  data: string | object,
): void {
  const safeUrl = sanitizeUrlForApiProxyLog(urlString);
  const bytes = responsePayloadByteLength(data);
  console.debug(
    `[ApiProxy] Received ${method} response from ${safeUrl}: HTTP ${status} ${statusText}, ${bytes} bytes in body`,
  );
}
