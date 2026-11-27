import { afterEach, describe, expect, test, vi } from 'vitest';

import type { SqliteStore } from '../sqliteStore';

const electronState = vi.hoisted(() => ({ isPackaged: false }));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged;
    },
  },
}));

import {
  getMcpMarketplaceUrl,
  isTestModeEnabled,
  refreshEndpointsTestMode,
} from './endpoints';

const createMockStore = (testMode?: boolean): SqliteStore => ({
  get: () => (testMode === undefined ? undefined : { app: { testMode } }),
}) as unknown as SqliteStore;

describe('endpoints MCP marketplace URL resolution', () => {
  afterEach(() => {
    electronState.isPackaged = false;
    refreshEndpointsTestMode(createMockStore(false));
  });

  test('uses prod MCP marketplace in dev builds when testMode is false or unset', () => {
    electronState.isPackaged = false;

    refreshEndpointsTestMode(createMockStore(undefined));
    expect(isTestModeEnabled()).toBe(false);
    expect(getMcpMarketplaceUrl()).toBe(
      'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/mcp-marketplace',
    );

    refreshEndpointsTestMode(createMockStore(false));
    expect(isTestModeEnabled()).toBe(false);
    expect(getMcpMarketplaceUrl()).toBe(
      'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/mcp-marketplace',
    );
  });

  test('switches MCP marketplace to test when testMode is enabled, including in packaged builds', () => {
    electronState.isPackaged = true;

    refreshEndpointsTestMode(createMockStore(true));
    expect(isTestModeEnabled()).toBe(true);
    expect(getMcpMarketplaceUrl()).toBe(
      'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/test/mcp-marketplace',
    );

    refreshEndpointsTestMode(createMockStore(false));
    expect(isTestModeEnabled()).toBe(false);
    expect(getMcpMarketplaceUrl()).toBe(
      'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/mcp-marketplace',
    );
  });
});
