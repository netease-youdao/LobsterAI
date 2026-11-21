import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DshHostBundleEnvVar,
  DshHostPhase,
  DshSearchPolicy,
} from '../../../shared/dshEngine/hostConstants';
import {
  buildIsolatedDshChildEnv,
  DshHostManager,
  resolveBundledDshPaths,
} from './dshHostManager';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dsh-host-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveBundledDshPaths', () => {
  test('resolves dev layout under vendor/dsh-runtime/current and dsh-bundles/', () => {
    const root = createTempDir();
    const res = resolveBundledDshPaths({ isPackaged: false, appRootDir: root });
    expect(res.runtimeDir).toBe(path.join(root, 'vendor', 'dsh-runtime', 'current'));
    expect(res.hostBundleDir).toBe(path.join(root, 'dsh-bundles', 'lobsterai-host'));
    expect(res.channelsBundleDir).toBeNull();
  });

  test('resolves packaged layout under resourcesPath and detects channels bundle when present', () => {
    const resources = createTempDir();
    const channelsDir = path.join(resources, 'dsh-bundles', 'lobsterai-channels');
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.writeFileSync(path.join(channelsDir, 'package.json'), '{"name":"@lobsterai/dsh-channels"}');

    const res = resolveBundledDshPaths({
      isPackaged: true,
      appRootDir: '/ignored',
      resourcesDir: resources,
    });
    expect(res.runtimeDir).toBe(path.join(resources, 'dsh-runtime'));
    expect(res.hostBundleDir).toBe(path.join(resources, 'dsh-bundles', 'lobsterai-host'));
    expect(res.channelsBundleDir).toBe(channelsDir);
  });
});

