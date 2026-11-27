import { describe, expect, test, vi } from 'vitest';

import {
  ArtifactBrowserWindowOpenDisposition,
  ArtifactPreviewIpc,
} from '../../shared/artifactPreview/constants';
import {
  ArtifactBrowserWindowOpenAction,
  type ArtifactBrowserWindowOpenDetails,
  attachArtifactBrowserWindowOpenHandler,
  resolveArtifactBrowserWindowOpenRequest,
} from './artifactBrowserWindowOpen';

describe('artifactBrowserWindowOpen', () => {
  test('resolves valid http and https URLs with disposition and referrer', () => {
    expect(resolveArtifactBrowserWindowOpenRequest({
      url: 'https://www.baidu.com/s?wd=test',
      disposition: ArtifactBrowserWindowOpenDisposition.ForegroundTab,
      referrer: { url: 'https://www.baidu.com/', policy: 'strict-origin-when-cross-origin' },
    })).toEqual({
      url: 'https://www.baidu.com/s?wd=test',
      disposition: ArtifactBrowserWindowOpenDisposition.ForegroundTab,
      referrer: 'https://www.baidu.com/',
    });

    expect(resolveArtifactBrowserWindowOpenRequest({
      url: 'http://127.0.0.1:3000/page',
      disposition: ArtifactBrowserWindowOpenDisposition.BackgroundTab,
      referrer: { url: 'http://127.0.0.1:3000/', policy: 'no-referrer' },
    })).toEqual({
      url: 'http://127.0.0.1:3000/page',
      disposition: ArtifactBrowserWindowOpenDisposition.BackgroundTab,
    });
  });

  test('rejects non-http(s) and invalid URLs', () => {
    for (const url of [
      '',
      'about:blank',
      'javascript:alert(1)',
      'data:text/html,<h1>hi</h1>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(resolveArtifactBrowserWindowOpenRequest({ url })).toBeNull();
    }
  });

  test('falls back to foreground-tab when disposition is unrecognized and drops invalid referrers', () => {
    expect(resolveArtifactBrowserWindowOpenRequest({
      url: 'https://example.com/path',
      disposition: 'unexpected-value',
      referrer: { url: 'file:///local', policy: 'default' },
    })).toEqual({
      url: 'https://example.com/path',
      disposition: ArtifactBrowserWindowOpenDisposition.ForegroundTab,
    });
  });

  test('denies native popup windows and forwards valid requests to host webContents', () => {
    let installedHandler:
      | ((details: ArtifactBrowserWindowOpenDetails) => { action: ArtifactBrowserWindowOpenAction })
      | undefined;
    const send = vi.fn();
    const host = { isDestroyed: () => false, send };
    const guest = {
      id: 42,
      setWindowOpenHandler: vi.fn(handler => {
        installedHandler = handler;
      }),
    };

    attachArtifactBrowserWindowOpenHandler(host, guest);
    expect(installedHandler).toBeTypeOf('function');

    const response = installedHandler!({
      url: 'https://www.baidu.com/s?wd=lobster',
      disposition: ArtifactBrowserWindowOpenDisposition.NewWindow,
      referrer: { url: 'https://www.baidu.com/', policy: 'default' },
    });

    expect(response).toEqual({ action: ArtifactBrowserWindowOpenAction.Deny });
    expect(send).toHaveBeenCalledWith(ArtifactPreviewIpc.BrowserWindowOpen, {
      webContentsId: 42,
      url: 'https://www.baidu.com/s?wd=lobster',
      disposition: ArtifactBrowserWindowOpenDisposition.NewWindow,
      referrer: 'https://www.baidu.com/',
    });
  });

  test('still denies without forwarding when URL is blocked or host is destroyed', () => {
    let installedHandler:
      | ((details: ArtifactBrowserWindowOpenDetails) => { action: ArtifactBrowserWindowOpenAction })
      | undefined;
    const send = vi.fn();
    let destroyed = false;
    const host = { isDestroyed: () => destroyed, send };
    const guest = {
      id: 7,
      setWindowOpenHandler: vi.fn(handler => {
        installedHandler = handler;
      }),
    };

    attachArtifactBrowserWindowOpenHandler(host, guest);

    expect(installedHandler!({ url: 'javascript:void(0)' })).toEqual({
      action: ArtifactBrowserWindowOpenAction.Deny,
    });
    expect(send).not.toHaveBeenCalled();

    destroyed = true;
    expect(installedHandler!({ url: 'https://example.com' })).toEqual({
      action: ArtifactBrowserWindowOpenAction.Deny,
    });
    expect(send).not.toHaveBeenCalled();
  });
});
