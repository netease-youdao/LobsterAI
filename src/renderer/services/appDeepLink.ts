import type { SettingsOpenOptions } from '../components/Settings';
import { MainView } from '../types/navigation';

/**
 * In-app links that ads (and other server-configured entries) can use instead of a web URL:
 *   lobsterai://settings/<tab>  opens Settings on that tab
 *   lobsterai://view/<view>     switches the main view
 * They are handled in the renderer; the OS-level lobsterai:// protocol still only serves auth callbacks.
 */
export const AppDeepLinkEvent = {
  Navigate: 'app:deepLinkNavigate',
} as const;

type SettingsTab = NonNullable<SettingsOpenOptions['initialTab']>;

const SETTINGS_TABS = [
  'general', 'appearance', 'desktopCompanion', 'coworkAgentEngine', 'model', 'im',
  'browserWebAccess', 'email', 'coworkMemory', 'coworkDreaming', 'plugins',
  'experimental', 'shortcuts', 'help', 'about',
] as const satisfies readonly SettingsTab[];

const MAIN_VIEWS: readonly MainView[] = Object.values(MainView);

export type AppDeepLinkTarget =
  | { kind: 'settings'; tab: SettingsTab }
  | { kind: 'view'; view: MainView };

/** i18n keys of the names users know these destinations by (settings tab titles, sidebar entries). */
const SETTINGS_LABEL_KEY = 'settings';
const SETTINGS_TAB_LABEL_KEYS: Record<SettingsTab, string> = {
  general: 'general',
  appearance: 'appearance',
  desktopCompanion: 'desktopCompanionTitle',
  coworkAgentEngine: 'coworkAgentEngine',
  model: 'settingsCustomModel',
  im: 'imBot',
  browserWebAccess: 'browserWebAccessTab',
  email: 'emailTab',
  coworkMemory: 'coworkMemoryTitle',
  coworkDreaming: 'coworkMemoryTabDreaming',
  plugins: 'pluginsTab',
  experimental: 'experimentalTab',
  shortcuts: 'shortcuts',
  help: 'helpAndFeedback',
  about: 'about',
};
const MAIN_VIEW_LABEL_KEYS: Record<MainView, string> = {
  [MainView.Cowork]: 'newChat',
  [MainView.Experts]: 'expertPlaza',
  [MainView.Kits]: 'kits',
  [MainView.Skills]: 'skills',
  [MainView.Connectors]: 'connectors',
  [MainView.ScheduledTasks]: 'scheduledTasks',
  [MainView.Library]: 'librarySidebarTitle',
};

/**
 * Human-readable name of a link's destination, e.g. "Expert Plaza" or "Settings · Floating Orb".
 * Shown while the destination cannot be seen yet (the engine startup screen covers the app).
 */
export const describeAppDeepLinkTarget = (
  target: AppDeepLinkTarget,
  translate: (key: string) => string,
): string => {
  if (target.kind === 'settings') {
    return `${translate(SETTINGS_LABEL_KEY)} · ${translate(SETTINGS_TAB_LABEL_KEYS[target.tab])}`;
  }
  return translate(MAIN_VIEW_LABEL_KEYS[target.view]);
};

const DEEP_LINK_PATTERN =/^lobsterai:\/\/([a-z]+)\/([A-Za-z]+)\/?$/;

export const isAppDeepLink = (url: string): boolean => /^lobsterai:\/\//i.test(url.trim());

/** Returns null for web URLs and for in-app links this client version does not know. */
export const parseAppDeepLink = (url: string): AppDeepLinkTarget | null => {
  const match = DEEP_LINK_PATTERN.exec(url.trim());
  if (!match) return null;
  const [, kind, target] = match;
  if (kind === 'settings') {
    const tab = SETTINGS_TABS.find(item => item === target);
    return tab ? { kind: 'settings', tab } : null;
  }
  if (kind === 'view') {
    const view = MAIN_VIEWS.find(item => item === target);
    return view ? { kind: 'view', view } : null;
  }
  return null;
};

/**
 * Navigates inside the app when `url` is a known in-app link.
 * Returns false for anything else so callers can fall back to opening a web URL.
 */
export const openAppDeepLink = (url: string): boolean => {
  const target = parseAppDeepLink(url);
  if (!target) return false;
  window.dispatchEvent(new CustomEvent<AppDeepLinkTarget>(AppDeepLinkEvent.Navigate, { detail: target }));
  return true;
};
