import {
  AppUpdateChannel,
  type AppUpdateInfo,
  type AppUpdateSource,
  type ChangeLogEntry,
} from '../../shared/appUpdate/constants';

export const APP_UPDATE_GRAY_TIMEOUT_MS = 2_000;
export const AppUpdateGrayPlatform = { Windows: 'win32', MacOS: 'darwin' } as const;
const GRAY_CHECK_PATH = '/api/client-updates/check';

export interface AppUpdateGraySession {
  sessionKey: string;
  accessToken: string;
  headers?: Record<string, string>;
}

interface Options {
  getSession: () => AppUpdateGraySession | null;
  getServerBaseUrl: () => string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  platform: string;
  arch: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function changeLog(value: unknown): ChangeLogEntry | null {
  const entry = object(value);
  if (!entry || typeof entry.title !== 'string' || !Array.isArray(entry.content)
      || !entry.content.every(item => typeof item === 'string')) return null;
  return { title: entry.title, content: entry.content as string[] };
}

/** Matches the existing updater's numeric version ordering. */
function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.split('.').map(part => {
    const match = part.trim().match(/^\d+/);
    return match ? Number.parseInt(match[0], 10) : 0;
  });
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

/** Preserve legacy stable-cache matching; gray bytes require the same owner and package. */
export function canReuseUpdatePackage(cached: AppUpdateInfo | undefined, selected: AppUpdateInfo): boolean {
  if (!cached?.gray && !selected.gray) return true;
  if (!cached?.gray || !selected.gray) return false;
  return cached.latestVersion === selected.latestVersion && cached.url === selected.url
    && cached.gray.sessionKey === selected.gray.sessionKey
    && cached.gray.serverBaseUrl === selected.gray.serverBaseUrl
    && cached.gray.rolloutId === selected.gray.rolloutId;
}

/** Optional overlay: no token refresh, logout, polling or changes to the stable request. */
export class AppUpdateGrayClient {
  constructor(private readonly options: Options) {}

  isCurrent(info: AppUpdateInfo): boolean {
    if (!info.gray) return true;
    try {
      const session = this.options.getSession();
      return !!session?.accessToken && session.sessionKey === info.gray.sessionKey
        && this.options.getServerBaseUrl() === info.gray.serverBaseUrl;
    } catch {
      return false;
    }
  }

  async select(
    loadStable: () => Promise<AppUpdateInfo | null>,
    currentVersion: string,
    source: AppUpdateSource,
  ): Promise<AppUpdateInfo | null> {
    // Always issue the original request, even when gray responds first.
    const [stable, gray] = await Promise.allSettled([
      loadStable(), this.query(currentVersion, source),
    ]);
    const candidate = gray.status === 'fulfilled' ? gray.value : null;
    const stableInfo = stable.status === 'fulfilled' ? stable.value : null;
    if (candidate && this.isCurrent(candidate)
        && (!stableInfo || compareVersions(candidate.latestVersion, stableInfo.latestVersion) > 0)) {
      return candidate;
    }
    if (stable.status === 'rejected') throw stable.reason;
    return stable.value;
  }

  async authorize(info: AppUpdateInfo, currentVersion: string, source: AppUpdateSource): Promise<boolean> {
    if (!info.gray) return true;
    if (!this.isCurrent(info)) return false;
    const candidate = await this.query(currentVersion, source);
    return candidate !== null && this.isCurrent(candidate) && canReuseUpdatePackage(info, candidate);
  }

  async query(currentVersion: string, source: AppUpdateSource): Promise<AppUpdateInfo | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const session = this.options.getSession();
      if (!session?.accessToken || !session.sessionKey
          || !Object.values(AppUpdateGrayPlatform).some(platform => platform === this.options.platform)
          || !['x64', 'arm64'].includes(this.options.arch)) return null;
      const serverBaseUrl = this.options.getServerBaseUrl();
      const url = new URL(`${serverBaseUrl}${GRAY_CHECK_PATH}`);
      url.search = new URLSearchParams({
        source, version: currentVersion, platform: this.options.platform, arch: this.options.arch,
      }).toString();
      const request = (async (): Promise<AppUpdateInfo | null> => {
        const response = await this.options.fetch(url.toString(), {
          method: 'GET',
          headers: { ...session.headers, Accept: 'application/json', Authorization: `Bearer ${session.accessToken}` },
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
        });
        if (!response.ok) return null;
        const payload = object(await response.json());
        const data = object(payload?.data);
        const release = object(data?.release);
        if (payload?.code !== 0 || data?.updateAvailable !== true || data.channel !== AppUpdateChannel.Gray
            || !release || typeof data.rolloutId !== 'string'
            || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(data.rolloutId)
            || !Number.isSafeInteger(data.policyRevision) || (data.policyRevision as number) <= 0
            || typeof release.version !== 'string' || release.version.length > 64
            || !/^\d+(\.\d+)*$/.test(release.version)
            || !release.version.split('.').every(part => Number(part) <= 2_147_483_647)
            || compareVersions(release.version, currentVersion) <= 0
            || typeof release.date !== 'string' || !release.date.trim()
            || typeof release.url !== 'string') return null;
        const logs = object(release.changeLog);
        const zh = changeLog(logs?.ch);
        const en = changeLog(logs?.en);
        const installer = new URL(release.url);
        const extension = this.options.platform === AppUpdateGrayPlatform.Windows ? '.exe' : '.dmg';
        if (!zh || !en || installer.protocol !== 'https:' || !installer.hostname
            || installer.username || installer.password || installer.port || installer.hash
            || !installer.pathname.toLowerCase().endsWith(extension)) return null;
        const info: AppUpdateInfo = {
          latestVersion: release.version, date: release.date, changeLog: { zh, en }, url: release.url,
          gray: { sessionKey: session.sessionKey, serverBaseUrl, rolloutId: data.rolloutId,
            policyRevision: data.policyRevision as number },
        };
        return this.isCurrent(info) ? info : null;
      })().catch((): null => null);
      const timeout = new Promise<null>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, APP_UPDATE_GRAY_TIMEOUT_MS);
      });
      return await Promise.race([request, timeout]);
    } catch {
      // Optional checks must never fail the original stable flow or change auth state.
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
