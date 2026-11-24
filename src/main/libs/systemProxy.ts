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
let activeSystemProxyUrl: string | null = null;

export const DEFAULT_PROXY_RESOLUTION_TARGETS = [
  'https://api.openai.com',
  'https://api.anthropic.com',
  'https://generativelanguage.googleapis.com',
  'https://openrouter.ai',
] as const;

export const DEFAULT_PROXY_OPERATION_TIMEOUT_MS = 2_000;

export function runWithProxyTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

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

export function setActiveSystemProxyUrl(proxyUrl: string | null): void {
  activeSystemProxyUrl = proxyUrl;
}

export function getActiveSystemProxyUrl(): string | null {
  return activeSystemProxyUrl;
}

export function restoreOriginalProxyEnv(): void {
  PROXY_ENV_KEYS.forEach((key) => {
    setEnvValue(key, originalProxyEnv[key]);
  });
  setActiveSystemProxyUrl(null);
}

export function applySystemProxyEnv(proxyUrl: string | null): void {
  // Always start from original env so toggling is reversible and predictable.
  restoreOriginalProxyEnv();
  setActiveSystemProxyUrl(proxyUrl);
  if (!proxyUrl) {
    return;
  }

  setEnvValue('http_proxy', proxyUrl);
  setEnvValue('https_proxy', proxyUrl);
  setEnvValue('HTTP_PROXY', proxyUrl);
  setEnvValue('HTTPS_PROXY', proxyUrl);
}

export async function setSessionProxyModeWithTimeout(
  mode: 'system' | 'direct',
  timeoutMs: number = DEFAULT_PROXY_OPERATION_TIMEOUT_MS,
): Promise<boolean> {
  if (!app.isReady()) {
    return false;
  }

  try {
    await runWithProxyTimeout(
      session.defaultSession.setProxy({ mode }),
      timeoutMs,
      `session.setProxy(${mode})`,
    );
    return true;
  } catch (error) {
    console.warn(`[SystemProxy] Failed to apply session proxy mode (${mode}):`, error);
    return false;
  }
}

export async function resolveSystemProxyUrl(
  targetUrl: string,
  timeoutMs: number = DEFAULT_PROXY_OPERATION_TIMEOUT_MS,
): Promise<string | null> {
  if (!app.isReady()) {
    return null;
  }

  try {
    const proxyResult = await runWithProxyTimeout(
      session.defaultSession.resolveProxy(targetUrl),
      timeoutMs,
      `session.resolveProxy(${targetUrl})`,
    );
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
    console.warn(`[SystemProxy] Failed to resolve system proxy for ${targetUrl}:`, error);
  }

  return null;
}

export async function resolveProxyForTargetsWithResolver(
  targetUrls: readonly string[],
  resolver: (targetUrl: string, timeoutMs: number) => Promise<string | null>,
  timeoutMs: number = DEFAULT_PROXY_OPERATION_TIMEOUT_MS,
): Promise<{ proxyUrl: string | null; targetUrl: string | null }> {
  if (targetUrls.length === 0) {
    return { proxyUrl: null, targetUrl: null };
  }

  // Probe all targets concurrently under a single bounded timeout so a slow
  // PAC/WPAD lookup cannot multiply across targets, while preserving target
  // priority order when selecting the result.
  const results = await Promise.all(
    targetUrls.map(async (targetUrl) => ({
      targetUrl,
      proxyUrl: await resolver(targetUrl, timeoutMs).catch((): null => null),
    })),
  );

  for (const result of results) {
    if (result.proxyUrl) {
      return result;
    }
  }

  return { proxyUrl: null, targetUrl: null };
}

export async function resolveSystemProxyUrlForTargets(
  targetUrls: readonly string[] = DEFAULT_PROXY_RESOLUTION_TARGETS,
  timeoutMs: number = DEFAULT_PROXY_OPERATION_TIMEOUT_MS,
): Promise<{ proxyUrl: string | null; targetUrl: string | null }> {
  return resolveProxyForTargetsWithResolver(targetUrls, resolveSystemProxyUrl, timeoutMs);
}
