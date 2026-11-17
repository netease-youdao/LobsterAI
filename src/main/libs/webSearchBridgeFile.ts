import fs from 'fs';
import path from 'path';

/**
 * Tells the web-search skill's bridge server where the running app's hidden
 * search page is. The server outlives the app and the bridge port changes on
 * every launch, so it reads this file per request instead of taking the
 * endpoint from its spawn arguments.
 */
export const WEB_SEARCH_BRIDGE_FILE_ENV = 'LOBSTERAI_WEB_SEARCH_BRIDGE_FILE';

const BRIDGE_FILE_NAME = 'web-search-bridge.json';

export const getWebSearchBridgeFilePath = (userDataPath: string): string => (
  path.join(userDataPath, BRIDGE_FILE_NAME)
);

export const writeWebSearchBridgeFile = (
  filePath: string,
  bridge: { bridgeUrl: string; bridgeSecret: string },
): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ version: 1, bridgeUrl: bridge.bridgeUrl, bridgeSecret: bridge.bridgeSecret }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600);
  }
};

export const removeWebSearchBridgeFile = (filePath: string): void => {
  fs.rmSync(filePath, { force: true });
};
