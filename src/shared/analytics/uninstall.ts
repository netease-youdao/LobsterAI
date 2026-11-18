// The NSIS reader uses the same INI contract; windowsUninstallAnalytics.test.ts
// checks the cross-language constants against scripts/nsis-uninstall-analytics.nsh.
export const UninstallAnalytics = {
  Filename: 'uninstall-analytics.ini',
  Section: 'uninstall',
  SchemaVersion: '1',
  MaxQueryLength: 6_000,
  Source: 'nsis',
} as const;

export const UninstallAnalyticsKey = {
  SchemaVersion: 'schema_version',
  InstallDirectory: 'install_directory',
  Query: 'query',
} as const;
