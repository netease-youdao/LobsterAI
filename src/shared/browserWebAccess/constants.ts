import {
  type BrowserCredentialLoginState,
  type BrowserCredentialSaveDecision,
  BrowserCredentialSaveMode,
  type BrowserCredentialSaveMode as BrowserCredentialSaveModeValue,
  type BrowserCredentialSavePrompt,
  BrowserCredentialUseMode,
  type BrowserCredentialUseMode as BrowserCredentialUseModeValue,
} from '../browserCredentials/constants';
import type { BrowserPasskeyNotice } from './passkeys';

export const AgentBrowserMcpServerName = 'lobster-browser';
export const AgentBrowserMcpToolPrefix = `mcp__${AgentBrowserMcpServerName}__`;

export const AgentBrowserPartition = {
  Default: 'persist:lobster-agent-browser',
} as const;

export type AgentBrowserPartition =
  typeof AgentBrowserPartition[keyof typeof AgentBrowserPartition];

export const AgentBrowserPageUrl = {
  Blank: 'about:blank',
} as const;

export const AgentBrowserNavigation = {
  Url: 'url',
  Back: 'back',
  Forward: 'forward',
  Reload: 'reload',
} as const;

export const AgentBrowserZoom = {
  Min: 0.25,
  Max: 3,
  Step: 0.1,
  Default: 1,
} as const;

export const AgentBrowserHostMenuAction = {
  CaptureScreenshot: 'capture-screenshot',
  NewBlankPage: 'new-blank-page',
  ZoomOut: 'zoom-out',
  ResetZoom: 'reset-zoom',
  ZoomIn: 'zoom-in',
  ClearCookies: 'clear-cookies',
  ClearCache: 'clear-cache',
} as const;

export type AgentBrowserHostMenuAction =
  typeof AgentBrowserHostMenuAction[keyof typeof AgentBrowserHostMenuAction];

export const BrowserDisplayMode = {
  InApp: 'in-app',
  External: 'external',
} as const;

export type BrowserDisplayMode = typeof BrowserDisplayMode[keyof typeof BrowserDisplayMode];

/**
 * Migration version for the persisted browser display setting.
 * v3 keeps the chosen mode and external connection settings on DSH upgrades.
 */
export const BROWSER_DISPLAY_MODE_MIGRATION_VERSION = 3;

const BrowserSearchUrlPrefix = {
  Baidu: 'https://www.baidu.com/s?wd=',
  Bing: 'https://www.bing.com/search?q=',
} as const;

/** Search URL for address-bar text that is not a URL; reachable without a proxy in China. */
export const buildBrowserSearchUrl = (query: string, language?: string): string => (
  `${language === 'zh' ? BrowserSearchUrlPrefix.Baidu : BrowserSearchUrlPrefix.Bing}${encodeURIComponent(query)}`
);

export const BrowserIpc = {
  GetHostState: 'openclaw:browser:getHostState',
  SetHostView: 'openclaw:browser:setHostView',
  NavigateHost: 'openclaw:browser:navigateHost',
  GoBackHost: 'openclaw:browser:goBackHost',
  GoForwardHost: 'openclaw:browser:goForwardHost',
  ReloadHost: 'openclaw:browser:reloadHost',
  StopHost: 'openclaw:browser:stopHost',
  CreateHostPage: 'openclaw:browser:createHostPage',
  SelectHostPage: 'openclaw:browser:selectHostPage',
  CloseHostPage: 'openclaw:browser:closeHostPage',
  ShowHostMenu: 'openclaw:browser:showHostMenu',
  CaptureHostScreenshot: 'openclaw:browser:captureHostScreenshot',
  SetHostZoom: 'openclaw:browser:setHostZoom',
  ClearHostCookies: 'openclaw:browser:clearHostCookies',
  ClearHostCache: 'openclaw:browser:clearHostCache',
  DismissCredentialLoginStatus: 'openclaw:browser:dismissCredentialLoginStatus',
  ResolveCredentialSavePrompt: 'openclaw:browser:resolveCredentialSavePrompt',
  ResolvePasskey: 'openclaw:browser:resolvePasskey',
  HostState: 'openclaw:browser:hostState',
} as const;

export type BrowserIpc = typeof BrowserIpc[keyof typeof BrowserIpc];

export interface BrowserWebAccessConfig {
  displayMode: BrowserDisplayMode;
  blockedHostnames: string[];
  credentialUseMode: BrowserCredentialUseModeValue;
  credentialSaveMode: BrowserCredentialSaveModeValue;
  executablePath?: string;
  cdpUrl?: string;
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
  zoomFactor: number;
}

export interface AgentBrowserHostState {
  tabs: AgentBrowserHostTab[];
  selectedPageId?: number;
  visible: boolean;
  updatedAt: number;
  credentialLogin?: BrowserCredentialLoginState;
  credentialSavePrompt?: BrowserCredentialSavePrompt;
  passkey?: BrowserPasskeyNotice;
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

export interface AgentBrowserHostZoomRequest extends AgentBrowserHostRequest {
  factor: number;
}

export interface AgentBrowserHostMenuRequest extends AgentBrowserHostRequest {
  x: number;
  y: number;
  darkMode: boolean;
}

export interface AgentBrowserHostMenuResponse {
  success: boolean;
  action?: AgentBrowserHostMenuAction;
  zoomFactor?: number;
  error?: string;
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

export const defaultBrowserWebAccessConfig: BrowserWebAccessConfig = {
  displayMode: BrowserDisplayMode.InApp,
  blockedHostnames: [],
  credentialUseMode: BrowserCredentialUseMode.AlwaysAsk,
  credentialSaveMode: BrowserCredentialSaveMode.Ask,
};

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
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

export type LegacyBrowserWebAccessConfigInput = Partial<BrowserWebAccessConfig> & {
  headless?: boolean;
};

export const normalizeBrowserWebAccessConfig = (
  value: LegacyBrowserWebAccessConfigInput | undefined | null,
): BrowserWebAccessConfig => {
  const displayMode = Object.values(BrowserDisplayMode).includes(value?.displayMode as BrowserDisplayMode)
    ? value?.displayMode as BrowserDisplayMode
    : value?.headless === false
      ? BrowserDisplayMode.External
      : defaultBrowserWebAccessConfig.displayMode;
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

  return {
    displayMode,
    blockedHostnames: normalizeBrowserHostnameList(value?.blockedHostnames),
    credentialUseMode,
    credentialSaveMode,
    ...(executablePath ? { executablePath } : {}),
    ...(cdpUrl ? { cdpUrl } : {}),
  };
};
