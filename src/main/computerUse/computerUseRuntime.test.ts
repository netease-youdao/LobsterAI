import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn(() => ''),
  },
  session: {
    defaultSession: {
      fetch: vi.fn(),
    },
  },
}));

import {
  ComputerUseRuntimeArch,
  ComputerUseRuntimePlatform,
  ComputerUseRuntimes,
  ComputerUseRuntimeStatus,
  ComputerUseRuntimeTarget,
  getCurrentComputerUseRuntimeDescriptor,
  inspectComputerUseRuntime,
  installComputerUseRuntime,
} from './computerUseRuntime';

const originalPlatform = process.platform;
const originalArch = process.arch;

/** `systemVersion` stands in for Electron's process.getSystemVersion(); omit it to leave the OS version unknown. */
function setHost(platform: string, arch: string, systemVersion?: string): void {
  Object.defineProperty(process, 'platform', { value: platform });
  Object.defineProperty(process, 'arch', { value: arch });
  if (systemVersion !== undefined) {
    Object.defineProperty(process, 'getSystemVersion', {
      configurable: true,
      value: () => systemVersion,
    });
  }
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  Object.defineProperty(process, 'arch', { value: originalArch });
  delete (process as { getSystemVersion?: unknown }).getSystemVersion;
});

describe('getCurrentComputerUseRuntimeDescriptor', () => {
  test('selects the Intel runtime on macOS x64', () => {
    setHost(ComputerUseRuntimePlatform.MacOS, ComputerUseRuntimeArch.X64, '13.0.0');

    expect(getCurrentComputerUseRuntimeDescriptor()).toBe(ComputerUseRuntimes[ComputerUseRuntimeTarget.MacX64]);
  });

  test('selects the Apple silicon runtime on macOS arm64', () => {
    setHost(ComputerUseRuntimePlatform.MacOS, ComputerUseRuntimeArch.Arm64, '26.0.1');

    expect(getCurrentComputerUseRuntimeDescriptor()).toBe(ComputerUseRuntimes[ComputerUseRuntimeTarget.MacArm64]);
  });

  test.each([ComputerUseRuntimeArch.Arm64, ComputerUseRuntimeArch.X64])(
    'offers no %s macOS runtime below the helper deployment target',
    (arch) => {
      setHost(ComputerUseRuntimePlatform.MacOS, arch, '12.7.6');

      expect(getCurrentComputerUseRuntimeDescriptor()).toBeNull();
      expect(inspectComputerUseRuntime().status).toBe(ComputerUseRuntimeStatus.Unsupported);
    },
  );

  test('keeps the macOS minimum away from the Windows runtime', () => {
    setHost(ComputerUseRuntimePlatform.Windows, ComputerUseRuntimeArch.X64, '10.0.19045');

    expect(getCurrentComputerUseRuntimeDescriptor()).toBe(ComputerUseRuntimes[ComputerUseRuntimeTarget.WindowsX64]);
  });

  test('does not gate on the OS version outside Electron', () => {
    setHost(ComputerUseRuntimePlatform.MacOS, ComputerUseRuntimeArch.X64);

    expect(getCurrentComputerUseRuntimeDescriptor()).toBe(ComputerUseRuntimes[ComputerUseRuntimeTarget.MacX64]);
  });
});

describe('installComputerUseRuntime', () => {
  test('names the supported platforms when macOS is too old', async () => {
    setHost(ComputerUseRuntimePlatform.MacOS, ComputerUseRuntimeArch.X64, '12.7.6');

    await expect(installComputerUseRuntime()).resolves.toEqual({
      success: false,
      error: 'Computer Use runtime is only available on Windows x64 or macOS 13 or later.',
    });
  });
});
