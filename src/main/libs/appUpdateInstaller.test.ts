import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  quit: vi.fn(),
  relaunch: vi.fn(),
  getPath: vi.fn(),
  fetch: vi.fn(),
}));

const cpMocks = vi.hoisted(() => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

const pathMocks = vi.hoisted(() => ({ usePosix: false }));

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof path }>();
  return {
    ...actual,
    // Stubbing process.platform does not change Node's native path implementation.
    // Keep the override local to these imports so Vitest's own paths are unaffected.
    default: new Proxy(actual.default, {
      get(target, key) {
        return Reflect.get(pathMocks.usePosix ? target.posix : target, key);
      },
    }),
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: mocks.getPath,
    quit: mocks.quit,
    relaunch: mocks.relaunch,
  },
  session: {
    defaultSession: {
      fetch: mocks.fetch,
    },
  },
  shell: {
    openPath: mocks.openPath,
    showItemInFolder: mocks.showItemInFolder,
  },
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    exec: cpMocks.exec,
    execFile: cpMocks.execFile,
    spawn: cpMocks.spawn,
  };
});

import { APP_UPDATE_ELEVATION_DECLINED_ERROR } from '../../shared/appUpdate/constants';
import {
  buildMacSwapInstallCommand,
  buildMacSwapPaths,
  buildWindowsInstallerLaunchScript,
  buildWindowsPowerShellCandidatePaths,
  cancelActiveDownload,
  downloadUpdate,
  findAttachedDevEntries,
  installUpdate,
  MAC_SWAP_BACKUP_INFIX,
  MAC_SWAP_ROLLED_BACK_EXIT_CODE,
  MAC_SWAP_STAGING_INFIX,
  parseHdiutilAttachOutput,
  resolveWindowsPowerShellPath,
  WINDOWS_NO_DEFENDER_EXCLUSION_ARG,
  WINDOWS_UAC_DECLINED_EXIT_CODE,
  WindowsInstallerLauncherFallback,
} from './appUpdateInstaller';
import { WINDOWS_INSTALLER_URL_POLICY_VERSION } from './appUpdateUrlPolicy';

const INSTALLER_PATH = 'C:\\Users\\test\\AppData\\Roaming\\LobsterAI\\updates\\lobsterai-update-manual-1.exe';

