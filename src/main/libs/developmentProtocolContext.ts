import path from 'node:path';

export const DevelopmentProtocolSwitch = {
  UserDataDir: 'lobsterai-dev-user-data-dir',
  StartUrl: 'lobsterai-dev-start-url',
} as const;

interface DevelopmentEnvironment {
  NODE_ENV?: string;
  ELECTRON_START_URL?: string;
  LOBSTERAI_DEV_USER_DATA_DIR?: string;
}

interface DevelopmentLaunchContext {
  userDataDir?: string;
  isDev: boolean;
  serverUrl: string;
}

function absoluteDirectory(value?: string): string | undefined {
  const directory = value?.trim();
  return directory && path.isAbsolute(directory) ? directory : undefined;
}

function loopbackServerUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

/** OS protocol launches do not inherit the shell environment of the running app. */
export function resolveDevelopmentLaunchContext(input: {
  isPackaged: boolean;
  environment: DevelopmentEnvironment;
  userDataDirArgument?: string;
  startUrlArgument?: string;
}): DevelopmentLaunchContext {
  const { environment } = input;
  const argumentServerUrl = input.isPackaged ? undefined : loopbackServerUrl(input.startUrlArgument);
  return {
    userDataDir: input.isPackaged ? undefined
      : absoluteDirectory(input.userDataDirArgument) ?? absoluteDirectory(environment.LOBSTERAI_DEV_USER_DATA_DIR),
    isDev: environment.NODE_ENV === 'development' || Boolean(argumentServerUrl),
    serverUrl: argumentServerUrl || environment.ELECTRON_START_URL || 'http://localhost:5175',
  };
}

/** Keep the same single-instance profile and renderer when Windows/Linux relaunch Electron. */
export function buildDevelopmentProtocolArgs(input: {
  entryPoint: string;
  userDataDir: string;
  isDev: boolean;
  serverUrl: string;
}): string[] {
  const args = [input.entryPoint];
  const directory = absoluteDirectory(input.userDataDir);
  if (directory) args.push(`--${DevelopmentProtocolSwitch.UserDataDir}=${directory}`);
  const serverUrl = input.isDev ? loopbackServerUrl(input.serverUrl) : undefined;
  if (serverUrl) args.push(`--${DevelopmentProtocolSwitch.StartUrl}=${serverUrl}`);
  return args;
}
