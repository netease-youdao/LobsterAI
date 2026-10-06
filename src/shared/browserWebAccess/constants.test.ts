import { describe, expect, test } from 'vitest';

import {
  BrowserCredentialSaveMode,
  BrowserCredentialUseMode,
} from '../browserCredentials/constants';
import {
  BrowserDisplayMode,
  BrowserNetworkMode,
  BrowserProfileMode,
  normalizeBrowserCdpUrl,
  normalizeBrowserHostnameList,
  normalizeBrowserHostnamePolicyList,
  normalizeBrowserWebAccessConfig,
} from './constants';

describe('browser web access constants', () => {
  test('normalizes hostname lists into browser URL entries', () => {
    expect(normalizeBrowserHostnameList([
      ' https://Example.com/docs ',
      'example.com:443',
      '*.Internal.local/path',
      'localhost:123',
      'youdao.com',
      'https://api.baidu.com/path',
      '',
      'https://Example.com/other',
    ])).toEqual([
      'https://www.example.com',
      'https://www.example.com:443',
      '*.internal.local',
      'https://localhost:123',
      'https://www.youdao.com',
      'https://api.baidu.com',
    ]);
  });

  test('builds hostname policy lists from browser URL entries', () => {
    expect(normalizeBrowserHostnamePolicyList([
      'https://www.baidu.com',
      'https://localhost:123',
      '*.internal.local',
      'https://api.baidu.com/path',
    ])).toEqual(['www.baidu.com', 'localhost', '*.internal.local', 'api.baidu.com']);
  });

  test('accepts only HTTP and WebSocket CDP URLs', () => {
    expect(normalizeBrowserCdpUrl('http://127.0.0.1:9222')).toBe('http://127.0.0.1:9222');
    expect(normalizeBrowserCdpUrl('wss://browser.example.com')).toBe('wss://browser.example.com');
    expect(normalizeBrowserCdpUrl('file:///tmp/browser')).toBeUndefined();
    expect(normalizeBrowserCdpUrl('127.0.0.1:9222')).toBeUndefined();
  });

  test('normalizes browser web access config values', () => {
    const config = normalizeBrowserWebAccessConfig({
      browserEnabled: false,
      profileMode: BrowserProfileMode.User,
      networkMode: BrowserNetworkMode.Strict,
      allowedHostnames: ['https://Localhost:8443/a'],
      blockedHostnames: ['tracking.example/path'],
      cdpUrl: 'ftp://browser.example.com',
      remoteCdpTimeoutMs: -1,
      webFetch: {
        enabled: false,
        followGlobalProxy: false,
        timeoutSeconds: 30,
        readability: false,
      },
    });

    expect(config.browserEnabled).toBe(false);
    expect(config.profileMode).toBe(BrowserProfileMode.User);
    expect(config.displayMode).toBe(BrowserDisplayMode.External);
    expect(config.networkMode).toBe(BrowserNetworkMode.Strict);
    expect(config.allowedHostnames).toEqual(['https://localhost:8443']);
    expect(config.blockedHostnames).toEqual(['https://tracking.example']);
    expect(config.cdpUrl).toBeUndefined();
    expect(config.remoteCdpTimeoutMs).toBeUndefined();
    expect(config.webFetch).toMatchObject({
      enabled: false,
      followGlobalProxy: false,
      timeoutSeconds: 30,
      readability: false,
    });
  });

  test('defaults to external display while preserving explicit display choices', () => {
    expect(normalizeBrowserWebAccessConfig(undefined).displayMode).toBe(
      BrowserDisplayMode.External,
    );
    expect(normalizeBrowserWebAccessConfig({ headless: false }).displayMode).toBe(
      BrowserDisplayMode.External,
    );
    expect(normalizeBrowserWebAccessConfig({ headless: true }).displayMode).toBe(
      BrowserDisplayMode.External,
    );
    expect(normalizeBrowserWebAccessConfig({
      displayMode: BrowserDisplayMode.External,
      headless: true,
    }).displayMode).toBe(BrowserDisplayMode.External);
    expect(normalizeBrowserWebAccessConfig({
      displayMode: BrowserDisplayMode.InApp,
    }).displayMode).toBe(BrowserDisplayMode.InApp);
  });

  test('defaults saved login use to per-use approval and preserves an explicit policy', () => {
    expect(normalizeBrowserWebAccessConfig(undefined).credentialUseMode).toBe(
      BrowserCredentialUseMode.AlwaysAsk,
    );
    expect(normalizeBrowserWebAccessConfig({
      credentialUseMode: BrowserCredentialUseMode.OncePerTask,
    }).credentialUseMode).toBe(BrowserCredentialUseMode.OncePerTask);
    expect(normalizeBrowserWebAccessConfig({
      credentialUseMode: 'invalid' as BrowserCredentialUseMode,
    }).credentialUseMode).toBe(BrowserCredentialUseMode.AlwaysAsk);
  });

  test('offers to save manual logins by default and preserves an explicit policy', () => {
    expect(normalizeBrowserWebAccessConfig(undefined).credentialSaveMode).toBe(
      BrowserCredentialSaveMode.Ask,
    );
    expect(normalizeBrowserWebAccessConfig({
      credentialSaveMode: BrowserCredentialSaveMode.Never,
    }).credentialSaveMode).toBe(BrowserCredentialSaveMode.Never);
    expect(normalizeBrowserWebAccessConfig({
      credentialSaveMode: 'invalid' as BrowserCredentialSaveMode,
    }).credentialSaveMode).toBe(BrowserCredentialSaveMode.Ask);
  });
});
