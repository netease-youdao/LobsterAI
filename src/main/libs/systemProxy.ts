import { app, session } from 'electron';

const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const;

type ProxyEnvKey = (typeof PROXY_ENV_KEYS)[number];
type ProxyEnvSnapshot = Record<ProxyEnvKey, string | undefined>;

const originalProxyEnv: ProxyEnvSnapshot = PROXY_ENV_KEYS.reduce((acc, key) => {
  acc[key] = process.env[key];
  return acc;
}, {} as ProxyEnvSnapshot);

let systemProxyEnabled = false;

function setEnvValue(key: ProxyEnvKey, value: string | undefined): void {
  if (typeof value === 'string' && value.length > 0) {
    process.env[key] = value;
    return;
  }
  delete process.env[key];
}

function parseProxyRule(rule: string): string | null {
  const normalizedRule = rule.trim();
  if (!normalizedRule || normalizedRule.toUpperCase() === 'DIRECT') {
    return null;
  }

  // Match standard PAC format: TYPE host:port
  // Strictly match host:port to avoid greedy capture of trailing content like ";SOCKS5 ..."
  const match = normalizedRule.match(/^(PROXY|HTTPS?|SOCKS5?|SOCKS4?)\s+([\w.\-]+:\d+)$/i);
  if (!match) {
    // Also try matching URL format: http://host:port (some proxy tools return URLs directly)
    const urlMatch = normalizedRule.match(/^(https?|socks5?|socks4?):\/\/([\w.\-]+:\d+)\/?$/i);
    if (urlMatch) {
      return `${urlMatch[1].toLowerCase()}://${urlMatch[2]}`;
    }
    return null;
  }

  const type = match[1].toUpperCase();
  const hostPort = match[2];

  if (type === 'HTTPS') {
    return `https://${hostPort}`;
  }
  if (type.startsWith('SOCKS4')) {
    return `socks4://${hostPort}`;
  }
  if (type.startsWith('SOCKS')) {
    return `socks5://${hostPort}`;
  }
  return `http://${hostPort}`;
}

export function isSystemProxyEnabled(): boolean {
  return systemProxyEnabled;
}

export function setSystemProxyEnabled(enabled: boolean): void {
  systemProxyEnabled = enabled;
}

export function restoreOriginalProxyEnv(): void {
  PROXY_ENV_KEYS.forEach((key) => {
    setEnvValue(key, originalProxyEnv[key]);
  });
}

export function applySystemProxyEnv(proxyUrl: string | null): void {
  // Always start from original env so toggling is reversible and predictable.
  restoreOriginalProxyEnv();
  if (!proxyUrl) {
    return;
  }

  setEnvValue('http_proxy', proxyUrl);
  setEnvValue('https_proxy', proxyUrl);
  setEnvValue('HTTP_PROXY', proxyUrl);
  setEnvValue('HTTPS_PROXY', proxyUrl);
}

export async function resolveSystemProxyUrl(targetUrl: string): Promise<string | null> {
  if (!app.isReady()) {
    return null;
  }

  try {
    const proxyResult = await session.defaultSession.resolveProxy(targetUrl);
    if (!proxyResult) {
      return null;
    }

    const rules = proxyResult.split(';');
    for (const rule of rules) {
      const proxyUrl = parseProxyRule(rule);
      if (proxyUrl) {
        return proxyUrl;
      }
    }
  } catch (error) {
    console.error('Failed to resolve system proxy:', error);
  }

  return null;
}