describe('DshHostManager', () => {
  test('dispatches named tools and delegates provider tools only for valid names', async () => {
    const temp = createTempDir();
    const manager = new DshHostManager({
      userDataDir: temp,
      runtimeDir: path.join(temp, 'runtime'),
      hostBundleDir: path.join(temp, 'bundle'),
      skillsDir: path.join(temp, 'skills'),
      executablePath: process.execPath,
    });
    const fallback = vi.fn(() => ({ via: 'provider' }));
    const unregisterOld = manager.registerBridgeToolHandler('sample', () => ({ via: 'old' }));
    const unregister = manager.registerBridgeToolHandler('sample', () => ({ via: 'registered' }));
    unregisterOld();
    manager.setFallbackBridgeToolHandler(fallback);
    await manager['ensureBridgeServer']();
    const execute = (toolName: unknown) => fetch(`${manager['bridgeUrl']}/dsh-bridge/tool-execute`, {
      method: 'POST',
      headers: { authorization: `Bearer ${manager['bridgeSecret']}` },
      body: JSON.stringify({ toolName }),
    });
    try {
      expect(await (await execute('sample')).json()).toEqual({ via: 'registered' });
      expect((await execute(123)).status).toBe(400);
      expect((await execute('   ')).status).toBe(400);
      expect(fallback).not.toHaveBeenCalled();
      expect(await (await execute('provider_tool')).json()).toEqual({ via: 'provider' });
      expect(fallback).toHaveBeenCalledWith(expect.objectContaining({
        toolName: 'provider_tool', signal: expect.any(AbortSignal),
      }));
      unregister();
      manager.setFallbackBridgeToolHandler(null);
      expect((await execute('sample')).status).toBe(404);
    } finally {
      await manager.stop();
    }
  });

  test('reports initial stopped status and fails clearly when runtime binary is missing', async () => {
    const temp = createTempDir();
    const manager = new DshHostManager({
      userDataDir: path.join(temp, 'userData'),
      runtimeDir: path.join(temp, 'missing-runtime'),
      hostBundleDir: path.join(temp, 'host-bundle'),
      skillsDir: path.join(temp, 'skills'),
      executablePath: process.execPath,
      skipElectronRunAsNode: true,
    });

    expect(manager.getStatus().phase).toBe(DshHostPhase.Stopped);
    expect(manager.isReady()).toBe(false);

    // Attach error listener so EventEmitter does not throw unhandled error.
    const errors: Error[] = [];
    manager.on('error', (err: Error) => errors.push(err));

    await expect(manager.start()).rejects.toThrow(/DSH runtime binary not found/);
    expect(manager.getStatus().phase).toBe(DshHostPhase.Failed);
    expect(errors.length).toBe(1);

    await manager.stop();
    expect(manager.getStatus().phase).toBe(DshHostPhase.Stopped);
  });

  test('caches sync payloads safely while stopped before host is ready', async () => {
    const temp = createTempDir();
    const manager = new DshHostManager({
      userDataDir: path.join(temp, 'userData'),
      runtimeDir: path.join(temp, 'runtime'),
      hostBundleDir: path.join(temp, 'host-bundle'),
      skillsDir: path.join(temp, 'skills'),
      executablePath: process.execPath,
      skipElectronRunAsNode: true,
    });

    const provRes = await manager.syncProviders({ providers: [] });
    const mcpRes = await manager.syncMcpServers([]);
    const skillRes = await manager.syncSkillsPolicy({ disabledIds: ['foo'] });
    const webAccessRes = await manager.syncWebAccessPolicy({
      webFetchEnabled: false,
      blockedHostnames: ['blocked.example.com'],
    });
    const toolsRes = await manager.syncHostTools([]);
    const agentsRes = await manager.syncAgents([]);
    const bindingsRes = await manager.syncSubagentBindings([], { replace: true });

    expect(provRes).toEqual({ deferred: true });
    expect(mcpRes).toEqual({ deferred: true });
    expect(skillRes).toEqual({ deferred: true });
    expect(webAccessRes).toEqual({ deferred: true });
    expect(toolsRes).toEqual({ deferred: true });
    expect(agentsRes).toEqual({ deferred: true });
    expect(bindingsRes).toEqual({ deferred: true });
  });

  test('buildIsolatedDshChildEnv strips inherited native DSH_* & DEEPSEEK_API_KEY vars and exposes skill/node-shim env', () => {
    const temp = createTempDir();
    const dshHomeDir = path.join(temp, 'userData', 'dsh-profile');
    const nodeShimDir = path.join(temp, 'userData', 'cowork', 'bin');
    fs.mkdirSync(nodeShimDir, { recursive: true });
    const skillsDir = path.join(temp, 'userData', 'SKILLs');
    const bridgeFile = path.join(temp, 'userData', 'web-search-bridge.json');
    const npmBinDir = path.join(temp, 'npm', 'bin');

    const env = buildIsolatedDshChildEnv({
      baseEnv: {
        PATH: '/usr/bin',
        DSH_HOME: '/Users/alice/.dsh',
        DSH_AGENTS_HOME: '/Users/alice/.agents',
        DSH_BUNDLED_SKILL_DIR: '/opt/native-dsh/skills',
        DSH_PROFILE: 'desktop',
        DEEPSEEK_API_KEY: 'sk-ambient-leak',
        deepseek_api_key: 'sk-ambient-leak-lower',
        npm_config_store_dir: '/Users/alice/.local/share/pnpm/store',
        npm_config_cache: '/Users/alice/.npm',
        HOME: '/Users/alice',
      },
      dshHomeDir,
      bridgeUrl: 'http://127.0.0.1:41234',
      bridgeSecret: 'secret',
      workspacesDir: path.join(temp, 'userData', 'workspaces'),
      skillsDir,
      searchPolicy: DshSearchPolicy.DeepSeekNativeOnly,
      runtimeDir: path.join(temp, 'runtime'),
      executablePath: '/Applications/LobsterAI.app/Contents/MacOS/LobsterAI',
      webSearchBridgeFile: bridgeFile,
      nodeShimDir,
      npmBinDir,
    });

    expect(env.DSH_HOME).toBe(dshHomeDir);
    expect(env.DSH_AGENTS_HOME).toBe(path.join(dshHomeDir, 'agents-home'));
    expect(env.DSH_TELEMETRY_DISABLED).toBe('1');
    expect(env.DSH_BUNDLED_SKILL_DIR).toBeUndefined();
    expect(env.DSH_PROFILE).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.deepseek_api_key).toBeUndefined();
    expect(env.SKILLS_ROOT).toBe(skillsDir.replace(/\\/g, '/'));
    expect(env.LOBSTERAI_SKILLS_ROOT).toBe(skillsDir.replace(/\\/g, '/'));
    expect(env.LOBSTERAI_ELECTRON_PATH).toBe('/Applications/LobsterAI.app/Contents/MacOS/LobsterAI');
    expect(env.LOBSTERAI_WEB_SEARCH_BRIDGE_FILE).toBe(bridgeFile);
    expect(env.LOBSTERAI_NPM_BIN_DIR).toBe(npmBinDir);
    expect(env.PATH?.split(path.delimiter)[0]).toBe(nodeShimDir);
    expect(env.npm_config_store_dir).toBe(path.join(dshHomeDir, 'cache', 'pnpm-store'));
    expect(env.npm_config_cache).toBe(path.join(dshHomeDir, 'cache', 'npm-cache'));
    expect(env.HOME).toBe('/Users/alice');
    expect(env[DshHostBundleEnvVar.SkillsDir]).toBe(skillsDir);
  });

  test('buildIsolatedDshChildEnv injects skill runtime vars, preserves TZ, and merges runtime PATH dirs without leaking DSH_*', () => {
    const temp = createTempDir();
    const dshHomeDir = path.join(temp, 'userData', 'dsh-profile');
    const runtimeDir = path.join(temp, 'runtime');
    const pmDir = path.join(runtimeDir, 'package-manager');
    fs.mkdirSync(pmDir, { recursive: true });
    const skillsDir = path.join(temp, 'userData', 'SKILLs');
    const bridgeFile = path.join(temp, 'userData', 'web-search-bridge.json');
    const nodeShimDir = path.join(temp, 'userData', 'cowork', 'bin');
    const pythonDir = path.join(temp, 'userData', 'runtimes', 'python-win');

    const withInheritedTz = buildIsolatedDshChildEnv({
      baseEnv: {
        PATH: `/usr/bin${path.delimiter}/bin`,
        TZ: 'America/Los_Angeles',
      },
      dshHomeDir,
      bridgeUrl: 'http://127.0.0.1:41234',
      bridgeSecret: 'secret',
      workspacesDir: path.join(temp, 'userData', 'workspaces'),
      skillsDir,
      searchPolicy: DshSearchPolicy.DeepSeekNativeOnly,
      runtimeDir,
      executablePath: '/Apps/LobsterAI Helper',
      webSearchBridgeFile: bridgeFile,
      timeZone: 'Asia/Shanghai',
      nodeShimDir,
      npmBinDir: '/Apps/resources/npm/bin',
      prependPathDirs: [pythonDir],
      appendPathDirs: ['/opt/homebrew/bin', '/usr/bin'],
      extraEnv: {
        LOBSTERAI_PYTHON_ROOT: pythonDir,
        PYTHONUTF8: '1',
        DSH_HOME: '/should/be/ignored',
        npm_config_cache: '/should/be/ignored',
      },
    });

    expect(withInheritedTz.SKILLS_ROOT).toBe(skillsDir);
    expect(withInheritedTz.LOBSTERAI_SKILLS_ROOT).toBe(skillsDir);
    expect(withInheritedTz.LOBSTERAI_ELECTRON_PATH).toBe('/Apps/LobsterAI Helper');
    expect(withInheritedTz.LOBSTERAI_WEB_SEARCH_BRIDGE_FILE).toBe(bridgeFile);
    expect(withInheritedTz.LOBSTERAI_NPM_BIN_DIR).toBe('/Apps/resources/npm/bin');
    expect(withInheritedTz.LOBSTERAI_PYTHON_ROOT).toBe(pythonDir);
    expect(withInheritedTz.PYTHONUTF8).toBe('1');
    expect(withInheritedTz.DSH_HOME).toBe(dshHomeDir);
    expect(withInheritedTz.npm_config_cache).toBe(path.join(dshHomeDir, 'cache', 'npm-cache'));
    expect(withInheritedTz.TZ).toBe('America/Los_Angeles');

    const pathParts = (withInheritedTz.PATH ?? '').split(path.delimiter);
    expect(pathParts).toEqual([pmDir, nodeShimDir, pythonDir, '/usr/bin', '/bin', '/opt/homebrew/bin']);

    const withoutInheritedTz = buildIsolatedDshChildEnv({
      baseEnv: { PATH: '/usr/bin' },
      dshHomeDir,
      bridgeUrl: 'http://127.0.0.1:41234',
      bridgeSecret: 'secret',
      workspacesDir: path.join(temp, 'userData', 'workspaces'),
      skillsDir,
      searchPolicy: DshSearchPolicy.DeepSeekNativeOnly,
      runtimeDir,
      timeZone: 'Asia/Shanghai',
    });
    expect(withoutInheritedTz.TZ).toBe('Asia/Shanghai');
  });

  test('buildIsolatedDshChildEnv injects SKILLS_ROOT, Electron node shim dir, and shim env vars while preserving Path casing', () => {
    const temp = createTempDir();
    const runtimeDir = path.join(temp, 'runtime');
    const pmDir = path.join(runtimeDir, 'package-manager');
    const nodeShimDir = path.join(temp, 'userData', 'cowork', 'bin');
    const npmBinDir = path.join(temp, 'resources', 'npm', 'bin');
    const skillsDir = path.join(temp, 'userData', 'SKILLs');
    fs.mkdirSync(pmDir, { recursive: true });
    fs.mkdirSync(nodeShimDir, { recursive: true });

    const env = buildIsolatedDshChildEnv({
      baseEnv: {
        Path: `/usr/bin${path.delimiter}${nodeShimDir}`,
      },
      dshHomeDir: path.join(temp, 'userData', 'dsh-profile'),
      bridgeUrl: 'http://127.0.0.1:41234',
      bridgeSecret: 'secret',
      workspacesDir: path.join(temp, 'userData', 'workspaces'),
      skillsDir,
      searchPolicy: DshSearchPolicy.DeepSeekNativeOnly,
      runtimeDir,
      executablePath: '/Apps/LobsterAI Helper',
      nodeShimDir,
      npmBinDir,
    });

    expect(env.SKILLS_ROOT).toBe(skillsDir);
    expect(env.LOBSTERAI_SKILLS_ROOT).toBe(skillsDir);
    expect(env[DshHostBundleEnvVar.SkillsDir]).toBe(skillsDir);
    expect(env.LOBSTERAI_ELECTRON_PATH).toBe('/Apps/LobsterAI Helper');
    expect(env.LOBSTERAI_NPM_BIN_DIR).toBe(npmBinDir);
    expect(env.PATH).toBeUndefined();
    expect(env.Path).toBe([pmDir, nodeShimDir, '/usr/bin'].join(path.delimiter));
  });

  test('E2E: imap-smtp-email scripts discover migrated accounts.json under buildIsolatedDshChildEnv without system node on PATH', () => {
    const temp = createTempDir();
    const userDataDir = path.join(temp, 'userData');
    const skillsDir = path.join(userDataDir, 'SKILLs');
    const emailSkillDir = path.join(skillsDir, 'imap-smtp-email');
    const scriptsDstDir = path.join(emailSkillDir, 'scripts');
    const repoEmailScriptsDir = path.resolve(process.cwd(), 'SKILLs', 'imap-smtp-email', 'scripts');

    fs.mkdirSync(scriptsDstDir, { recursive: true });
    for (const fileName of ['config.js', 'imap.js', 'smtp.js', 'attachment-storage.js']) {
      fs.copyFileSync(
        path.join(repoEmailScriptsDir, fileName),
        path.join(scriptsDstDir, fileName),
      );
    }

    // Link dotenv from repo node_modules and ensure imap/mailparser/nodemailer
    // resolve even on a clean checkout without SKILLs/imap-smtp-email/node_modules.
    const skillNodeModules = path.join(emailSkillDir, 'node_modules');
    fs.mkdirSync(skillNodeModules, { recursive: true });
    const repoDotenvDir = path.resolve(process.cwd(), 'node_modules', 'dotenv');
    fs.symlinkSync(repoDotenvDir, path.join(skillNodeModules, 'dotenv'), 'dir');
    const repoEmailNodeModules = path.resolve(process.cwd(), 'SKILLs', 'imap-smtp-email', 'node_modules');
    for (const pkg of ['imap', 'mailparser', 'nodemailer']) {
      const realPkgDir = path.join(repoEmailNodeModules, pkg);
      if (fs.existsSync(realPkgDir)) {
        fs.symlinkSync(realPkgDir, path.join(skillNodeModules, pkg), 'dir');
      } else {
        const stubDir = path.join(skillNodeModules, pkg);
        fs.mkdirSync(stubDir, { recursive: true });
        fs.writeFileSync(
          path.join(stubDir, 'index.js'),
          pkg === 'mailparser'
            ? 'module.exports = { simpleParser: async () => ({}) };\n'
            : 'module.exports = function Stub() {};\n',
          'utf8',
        );
      }
    }

    // Write a migrated multi-account config into <skillsDir>/imap-smtp-email/accounts.json.
    fs.writeFileSync(
      path.join(emailSkillDir, 'accounts.json'),
      JSON.stringify({
        version: 1,
        defaultAccountId: 'migrated-work',
        accounts: [
          {
            id: 'migrated-work',
            name: 'Work Mailbox',
            enabled: true,
            provider: '163',
            email: 'alice@163.com',
            password: 'super-secret-auth-code',
            imapHost: 'imap.163.com',
            imapPort: 993,
            imapTls: true,
            imapRejectUnauthorized: true,
            smtpHost: 'smtp.163.com',
            smtpPort: 465,
            smtpSecure: true,
            smtpRejectUnauthorized: true,
            smtpFrom: 'alice@163.com',
            mailbox: 'INBOX',
            requireSendConfirmation: true,
          },
        ],
      }, null, 2) + '\n',
      'utf8',
    );

    // Create the Electron-backed `node` shim matching ensureElectronNodeShim().
    const nodeShimDir = path.join(userDataDir, 'cowork', 'bin');
    fs.mkdirSync(nodeShimDir, { recursive: true });
    const nodeShimPath = path.join(nodeShimDir, process.platform === 'win32' ? 'node.cmd' : 'node');
    if (process.platform === 'win32') {
      fs.writeFileSync(
        nodeShimPath,
        [
          '@echo off',
          'if "%LOBSTERAI_ELECTRON_PATH%"=="" (',
          '  echo LOBSTERAI_ELECTRON_PATH is not set 1>&2',
          '  exit /b 127',
          ')',
          'set ELECTRON_RUN_AS_NODE=1',
          '"%LOBSTERAI_ELECTRON_PATH%" %*',
          '',
        ].join('\r\n'),
        'utf8',
      );
    } else {
      fs.writeFileSync(
        nodeShimPath,
        [
          '#!/usr/bin/env bash',
          'if [ -z "${LOBSTERAI_ELECTRON_PATH:-}" ]; then',
          '  echo "LOBSTERAI_ELECTRON_PATH is not set" >&2',
          '  exit 127',
          'fi',
          'exec env ELECTRON_RUN_AS_NODE=1 "${LOBSTERAI_ELECTRON_PATH}" "$@"',
          '',
        ].join('\n'),
        'utf8',
      );
      fs.chmodSync(nodeShimPath, 0o755);
    }

    // Build a minimal base PATH that deliberately contains NO system `node`.
    const minimalSystemBin = path.join(temp, 'minimal-bin');
    fs.mkdirSync(minimalSystemBin, { recursive: true });
    let basePath = minimalSystemBin;
    if (process.platform !== 'win32') {
      const envBin = fs.existsSync('/usr/bin/env') ? '/usr/bin/env' : '/bin/env';
      const bashBin = fs.existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash';
      fs.symlinkSync(envBin, path.join(minimalSystemBin, 'env'));
      fs.symlinkSync(bashBin, path.join(minimalSystemBin, 'bash'));
    } else {
      basePath = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32')
        : minimalSystemBin;
    }

    const dshEnv = buildIsolatedDshChildEnv({
      baseEnv: {
        PATH: basePath,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
      },
      dshHomeDir: path.join(userDataDir, 'dsh-profile'),
      bridgeUrl: 'http://127.0.0.1:41234',
      bridgeSecret: 'secret',
      workspacesDir: path.join(userDataDir, 'workspaces'),
      skillsDir,
      searchPolicy: DshSearchPolicy.DeepSeekNativeOnly,
      runtimeDir: path.join(temp, 'runtime'),
      executablePath: process.execPath,
      nodeShimDir,
    });

    if (process.platform !== 'win32') {
      // Confirm `node` resolves exclusively to our Electron node shim.
      const whichRes = spawnSync(path.join(minimalSystemBin, 'bash'), ['-c', 'command -v node'], {
        env: dshEnv,
        encoding: 'utf8',
      });
      expect(whichRes.status).toBe(0);
      expect(whichRes.stdout.trim()).toBe(nodeShimPath);
    }

    // Run real config.js, imap.js accounts, and smtp.js accounts via `node` from dshEnv.
    const runViaNodeShim = (shellCommand: string) => (
      process.platform === 'win32'
        ? spawnSync(shellCommand, { cwd: emailSkillDir, env: dshEnv, encoding: 'utf8', shell: true })
        : spawnSync(path.join(minimalSystemBin, 'bash'), ['-c', shellCommand], {
            cwd: emailSkillDir,
            env: dshEnv,
            encoding: 'utf8',
          })
    );

    const assertDiscoveredMigratedAccount = (stdout: string) => {
      const parsed = JSON.parse(stdout) as {
        success: boolean;
        source: string;
        defaultAccountId: string;
        accounts: Array<Record<string, unknown>>;
      };
      expect(parsed.success).toBe(true);
      expect(parsed.source).toBe('accounts');
      expect(parsed.defaultAccountId).toBe('migrated-work');
      expect(parsed.accounts).toHaveLength(1);
      expect(parsed.accounts[0]).toMatchObject({
        id: 'migrated-work',
        name: 'Work Mailbox',
        enabled: true,
        isDefault: true,
        email: 'al***@163.com',
        imapHost: 'imap.163.com',
        imapPort: 993,
        smtpHost: 'smtp.163.com',
        smtpPort: 465,
        hasPassword: true,
        hasImapConfig: true,
        hasSmtpConfig: true,
      });
      // Secrets must never be exposed in CLI output.
      expect(stdout).not.toContain('super-secret-auth-code');
      expect(stdout).not.toContain('alice@163.com');
    };

    const configRun = runViaNodeShim(
      process.platform === 'win32'
        ? 'node -e "console.log(JSON.stringify(require(process.env.SKILLS_ROOT + \'/imap-smtp-email/scripts/config.js\').listAccountsConfig()))"'
        : 'node -e \'console.log(JSON.stringify(require(process.env.SKILLS_ROOT + "/imap-smtp-email/scripts/config.js").listAccountsConfig()))\'',
    );
    expect(configRun.status, configRun.stderr).toBe(0);
    assertDiscoveredMigratedAccount(configRun.stdout);

    const imapRun = runViaNodeShim(
      process.platform === 'win32'
        ? 'node "%SKILLS_ROOT%\\imap-smtp-email\\scripts\\imap.js" accounts'
        : 'node "$SKILLS_ROOT/imap-smtp-email/scripts/imap.js" accounts',
    );
    expect(imapRun.status, imapRun.stderr).toBe(0);
    assertDiscoveredMigratedAccount(imapRun.stdout);

    const smtpRun = runViaNodeShim(
      process.platform === 'win32'
        ? 'node "%SKILLS_ROOT%\\imap-smtp-email\\scripts\\smtp.js" accounts'
        : 'node "$SKILLS_ROOT/imap-smtp-email/scripts/smtp.js" accounts',
    );
    expect(smtpRun.status, smtpRun.stderr).toBe(0);
    assertDiscoveredMigratedAccount(smtpRun.stdout);
  });
});
