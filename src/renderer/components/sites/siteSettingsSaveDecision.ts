export const SiteSettingsSaveDecision = {
  None: 'none',
  SaveDirectly: 'save_directly',
  ConfirmChange: 'confirm_change',
  ConfirmStop: 'confirm_stop',
  ConfirmResume: 'confirm_resume',
} as const;

export type SiteSettingsSaveDecision = typeof SiteSettingsSaveDecision[
  keyof typeof SiteSettingsSaveDecision
];

export function resolveSiteSettingsSaveDecision({
  accessChanged,
  actionLoading,
  currentAccessStopped,
  hasUnsavedSettings,
  targetAccessStopped,
}: {
  accessChanged: boolean;
  actionLoading: boolean;
  currentAccessStopped: boolean;
  hasUnsavedSettings: boolean;
  targetAccessStopped: boolean;
}): SiteSettingsSaveDecision {
  if (!hasUnsavedSettings || actionLoading) return SiteSettingsSaveDecision.None;
  if (!accessChanged) return SiteSettingsSaveDecision.SaveDirectly;
  if (targetAccessStopped) return SiteSettingsSaveDecision.ConfirmStop;
  if (currentAccessStopped) return SiteSettingsSaveDecision.ConfirmResume;
  return SiteSettingsSaveDecision.ConfirmChange;
}
