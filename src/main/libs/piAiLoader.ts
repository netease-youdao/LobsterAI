import { app } from 'electron';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { pathToFileURL } from 'url';

export type PiAiModule = typeof import('@mariozechner/pi-ai');

let piAiPromise: Promise<PiAiModule> | null = null;

const PI_AI_PATH_PARTS = ['@mariozechner', 'pi-ai', 'dist', 'index.js'];
const moduleRequire = createRequire(__filename);

function resolveInstalledPiAiPath(): string | null {
  try {
    return moduleRequire.resolve('@mariozechner/pi-ai/dist/index.js');
  } catch {
    return null;
  }
}

function getPiAiPath(): string {
  const installedPath = resolveInstalledPiAiPath();
  if (installedPath && existsSync(installedPath)) {
    return installedPath;
  }

  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      ...PI_AI_PATH_PARTS
    );
  }

  const appPath = app.getAppPath();
  const rootDir = appPath.endsWith('dist-electron')
    ? join(appPath, '..')
    : appPath;

  return join(rootDir, 'node_modules', ...PI_AI_PATH_PARTS);
}

export function loadPiAi(): Promise<PiAiModule> {
  if (!piAiPromise) {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<PiAiModule>;

    const modulePath = getPiAiPath();
    if (!existsSync(modulePath)) {
      throw new Error(`pi-ai module not found at: ${modulePath}`);
    }

    piAiPromise = dynamicImport(pathToFileURL(modulePath).href).catch((error) => {
      piAiPromise = null;
      throw error;
    });
  }

  return piAiPromise;
}
