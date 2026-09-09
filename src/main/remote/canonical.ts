import { createHash } from 'crypto';

/** Protocol canonical JSON: recursive lexical keys, ordered arrays, unescaped UTF-8. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('Remote payload must contain finite JSON values');
}
export const payloadHash = (value: unknown): string => createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
export const sameOwner = (a: { userId: string; scopeKey: string } | null, b: { userId: string; scopeKey: string } | null): boolean =>
  a !== null && b !== null && a.userId === b.userId && a.scopeKey === b.scopeKey;

export function remoteError(code: number, reason: string, message: string): { code: number; reason: string; message: string; retryable: boolean; retryAfterMs: null; reasonDetail: null } {
  return { code, reason, message: Buffer.from(message).subarray(0, 1000).toString('utf8').replace(/\uFFFD$/u, ''), retryable: false, retryAfterMs: null, reasonDetail: null };
}
