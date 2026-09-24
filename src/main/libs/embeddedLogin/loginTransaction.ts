import crypto from 'crypto';

export interface LoginTransaction {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

/** RFC 7636 S256 parameters for one embedded login; the verifier never leaves the main process. */
export function createLoginTransaction(
  randomBytes: (size: number) => Buffer = crypto.randomBytes,
): LoginTransaction {
  const codeVerifier = randomBytes(32).toString('base64url');
  return {
    state: randomBytes(32).toString('base64url'),
    codeVerifier,
    codeChallenge: crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url'),
  };
}

export function isSameState(expected: string, received: string | null | undefined): boolean {
  if (typeof received !== 'string') return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length
    && crypto.timingSafeEqual(expectedBytes, receivedBytes);
}
