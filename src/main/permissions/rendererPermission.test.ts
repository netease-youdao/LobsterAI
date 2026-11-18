import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { RendererMediaType, RendererPermission } from './constants';

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
  const companionUrl = new URL('companion-composer.html?surface=panel', appUrl).href;
  const companionWebContents = createWebContents(companionUrl);
  const isAdditionalVoiceInputWebContents = vi.fn((webContents: Electron.WebContents) => webContents === companionWebContents);

  registerRendererPermissionHandler({
    session,
    getMainWindow: () => ({ webContents: mainWebContents }) as unknown as Electron.BrowserWindow,
    isAdditionalVoiceInputWebContents,
    isDev,
    startUrl,
  });

  const request = (
    permission: RequestedPermission,
    {
      webContents = mainWebContents,
      isMainFrame = true,
      requestingUrl = webContents.getURL(),
      mediaTypes,
    }: {
      webContents?: Electron.WebContents;
      isMainFrame?: boolean;
      requestingUrl?: string;
      mediaTypes?: RendererMediaType[];
    } = {},
  ): Promise<boolean> => new Promise(resolve => {
    const details = { isMainFrame, requestingUrl, ...(mediaTypes ? { mediaTypes } : {}) };
    handler?.(webContents, permission, resolve, details as Electron.PermissionRequest);
  });

  return { request, companionWebContents, companionUrl, isAdditionalVoiceInputWebContents };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  electronMocks.getMediaAccessStatus.mockReturnValue('granted');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerRendererPermissionHandler', () => {
  test('grants clipboard access to the app page', async () => {
    const { request } = setupHandler();

    await expect(request(RendererPermission.ClipboardWrite)).resolves.toBe(true);
    await expect(request(RendererPermission.ClipboardRead)).resolves.toBe(true);
  });

  test('grants clipboard access to the dev server page in development', async () => {
    const { request } = setupHandler({ isDev: true, startUrl: DEV_SERVER_URL });

    await expect(request(RendererPermission.ClipboardWrite)).resolves.toBe(true);
    await expect(request(RendererPermission.ClipboardRead)).resolves.toBe(true);
  });

  test('blocks clipboard access from frames inside the app page', async () => {
    const { request } = setupHandler();

    await expect(request(RendererPermission.ClipboardWrite, {
      isMainFrame: false,
      requestingUrl: ARTIFACT_PREVIEW_URL,
    })).resolves.toBe(false);
    await expect(request(RendererPermission.ClipboardRead, {
      isMainFrame: false,
      requestingUrl: 'file:///Users/me/report.html',
    })).resolves.toBe(false);
  });

  test('blocks clipboard access from other web contents and remote pages', async () => {
    const { request } = setupHandler();

    await expect(request(RendererPermission.ClipboardWrite, {
      webContents: createWebContents(APP_URL),
    })).resolves.toBe(false);
    await expect(request(RendererPermission.ClipboardRead, {
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

    await expect(request(RendererPermission.Media, { mediaTypes: [RendererMediaType.Audio] })).resolves.toBe(true);
    await expect(request(RendererPermission.Media, { mediaTypes: [RendererMediaType.Video] })).resolves.toBe(false);
    await expect(request(RendererPermission.Media, {
      mediaTypes: [RendererMediaType.Audio],
      isMainFrame: false,
      requestingUrl: ARTIFACT_PREVIEW_URL,
    })).resolves.toBe(false);
  });

  test.each([false, true])('grants microphone access to the companion composer (dev=%s)', async isDev => {
    const { request, companionWebContents } = setupHandler({ isDev, startUrl: isDev ? DEV_SERVER_URL : undefined });

    await expect(request(RendererPermission.Media, {
      webContents: companionWebContents,
      mediaTypes: [RendererMediaType.Audio],
    })).resolves.toBe(true);
  });

  test('does not grant the companion composer clipboard permissions', async () => {
    const { request, companionWebContents } = setupHandler();

    for (const permission of [RendererPermission.ClipboardRead, RendererPermission.ClipboardWrite]) {
      await expect(request(permission, { webContents: companionWebContents })).resolves.toBe(false);
    }
  });

  test('blocks microphone access from unregistered windows, including the same composer URL', async () => {
    const { request, companionUrl } = setupHandler();

    for (const url of [APP_URL, companionUrl]) {
      await expect(request(RendererPermission.Media, {
        webContents: createWebContents(url),
        mediaTypes: [RendererMediaType.Audio],
      })).resolves.toBe(false);
    }
    expect(electronMocks.askForMediaAccess).not.toHaveBeenCalled();
  });

  test.each([false, true])('blocks microphone access from frames even with a trusted URL (dev=%s)', async isDev => {
    const { request, companionWebContents } = setupHandler({ isDev });

    for (const webContents of [undefined, companionWebContents]) {
      await expect(request(RendererPermission.Media, {
        webContents,
        isMainFrame: false,
        mediaTypes: [RendererMediaType.Audio],
      })).resolves.toBe(false);
    }
  });

  test.each([ARTIFACT_PREVIEW_URL, 'https://example.com/', 'http://localhost:5176/'])('blocks an untrusted microphone request URL: %s', async requestingUrl => {
    const { request, companionWebContents } = setupHandler({ isDev: true, startUrl: DEV_SERVER_URL });

    await expect(request(RendererPermission.Media, {
      webContents: companionWebContents,
      requestingUrl,
      mediaTypes: [RendererMediaType.Audio],
    })).resolves.toBe(false);
  });

  test('only grants audio capture, never camera or combined audio/video requests', async () => {
    const { request, companionWebContents } = setupHandler();

    for (const webContents of [undefined, companionWebContents]) {
      for (const mediaTypes of [undefined, [], [RendererMediaType.Video], [RendererMediaType.Audio, RendererMediaType.Video]]) {
        await expect(request(RendererPermission.Media, { webContents, mediaTypes })).resolves.toBe(false);
      }
    }
  });

  test('rechecks composer ownership for each request', async () => {
    const { request, companionWebContents, isAdditionalVoiceInputWebContents } = setupHandler();
    const options = { webContents: companionWebContents, mediaTypes: [RendererMediaType.Audio] };

    await expect(request(RendererPermission.Media, options)).resolves.toBe(true);
    isAdditionalVoiceInputWebContents.mockReturnValue(false);
    await expect(request(RendererPermission.Media, options)).resolves.toBe(false);
  });

  test.runIf(process.platform === 'darwin')('still requests macOS microphone access for the composer', async () => {
    electronMocks.getMediaAccessStatus.mockReturnValue('not-determined');
    electronMocks.askForMediaAccess.mockResolvedValue(true);
    const { request, companionWebContents } = setupHandler();

    await expect(request(RendererPermission.Media, {
      webContents: companionWebContents,
      mediaTypes: [RendererMediaType.Audio],
    })).resolves.toBe(true);
    expect(electronMocks.askForMediaAccess).toHaveBeenCalledExactlyOnceWith('microphone');
  });

  test.runIf(process.platform === 'darwin').each(['denied', 'restricted'])('respects macOS microphone status: %s', async status => {
    electronMocks.getMediaAccessStatus.mockReturnValue(status);
    const { request, companionWebContents } = setupHandler();

    await expect(request(RendererPermission.Media, {
      webContents: companionWebContents,
      mediaTypes: [RendererMediaType.Audio],
    })).resolves.toBe(false);
    expect(electronMocks.getMediaAccessStatus).toHaveBeenCalledWith('microphone');
    expect(electronMocks.askForMediaAccess).not.toHaveBeenCalled();
  });
});
