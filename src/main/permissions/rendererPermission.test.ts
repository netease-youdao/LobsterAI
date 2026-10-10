import { beforeEach, describe, expect, test, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  askForMediaAccess: vi.fn<() => Promise<boolean>>(),
  getMediaAccessStatus: vi.fn<() => string>(),
}));

vi.mock('electron', () => ({
  systemPreferences: {
    askForMediaAccess: electronMocks.askForMediaAccess,
    getMediaAccessStatus: electronMocks.getMediaAccessStatus,
  },
}));

import { registerRendererPermissionHandler } from './rendererPermission';

type PermissionRequestHandler = NonNullable<Parameters<Electron.Session['setPermissionRequestHandler']>[0]>;
type RequestedPermission = Parameters<PermissionRequestHandler>[1];

const APP_URL = 'file:///Applications/LobsterAI.app/Contents/Resources/app.asar/dist/index.html';
const DEV_SERVER_URL = 'http://localhost:5175';
const ARTIFACT_PREVIEW_URL = 'http://127.0.0.1:43123/preview/index.html';

const createWebContents = (url: string): Electron.WebContents =>
  ({ getURL: () => url }) as unknown as Electron.WebContents;

const setupHandler = ({ isDev = false, startUrl }: { isDev?: boolean; startUrl?: string } = {}) => {
  let handler: PermissionRequestHandler | undefined;
  const session = {
    setPermissionRequestHandler: (next: PermissionRequestHandler) => {
      handler = next;
    },
  } as unknown as Electron.Session;
  const appUrl = isDev ? `${DEV_SERVER_URL}/` : APP_URL;
  const mainWebContents = createWebContents(appUrl);

  registerRendererPermissionHandler({
    session,
    getMainWindow: () => ({ webContents: mainWebContents }) as unknown as Electron.BrowserWindow,
    isDev,
    startUrl,
  });

  const request = (
    permission: RequestedPermission,
    {
      webContents = mainWebContents,
      isMainFrame = true,
      requestingUrl = appUrl,
      mediaTypes,
    }: {
      webContents?: Electron.WebContents;
      isMainFrame?: boolean;
      requestingUrl?: string;
      mediaTypes?: Array<'audio' | 'video'>;
    } = {},
  ): Promise<boolean> => new Promise(resolve => {
    const details = { isMainFrame, requestingUrl, ...(mediaTypes ? { mediaTypes } : {}) };
    handler?.(webContents, permission, resolve, details as Electron.PermissionRequest);
  });

  return { request };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  electronMocks.getMediaAccessStatus.mockReturnValue('granted');
});

describe('registerRendererPermissionHandler', () => {
  test('grants clipboard access to the app page', async () => {
    const { request } = setupHandler();

    await expect(request('clipboard-sanitized-write')).resolves.toBe(true);
    await expect(request('clipboard-read')).resolves.toBe(true);
  });

  test('grants clipboard access to the dev server page in development', async () => {
    const { request } = setupHandler({ isDev: true, startUrl: DEV_SERVER_URL });

    await expect(request('clipboard-sanitized-write')).resolves.toBe(true);
    await expect(request('clipboard-read')).resolves.toBe(true);
  });

  test('blocks clipboard access from frames inside the app page', async () => {
    const { request } = setupHandler();

    await expect(request('clipboard-sanitized-write', {
      isMainFrame: false,
      requestingUrl: ARTIFACT_PREVIEW_URL,
    })).resolves.toBe(false);
    await expect(request('clipboard-read', {
      isMainFrame: false,
      requestingUrl: 'file:///Users/me/report.html',
    })).resolves.toBe(false);
  });

  test('blocks clipboard access from other web contents and remote pages', async () => {
    const { request } = setupHandler();

    await expect(request('clipboard-sanitized-write', {
      webContents: createWebContents(APP_URL),
    })).resolves.toBe(false);
    await expect(request('clipboard-read', {
      requestingUrl: 'https://example.com/',
    })).resolves.toBe(false);
  });

  test('keeps denying unrelated permissions', async () => {
    const { request } = setupHandler();

    await expect(request('notifications')).resolves.toBe(false);
    await expect(request('geolocation')).resolves.toBe(false);
  });

  test('grants microphone access to the app page only', async () => {
    const { request } = setupHandler();

    await expect(request('media', { mediaTypes: ['audio'] })).resolves.toBe(true);
    await expect(request('media', { mediaTypes: ['video'] })).resolves.toBe(false);
    await expect(request('media', {
      mediaTypes: ['audio'],
      isMainFrame: false,
      requestingUrl: ARTIFACT_PREVIEW_URL,
    })).resolves.toBe(false);
  });
});
