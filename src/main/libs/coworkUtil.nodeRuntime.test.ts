import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const electronState = vi.hoisted(() => ({ isPackaged: false, name: 'LobsterAI' }));

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return electronState.isPackaged; },
    getName: () => electronState.name,
  },
}));
vi.mock('./claudeSettings', () => ({}));
vi.mock('./coworkLogger', () => ({ coworkLog: vi.fn() }));
vi.mock('./pythonRuntime', () => ({}));
vi.mock('./systemProxy', () => ({}));

const hostProcess = process;
let appContents: string;

beforeEach(() => {
  vi.resetModules();
  electronState.isPackaged = false;
  electronState.name = 'LobsterAI';
  appContents = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai electron runtime '));
  vi.stubGlobal('process', {
    ...hostProcess,
    platform: 'darwin',
    resourcesPath: path.join(appContents, 'Resources'),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(appContents, { recursive: true, force: true });
});

function createHelper(name: string): string {
  const executable = path.join(appContents, 'Frameworks', `${name}.app`, 'Contents', 'MacOS', name);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '');
  return executable;
}

describe('getElectronNodeRuntimePath', () => {
  test('uses the background Electron Helper in macOS development despite the product app name', async () => {
    createHelper('Electron Helper (Renderer)');
    const helper = createHelper('Electron Helper');
    const { getElectronNodeRuntimePath } = await import('./coworkUtil');

    expect(getElectronNodeRuntimePath()).toBe(helper);
  });

  test('keeps the product-specific helper for packaged macOS apps', async () => {
    electronState.isPackaged = true;
    electronState.name = 'Lobster AI';
    createHelper('Lobster AI Helper (Renderer)');
    const helper = createHelper('Lobster AI Helper');
    const { getElectronNodeRuntimePath } = await import('./coworkUtil');

    expect(getElectronNodeRuntimePath()).toBe(helper);
  });

  test('falls back to the current executable when no macOS helper is bundled', async () => {
    const { getElectronNodeRuntimePath } = await import('./coworkUtil');

    expect(getElectronNodeRuntimePath()).toBe(hostProcess.execPath);
  });

  test.each<NodeJS.Platform>(['win32', 'linux'])(
    'keeps the current executable on %s',
    async platform => {
      vi.stubGlobal('process', { ...process, platform });
      createHelper('Electron Helper');
      const { getElectronNodeRuntimePath } = await import('./coworkUtil');

      expect(getElectronNodeRuntimePath()).toBe(hostProcess.execPath);
    },
  );
});
