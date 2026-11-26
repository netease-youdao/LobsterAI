export const RemoteEnvironment = {
  Production: 'production',
  Test: 'test',
} as const;
export type RemoteEnvironment = typeof RemoteEnvironment[keyof typeof RemoteEnvironment];

const legacyEnvironments: Record<RemoteEnvironment, readonly string[]> = {
  [RemoteEnvironment.Production]: ['https://lobsterai-server.youdao.com'],
  [RemoteEnvironment.Test]: [
    'https://lobsterai-server.inner.youdao.com',
    'https://lobsterai-server-dev.inner.youdao.com',
    'https://lobsterai-server-test.youdao.com',
  ],
};

function normalizeLegacyUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
  } catch { return value; }
}

function canonicalEnvironment(value: string): string {
  const normalized = normalizeLegacyUrl(value);
  return Object.values(RemoteEnvironment).find(mode => legacyEnvironments[mode].includes(normalized)) ?? value;
}

/** Compare historical local scopes without rewriting signed deletion evidence. */
export function sameRemoteEnvironment(left: string, right: string): boolean {
  return canonicalEnvironment(left) === canonicalEnvironment(right);
}

/** URL aliases are only used to migrate records written before client mode was stored. */
export function legacyRemoteEnvironments(environment: RemoteEnvironment, apiBaseUrl: string): string[] {
  const current = normalizeLegacyUrl(apiBaseUrl);
  const known = canonicalEnvironment(current);
  const belongsToOtherMode = Object.values(RemoteEnvironment).some(mode => mode !== environment && mode === known);
  return [...new Set([...legacyEnvironments[environment], ...(!belongsToOtherMode && current !== environment ? [current] : [])])];
}
