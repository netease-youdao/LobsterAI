import {
  type BrowserCredentialLoginState,
  type BrowserCredentialSaveDecision,
  BrowserCredentialSaveMode,
  type BrowserCredentialSaveMode as BrowserCredentialSaveModeValue,
  type BrowserCredentialSavePrompt,
  BrowserCredentialUseMode,
  type BrowserCredentialUseMode as BrowserCredentialUseModeValue,
} from '../browserCredentials/constants';

export const BrowserProfileMode = {
  Managed: 'managed',
  User: 'user',
  Custom: 'custom',
} as const;

export type BrowserProfileMode = typeof BrowserProfileMode[keyof typeof BrowserProfileMode];

export const BrowserRuntimeProfile = {
  Managed: 'openclaw',
  InApp: 'lobster-in-app',
  User: 'user',
} as const;

export type BrowserRuntimeProfile = typeof BrowserRuntimeProfile[keyof typeof BrowserRuntimeProfile];

export const AgentBrowserPartition = {
  Default: 'persist:lobster-agent-browser',
} as const;

export type AgentBrowserPartition =
  typeof AgentBrowserPartition[keyof typeof AgentBrowserPartition];

export const BrowserDisplayMode = {
  InApp: 'in-app',
  External: 'external',
} as const;

export type BrowserDisplayMode = typeof BrowserDisplayMode[keyof typeof BrowserDisplayMode];

export const BrowserNetworkMode = {
  ProxyCompatible: 'proxy-compatible',
  Strict: 'strict',
} as const;

export type BrowserNetworkMode = typeof BrowserNetworkMode[keyof typeof BrowserNetworkMode];

export const BrowserSnapshotMode = {
  Default: 'default',
  Efficient: 'efficient',
} as const;

export type BrowserSnapshotMode = typeof BrowserSnapshotMode[keyof typeof BrowserSnapshotMode];

export const BrowserDiagnosticStep = {
  GatewayStatus: 'gateway-status',
  Profiles: 'profiles',
  BrowserStatus: 'browser-status',
  BrowserStart: 'browser-start',
  OpenTestPage: 'open-test-page',
} as const;

export type BrowserDiagnosticStep = typeof BrowserDiagnosticStep[keyof typeof BrowserDiagnosticStep];

export const BrowserDiagnosticStatus = {
  Success: 'success',
  Warning: 'warning',
  Error: 'error',
} as const;

export type BrowserDiagnosticStatus = typeof BrowserDiagnosticStatus[keyof typeof BrowserDiagnosticStatus];

export const BrowserIpc = {
  GetStatus: 'openclaw:browser:getStatus',
  ListProfiles: 'openclaw:browser:listProfiles',
  Test: 'openclaw:browser:test',
  ResetProfile: 'openclaw:browser:resetProfile',
  GetHostState: 'openclaw:browser:getHostState',
  SetHostView: 'openclaw:browser:setHostView',
  NavigateHost: 'openclaw:browser:navigateHost',
  GoBackHost: 'openclaw:browser:goBackHost',
  GoForwardHost: 'openclaw:browser:goForwardHost',
  ReloadHost: 'openclaw:browser:reloadHost',
  StopHost: 'openclaw:browser:stopHost',
  SelectHostPage: 'openclaw:browser:selectHostPage',
  CloseHostPage: 'openclaw:browser:closeHostPage',
  DismissCredentialLoginStatus: 'openclaw:browser:dismissCredentialLoginStatus',
  ResolveCredentialSavePrompt: 'openclaw:browser:resolveCredentialSavePrompt',
  HostState: 'openclaw:browser:hostState',
} as const;

export type BrowserIpc = typeof BrowserIpc[keyof typeof BrowserIpc];

export const BrowserControlRequestMethod = {
  Get: 'GET',
  Post: 'POST',
  Delete: 'DELETE',
} as const;

export type BrowserControlRequestMethod =
  typeof BrowserControlRequestMethod[keyof typeof BrowserControlRequestMethod];

export const OpenClawBrowserGatewayMethod = {
  Request: 'browser.request',
} as const;