describe('Windows update install', () => {
  const originalPlatform = process.platform;

  const mockSilentLaunchResult = (error: Error | null, stderr = '') => {
    cpMocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _opts: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        setImmediate(() => callback(error, '', stderr));
        return {} as never;
      },
    );
  };

  beforeEach(() => {
    mocks.openPath.mockReset();
    mocks.showItemInFolder.mockReset();
    mocks.quit.mockReset();
    cpMocks.execFile.mockReset();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 1024 } as fs.Stats);
    vi.spyOn(fs, 'lstatSync').mockReturnValue({
      isFile: () => true,
      isSymbolicLink: () => false,
    } as fs.Stats);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.restoreAllMocks();
  });

  test('launches the update-mode installer through PowerShell and quits on success', async () => {
    mockSilentLaunchResult(null);

    await installUpdate(INSTALLER_PATH);

    expect(cpMocks.execFile).toHaveBeenCalledOnce();
    const [file, args] = cpMocks.execFile.mock.calls[0] as [string, string[]];
    expect(file).toMatch(
      /^[A-Z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i,
    );
    expect(file.toLowerCase()).not.toBe('powershell.exe');
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-NonInteractive');
    const script = args[args.length - 1];
    expect(script).toContain('-FilePath $installer');
    expect(script).toContain('$env:LOBSTERAI_UPDATE_INSTALLER_PATH');
    expect(script).not.toContain(INSTALLER_PATH);
    expect(script).toContain(`'--force-run','--updated'`);
    expect(script).not.toContain(`'/S'`);
    const options = cpMocks.execFile.mock.calls[0]?.[2] as {
      env?: NodeJS.ProcessEnv;
    };
    expect(options.env?.LOBSTERAI_UPDATE_INSTALLER_PATH).toBe(INSTALLER_PATH);
    expect(mocks.quit).toHaveBeenCalledOnce();
    // The wizard path must not run: silent launch succeeded.
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  test('maps a declined UAC prompt to the stable marker and stays running', async () => {
    mockSilentLaunchResult(
      Object.assign(new Error('powershell exited with 1223'), {
        code: WINDOWS_UAC_DECLINED_EXIT_CODE,
      }),
      'Der Vorgang wurde durch den Benutzer abgebrochen.',
    );

    await expect(installUpdate(INSTALLER_PATH)).rejects.toThrow(
      APP_UPDATE_ELEVATION_DECLINED_ERROR,
    );

    // No interactive fallback: it would raise a second elevation prompt.
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  test('falls back to the interactive installer when PowerShell is unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(fs.lstatSync).mockImplementation(() => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });
    mocks.openPath.mockResolvedValue('');

    await installUpdate(INSTALLER_PATH);

    expect(cpMocks.execFile).not.toHaveBeenCalled();
    expect(mocks.openPath).toHaveBeenCalledWith(INSTALLER_PATH);
    expect(mocks.quit).toHaveBeenCalledOnce();
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(' ')).toContain(
      `launcher_fallback=${WindowsInstallerLauncherFallback.WizardNoArgs}`,
    );
  });

  test('falls back to the interactive installer when trusted PowerShell is blocked', async () => {
    mockSilentLaunchResult(
      Object.assign(new Error('spawn blocked'), { code: 'EACCES' }),
    );
    mocks.openPath.mockResolvedValue('');

    await installUpdate(INSTALLER_PATH);

    expect(cpMocks.execFile).toHaveBeenCalledOnce();
    expect(mocks.openPath).toHaveBeenCalledWith(INSTALLER_PATH);
    expect(mocks.quit).toHaveBeenCalledOnce();
  });

  test('reveals the installer in Explorer when the fallback launch also fails', async () => {
    mockSilentLaunchResult(Object.assign(new Error('blocked'), { code: 1 }));
    mocks.openPath.mockResolvedValue('Access is denied.');

    await expect(installUpdate(INSTALLER_PATH)).rejects.toThrow('Access is denied.');

    expect(mocks.showItemInFolder).toHaveBeenCalledWith(INSTALLER_PATH);
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  test('rejects when the installer file is missing', async () => {
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(enoent);

    await expect(installUpdate(INSTALLER_PATH)).rejects.toThrow('Update file not found');

    expect(cpMocks.execFile).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  test('forwards the enterprise no-exclusion switch to the installer', async () => {
    mockSilentLaunchResult(null);

    await installUpdate(INSTALLER_PATH, { noDefenderExclusion: true });

    const [, args] = cpMocks.execFile.mock.calls[0] as [string, string[]];
    const script = args[args.length - 1];
    expect(script).toContain(`'--force-run','--updated','${WINDOWS_NO_DEFENDER_EXCLUSION_ARG}'`);
  });

  test('omits the no-exclusion switch by default', async () => {
    mockSilentLaunchResult(null);

    await installUpdate(INSTALLER_PATH);

    const [, args] = cpMocks.execFile.mock.calls[0] as [string, string[]];
    const script = args[args.length - 1];
    expect(script).not.toContain(WINDOWS_NO_DEFENDER_EXCLUSION_ARG);
  });

  test('passes a metacharacter-containing installer path only through the child environment', async () => {
    const installerPath = "C:\\Users\\o'brien & team\\updates\\setup.exe";
    mockSilentLaunchResult(null);

    await installUpdate(installerPath);

    const [, args, options] = cpMocks.execFile.mock.calls[0] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
    ];
    expect(args.at(-1)).not.toContain(installerPath);
    expect(options.env?.LOBSTERAI_UPDATE_INSTALLER_PATH).toBe(installerPath);
  });
});

describe('Windows PowerShell path resolution', () => {
  test('prefers Sysnative for a 32-bit process on 64-bit Windows', () => {
    expect(buildWindowsPowerShellCandidatePaths({
      systemRoot: 'D:\\Windows',
      processArch: 'ia32',
      env: { PROCESSOR_ARCHITEW6432: 'AMD64' },
    })).toEqual([
      'D:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe',
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
  });

  test('uses System32 directly for a native 64-bit process', () => {
    expect(buildWindowsPowerShellCandidatePaths({
      systemRoot: 'C:\\Windows',
      processArch: 'x64',
      env: {},
    })).toEqual([
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
  });

  test('selects only a trusted existing candidate and never searches PATH', () => {
    const inspected: string[] = [];
    const result = resolveWindowsPowerShellPath({
      systemRoot: 'C:\\Windows',
      processArch: 'ia32',
      env: {
        PROCESSOR_ARCHITEW6432: 'AMD64',
        PATH: 'C:\\Users\\attacker\\bin',
      },
      isTrustedFile: candidate => {
        inspected.push(candidate);
        return candidate.includes('\\System32\\');
      },
    });

    expect(result).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(inspected).not.toContain('C:\\Users\\attacker\\bin\\powershell.exe');
  });

  test('rejects a relative SystemRoot instead of resolving it through cwd', () => {
    expect(resolveWindowsPowerShellPath({
      systemRoot: '..\\Windows',
      processArch: 'x64',
      env: {},
      isTrustedFile: () => true,
    })).toBeNull();
  });

  test('rejects a user-writable fake SystemRoot even when it contains a file', () => {
    expect(resolveWindowsPowerShellPath({
      systemRoot: 'C:\\Users\\attacker\\fake-windows',
      processArch: 'x64',
      env: {},
      isTrustedFile: () => true,
    })).toBeNull();
  });
});

describe('buildWindowsInstallerLaunchScript', () => {
  test('reads the installer path from an environment variable instead of script text', () => {
    const script = buildWindowsInstallerLaunchScript();

    expect(script).toContain('$env:LOBSTERAI_UPDATE_INSTALLER_PATH');
    expect(script).toContain('-FilePath $installer');
  });

  test('converts a declined elevation into the dedicated exit code', () => {
    const script = buildWindowsInstallerLaunchScript();

    expect(script).toContain(`$native -eq ${WINDOWS_UAC_DECLINED_EXIT_CODE}`);
    expect(script).toContain(`exit ${WINDOWS_UAC_DECLINED_EXIT_CODE}`);
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
  });
});

describe('Windows update download URL enforcement', () => {
  const originalPlatform = process.platform;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-download-policy-'));
    mocks.getPath.mockReset();
    mocks.getPath.mockReturnValue(tmpDir);
    mocks.fetch.mockReset();
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test('rejects an insecure input before fetching or creating a partial file', async () => {
    await expect(downloadUpdate(
      'http://downloads.example.com/LobsterAI.exe',
      'manual',
      () => {},
    )).rejects.toThrow('update-url-untrusted');

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, 'updates'))).toBe(false);
  });

  test('downloads directly without relying on Electron response.url', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bytes = new TextEncoder().encode('signed-installer-placeholder');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: '',
      headers: new Headers({ 'content-length': String(bytes.byteLength) }),
      body,
    });

    const inputUrl =
      'https://downloads.example.com/LobsterAI.exe?inputToken=do-not-log';
    const result = await downloadUpdate(
      inputUrl,
      'auto',
      () => {},
    );

    expect(mocks.fetch).toHaveBeenCalledWith(
      inputUrl,
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fs.readFileSync(result.filePath)).toEqual(Buffer.from(bytes));
    expect(result.windowsInstallerUrlPolicyReceipt).toEqual({
      policyVersion: WINDOWS_INSTALLER_URL_POLICY_VERSION,
      inputOrigin: 'https://downloads.example.com',
      finalOrigin: 'https://downloads.example.com',
    });
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('do-not-log');
  });

  test('leaves no cached file when the Windows fetch rejects a redirect', async () => {
    mocks.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(downloadUpdate(
      'https://downloads.example.com/LobsterAI.exe',
      'auto',
      () => {},
    )).rejects.toThrow('Failed to fetch');

    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://downloads.example.com/LobsterAI.exe',
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(fs.existsSync(path.join(tmpDir, 'updates'))).toBe(false);
  });

  test('a cancelled stale download does not clear the replacement download controller', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bodyControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    mocks.fetch.mockImplementation((_url, options: { signal: AbortSignal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyControllers.push(controller);
          options.signal.addEventListener('abort', () => {
            controller.error(new Error('aborted'));
          }, { once: true });
        },
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        url: '',
        headers: new Headers(),
        body,
      });
    });

    const firstDownload = downloadUpdate(
      'https://downloads.example.com/LobsterAI.exe',
      'auto',
      () => {},
    );
    await vi.waitFor(() => expect(bodyControllers).toHaveLength(1));

    expect(cancelActiveDownload()).toBe(true);
    const replacementDownload = downloadUpdate(
      'https://downloads.example.com/LobsterAI.exe',
      'manual',
      () => {},
    );
    await vi.waitFor(() => expect(bodyControllers).toHaveLength(2));
    await expect(firstDownload).rejects.toThrow('Download cancelled');

    expect(cancelActiveDownload()).toBe(true);
    await expect(replacementDownload).rejects.toThrow('Download cancelled');
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('hdiutil plist parsing', () => {
  test('extracts the mount point and dev entries from an APFS attach result', () => {
    // Real-world shape: entity order is not device order.
    const json = JSON.stringify({
      'system-entities': [
        { 'content-hint': 'GUID_partition_scheme', 'dev-entry': '/dev/disk4' },
        { 'dev-entry': '/dev/disk5s1', 'mount-point': '/Volumes/LobsterAI', 'volume-kind': 'apfs' },
        { 'content-hint': 'EF57347C-0000-11AA-AA11-00306543ECAC', 'dev-entry': '/dev/disk5' },
        { 'content-hint': 'Apple_APFS', 'dev-entry': '/dev/disk4s1' },
      ],
    });

    const result = parseHdiutilAttachOutput(json);

    expect(result.mountPoint).toBe('/Volumes/LobsterAI');
    expect(result.devEntries).toEqual(['/dev/disk4', '/dev/disk5s1', '/dev/disk5', '/dev/disk4s1']);
  });

  test('extracts the mount point from an HFS attach result', () => {
    const json = JSON.stringify({
      'system-entities': [
        { 'content-hint': 'GUID_partition_scheme', 'dev-entry': '/dev/disk4' },
        { 'content-hint': 'Apple_HFS', 'dev-entry': '/dev/disk4s1', 'mount-point': '/Volumes/LobsterAI 1' },
      ],
    });

    const result = parseHdiutilAttachOutput(json);

    expect(result.mountPoint).toBe('/Volumes/LobsterAI 1');
  });

  test('reports no mount point when the volume failed to mount', () => {
    const json = JSON.stringify({
      'system-entities': [
        { 'content-hint': 'GUID_partition_scheme', 'dev-entry': '/dev/disk4' },
        { 'content-hint': 'Apple_HFS', 'dev-entry': '/dev/disk4s1' },
      ],
    });

    const result = parseHdiutilAttachOutput(json);

    expect(result.mountPoint).toBeUndefined();
    expect(result.devEntries).toEqual(['/dev/disk4', '/dev/disk4s1']);
  });

  test('preserves special characters in mount points', () => {
    const mountPoint = '/Volumes/龙虾 Test & Vol';
    const json = JSON.stringify({
      'system-entities': [{ 'dev-entry': '/dev/disk4s1', 'mount-point': mountPoint }],
    });

    expect(parseHdiutilAttachOutput(json).mountPoint).toBe(mountPoint);
  });

  test('treats malformed output as no mount point', () => {
    expect(parseHdiutilAttachOutput('not json')).toEqual({ mountPoint: undefined, devEntries: [] });
    expect(parseHdiutilAttachOutput('')).toEqual({ mountPoint: undefined, devEntries: [] });
    expect(parseHdiutilAttachOutput('{}')).toEqual({ mountPoint: undefined, devEntries: [] });
  });

  test('finds dev entries of an attached image by image path', () => {
    const json = JSON.stringify({
      images: [
        {
          'image-path': '/tmp/other.dmg',
          'system-entities': [{ 'dev-entry': '/dev/disk9' }],
        },
        {
          'image-path': '/tmp/update.dmg',
          'system-entities': [{ 'dev-entry': '/dev/disk4' }, { 'dev-entry': '/dev/disk4s1' }],
        },
      ],
    });

    expect(findAttachedDevEntries(json, '/tmp/update.dmg')).toEqual(['/dev/disk4', '/dev/disk4s1']);
    expect(findAttachedDevEntries(json, '/tmp/missing.dmg')).toEqual([]);
    expect(findAttachedDevEntries('not json', '/tmp/update.dmg')).toEqual([]);
  });
});

describe('mac swap builders', () => {
  beforeEach(() => {
    pathMocks.usePosix = true;
  });

  afterEach(() => {
    pathMocks.usePosix = false;
  });

  test('places staging and backup next to the target app, hidden and not .app-suffixed', () => {
    const swapPaths = buildMacSwapPaths('/Applications/Lobster AI.app', 1234);

    expect(path.dirname(swapPaths.staging)).toBe('/Applications');
    expect(path.dirname(swapPaths.backup)).toBe('/Applications');
    expect(path.basename(swapPaths.staging)).toBe(`.Lobster AI.app${MAC_SWAP_STAGING_INFIX}1234`);
    expect(path.basename(swapPaths.backup)).toBe(`.Lobster AI.app${MAC_SWAP_BACKUP_INFIX}1234`);
    expect(swapPaths.staging.endsWith('.app')).toBe(false);
    expect(swapPaths.backup.endsWith('.app')).toBe(false);
  });

  test('builds a staged-copy, guarded-backup, rollback and cleanup sequence', () => {
    const target = '/Applications/LobsterAI.app';
    const swapPaths = buildMacSwapPaths(target, 7);

    const cmd = buildMacSwapInstallCommand('/Volumes/LobsterAI/LobsterAI.app', target, swapPaths);

    const cpIndex = cmd.indexOf(`cp -R '/Volumes/LobsterAI/LobsterAI.app' '${swapPaths.staging}'`);
    const backupIndex = cmd.indexOf(`mv '${target}' '${swapPaths.backup}'`);
    const swapIndex = cmd.indexOf(`mv '${swapPaths.staging}' '${target}'`);
    const rollbackIndex = cmd.indexOf(`mv '${swapPaths.backup}' '${target}'`);
    expect(cpIndex).toBe(0);
    expect(backupIndex).toBeGreaterThan(cpIndex);
    expect(swapIndex).toBeGreaterThan(backupIndex);
    expect(rollbackIndex).toBeGreaterThan(swapIndex);
    expect(cmd).toContain(`exit ${MAC_SWAP_ROLLED_BACK_EXIT_CODE}`);
    expect(cmd).toContain(`[ ! -e '${target}' ]`);
    expect(cmd).toContain(`rm -rf '${swapPaths.backup}'`);
  });

  test('single-quotes paths containing spaces and quotes', () => {
    const target = `/Applications/It's "Lobster".app`;
    const swapPaths = buildMacSwapPaths(target, 7);

    const cmd = buildMacSwapInstallCommand('/Volumes/src.app', target, swapPaths);

    expect(cmd).toContain(`'/Applications/It'\\''s "Lobster".app'`);
  });
});

describe('macOS DMG install', () => {
  const originalPlatform = process.platform;
  const originalResourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  const USER_DATA = '/Users/test/Library/Application Support/LobsterAI';
  const DMG_PATH = `${USER_DATA}/updates/lobsterai-update-auto-1.dmg`;
  const TARGET_APP = '/Applications/LobsterAI.app';

  const attachNoMountJson = JSON.stringify({
    'system-entities': [
      { 'content-hint': 'GUID_partition_scheme', 'dev-entry': '/dev/disk4' },
      { 'content-hint': 'Apple_HFS', 'dev-entry': '/dev/disk4s1' },
    ],
  });

  const attachMountedJson = (mountPoint: string) =>
    JSON.stringify({
      'system-entities': [
        { 'content-hint': 'GUID_partition_scheme', 'dev-entry': '/dev/disk4' },
        { 'content-hint': 'Apple_HFS', 'dev-entry': '/dev/disk4s1', 'mount-point': mountPoint },
      ],
    });

  /** Responds to consecutive `hdiutil attach` calls; other commands succeed with empty output. */
  let attachResponders: Array<(cmd: string) => string>;
  let attachCommands: string[];
  let detachCommands: string[];
  /** Every command passed to exec, in call order. */
  let execCommands: string[];
  /** Per-test hook to fail or answer specific commands; undefined falls through to defaults. */
  let execOverride: ((cmd: string) => { error?: Error; stdout?: string } | undefined) | null;
  /** readdir result for the target app's parent directory. */
  let applicationsEntries: string[];

  const respondNoMount = () => attachNoMountJson;
  const respondMountedAtVolumes = () => attachMountedJson('/Volumes/LobsterAI');
  const respondMountedAtRequestedPoint = (cmd: string) => {
    const match = cmd.match(/-mountpoint '([^']+)'/);
    return attachMountedJson(match ? match[1] : '/Volumes/unexpected');
  };

  const isSwapInCommand = (cmd: string) =>
    cmd.startsWith('mv ') && cmd.includes(MAC_SWAP_STAGING_INFIX) && cmd.endsWith(`'${TARGET_APP}'`);
  const isRollbackCommand = (cmd: string) =>
    cmd.startsWith('mv ') && cmd.includes(MAC_SWAP_BACKUP_INFIX) && cmd.endsWith(`'${TARGET_APP}'`);

  const failPrivilegedInstall = (message: string) => {
    cpMocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _opts: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        setImmediate(() => callback(new Error(message), '', ''));
        return {} as never;
      },
    );
  };

  /** plutil stand-in that echoes stdin, so exec fixtures can be JSON directly. */
  const fakePlutilProcess = () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (encoding: string) => void };
      stderr: EventEmitter & { setEncoding: (encoding: string) => void };
      stdin: { on: (event: string, listener: () => void) => void; end: (data?: string) => void };
    };
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    child.stdin = {
      on: () => {},
      end: (data?: string) => {
        setImmediate(() => {
          child.stdout.emit('data', data ?? '');
          child.emit('close', 0);
        });
      },
    };
    return child;
  };

  beforeEach(() => {
    mocks.openPath.mockReset();
    mocks.showItemInFolder.mockReset();
    mocks.quit.mockReset();
    mocks.relaunch.mockReset();
    mocks.getPath.mockReset();
    mocks.getPath.mockReturnValue(USER_DATA);
    cpMocks.exec.mockReset();
    cpMocks.execFile.mockReset();
    cpMocks.spawn.mockReset();

    Object.defineProperty(process, 'platform', { value: 'darwin' });
    pathMocks.usePosix = true;
    Object.defineProperty(process, 'resourcesPath', {
      value: `${TARGET_APP}/Contents/Resources`,
      configurable: true,
    });

    attachResponders = [];
    attachCommands = [];
    detachCommands = [];
    execCommands = [];
    execOverride = null;
    applicationsEntries = ['LobsterAI.app'];

    cpMocks.exec.mockImplementation(
      (
        cmd: string,
        _opts: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        execCommands.push(cmd);
        const finish = (error: Error | null, stdout = '') =>
          setImmediate(() => callback(error, stdout, ''));
        const override = execOverride?.(cmd);
        if (override) {
          finish(override.error ?? null, override.stdout ?? '');
        } else if (cmd.startsWith('hdiutil attach')) {
          attachCommands.push(cmd);
          const responder = attachResponders.shift() ?? respondNoMount;
          finish(null, responder(cmd));
        } else if (cmd.startsWith('hdiutil detach')) {
          detachCommands.push(cmd);
          finish(null, '');
        } else {
          finish(null, '');
        }
        return {} as never;
      },
    );
    cpMocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _opts: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        setImmediate(() => callback(null, '', ''));
        return {} as never;
      },
    );
    cpMocks.spawn.mockImplementation(() => fakePlutilProcess() as never);

    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 1024 } as fs.Stats);
    vi.spyOn(fs.promises, 'lstat').mockResolvedValue({} as fs.Stats);
    vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
    vi.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined);
    vi.spyOn(fs.promises, 'rmdir').mockResolvedValue(undefined);
    vi.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    vi.spyOn(fs.promises, 'readdir').mockImplementation(((dir: fs.PathLike) => {
      const dirPath = String(dir);
      if (dirPath.endsWith(path.join('Contents', 'MacOS'))) {
        return Promise.resolve(['LobsterAI']);
      }
      if (dirPath === path.dirname(TARGET_APP)) {
        return Promise.resolve(applicationsEntries);
      }
      return Promise.resolve(['LobsterAI.app']);
    }) as never);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    pathMocks.usePosix = false;
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  test('mounts, swap-installs and relaunches on the happy path', async () => {
    attachResponders = [respondMountedAtVolumes];

    await installUpdate(DMG_PATH);

    expect(attachCommands).toHaveLength(1);
    expect(attachCommands[0]).toContain('-plist');
    expect(attachCommands[0]).not.toContain('-mountpoint');

    // Staged copy runs first, then backup move, then the swap-in rename.
    const cpIndex = execCommands.findIndex(
      (cmd) => cmd.startsWith('cp -R') && cmd.includes(MAC_SWAP_STAGING_INFIX),
    );
    const backupIndex = execCommands.findIndex(
      (cmd) => cmd.startsWith(`mv '${TARGET_APP}'`) && cmd.includes(MAC_SWAP_BACKUP_INFIX),
    );
    const swapIndex = execCommands.findIndex(isSwapInCommand);
    expect(cpIndex).toBeGreaterThanOrEqual(0);
    expect(backupIndex).toBeGreaterThan(cpIndex);
    expect(swapIndex).toBeGreaterThan(backupIndex);
    // The destructive rm -rf of the old install is gone; the backup is
    // removed via fs.rm only after the new version is in place.
    expect(execCommands.some((cmd) => cmd.startsWith('rm -rf'))).toBe(false);
    expect(fs.promises.rm).toHaveBeenCalledWith(
      expect.stringContaining(MAC_SWAP_BACKUP_INFIX),
      { recursive: true, force: true },
    );

    expect(detachCommands).toHaveLength(1);
    expect(detachCommands[0]).toContain('/Volumes/LobsterAI');
    expect(fs.promises.unlink).toHaveBeenCalledWith(DMG_PATH);
    expect(cpMocks.execFile).not.toHaveBeenCalled();
    expect(mocks.relaunch).toHaveBeenCalledExactlyOnceWith({
      execPath: `${TARGET_APP}/Contents/MacOS/LobsterAI`,
    });
    expect(mocks.quit).toHaveBeenCalledOnce();
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(fs.promises.mkdir).not.toHaveBeenCalled();
  });

  test('detaches the stale attachment and retries with an explicit mount point', async () => {
    attachResponders = [respondNoMount, respondMountedAtRequestedPoint];

    await installUpdate(DMG_PATH);

    expect(attachCommands).toHaveLength(2);
    expect(attachCommands[1]).toContain('-mountpoint');
    expect(attachCommands[1]).toContain(`${USER_DATA}/updates/mnt-`);
    // Stale attachment from the failed first attach is torn down before the retry.
    expect(detachCommands.some((cmd) => cmd.includes('/dev/disk4'))).toBe(true);
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.quit).toHaveBeenCalledOnce();
    // The explicit mount point directory is removed after detach.
    expect(fs.promises.rmdir).toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  test('opens the DMG in Finder and rejects when the volume never mounts', async () => {
    attachResponders = [respondNoMount, respondNoMount];
    mocks.openPath.mockResolvedValue('');

    await expect(installUpdate(DMG_PATH)).rejects.toThrow(
      'Failed to determine mount point from hdiutil output',
    );

    expect(attachCommands).toHaveLength(2);
    expect(mocks.openPath).toHaveBeenCalledWith(DMG_PATH);
    expect(detachCommands.length).toBeGreaterThan(0);
    expect(fs.promises.rmdir).toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  test('falls back to revealing the DMG when Finder cannot open it', async () => {
    attachResponders = [respondNoMount, respondNoMount];
    mocks.openPath.mockResolvedValue('No application knows how to open this file.');

    await expect(installUpdate(DMG_PATH)).rejects.toThrow(
      'Failed to determine mount point from hdiutil output',
    );

    expect(mocks.showItemInFolder).toHaveBeenCalledWith(DMG_PATH);
  });

  test('leaves the current app untouched when the staging copy fails everywhere', async () => {
    attachResponders = [respondMountedAtVolumes];
    execOverride = (cmd) =>
      cmd.startsWith('cp -R') ? { error: new Error('No space left on device') } : undefined;
    failPrivilegedInstall('execution error: User canceled. (-128)');

    await expect(installUpdate(DMG_PATH)).rejects.toThrow(
      /insufficient permissions[\s\S]*current version untouched/,
    );

    // The current install is never moved or deleted.
    expect(execCommands.some((cmd) => cmd.startsWith(`mv '${TARGET_APP}'`))).toBe(false);
    expect(execCommands.some((cmd) => cmd.startsWith('rm -rf'))).toBe(false);
    // The failed staging copy is cleaned up.
    expect(fs.promises.rm).toHaveBeenCalledWith(
      expect.stringContaining(MAC_SWAP_STAGING_INFIX),
      { recursive: true, force: true },
    );
    // The image is detached on failure.
    expect(detachCommands.length).toBeGreaterThan(0);
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  test('rolls back the backup and retries with privileges when the swap-in fails', async () => {
    attachResponders = [respondMountedAtVolumes];
    execOverride = (cmd) => (isSwapInCommand(cmd) ? { error: new Error('swap blocked') } : undefined);

    await installUpdate(DMG_PATH);

    const swapIndex = execCommands.findIndex(isSwapInCommand);
    const rollbackIndex = execCommands.findIndex(isRollbackCommand);
    expect(swapIndex).toBeGreaterThanOrEqual(0);
    expect(rollbackIndex).toBeGreaterThan(swapIndex);
    expect(cpMocks.execFile).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });

  test('reports rolled back when the privileged swap also fails after a rollback', async () => {
    attachResponders = [respondMountedAtVolumes];
    execOverride = (cmd) => (isSwapInCommand(cmd) ? { error: new Error('swap blocked') } : undefined);
    failPrivilegedInstall(
      `execution error: 该命令退出时状态为非零。 (${MAC_SWAP_ROLLED_BACK_EXIT_CODE})`,
    );

    await expect(installUpdate(DMG_PATH)).rejects.toThrow(/rolled back to current version/);

    expect(mocks.quit).not.toHaveBeenCalled();
  });

  test('skips the backup step when no app exists at the target path', async () => {
    attachResponders = [respondMountedAtVolumes];
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    vi.mocked(fs.promises.lstat).mockRejectedValue(enoent);

    await installUpdate(DMG_PATH);

    expect(execCommands.some((cmd) => cmd.startsWith(`mv '${TARGET_APP}'`))).toBe(false);
    expect(execCommands.findIndex(isSwapInCommand)).toBeGreaterThanOrEqual(0);
    expect(mocks.quit).toHaveBeenCalledOnce();
  });

  test('surfaces the backup path when the rollback itself fails', async () => {
    attachResponders = [respondMountedAtVolumes];
    execOverride = (cmd) => {
      if (isSwapInCommand(cmd)) {
        return { error: new Error('swap blocked') };
      }
      if (isRollbackCommand(cmd)) {
        return { error: new Error('rollback blocked') };
      }
      return undefined;
    };

    await expect(installUpdate(DMG_PATH)).rejects.toThrow(
      /previous version preserved at .*\.backup-/,
    );

    // No privileged retry on a stranded backup: the filesystem state is unexpected.
    expect(cpMocks.execFile).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  test('cleans up leftover staging and backup directories before installing', async () => {
    attachResponders = [respondMountedAtVolumes];
    applicationsEntries = [
      `.LobsterAI.app${MAC_SWAP_STAGING_INFIX}1`,
      `.LobsterAI.app${MAC_SWAP_BACKUP_INFIX}2`,
      'LobsterAI.app',
      'Other.app',
    ];

    await installUpdate(DMG_PATH);

    expect(fs.promises.rm).toHaveBeenCalledWith(
      `/Applications/.LobsterAI.app${MAC_SWAP_STAGING_INFIX}1`,
      { recursive: true, force: true },
    );
    expect(fs.promises.rm).toHaveBeenCalledWith(
      `/Applications/.LobsterAI.app${MAC_SWAP_BACKUP_INFIX}2`,
      { recursive: true, force: true },
    );
    expect(fs.promises.rm).not.toHaveBeenCalledWith('/Applications/Other.app', expect.anything());
    expect(mocks.quit).toHaveBeenCalledOnce();
  });

  test('passes the composite swap command to osascript for the privileged path', async () => {
    attachResponders = [respondMountedAtVolumes];
    execOverride = (cmd) =>
      cmd.startsWith('cp -R') ? { error: new Error('Operation not permitted') } : undefined;

    await installUpdate(DMG_PATH);

    expect(cpMocks.execFile).toHaveBeenCalledOnce();
    const [file, args] = cpMocks.execFile.mock.calls[0] as [string, string[]];
    expect(file).toBe('osascript');
    expect(args[0]).toBe('-e');
    expect(args[1]).toContain('do shell script "');
    expect(args[1]).toContain('with administrator privileges');
    expect(args[1]).toContain('cp -R ');
    expect(args[1]).toContain(`exit ${MAC_SWAP_ROLLED_BACK_EXIT_CODE}`);
    expect(mocks.quit).toHaveBeenCalledOnce();
  });
});
