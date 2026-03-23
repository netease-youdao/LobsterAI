import { app } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { coworkLog } from './coworkLogger';

export type ClaudeSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

let claudeSdkPromise: Promise<ClaudeSdkModule> | null = null;

const CLAUDE_SDK_PATH_PARTS = ['@anthropic-ai', 'claude-agent-sdk'];

function getClaudeSdkPath(): string {
  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      ...CLAUDE_SDK_PATH_PARTS,
      'sdk.mjs'
    );
  }

  // In development, try to find the SDK in the project root node_modules
  // app.getAppPath() might point to dist-electron or other build output directories
  // We need to look in the project root
  const appPath = app.getAppPath();
  // If appPath ends with dist-electron, go up one level
  const rootDir = appPath.endsWith('dist-electron')
    ? join(appPath, '..')
    : appPath;

  const sdkPath = join(
    rootDir,
    'node_modules',
    ...CLAUDE_SDK_PATH_PARTS,
    'sdk.mjs'
  );

  console.log('[ClaudeSDK] Resolved SDK path:', sdkPath);
  return sdkPath;
}

// SECURITY NOTE: We use `new Function()` here to enable dynamic ESM import from CJS context.
// This is a controlled usage pattern where the specifier is always a validated file:// URL
// pointing to the bundled Claude SDK path. The path is computed from app.getAppPath() and
// process.resourcesPath, not from user input, making this safe from injection attacks.
// Alternative approaches (vm.Module, worker_threads) would add significant complexity.
const createDynamicImport = (): ((specifier: string) => Promise<ClaudeSdkModule>) => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<ClaudeSdkModule>;
};

// Validate that a URL is a safe file:// URL pointing to our SDK
const isValidSdkUrl = (url: string): boolean => {
  if (!url.startsWith('file://')) {
    return false;
  }
  // Must contain our expected SDK path parts
  return url.includes('@anthropic-ai') && url.includes('claude-agent-sdk') && url.endsWith('sdk.mjs');
};

export function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  if (!claudeSdkPromise) {
    const sdkPath = getClaudeSdkPath();
    const sdkUrl = pathToFileURL(sdkPath).href;
    const sdkExists = existsSync(sdkPath);

    // Validate the URL before dynamic import
    if (!isValidSdkUrl(sdkUrl)) {
      const error = new Error(`Invalid SDK URL: ${sdkUrl}`);
      coworkLog('ERROR', 'loadClaudeSdk', 'SDK URL validation failed', {
        sdkUrl,
        sdkPath,
      });
      return Promise.reject(error);
    }

    coworkLog('INFO', 'loadClaudeSdk', 'Loading Claude SDK', {
      sdkPath,
      sdkUrl,
      sdkExists,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });

    // Use runtime dynamic import so the CJS build can load the SDK's ESM entry.
    const dynamicImport = createDynamicImport();
    claudeSdkPromise = dynamicImport(sdkUrl).catch((error) => {
      coworkLog('ERROR', 'loadClaudeSdk', 'Failed to load Claude SDK', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        sdkPath,
        sdkExists,
      });
      claudeSdkPromise = null;
      throw error;
    });
  }

  return claudeSdkPromise;
}
