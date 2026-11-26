export const SettingsTabId = {
  General: 'general',
  Appearance: 'appearance',
  DesktopCompanion: 'desktopCompanion',
  Shortcuts: 'shortcuts',
  CoworkAgentEngine: 'coworkAgentEngine',
  Model: 'model',
  CoworkMemory: 'coworkMemory',
  CoworkDreaming: 'coworkDreaming',
  BrowserWebAccess: 'browserWebAccess',
  Im: 'im',
  RemoteDevices: 'remoteDevices',
  Email: 'email',
  Plugins: 'plugins',
  DataPrivacy: 'dataPrivacy',
  Experimental: 'experimental',
  Help: 'help',
  About: 'about',
} as const;

export type SettingsTab = (typeof SettingsTabId)[keyof typeof SettingsTabId];

/** Curated flat order for the Settings sidebar. */
export const SETTINGS_TAB_ORDER: readonly SettingsTab[] = [
  SettingsTabId.General,
  SettingsTabId.Appearance,
  SettingsTabId.DesktopCompanion,
  SettingsTabId.Model,
  SettingsTabId.Im,
  SettingsTabId.RemoteDevices,
  SettingsTabId.BrowserWebAccess,
  SettingsTabId.CoworkMemory,
  SettingsTabId.Email,
  SettingsTabId.Plugins,
  SettingsTabId.Experimental,
  SettingsTabId.Shortcuts,
  SettingsTabId.DataPrivacy,
  SettingsTabId.Help,
  SettingsTabId.About,
];

// Only legacy OpenClaw-only tabs are retired. Keep `'email'` active because it
// configures the bundled `imap-smtp-email` skill (`EmailSkillConfig`), separate
// from the retired IM Email bot channel (`im_config.email`).
export const RETIRED_SETTINGS_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>([
  SettingsTabId.CoworkAgentEngine,
  SettingsTabId.CoworkDreaming,
]);

export const normalizeSettingsTab = (tab?: SettingsTab): SettingsTab => (
  !tab || RETIRED_SETTINGS_TABS.has(tab) ? SettingsTabId.General : tab
);

export const filterVisibleSettingsTabs = <T extends { key: SettingsTab }>(
  tabsByKey: ReadonlyMap<SettingsTab, T>,
  enterpriseUi?: Record<string, string>,
): T[] => (
  SETTINGS_TAB_ORDER
    .filter((tabId) => enterpriseUi?.[`settings.${tabId}`] !== 'hide')
    .map((tabId) => tabsByKey.get(tabId))
    .filter((tab): tab is T => tab !== undefined)
);