export interface BrowserControlGatewayRequest {
  method: BrowserControlRequestMethod;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface BrowserWebFetchConfig {
  enabled: boolean;
  followGlobalProxy: boolean;
  timeoutSeconds?: number;
  maxRedirects?: number;
  maxChars?: number;
  userAgent?: string;
  readability: boolean;
  allowRfc2544BenchmarkRange?: boolean;
}

export interface BrowserWebAccessConfig {
  browserEnabled: boolean;
  profileMode: BrowserProfileMode;
  displayMode: BrowserDisplayMode;
  networkMode: BrowserNetworkMode;
  followGlobalProxy: boolean;
  allowedHostnames: string[];
  blockedHostnames: string[];
  snapshotMode: BrowserSnapshotMode;
  evaluateEnabled: boolean;
  credentialUseMode: BrowserCredentialUseModeValue;
  credentialSaveMode: BrowserCredentialSaveModeValue;
  executablePath?: string;
  cdpUrl?: string;
  headless?: boolean;
  attachOnly?: boolean;
  remoteCdpTimeoutMs?: number;
  remoteCdpHandshakeTimeoutMs?: number;
  extraArgs?: string[];
  webFetch: BrowserWebFetchConfig;
}

export const AgentBrowserToolPhase = {
  Start: 'start',
  Update: 'update',
  Result: 'result',
} as const;

export type AgentBrowserToolPhase =
  typeof AgentBrowserToolPhase[keyof typeof AgentBrowserToolPhase];

export interface AgentBrowserToolEvent {
  sessionId: string;
  phase: AgentBrowserToolPhase;
  action?: string;
  profile?: string;
  targetId?: string;
  isError?: boolean;
}

export interface AgentBrowserHostTab {
  pageId: number;
  title: string;
  url: string;
  selected: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface AgentBrowserHostState {
  tabs: AgentBrowserHostTab[];
  selectedPageId?: number;
  visible: boolean;
  updatedAt: number;
  credentialLogin?: BrowserCredentialLoginState;
  credentialSavePrompt?: BrowserCredentialSavePrompt;
  error?: string;
}

export interface AgentBrowserHostStateEvent {
  sessionId?: string;
  state: AgentBrowserHostState;
}

export interface AgentBrowserHostRequest {
  sessionId?: string;
}

export interface AgentBrowserHostSetViewRequest extends AgentBrowserHostRequest {
  visible: boolean;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface AgentBrowserHostNavigateRequest extends AgentBrowserHostRequest {
  url: string;
}

export interface AgentBrowserHostPageRequest extends AgentBrowserHostRequest {
  pageId: number;
}

export interface AgentBrowserCredentialSavePromptRequest extends AgentBrowserHostRequest {
  requestId: string;
  decision: BrowserCredentialSaveDecision;
}

export interface AgentBrowserHostResponse {
  success: boolean;
  state?: AgentBrowserHostState;
  error?: string;
}

export interface BrowserDiagnosticResultStep {
  step: BrowserDiagnosticStep;
  status: BrowserDiagnosticStatus;
  message: string;
  details?: string;
}

export interface BrowserDiagnosticResult {
  success: boolean;
  steps: BrowserDiagnosticResultStep[];
  error?: string;
}

export const defaultBrowserWebAccessConfig: BrowserWebAccessConfig = {
  browserEnabled: true,
  profileMode: BrowserProfileMode.Managed,
  displayMode: BrowserDisplayMode.External,
  networkMode: BrowserNetworkMode.ProxyCompatible,
  followGlobalProxy: true,
  allowedHostnames: [],
  blockedHostnames: [],
  snapshotMode: BrowserSnapshotMode.Efficient,
  evaluateEnabled: true,
  credentialUseMode: BrowserCredentialUseMode.AlwaysAsk,
  credentialSaveMode: BrowserCredentialSaveMode.Ask,
  webFetch: {
    enabled: true,
    followGlobalProxy: true,
    readability: true,
  },
};

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
};

const normalizeOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value > 0 ? value : undefined;
};

export const normalizeBrowserStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean),
  ));
};

const BrowserUrlProtocol = {
  Http: 'http:',
  Https: 'https:',
  Ws: 'ws:',
  Wss: 'wss:',
} as const;

type BrowserUrlProtocol = typeof BrowserUrlProtocol[keyof typeof BrowserUrlProtocol];

const BrowserAccessRootDomainSuffixes = new Set([
  'ai',
  'app',
  'biz',
  'cc',
  'cn',
  'co',
  'com',
  'dev',
  'edu',
  'gov',
  'info',
  'io',
  'me',
  'net',
  'org',
  'tv',
]);

const BrowserAccessCompoundDomainSuffixes = new Set([
  'co.uk',
  'com.au',
  'com.cn',
  'com.hk',
  'com.tw',
  'net.cn',
  'org.cn',
]);

