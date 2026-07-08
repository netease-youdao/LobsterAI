import { app } from 'electron';

const AUTO_LAUNCH_ARGS = ['--auto-launched'];

export type AutoLaunchStatus = {
  enabled: boolean;
  openAtLogin: boolean;
  status?: string;
  executableWillLaunchAtLogin?: boolean;
  launchItems?: Array<{
    name: string;
    path: string;
    args: string[];
    enabled: boolean;
    scope: string;
  }>;
};

const getLoginItemSettings = () => {
  if (process.platform === 'win32') {
    // Windows: must pass the same args used in setLoginItemSettings,
    // otherwise openAtLogin defaults to comparing against [] which
    // won't match the registered ['--auto-launched'] and returns false.
    return app.getLoginItemSettings({
      args: AUTO_LAUNCH_ARGS,
    });
  }

  return app.getLoginItemSettings();
};

export function getAutoLaunchStatus(): AutoLaunchStatus {
  const settings = getLoginItemSettings();
  const status = typeof settings.status === 'string' ? settings.status : undefined;
  const enabled = process.platform === 'darwin' && status
    ? status === 'enabled'
    : process.platform === 'win32'
      ? Boolean(settings.executableWillLaunchAtLogin)
      : settings.openAtLogin;

  return {
    enabled,
    openAtLogin: settings.openAtLogin,
    status,
    executableWillLaunchAtLogin: settings.executableWillLaunchAtLogin,
    launchItems: Array.isArray(settings.launchItems)
      ? settings.launchItems.map(item => ({
          name: item.name,
          path: item.path,
          args: item.args,
          enabled: item.enabled,
          scope: item.scope,
        }))
      : undefined,
  };
}

const disableWindowsLoginItems = () => {
  const settings = getLoginItemSettings();
  const launchItems = Array.isArray(settings.launchItems) ? settings.launchItems : [];
  const currentExecutablePath = process.execPath.toLowerCase();
  const matchingLaunchItems = launchItems.filter(item => item.path.toLowerCase() === currentExecutablePath);
  for (const item of matchingLaunchItems) {
    app.setLoginItemSettings({
      openAtLogin: false,
      path: item.path,
      args: item.args,
      name: item.name,
    });
  }

  app.setLoginItemSettings({
    openAtLogin: false,
    args: AUTO_LAUNCH_ARGS,
  });
  app.setLoginItemSettings({
    openAtLogin: false,
    args: [],
  });
};

export function setAutoLaunchEnabled(enabled: boolean): void {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';

  try {
    if (isWindows && !enabled) {
      disableWindowsLoginItems();
      return;
    }

    app.setLoginItemSettings({
      openAtLogin: enabled,
      // macOS: kept for older versions; Electron marks this deprecated on macOS 13+.
      openAsHidden: isMac ? enabled : false,
      // Windows: 通过命令行参数标记自启动
      args: isWindows ? AUTO_LAUNCH_ARGS : [],
    });
  } catch (error) {
    console.error('Failed to set auto-launch settings:', error);
    throw error;
  }
}

export function isAutoLaunched(): boolean {
  try {
    if (process.platform === 'darwin') {
      const settings = app.getLoginItemSettings();
      return settings.wasOpenedAtLogin || false;
    }
    // Windows: 检查命令行参数
    return process.argv.includes('--auto-launched');
  } catch (error) {
    console.error('Failed to check auto-launch status:', error);
    return false;
  }
}
