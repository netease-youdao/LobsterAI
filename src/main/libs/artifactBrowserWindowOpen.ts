import {
  ArtifactBrowserWindowOpenDisposition,
  type ArtifactBrowserWindowOpenEvent,
  ArtifactPreviewIpc,
} from '../../shared/artifactPreview/constants';

export const ArtifactBrowserWindowOpenAction = {
  Deny: 'deny',
} as const;

export type ArtifactBrowserWindowOpenAction =
  typeof ArtifactBrowserWindowOpenAction[keyof typeof ArtifactBrowserWindowOpenAction];

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const VALID_DISPOSITIONS = new Set<string>(Object.values(ArtifactBrowserWindowOpenDisposition));
const NO_REFERRER_POLICY = 'no-referrer';

export interface ArtifactBrowserWindowOpenDetails {
  url?: string;
  disposition?: string;
  referrer?: {
    url?: string;
    policy?: string;
  } | null;
}

export interface ResolvedArtifactBrowserWindowOpenRequest {
  url: string;
  disposition: ArtifactBrowserWindowOpenDisposition;
  referrer?: string;
}

interface HostWebContentsLike {
  isDestroyed: () => boolean;
  send: (channel: string, payload: ArtifactBrowserWindowOpenEvent) => void;
}

interface GuestWebContentsLike {
  id: number;
  setWindowOpenHandler: (
    handler: (details: ArtifactBrowserWindowOpenDetails) => { action: ArtifactBrowserWindowOpenAction },
  ) => void;
}

function isAllowedHttpUrl(value: string | undefined): value is string {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function resolveArtifactBrowserWindowOpenRequest(
  details: ArtifactBrowserWindowOpenDetails,
): ResolvedArtifactBrowserWindowOpenRequest | null {
  const url = details.url?.trim();
  if (!isAllowedHttpUrl(url)) return null;

  const disposition = details.disposition && VALID_DISPOSITIONS.has(details.disposition)
    ? details.disposition as ArtifactBrowserWindowOpenDisposition
    : ArtifactBrowserWindowOpenDisposition.ForegroundTab;

  const referrerUrl = details.referrer?.policy !== NO_REFERRER_POLICY
    ? details.referrer?.url?.trim()
    : undefined;
  const referrer = isAllowedHttpUrl(referrerUrl) ? referrerUrl : undefined;

  return {
    url,
    disposition,
    ...(referrer ? { referrer } : {}),
  };
}

/**
 * Intercepts target="_blank" and window.open() from artifact browser <webview>
 * guests so Electron never spawns a standalone BrowserWindow, forwarding valid
 * http(s) URLs to the renderer to open in a new tab instead.
 */
export function attachArtifactBrowserWindowOpenHandler(
  hostWebContents: HostWebContentsLike,
  guestWebContents: GuestWebContentsLike,
): void {
  guestWebContents.setWindowOpenHandler(details => {
    const request = resolveArtifactBrowserWindowOpenRequest(details);
    if (request && !hostWebContents.isDestroyed()) {
      hostWebContents.send(ArtifactPreviewIpc.BrowserWindowOpen, {
        webContentsId: guestWebContents.id,
        ...request,
      });
    }
    return { action: ArtifactBrowserWindowOpenAction.Deny };
  });
}