const BrowserAccessUrlSchemePattern = /^([a-z][a-z0-9+.-]*):\/\//i;
const BrowserIpv4HostnamePattern = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const resolveBrowserAccessProtocol = (value: string): BrowserUrlProtocol => {
  const match = value.trim().match(BrowserAccessUrlSchemePattern);
  if (!match) {
    return BrowserUrlProtocol.Https;
  }

  const protocol = `${match[1].toLowerCase()}:`;
  return protocol === BrowserUrlProtocol.Http || protocol === BrowserUrlProtocol.Https
    ? protocol
    : BrowserUrlProtocol.Https;
};

const parseBrowserHostnameEntry = (value: string): { hostname: string; port?: string } | null => {
  const withoutProtocol = value.trim().replace(BrowserAccessUrlSchemePattern, '');
  const withoutAuth = withoutProtocol.includes('@')
    ? withoutProtocol.slice(withoutProtocol.lastIndexOf('@') + 1)
    : withoutProtocol;
  const hostWithPort = (withoutAuth.split(/[/?#]/, 1)[0] ?? '').trim().toLowerCase();
  if (!hostWithPort) {
    return null;
  }

  if (hostWithPort.startsWith('[')) {
    const ipv6Match = hostWithPort.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!ipv6Match) {
      return null;
    }
    return { hostname: ipv6Match[1], port: ipv6Match[2] };
  }

  if ((hostWithPort.match(/:/g) ?? []).length > 1) {
    return { hostname: hostWithPort };
  }

  const hostPortMatch = hostWithPort.match(/^(.+?)(?::(\d+))?$/);
  const hostname = hostPortMatch?.[1]?.replace(/\.+$/, '') ?? '';
  if (!hostname || /\s/.test(hostname)) {
    return null;
  }

  return { hostname, port: hostPortMatch?.[2] };
};

const shouldAddBrowserWwwPrefix = (hostname: string): boolean => {
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.startsWith('*.')
    || hostname.startsWith('www.')
    || hostname.includes(':')
    || BrowserIpv4HostnamePattern.test(hostname)
  ) {
    return false;
  }

  const labels = hostname.split('.').filter(Boolean);
  if (labels.length === 2) {
    return BrowserAccessRootDomainSuffixes.has(labels[1]);
  }

  if (labels.length === 3) {
    return BrowserAccessCompoundDomainSuffixes.has(`${labels[1]}.${labels[2]}`);
  }

  return false;
};

const normalizeBrowserAccessHostname = (hostname: string): string => {
  const normalized = hostname.toLowerCase().replace(/\.+$/, '');
  if (!normalized) {
    return '';
  }
  return shouldAddBrowserWwwPrefix(normalized) ? `www.${normalized}` : normalized;
};

const formatBrowserUrlHostname = (hostname: string): string => (
  hostname.includes(':') && !hostname.startsWith('*.') ? `[${hostname}]` : hostname
);

const normalizeBrowserAccessUrl = (value: string): string => {
  const parsed = parseBrowserHostnameEntry(value);
  if (!parsed) {
    return '';
  }

  const hostname = normalizeBrowserAccessHostname(parsed.hostname);
  if (!hostname) {
    return '';
  }

  if (hostname.startsWith('*.')) {
    return hostname;
  }

  const port = parsed.port ? `:${parsed.port}` : '';
  return `${resolveBrowserAccessProtocol(value)}//${formatBrowserUrlHostname(hostname)}${port}`;
};

export const normalizeBrowserHostnameList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map(item => normalizeBrowserAccessUrl(item))
      .filter(Boolean),
  ));
};

export const normalizeBrowserHostnamePolicyList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map(item => parseBrowserHostnameEntry(item)?.hostname.toLowerCase().replace(/\.+$/, '') ?? '')
      .filter(Boolean),
  ));
};

export const normalizeBrowserCdpUrl = (value: unknown): string | undefined => {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  try {
    const parsed = new URL(normalized);
    return [
      BrowserUrlProtocol.Http,
      BrowserUrlProtocol.Https,
      BrowserUrlProtocol.Ws,
      BrowserUrlProtocol.Wss,
    ].includes(parsed.protocol as BrowserUrlProtocol) ? normalized : undefined;
  } catch {
    return undefined;
  }
};

