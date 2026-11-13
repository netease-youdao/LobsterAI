/** Server-configured ad slots rendered by the desktop client. */
export const ClientBannerPlacement = {
  DesktopSidebar: 'desktop_sidebar',
  DesktopLaunchModal: 'desktop_launch_modal',
} as const;

export type ClientBannerPlacement =
  typeof ClientBannerPlacement[keyof typeof ClientBannerPlacement];

const PLACEMENTS = new Set<string>(Object.values(ClientBannerPlacement));

export const normalizeClientBannerPlacement = (value: unknown): ClientBannerPlacement => (
  typeof value === 'string' && PLACEMENTS.has(value)
    ? value as ClientBannerPlacement
    : ClientBannerPlacement.DesktopSidebar
);

/** How often a launch-modal banner may pop up; configured per banner in Admin. */
export const ClientBannerDisplayFrequency = {
  EveryLaunch: 'every_launch',
  Daily: 'daily',
  Once: 'once',
} as const;

export type ClientBannerDisplayFrequency =
  typeof ClientBannerDisplayFrequency[keyof typeof ClientBannerDisplayFrequency];
