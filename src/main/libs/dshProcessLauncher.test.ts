import { describe, expect, test } from 'vitest';

import { buildDshProcessLaunch } from './dshProcessLauncher';

const baseOptions = {
  executablePath: '/Applications/LobsterAI.app/Contents/MacOS/LobsterAI',
  args: ['/runtime/lib/bin.js', 'web', '--port', '31163'],
  cwd: '/work/project',
  env: { DSH_HOME: '/home/user/.dsh', ELECTRON_RUN_AS_NODE: 'stale' },
};

describe('buildDshProcessLaunch', () => {
  test('runs Electron as Node with the Cordis loader flag on macOS', () => {
    const launch = buildDshProcessLaunch(baseOptions, 'darwin');

    expect(launch.command).toBe(baseOptions.executablePath);
    expect(launch.args).toEqual(['--expose-internals', ...baseOptions.args]);
    expect(launch.options).toMatchObject({
      cwd: baseOptions.cwd,
      env: { DSH_HOME: '/home/user/.dsh', ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(launch.options).not.toHaveProperty('windowsHide');
  });

  test('uses the same launcher on Windows and hides its console window', () => {
    const launch = buildDshProcessLaunch(baseOptions, 'win32');

    expect(launch.args[0]).toBe('--expose-internals');
    expect(launch.options.env?.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(launch.options.windowsHide).toBe(true);
  });

  test('uses the same launcher on Linux', () => {
    const launch = buildDshProcessLaunch(baseOptions, 'linux');

    expect(launch.args).toEqual(['--expose-internals', ...baseOptions.args]);
    expect(launch.options.env?.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(launch.options).not.toHaveProperty('windowsHide');
  });
});
