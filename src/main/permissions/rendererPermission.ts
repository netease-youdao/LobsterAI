import { systemPreferences } from 'electron';

import type { RendererPermissionHandlerOptions } from './types';

// The async Clipboard API asks for these: plain/HTML writes need
// `clipboard-sanitized-write`, while reads and writes carrying custom formats
// need `clipboard-read`. The Office editors (Univer) copy, cut and paste with it.
const CLIPBOARD_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-read', 'clipboard-sanitized-write']);

const isLocalhost = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';

function isTrustedRendererUrl(requestUrl: string, isDev: boolean, startUrl?: string): boolean {
  try {
    const url = new URL(requestUrl);
    if (url.protocol === 'file:') return true;
    if (!isDev || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;

    if (startUrl) {
      try {
        return url.origin === new URL(startUrl).origin;
      } catch {
        return false;
      }
    }

    return isLocalhost(url.hostname) && url.port === '5175';
  } catch {
    return false;
  }
}

async function requestMacMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;

  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  if (status === 'denied' || status === 'restricted') {
    console.warn(`[VoiceInput] macOS microphone access is ${status}`);
    return false;
  }

  try {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) {
      console.warn('[VoiceInput] macOS microphone access was not granted');
    }
    return granted;
  } catch (error) {
    console.warn('[VoiceInput] macOS microphone access request failed:', error);
    return false;
  }
}

function getPermissionMediaTypes(details: unknown): string[] {
  if (!details || typeof details !== 'object' || !('mediaTypes' in details)) return [];
  const mediaTypes = (details as { mediaTypes?: unknown }).mediaTypes;
  return Array.isArray(mediaTypes) ? mediaTypes.filter((mediaType): mediaType is string => typeof mediaType === 'string') : [];
}

/**
 * The only permission request handler of the session: anything not allowed
 * here is denied, so web APIs gated by a permission fail in the renderer.
 */
export function registerRendererPermissionHandler({
  session,
  getMainWindow,
  isDev,
  startUrl,
}: RendererPermissionHandlerOptions): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl || webContents.getURL();
    const isTrustedMainWindowRequest = (): boolean =>
      getMainWindow()?.webContents === webContents && isTrustedRendererUrl(requestingUrl, isDev, startUrl);

    if (CLIPBOARD_PERMISSIONS.has(permission)) {
      // Only the app's own page; frames inside it (artifact previews) stay blocked.
      const granted = details.isMainFrame && isTrustedMainWindowRequest();
      if (!granted) {
        console.warn(`[Permissions] blocked ${permission} permission request from ${requestingUrl || 'unknown origin'}`);
      }
      callback(granted);
      return;
    }

    if (permission !== 'media') {
      callback(false);
      return;
    }

    const mediaTypes = getPermissionMediaTypes(details);
    if (!mediaTypes.includes('audio')) {
      callback(false);
      return;
    }

    if (!isTrustedMainWindowRequest()) {
      console.warn(`[VoiceInput] blocked microphone permission request from ${requestingUrl || 'unknown origin'}`);
      callback(false);
      return;
    }

    void requestMacMicrophoneAccess().then(granted => {
      callback(granted);
    });
  });
}