export const normalizeBrowserWebAccessConfig = (
  value: Partial<BrowserWebAccessConfig> | undefined | null,
): BrowserWebAccessConfig => {
  const webFetch: Partial<BrowserWebFetchConfig> = value?.webFetch ?? {};
  const profileMode = Object.values(BrowserProfileMode).includes(value?.profileMode as BrowserProfileMode)
    ? value?.profileMode as BrowserProfileMode
    : defaultBrowserWebAccessConfig.profileMode;
  const displayMode = Object.values(BrowserDisplayMode).includes(value?.displayMode as BrowserDisplayMode)
    ? value?.displayMode as BrowserDisplayMode
    : value?.headless === false
      ? BrowserDisplayMode.External
      : defaultBrowserWebAccessConfig.displayMode;
  const networkMode = Object.values(BrowserNetworkMode).includes(value?.networkMode as BrowserNetworkMode)
    ? value?.networkMode as BrowserNetworkMode
    : defaultBrowserWebAccessConfig.networkMode;
  const snapshotMode = Object.values(BrowserSnapshotMode).includes(value?.snapshotMode as BrowserSnapshotMode)
    ? value?.snapshotMode as BrowserSnapshotMode
    : defaultBrowserWebAccessConfig.snapshotMode;
  const credentialUseMode = Object.values(BrowserCredentialUseMode).includes(
    value?.credentialUseMode as BrowserCredentialUseModeValue,
  )
    ? value?.credentialUseMode as BrowserCredentialUseModeValue
    : defaultBrowserWebAccessConfig.credentialUseMode;
  const credentialSaveMode = Object.values(BrowserCredentialSaveMode).includes(
    value?.credentialSaveMode as BrowserCredentialSaveModeValue,
  )
    ? value?.credentialSaveMode as BrowserCredentialSaveModeValue
    : defaultBrowserWebAccessConfig.credentialSaveMode;
  const executablePath = normalizeOptionalString(value?.executablePath);
  const cdpUrl = normalizeBrowserCdpUrl(value?.cdpUrl);
  const remoteCdpTimeoutMs = normalizeOptionalNumber(value?.remoteCdpTimeoutMs);
  const remoteCdpHandshakeTimeoutMs = normalizeOptionalNumber(value?.remoteCdpHandshakeTimeoutMs);
  const extraArgs = normalizeBrowserStringList(value?.extraArgs);
  const timeoutSeconds = normalizeOptionalNumber(webFetch.timeoutSeconds);
  const maxRedirects = normalizeOptionalNumber(webFetch.maxRedirects);
  const maxChars = normalizeOptionalNumber(webFetch.maxChars);
  const userAgent = normalizeOptionalString(webFetch.userAgent);

  return {
    browserEnabled: value?.browserEnabled ?? defaultBrowserWebAccessConfig.browserEnabled,
    profileMode,
    displayMode,
    networkMode,
    followGlobalProxy: value?.followGlobalProxy ?? defaultBrowserWebAccessConfig.followGlobalProxy,
    allowedHostnames: normalizeBrowserHostnameList(value?.allowedHostnames),
    blockedHostnames: normalizeBrowserHostnameList(value?.blockedHostnames),
    snapshotMode,
    evaluateEnabled: value?.evaluateEnabled ?? defaultBrowserWebAccessConfig.evaluateEnabled,
    credentialUseMode,
    credentialSaveMode,
    ...(executablePath ? { executablePath } : {}),
    ...(cdpUrl ? { cdpUrl } : {}),
    ...(value?.attachOnly === true ? { attachOnly: true } : {}),
    ...(remoteCdpTimeoutMs ? { remoteCdpTimeoutMs } : {}),
    ...(remoteCdpHandshakeTimeoutMs ? { remoteCdpHandshakeTimeoutMs } : {}),
    ...(extraArgs.length ? { extraArgs } : {}),
    webFetch: {
      enabled: webFetch.enabled ?? defaultBrowserWebAccessConfig.webFetch.enabled,
      followGlobalProxy: webFetch.followGlobalProxy ?? defaultBrowserWebAccessConfig.webFetch.followGlobalProxy,
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
      ...(maxRedirects ? { maxRedirects } : {}),
      ...(maxChars ? { maxChars } : {}),
      ...(userAgent ? { userAgent } : {}),
      readability: webFetch.readability ?? defaultBrowserWebAccessConfig.webFetch.readability,
      ...(webFetch.allowRfc2544BenchmarkRange === true ? { allowRfc2544BenchmarkRange: true } : {}),
    },
  };
};
