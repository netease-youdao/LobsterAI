export type SettingsTab =
  | 'general'
  | 'appearance'
  | 'desktopCompanion'
  | 'coworkAgentEngine'
  | 'model'
  | 'browserWebAccess'
  | 'coworkMemory'
  | 'coworkDreaming'
  | 'shortcuts'
  | 'im'
  | 'email'
  | 'plugins'
  | 'experimental'
  | 'help'
  | 'about';

// Only legacy OpenClaw-only tabs are retired. Keep `'email'` active because it
// configures the bundled `imap-smtp-email` skill (`EmailSkillConfig`), separate
// from the retired IM Email bot channel (`im_config.email`).
export const RETIRED_SETTINGS_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>([
  'coworkAgentEngine',
  'coworkDreaming',
]);

export const normalizeSettingsTab = (tab?: SettingsTab): SettingsTab => (
  !tab || RETIRED_SETTINGS_TABS.has(tab) ? 'general' : tab
);
