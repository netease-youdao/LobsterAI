export const ShellIpc = {
  OpenPath: 'shell:openPath',
  ShowItemInFolder: 'shell:showItemInFolder',
  OpenExternal: 'shell:openExternal',
  OpenHtmlInBrowser: 'shell:openHtmlInBrowser',
  GetAppsForFile: 'shell:getAppsForFile',
  GetBrowserApps: 'shell:getBrowserApps',
  OpenPathWithApp: 'shell:openPathWithApp',
  OpenUrlWithApp: 'shell:openUrlWithApp',
} as const;

export type ShellIpc = typeof ShellIpc[keyof typeof ShellIpc];

export interface ShellGetBrowserAppsInput {
  projectDirectory?: string;
}

export const ShellOpenFailureReason = {
  NotFound: 'not_found',
  PermissionDenied: 'permission_denied',
  OpenFailed: 'open_failed',
  Unknown: 'unknown',
} as const;

export type ShellOpenFailureReason =
  typeof ShellOpenFailureReason[keyof typeof ShellOpenFailureReason];
