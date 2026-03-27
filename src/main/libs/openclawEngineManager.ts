import { app, utilityProcess, type UtilityProcess } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { getElectronNodeRuntimePath, ensureElectronNodeShim, getSkillsRoot } from './coworkUtil';
import { syncLocalOpenClawExtensionsIntoRuntime } from './openclawLocalExtensions';
import { appendPythonRuntimeToEnv } from './pythonRuntime';
import { isSystemProxyEnabled, resolveSystemProxyUrl } from './systemProxy';

type GatewayProcess = UtilityProcess | ChildProcess;

const DEFAULT_OPENCLAW_VERSION = '2026.2.23';
const DEFAULT_GATEWAY_PORT = 18789;
const GATEWAY_PORT_SCAN_LIMIT = 80;
const GATEWAY_BOOT_TIMEOUT_MS = 300 * 1000;
const GATEWAY_RESTART_DELAY_MS = 3000;

export type OpenClawEnginePhase =
  | 'not_installed'
  | 'installing'
  | 'ready'
  | 'starting'
  | 'running'
  | 'error';

export interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  progressPercent?: number;
  message?: string;
  canRetry: boolean;
}

export interface OpenClawGatewayConnectionInfo {
  version: string | null;
  port: number | null;
  token: string | null;
  url: string | null;
  clientEntryPath: string | null;
}

interface OpenClawEngineManagerEvents {
  status: (status: OpenClawEngineStatus) => void;
}

type RuntimeMetadata = {
  root: string | null;
  version: string | null;
  expectedPathHint: string;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const parseJsonFile = <T>(filePath: string): T | null => {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const findPath = (candidates: string[]): string | null => {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const isPortAvailable = async (port: number): Promise<boolean> => {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
};

const isPortReachable = (host: string, port: number, timeoutMs = 1200): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
};

const isGatewayProcessAlive = (child: GatewayProcess | null): child is GatewayProcess => {
  if (!child) return false;
  if ('pid' in child && typeof child.pid === 'number') {
    // For ChildProcess, also check it hasn't already exited.
    if ('exitCode' in child && child.exitCode !== null) return false;
    return true;
  }
  return false;
};

const fetchWithTimeout = async (url: string, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timeout);
  }
};

export class OpenClawEngineManager extends EventEmitter {
  private readonly baseDir: string;
  private readonly logsDir: string;
  private readonly stateDir: string;
  private readonly gatewayTokenPath: string;
  private readonly gatewayPortPath: string;
  private readonly gatewayLogPath: string;
  private readonly configPath: string;

  private desiredVersion: string;
  private status: OpenClawEngineStatus;
  private gatewayProcess: GatewayProcess | null = null;
  private readonly expectedGatewayExits = new WeakSet<object>();
  private gatewayRestartTimer: NodeJS.Timeout | null = null;
  private shutdownRequested = false;
  private gatewayPort: number | null = null;
  private startGatewayPromise: Promise<OpenClawEngineStatus> | null = null;
  private secretEnvVars: Record<string, string> = {};

  constructor() {
    super();

    const userDataPath = app.getPath('userData');
    this.baseDir = path.join(userDataPath, 'openclaw');
    this.logsDir = path.join(this.baseDir, 'logs');
    this.stateDir = path.join(this.baseDir, 'state');

    this.gatewayTokenPath = path.join(this.stateDir, 'gateway-token');
    this.gatewayPortPath = path.join(this.stateDir, 'gateway-port.json');
    this.gatewayLogPath = path.join(this.logsDir, 'gateway.log');
    this.configPath = path.join(this.stateDir, 'openclaw.json');

    ensureDir(this.baseDir);
    ensureDir(this.logsDir);
    ensureDir(this.stateDir);

    const runtime = this.resolveRuntimeMetadata();
    this.desiredVersion = runtime.version || DEFAULT_OPENCLAW_VERSION;

    this.status = runtime.root
      ? {
          phase: 'ready',
          version: this.desiredVersion,
          message: 'OpenClaw runtime is ready.',
          canRetry: false,
        }
      : {
          phase: 'not_installed',
          version: null,
          message: `Bundled OpenClaw runtime is missing. Expected: ${runtime.expectedPathHint}`,
          canRetry: true,
        };
  }

  /**
   * Set secret environment variables to inject into the gateway process.
   * These contain the plaintext values for `${VAR}` placeholders in openclaw.json.
   */
  setSecretEnvVars(vars: Record<string, string>): void {
    this.secretEnvVars = vars;
  }

  /** Return the current secret env vars snapshot (for change detection). */
  getSecretEnvVars(): Record<string, string> {
    return this.secretEnvVars;
  }

  override on<U extends keyof OpenClawEngineManagerEvents>(
    event: U,
    listener: OpenClawEngineManagerEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override emit<U extends keyof OpenClawEngineManagerEvents>(
    event: U,
    ...args: Parameters<OpenClawEngineManagerEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  getStatus(): OpenClawEngineStatus {
    return { ...this.status };
  }

  setExternalError(message: string): OpenClawEngineStatus {
    const runtime = this.resolveRuntimeMetadata();
    this.setStatus({
      phase: 'error',
      version: runtime.version || this.status.version || null,
      message: message.slice(0, 500),
      canRetry: true,
    });
    return this.getStatus();
  }

  getDesiredVersion(): string {
    return this.desiredVersion;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getStateDir(): string {
    return this.stateDir;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getGatewayConnectionInfo(): OpenClawGatewayConnectionInfo {
    const runtime = this.resolveRuntimeMetadata();
    const port = this.gatewayPort ?? this.readGatewayPort();
    const token = this.readGatewayToken();
    const clientEntryPath = runtime.root ? this.resolveGatewayClientEntry(runtime.root) : null;

    return {
      version: runtime.version,
      port,
      token,
      url: port ? `ws://127.0.0.1:${port}` : null,
      clientEntryPath,
    };
  }

  async ensureReady(_options: { forceReinstall?: boolean } = {}): Promise<OpenClawEngineStatus> {
    const runtime = this.resolveRuntimeMetadata();
    this.desiredVersion = runtime.version || DEFAULT_OPENCLAW_VERSION;

    if (!runtime.root) {
      this.setStatus({
        phase: 'not_installed',
        version: null,
        message: `Bundled OpenClaw runtime is missing. Expected: ${runtime.expectedPathHint}`,
        canRetry: true,
      });
      return this.getStatus();
    }

    const localExtensionSync = syncLocalOpenClawExtensionsIntoRuntime(runtime.root);
    if (localExtensionSync.copied.length > 0) {
      console.log(`[OpenClaw] synced local extensions: ${localExtensionSync.copied.join(', ')}`);
    }

    if (this.status.phase === 'running') {
      return this.getStatus();
    }

    this.setStatus({
      phase: 'ready',
      version: this.desiredVersion,
      message: 'OpenClaw runtime is ready.',
      canRetry: false,
    });
    return this.getStatus();
  }

  async startGateway(): Promise<OpenClawEngineStatus> {
    if (this.startGatewayPromise) {
      console.log('[OpenClaw] startGateway: already in progress, reusing existing promise');
      return this.startGatewayPromise;
    }
    this.startGatewayPromise = this.doStartGateway().finally(() => {
      this.startGatewayPromise = null;
    });
    return this.startGatewayPromise;
  }

  private async doStartGateway(): Promise<OpenClawEngineStatus> {
    this.shutdownRequested = false;
    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;

    const ensured = await this.ensureReady();
    console.log(`[OpenClaw] startGateway: ensureReady done (${elapsed()}), phase=${ensured.phase}`);
    if (ensured.phase !== 'ready' && ensured.phase !== 'running') {
      return ensured;
    }

    if (isGatewayProcessAlive(this.gatewayProcess)) {
      const port = this.gatewayPort ?? this.readGatewayPort();
      if (port) {
        const healthy = await this.isGatewayHealthy(port);
        console.log(`[OpenClaw] startGateway: existing process health check (${elapsed()}), healthy=${healthy}`);
        if (healthy) {
          if (this.status.phase !== 'running') {
            this.setStatus({
              phase: 'running',
              version: this.desiredVersion,
              message: `OpenClaw gateway is running on loopback:${port}.`,
              canRetry: false,
            });
          }
          return this.getStatus();
        }
      }

      this.stopGatewayProcess(this.gatewayProcess);
      this.gatewayProcess = null;
    }

    const runtime = this.resolveRuntimeMetadata();
    console.log(`[OpenClaw] startGateway: resolveRuntimeMetadata done (${elapsed()}), root=${runtime.root ? 'found' : 'missing'}`);
    if (!runtime.root) {
      this.setStatus({
        phase: 'not_installed',
        version: null,
        message: `Bundled OpenClaw runtime is missing. Expected: ${runtime.expectedPathHint}`,
        canRetry: true,
      });
      return this.getStatus();
    }

    this.ensureBareEntryFiles(runtime.root);
    console.log(`[OpenClaw] startGateway: ensureBareEntryFiles done (${elapsed()})`);
    const openclawEntry = this.resolveOpenClawEntry(runtime.root);
    console.log(`[OpenClaw] startGateway: resolveOpenClawEntry done (${elapsed()}), entry=${openclawEntry}`);
    if (!openclawEntry) {
      this.setStatus({
        phase: 'error',
        version: runtime.version,
        message: `OpenClaw entry file is missing in runtime: ${runtime.root}.`,
        canRetry: true,
      });
      return this.getStatus();
    }

    const token = this.ensureGatewayToken();
    console.log(`[OpenClaw] startGateway: ensureGatewayToken done (${elapsed()})`);
    const port = await this.resolveGatewayPort();
    console.log(`[OpenClaw] startGateway: resolveGatewayPort done (${elapsed()}), port=${port}`);
    this.gatewayPort = port;
    this.writeGatewayPort(port);
    this.ensureConfigFile();
    console.log(`[OpenClaw] startGateway: pre-fork setup done (${elapsed()})`);

    this.setStatus({
      phase: 'starting',
      version: runtime.version,
      progressPercent: 10,
      message: 'Starting OpenClaw gateway...',
      canRetry: false,
    });

    const compileCacheDir = path.join(this.stateDir, '.compile-cache');
    console.log(`[OpenClaw] compile cache dir: ${compileCacheDir}`);
    const electronNodeRuntimePath = getElectronNodeRuntimePath();
    const cliShimDir = this.ensureBundledCliShims();
    const skillsRoot = getSkillsRoot().replace(/\\/g, '/');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SKILLS_ROOT: skillsRoot,
      LOBSTERAI_SKILLS_ROOT: skillsRoot,
      OPENCLAW_HOME: runtime.root,
      OPENCLAW_STATE_DIR: this.stateDir,
      OPENCLAW_CONFIG_PATH: this.configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_ENGINE_VERSION: runtime.version || DEFAULT_OPENCLAW_VERSION,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtime.root, 'extensions'),
      // Enable debug-level logging so gateway emits phase-level detail during startup.
      OPENCLAW_LOG_LEVEL: 'debug',
      // Enable V8 compile cache for both CJS and ESM modules.
      // This env var works for import() (ESM), unlike enableCompileCache() which is CJS-only.
      NODE_COMPILE_CACHE: compileCacheDir,
      LOBSTERAI_ELECTRON_PATH: electronNodeRuntimePath.replace(/\\/g, '/'),
      LOBSTERAI_OPENCLAW_ENTRY: openclawEntry.replace(/\\/g, '/'),
      // Inject secret values for ${VAR} placeholders in openclaw.json.
      // This keeps plaintext credentials out of the config file on disk.
      ...this.secretEnvVars,
    };

    // Ensure the gateway process uses the host's local timezone for logging.
    // macOS does not set TZ in the environment by default (it uses NSTimeZone/ICU),
    // so utilityProcess.fork() children may fall back to UTC for date formatting.
    if (!env.TZ) {
      const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (hostTimezone) {
        env.TZ = hostTimezone;
        console.log(`[OpenClaw] injected TZ=${hostTimezone} into gateway env`);
      }
    }

    if (cliShimDir) {
      // Plain object is case-sensitive: the spread key from process.env on Windows is "Path",
      // not "PATH". We must read the actual key to avoid creating a PATH with only cliShimDir.
      const currentPath = env.PATH || env.Path || '';
      env.PATH = [cliShimDir, currentPath].filter(Boolean).join(path.delimiter);
    }

    // Prepend bundled/user Python runtime paths so gateway exec commands
    // find the LobsterAI-managed Python instead of the Windows Store stub.
    appendPythonRuntimeToEnv(env as Record<string, string | undefined>);

    // Inject node/npm/npx shims so gateway exec commands can use them.
    // The shims wrap Electron as a Node.js runtime via ELECTRON_RUN_AS_NODE=1.
    const npmBinDir = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin')
      : undefined;
    const nodeShimDir = ensureElectronNodeShim(electronNodeRuntimePath, npmBinDir);
    if (nodeShimDir) {
      const curPath = env.PATH || env.Path || '';
      env.PATH = [nodeShimDir, curPath].filter(Boolean).join(path.delimiter);
      env.LOBSTERAI_NPM_BIN_DIR = npmBinDir || '';
    }

    if (isSystemProxyEnabled()) {
      const proxyUrl = await resolveSystemProxyUrl('https://openrouter.ai');
      if (proxyUrl) {
        env.http_proxy = proxyUrl;
        env.https_proxy = proxyUrl;
        env.HTTP_PROXY = proxyUrl;
        env.HTTPS_PROXY = proxyUrl;
        console.log('[OpenClaw] Injected system proxy for gateway:', proxyUrl);
      }
    }

    const forkArgs = ['gateway', '--bind', 'loopback', '--port', String(port), '--token', token, '--verbose'];
    console.log(`[OpenClaw] forking gateway: entry=${openclawEntry}, cwd=${runtime.root}, port=${port}, args=${JSON.stringify(forkArgs)}`);

    // On Windows, use child_process.spawn with ELECTRON_RUN_AS_NODE=1 instead of
    // utilityProcess.fork(). Benchmark shows utilityProcess has ~5x overhead for
    // cold ESM compilation on Windows (163s vs 34s for a 28MB bundle).
    let child: GatewayProcess;
    if (process.platform === 'win32') {
      child = spawn(
        process.execPath,
        [openclawEntry, ...forkArgs],
        {
          cwd: runtime.root,
          env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } else {
      child = utilityProcess.fork(
        openclawEntry,
        forkArgs,
        {
          cwd: runtime.root,
          env,
          stdio: 'pipe',
          serviceName: 'OpenClaw Gateway',
        },
      );
    }
    console.log(`[OpenClaw] startGateway: gateway process created (${elapsed()}), platform=${process.platform}`);

    this.gatewayProcess = child;
    this.attachGatewayProcessLogs(child);
    this.attachGatewayExitHandlers(child);

    // Wait for the spawn event to confirm the process started (pid becomes available).
    child.once('spawn', () => {
      console.log(`[OpenClaw] gateway process spawned (${elapsed()}), pid=${child.pid}`);
    });

    const ready = await this.waitForGatewayReady(port, GATEWAY_BOOT_TIMEOUT_MS);
    console.log(`[OpenClaw] startGateway: waitForGatewayReady returned (${elapsed()}), ready=${ready}`);
    if (!ready) {
      this.setStatus({
        phase: 'error',
        version: runtime.version,
        message: 'OpenClaw gateway failed to become healthy in time.',
        canRetry: true,
      });
      this.stopGatewayProcess(child);
      return this.getStatus();
    }

    console.log(`[OpenClaw] startGateway: gateway is running, total startup time: ${elapsed()}`);
    this.setStatus({
      phase: 'running',
      version: runtime.version,
      progressPercent: 100,
      message: `OpenClaw gateway is running on loopback:${port}.`,
      canRetry: false,
    });

    return this.getStatus();
  }

  async stopGateway(): Promise<void> {
    this.shutdownRequested = true;

    if (this.gatewayRestartTimer) {
      clearTimeout(this.gatewayRestartTimer);
      this.gatewayRestartTimer = null;
    }

    if (this.gatewayProcess) {
      this.stopGatewayProcess(this.gatewayProcess);
      this.gatewayProcess = null;
    }

    const runtime = this.resolveRuntimeMetadata();
    this.setStatus({
      phase: runtime.root ? 'ready' : 'not_installed',
      version: runtime.version,
      message: runtime.root
        ? 'OpenClaw runtime is ready. Gateway is stopped.'
        : `Bundled OpenClaw runtime is missing. Expected: ${runtime.expectedPathHint}`,
      canRetry: !runtime.root,
    });
  }

  async restartGateway(): Promise<OpenClawEngineStatus> {
    console.log('[OpenClaw] restartGateway: stopping existing gateway...');
    await this.stopGateway();
    console.log('[OpenClaw] restartGateway: starting gateway with new env...');
    return this.startGateway();
  }

  private resolveRuntimeMetadata(): RuntimeMetadata {
    const candidateRoots = app.isPackaged
      ? [path.join(process.resourcesPath, 'cfmind')]
      : [
          path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current'),
          path.join(process.cwd(), 'vendor', 'openclaw-runtime', 'current'),
        ];

    const runtimeRoot = findPath(candidateRoots);
    const expectedPathHint = app.isPackaged
      ? path.join(process.resourcesPath, 'cfmind')
      : path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current');

    if (!runtimeRoot) {
      return {
        root: null,
        version: null,
        expectedPathHint,
      };
    }

    return {
      root: runtimeRoot,
      version: this.readRuntimeVersion(runtimeRoot) || DEFAULT_OPENCLAW_VERSION,
      expectedPathHint,
    };
  }

  private readRuntimeVersion(runtimeRoot: string): string | null {
    const fromRootPackage = parseJsonFile<{ version?: string }>(path.join(runtimeRoot, 'package.json'))?.version;
    if (typeof fromRootPackage === 'string' && fromRootPackage.trim()) {
      return fromRootPackage.trim();
    }

    const fromOpenClawPackage = parseJsonFile<{ version?: string }>(
      path.join(runtimeRoot, 'node_modules', 'openclaw', 'package.json'),
    )?.version;
    if (typeof fromOpenClawPackage === 'string' && fromOpenClawPackage.trim()) {
      return fromOpenClawPackage.trim();
    }

    const fromBuildInfo = parseJsonFile<{ version?: string }>(path.join(runtimeRoot, 'runtime-build-info.json'))?.version;
    if (typeof fromBuildInfo === 'string' && fromBuildInfo.trim()) {
      return fromBuildInfo.trim();
    }

    return null;
  }

  private ensureBareEntryFiles(runtimeRoot: string): void {
    const t0 = Date.now();

    // Fast path: if gateway-bundle.mjs exists, skip full dist extraction.
    // The bundle is the primary entry; dist/ modules are only needed as fallback.
    const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
    if (fs.existsSync(bundlePath)) {
      console.log('[OpenClaw] ensureBareEntryFiles: bundle exists, skipping dist extraction');
      this.ensureControlUiFiles(runtimeRoot);
      console.log(`[OpenClaw] ensureBareEntryFiles: completed in ${Date.now() - t0}ms`);
      return;
    }

    console.log('[OpenClaw] ensureBareEntryFiles: no bundle found, checking bare files');
    const bareEntry = path.join(runtimeRoot, 'openclaw.mjs');
    const bareDistEntry = path.join(runtimeRoot, 'dist', 'entry.js');

    if (fs.existsSync(bareEntry) && fs.existsSync(bareDistEntry)) {
      return;
    }

    const asarRoot = path.join(runtimeRoot, 'gateway.asar');
    const asarEntry = path.join(asarRoot, 'openclaw.mjs');
    if (!fs.existsSync(asarEntry)) {
      return;
    }

    console.log('[OpenClaw] ensureBareEntryFiles: extracting from gateway.asar (no bundle)');

    try {
      if (!fs.existsSync(bareEntry)) {
        fs.writeFileSync(bareEntry, fs.readFileSync(asarEntry));
        console.log('[OpenClaw] Extracted openclaw.mjs');
      }

      const asarDist = path.join(asarRoot, 'dist');
      const bareDist = path.join(runtimeRoot, 'dist');
      if (fs.existsSync(asarDist) && !fs.existsSync(bareDistEntry)) {
        this.copyDirFromAsar(asarDist, bareDist);
        console.log('[OpenClaw] Extracted dist/');
      }

      console.log('[OpenClaw] Entry files extracted successfully.');
    } catch (err) {
      console.error('[OpenClaw] Failed to extract entry files from gateway.asar:', err);
    }
  }

  /**
   * Extract only dist/control-ui/ from gateway.asar if not already on disk.
   * The control-ui directory contains static HTML/CSS/JS assets served by the
   * gateway's admin UI and must exist as bare files on the filesystem.
   */
  private ensureControlUiFiles(runtimeRoot: string): void {
    const controlUiIndex = path.join(runtimeRoot, 'dist', 'control-ui', 'index.html');
    if (fs.existsSync(controlUiIndex)) {
      return;
    }

    const asarControlUi = path.join(runtimeRoot, 'gateway.asar', 'dist', 'control-ui');
    if (!fs.existsSync(asarControlUi)) {
      // control-ui may already exist as bare files from the build (see build-openclaw-runtime.sh)
      return;
    }

    console.log('[OpenClaw] Extracting dist/control-ui/ from gateway.asar...');
    try {
      this.copyDirFromAsar(asarControlUi, path.join(runtimeRoot, 'dist', 'control-ui'));
      console.log('[OpenClaw] Extracted dist/control-ui/');
    } catch (err) {
      console.error('[OpenClaw] Failed to extract dist/control-ui/ from gateway.asar:', err);
    }
  }

  private ensureBundledCliShims(): string | null {
    const shimDir = path.join(this.stateDir, 'bin');
    const shellWrapper = [
      '#!/usr/bin/env bash',
      'if [ -z "${LOBSTERAI_OPENCLAW_ENTRY:-}" ]; then',
      '  echo "LOBSTERAI_OPENCLAW_ENTRY is not set" >&2',
      '  exit 127',
      'fi',
      'if [ -n "${LOBSTERAI_ELECTRON_PATH:-}" ]; then',
      '  exec env ELECTRON_RUN_AS_NODE=1 "${LOBSTERAI_ELECTRON_PATH}" "${LOBSTERAI_OPENCLAW_ENTRY}" "$@"',
      'fi',
      'if command -v node >/dev/null 2>&1; then',
      '  exec node "${LOBSTERAI_OPENCLAW_ENTRY}" "$@"',
      'fi',
      'echo "Neither LOBSTERAI_ELECTRON_PATH nor node is available for OpenClaw CLI." >&2',
      'exit 127',
      '',
    ].join('\n');
    const windowsWrapper = [
      '@echo off',
      'if "%LOBSTERAI_OPENCLAW_ENTRY%"=="" (',
      '  echo LOBSTERAI_OPENCLAW_ENTRY is not set 1>&2',
      '  exit /b 127',
      ')',
      'if not "%LOBSTERAI_ELECTRON_PATH%"=="" (',
      '  set ELECTRON_RUN_AS_NODE=1',
      '  "%LOBSTERAI_ELECTRON_PATH%" "%LOBSTERAI_OPENCLAW_ENTRY%" %*',
      '  exit /b %ERRORLEVEL%',
      ')',
      'node "%LOBSTERAI_OPENCLAW_ENTRY%" %*',
      '',
    ].join('\r\n');

    try {
      ensureDir(shimDir);
      for (const commandName of ['openclaw', 'claw']) {
        const shellPath = path.join(shimDir, commandName);
        const existingShell = fs.existsSync(shellPath) ? fs.readFileSync(shellPath, 'utf8') : '';
        if (existingShell !== shellWrapper) {
          fs.writeFileSync(shellPath, shellWrapper, 'utf8');
          fs.chmodSync(shellPath, 0o755);
        }

        if (process.platform === 'win32') {
          const cmdPath = path.join(shimDir, `${commandName}.cmd`);
          const existingCmd = fs.existsSync(cmdPath) ? fs.readFileSync(cmdPath, 'utf8') : '';
          if (existingCmd !== windowsWrapper) {
            fs.writeFileSync(cmdPath, windowsWrapper, 'utf8');
          }
        }
      }

      return shimDir;
    } catch (error) {
      console.error('[OpenClaw] Failed to prepare CLI shims:', error);
      return null;
    }
  }

  private copyDirFromAsar(srcDir: string, destDir: string): void {
    fs.mkdirSync(destDir, { recursive: true });
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        this.copyDirFromAsar(srcPath, destPath);
      } else {
        fs.writeFileSync(destPath, fs.readFileSync(srcPath));
      }
    }
  }

  private resolveOpenClawEntry(runtimeRoot: string): string | null {
    // Bundle fast-path via CJS launcher is only needed on Windows where
    // utilityProcess.fork() cannot load ESM directly. On macOS/Linux,
    // ensureBareEntryFiles already skips extraction when bundle exists,
    // but this method falls through to gateway.asar/openclaw.mjs which
    // ESM loads directly without a CJS wrapper.
    if (process.platform === 'win32') {
      const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
      if (fs.existsSync(bundlePath)) {
        console.log('[OpenClaw] resolveOpenClawEntry: using bundle fast path');
        return this.ensureGatewayLauncherCjsForBundle(runtimeRoot);
      }
    }

    const esmEntry = findPath([
      path.join(runtimeRoot, 'openclaw.mjs'),
      path.join(runtimeRoot, 'dist', 'entry.js'),
      path.join(runtimeRoot, 'dist', 'entry.mjs'),
      path.join(runtimeRoot, 'gateway.asar', 'openclaw.mjs'),
    ]);
    if (!esmEntry) return null;

    // On Windows, utilityProcess.fork() cannot load ESM modules directly because
    // the ESM loader misinterprets the drive letter (e.g. "D:") as a URL scheme.
    // Work around this by generating a CJS wrapper that imports the ESM entry via file:// URL.
    if (process.platform === 'win32') {
      return this.ensureGatewayLauncherCjs(runtimeRoot, esmEntry);
    }
    return esmEntry;
  }

  private ensureGatewayLauncherCjs(runtimeRoot: string, esmEntry: string): string {
    const launcherPath = path.join(runtimeRoot, 'gateway-launcher.cjs');
    const esmBasename = path.basename(esmEntry);
    const expectedContent =
      `// Auto-generated CJS wrapper for Windows ESM compatibility.\n` +
      `// On Windows, Electron utilityProcess.fork() cannot load ESM modules directly\n` +
      `// because the drive letter (e.g. "D:") is misinterpreted as a URL scheme.\n` +
      `const { pathToFileURL } = require('node:url');\n` +
      `const path = require('node:path');\n` +
      `const fs = require('node:fs');\n` +
      `// Enable V8 compile cache to speed up subsequent startups.\n` +
      `// Cache is stored per-user so it survives app restarts and reboots.\n` +
      `try {\n` +
      `  const { enableCompileCache } = require('node:module');\n` +
      `  const ccDir = path.join(process.env.OPENCLAW_STATE_DIR || __dirname, '.compile-cache');\n` +
      `  enableCompileCache(ccDir);\n` +
      `  process.stderr.write('[openclaw-launcher] compile-cache dir=' + require('node:module').getCompileCacheDir() + '\\n');\n` +
      `} catch (_) {}\n` +
      `const esmEntry = path.join(__dirname, '${esmBasename}');\n` +
      `// Patch argv so openclaw's isMainModule() recognizes this as the main entry.\n` +
      `// In standard Node.js: process.argv = [execPath, scriptPath, ...args]\n` +
      `// In Electron utilityProcess: process.argv = [execPath, ...args] (no scriptPath)\n` +
      `// We must detect which layout we have to avoid overwriting the 'gateway' command arg.\n` +
      `// Use fs.realpathSync to resolve symlinks/junctions so that e.g.\n` +
      `// "...current/gateway-launcher.cjs" (junction) matches "...win-x64/gateway-launcher.cjs".\n` +
      `const _realpath = (p) => { try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };\n` +
      `const _launcherInArgv = process.argv[1] &&\n` +
      `  _realpath(process.argv[1]).toLowerCase() === _realpath(__filename).toLowerCase();\n` +
      `if (_launcherInArgv) {\n` +
      `  process.argv[1] = esmEntry;\n` +
      `} else {\n` +
      `  process.argv.splice(1, 0, esmEntry);\n` +
      `}\n` +
      `process.stderr.write('[openclaw-launcher] argv=' + JSON.stringify(process.argv) + '\\n');\n` +
      `process.stderr.write('[openclaw-launcher] node=' + process.versions.node + '\\n');\n` +
      `// Keep the event loop alive while openclaw's fire-and-forget import chain\n` +
      `// loads its full module graph and starts the gateway server. Without this,\n` +
      `// Electron's utilityProcess exits before the async work completes.\n` +
      `const _keepAlive = setInterval(() => {}, 30000);\n` +
      `const t0 = Date.now();\n` +
      `// Strategy 1: Try the esbuild single-file bundle via dynamic import().\n` +
      `// The bundle collapses ~1100 ESM modules into one file, eliminating the\n` +
      `// expensive ESM module resolution overhead in Electron's utilityProcess.\n` +
      `// We use import() (not require()) to avoid the ESM loader re-entrancy lock\n` +
      `// that causes microtask deadlocks when require(esm) is used.\n` +
      `const bundlePath = path.join(__dirname, 'gateway-bundle.mjs');\n` +
      `if (fs.existsSync(bundlePath)) {\n` +
      `  // Patch argv[1] to the bundle path so openclaw's isMainModule() matches.\n` +
      `  // isMainModule compares basename(import.meta.url) with basename(argv[1]);\n` +
      `  // both will be "gateway-bundle.mjs", satisfying the basename equality check.\n` +
      `  // argv[1] was already patched to esmEntry above; just overwrite it.\n` +
      `  process.argv[1] = bundlePath;\n` +
      `  process.stderr.write('[openclaw-launcher] argv(patched for bundle)=' + JSON.stringify(process.argv) + '\\n');\n` +
      `  const bundleUrl = pathToFileURL(bundlePath).href;\n` +
      `  process.stderr.write('[openclaw-launcher] loading bundle via import(): ' + bundleUrl + '\\n');\n` +
      `  import(bundleUrl).then(() => {\n` +
      `    process.stderr.write('[openclaw-launcher] import(gateway-bundle.mjs) ok (' + (Date.now() - t0) + 'ms)\\n');\n` +
      `    try { require('node:module').flushCompileCache(); } catch (_) {}\n` +
      `  }).catch((err) => {\n` +
      `    process.stderr.write('[openclaw-launcher] import(gateway-bundle.mjs) failed (' + (Date.now() - t0) + 'ms): ' + (err.stack || err) + '\\n');\n` +
      `    process.stderr.write('[openclaw-launcher] Falling back to multi-file dist...\\n');\n` +
      `    return _loadFallback();\n` +
      `  });\n` +
      `} else {\n` +
      `  _loadFallback();\n` +
      `}\n` +
      `// Fallback: load the original multi-file dist.\n` +
      `function _loadFallback() {\n` +
      `  try {\n` +
      `    try {\n` +
      `      const wf = require('./dist/warning-filter.js');\n` +
      `      if (typeof wf.installProcessWarningFilter === 'function') {\n` +
      `        wf.installProcessWarningFilter();\n` +
      `      }\n` +
      `    } catch (_) {}\n` +
      `    require('./dist/entry.js');\n` +
      `    process.stderr.write('[openclaw-launcher] require(entry.js) ok (' + (Date.now() - t0) + 'ms)\\n');\n` +
      `    try { require('node:module').flushCompileCache(); } catch (_) {}\n` +
      `  } catch (err) {\n` +
      `    process.stderr.write('[openclaw-launcher] require(entry.js) failed (' + (Date.now() - t0) + 'ms): ' + err.message + '\\n');\n` +
      `    const entryPath = path.join(__dirname, 'dist', 'entry.js');\n` +
      `    const importUrl = pathToFileURL(entryPath).href;\n` +
      `    process.stderr.write('[openclaw-launcher] falling back to import(): ' + importUrl + '\\n');\n` +
      `    import(importUrl).then(() => {\n` +
      `      process.stderr.write('[openclaw-launcher] import() ok (' + (Date.now() - t0) + 'ms)\\n');\n` +
      `    }).catch((err2) => {\n` +
      `      process.stderr.write('[openclaw-launcher] ERROR (' + (Date.now() - t0) + 'ms): ' + (err2.stack || err2) + '\\n');\n` +
      `      process.exit(1);\n` +
      `    });\n` +
      `  }\n` +
      `}\n`;

    try {
      const existing = fs.existsSync(launcherPath) ? fs.readFileSync(launcherPath, 'utf8') : '';
      if (existing !== expectedContent) {
        fs.writeFileSync(launcherPath, expectedContent, 'utf8');
        console.log(`[OpenClaw] Generated gateway-launcher.cjs for Windows ESM compat`);
      }
    } catch (err) {
      console.error('[OpenClaw] Failed to write gateway-launcher.cjs:', err);
      return esmEntry;
    }
    return launcherPath;
  }

  /**
   * Generate a simplified CJS launcher that loads gateway-bundle.mjs directly.
   * Unlike ensureGatewayLauncherCjs(), this version does not include a fallback
   * to dist/entry.js because the bundle is guaranteed to exist.
   */
  private ensureGatewayLauncherCjsForBundle(runtimeRoot: string): string {
    const launcherPath = path.join(runtimeRoot, 'gateway-launcher.cjs');
    const expectedContent =
      `// Auto-generated CJS launcher for Windows — bundle-only mode.\n` +
      `// Loads gateway-bundle.mjs directly without dist/ fallback.\n` +
      `const { pathToFileURL } = require('node:url');\n` +
      `const path = require('node:path');\n` +
      `const fs = require('node:fs');\n` +
      `const _log = (msg) => process.stderr.write('[openclaw-launcher] ' + msg + '\\n');\n` +
      `const _t0 = Date.now();\n` +
      `const _elapsed = () => (Date.now() - _t0) + 'ms';\n` +
      `// ─── Compile cache setup ───\n` +
      `try {\n` +
      `  const { enableCompileCache, getCompileCacheDir } = require('node:module');\n` +
      `  const _ccDir = path.join(process.env.OPENCLAW_STATE_DIR || __dirname, '.compile-cache');\n` +
      `  enableCompileCache(_ccDir);\n` +
      `  _log('compile-cache dir=' + getCompileCacheDir());\n` +
      `} catch (_) {}\n` +
      `// ─── Load bundle ───\n` +
      `const bundlePath = path.join(__dirname, 'gateway-bundle.mjs');\n` +
      `const _realpath = (p) => { try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };\n` +
      `const _launcherInArgv = process.argv[1] &&\n` +
      `  _realpath(process.argv[1]).toLowerCase() === _realpath(__filename).toLowerCase();\n` +
      `if (_launcherInArgv) {\n` +
      `  process.argv[1] = bundlePath;\n` +
      `} else {\n` +
      `  process.argv.splice(1, 0, bundlePath);\n` +
      `}\n` +
      `const _keepAlive = setInterval(() => {}, 30000);\n` +
      `const bundleUrl = pathToFileURL(bundlePath).href;\n` +
      `_log('loading bundle (' + _elapsed() + ')');\n` +
      `import(bundleUrl).then(() => {\n` +
      `  _log('import ok (' + _elapsed() + ')');\n` +
      `  try { require('node:module').flushCompileCache(); } catch (_) {}\n` +
      `}).catch((err) => {\n` +
      `  _log('import failed (' + _elapsed() + '): ' + (err.stack || err));\n` +
      `  process.exit(1);\n` +
      `});\n`;

    try {
      const existing = fs.existsSync(launcherPath) ? fs.readFileSync(launcherPath, 'utf8') : '';
      if (existing !== expectedContent) {
        if (existing) {
          console.log('[OpenClaw] Overwriting existing gateway-launcher.cjs (switching to bundle-only mode)');
        }
        fs.writeFileSync(launcherPath, expectedContent, 'utf8');
        console.log('[OpenClaw] Generated gateway-launcher.cjs for bundle-only mode');
      }
    } catch (err) {
      console.error('[OpenClaw] Failed to write gateway-launcher.cjs:', err);
      // Fall back to the legacy launcher generation
      const esmEntry = findPath([
        path.join(runtimeRoot, 'openclaw.mjs'),
        path.join(runtimeRoot, 'gateway.asar', 'openclaw.mjs'),
      ]);
      if (esmEntry) return this.ensureGatewayLauncherCjs(runtimeRoot, esmEntry);
      return launcherPath;
    }
    return launcherPath;
  }

  private resolveGatewayClientEntry(runtimeRoot: string): string | null {
    const distRoots = [
      path.join(runtimeRoot, 'dist'),
      path.join(runtimeRoot, 'gateway.asar', 'dist'),
    ];

    for (const distRoot of distRoots) {
      const clientEntry = this.findGatewayClientEntryFromDistRoot(distRoot);
      if (clientEntry) {
        return clientEntry;
      }
    }

    return null;
  }

  private findGatewayClientEntryFromDistRoot(distRoot: string): string | null {
    const gatewayClient = path.join(distRoot, 'gateway', 'client.js');
    if (fs.existsSync(gatewayClient)) {
      return gatewayClient;
    }

    const directClient = path.join(distRoot, 'client.js');
    if (fs.existsSync(directClient)) {
      return directClient;
    }

    try {
      if (!fs.existsSync(distRoot) || !fs.statSync(distRoot).isDirectory()) {
        return null;
      }

      const candidates = fs.readdirSync(distRoot)
        .filter((name) => /^client(?:-.*)?\.js$/i.test(name))
        .sort();
      if (candidates.length > 0) {
        return path.join(distRoot, candidates[0]);
      }
    } catch {
      // ignore
    }

    return null;
  }

  private ensureGatewayToken(): string {
    try {
      const existing = fs.readFileSync(this.gatewayTokenPath, 'utf8').trim();
      if (existing) {
        return existing;
      }
    } catch {
      // ignore
    }

    const token = crypto.randomBytes(24).toString('hex');
    ensureDir(path.dirname(this.gatewayTokenPath));
    fs.writeFileSync(this.gatewayTokenPath, token, 'utf8');
    return token;
  }

  getGatewayToken(): string | null {
    return this.readGatewayToken();
  }

  private readGatewayToken(): string | null {
    try {
      const token = fs.readFileSync(this.gatewayTokenPath, 'utf8').trim();
      return token || null;
    } catch {
      return null;
    }
  }

  private ensureConfigFile(): void {
    ensureDir(path.dirname(this.configPath));
    if (!fs.existsSync(this.configPath)) {
      fs.writeFileSync(this.configPath, JSON.stringify({ gateway: { mode: 'local' } }, null, 2) + '\n', 'utf8');
      return;
    }
    // Ensure gateway.mode is set even if config already exists
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const config = JSON.parse(raw);
      if (!config.gateway?.mode) {
        config.gateway = { ...config.gateway, mode: 'local' };
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
      }
    } catch {
      // ignore parse errors
    }
  }

  private writeGatewayPort(port: number): void {
    fs.writeFileSync(this.gatewayPortPath, JSON.stringify({ port, updatedAt: Date.now() }, null, 2), 'utf8');
  }

  private readGatewayPort(): number | null {
    const payload = parseJsonFile<{ port?: number }>(this.gatewayPortPath);
    if (!payload || typeof payload.port !== 'number' || !Number.isInteger(payload.port)) {
      return null;
    }
    if (payload.port <= 0 || payload.port > 65535) {
      return null;
    }
    return payload.port;
  }

  private async resolveGatewayPort(): Promise<number> {
    const candidates: number[] = [];

    candidates.push(DEFAULT_GATEWAY_PORT);
    if (this.gatewayPort) candidates.push(this.gatewayPort);
    const persisted = this.readGatewayPort();
    if (persisted) candidates.push(persisted);

    const uniqCandidates = Array.from(new Set(candidates));
    for (const candidate of uniqCandidates) {
      if (await isPortAvailable(candidate)) {
        return candidate;
      }
    }

    // Scan ports in parallel batches of 10 for faster resolution.
    const BATCH_SIZE = 10;
    for (let batch = 0; batch * BATCH_SIZE < GATEWAY_PORT_SCAN_LIMIT; batch += 1) {
      const batchStart = DEFAULT_GATEWAY_PORT + batch * BATCH_SIZE + 1;
      const batchEnd = Math.min(batchStart + BATCH_SIZE, DEFAULT_GATEWAY_PORT + GATEWAY_PORT_SCAN_LIMIT + 1);
      const portBatch = Array.from({ length: batchEnd - batchStart }, (_, i) => batchStart + i);
      const results = await Promise.all(
        portBatch.map(async (p) => (await isPortAvailable(p)) ? p : null),
      );
      const available = results.find((p) => p !== null);
      if (available != null) {
        return available;
      }
    }

    throw new Error('No available loopback port for OpenClaw gateway.');
  }

  private async isGatewayHealthy(port: number, verbose = false): Promise<boolean> {
    const probeUrls = [
      `http://127.0.0.1:${port}/health`,
      `http://127.0.0.1:${port}/healthz`,
      `http://127.0.0.1:${port}/ready`,
      `http://127.0.0.1:${port}/`,
    ];

    // Run all HTTP probes in parallel and resolve as soon as any succeeds.
    // Previously these ran sequentially, costing up to 4*1200ms per tick.
    const httpResults: string[] = [];
    const httpProbes = probeUrls.map(async (url, i) => {
      try {
        const response = await fetchWithTimeout(url, 1500);
        if (verbose) httpResults[i] = `${url} → ${response.status}`;
        if (response.status < 500) return true;
      } catch (err) {
        if (verbose) httpResults[i] = `${url} → ${(err as Error).message || err}`;
      }
      return false;
    });

    // Also probe TCP reachability in parallel as fallback.
    const tcpProbe = isPortReachable('127.0.0.1', port, 1500);

    const results = await Promise.all([...httpProbes, tcpProbe]);
    const healthy = results.some(Boolean);
    if (verbose && !healthy) {
      const tcpResult = results[results.length - 1] ? 'reachable' : 'unreachable';
      console.log(`[OpenClaw] health probe details: tcp=${tcpResult}, ${httpResults.join(', ')}`);
    }
    return healthy;
  }

  private waitForGatewayReady(port: number, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    let pollCount = 0;
    return new Promise((resolve) => {
      const tick = async () => {
        if (this.shutdownRequested) {
          console.log('[OpenClaw] waitForGatewayReady: shutdown requested, giving up');
          resolve(false);
          return;
        }

        if (!this.gatewayProcess) {
          console.log('[OpenClaw] waitForGatewayReady: gateway process is gone (exited early), giving up');
          resolve(false);
          return;
        }

        pollCount += 1;
        const elapsedMs = Date.now() - startedAt;

        // Log verbose probe details every 10 polls (~6s) to diagnose health check failures.
        const verboseProbe = pollCount % 10 === 0;
        const healthy = await this.isGatewayHealthy(port, verboseProbe);
        if (healthy) {
          console.log(`[OpenClaw] waitForGatewayReady: gateway healthy after ${elapsedMs}ms (${pollCount} polls)`);
          resolve(true);
          return;
        }

        if (elapsedMs >= timeoutMs) {
          console.log(`[OpenClaw] waitForGatewayReady: timed out after ${timeoutMs}ms (${pollCount} polls)`);
          resolve(false);
          return;
        }

        // Update progress from 10% → 90% during the wait, so the UI shows meaningful feedback.
        const progress = Math.min(90, 10 + Math.round((elapsedMs / timeoutMs) * 80));
        this.setStatus({
          phase: 'starting',
          version: this.status.version,
          progressPercent: progress,
          message: `Starting OpenClaw gateway... (${Math.round(elapsedMs / 1000)}s)`,
          canRetry: false,
        });

        if (pollCount % 5 === 0) {
          console.log(`[OpenClaw] waitForGatewayReady: poll #${pollCount}, elapsed=${elapsedMs}ms, progress=${progress}%`);
        }

        setTimeout(() => {
          void tick();
        }, 600);
      };

      void tick();
    });
  }

  private stopGatewayProcess(child: GatewayProcess): void {
    this.expectedGatewayExits.add(child);

    try {
      child.kill();
    } catch {
      // ignore
    }

    setTimeout(() => {
      try {
        if ('pid' in child && typeof child.pid === 'number') {
          child.kill();
        }
      } catch {
        // ignore
      }
    }, 1200);
  }

  // Workaround: Electron utilityProcess V8 isolate reports getTimezoneOffset()=0.
  private static rewriteUtcTimestamps(text: string): string {
    return text.replace(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
      (utc) => {
        const d = new Date(utc);
        if (Number.isNaN(d.getTime())) return utc;
        const pad = (n: number) => String(n).padStart(2, '0');
        const ms = String(d.getMilliseconds()).padStart(3, '0');
        const offsetMin = -d.getTimezoneOffset();
        const sign = offsetMin >= 0 ? '+' : '-';
        const absH = Math.floor(Math.abs(offsetMin) / 60);
        const absM = Math.abs(offsetMin) % 60;
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}${sign}${pad(absH)}:${pad(absM)}`;
      },
    );
  }

  private attachGatewayProcessLogs(child: GatewayProcess): void {
    ensureDir(path.dirname(this.gatewayLogPath));
    const appendLog = (chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      const line = `[${new Date().toISOString()}] [${stream}] ${text}`;
      fs.appendFile(this.gatewayLogPath, line, () => {
        // best-effort log append
      });
    };

    child.stdout?.on('data', (chunk) => {
      appendLog(chunk, 'stdout');
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      console.log(`[OpenClaw stdout] ${OpenClawEngineManager.rewriteUtcTimestamps(text)}`);
    });
    child.stderr?.on('data', (chunk) => {
      appendLog(chunk, 'stderr');
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      console.error(`[OpenClaw stderr] ${OpenClawEngineManager.rewriteUtcTimestamps(text)}`);
    });
  }

  private attachGatewayExitHandlers(child: GatewayProcess): void {
    child.once('error', (...args: unknown[]) => {
      // UtilityProcess error: (type: string, location: string)
      // ChildProcess error: (err: Error)
      const errorMsg = args[0] instanceof Error
        ? args[0].message
        : `${args[0]}${args[1] ? ` (${args[1]})` : ''}`;
      console.error(`[OpenClaw] gateway process error event: ${errorMsg}`);
      // Don't delete from expectedGatewayExits here — the 'exit' event always
      // follows and handles cleanup. Deleting here would cause 'exit' to miss
      // the expected-exit guard, triggering a spurious restart.
      if (this.expectedGatewayExits.has(child)) return;
      if (this.shutdownRequested) return;
      this.setStatus({
        phase: 'error',
        version: this.status.version,
        message: `OpenClaw gateway process error: ${errorMsg}`,
        canRetry: true,
      });
    });

    child.once('exit', (code) => {
      console.log(`[OpenClaw] gateway process exited with code=${code}`);
      if (this.gatewayProcess === child) {
        this.gatewayProcess = null;
      }
      if (this.expectedGatewayExits.has(child)) {
        this.expectedGatewayExits.delete(child);
        return;
      }
      if (this.shutdownRequested) return;

      this.setStatus({
        phase: 'error',
        version: this.status.version,
        message: `OpenClaw gateway exited unexpectedly (code=${code ?? 'null'}).`,
        canRetry: true,
      });
      this.scheduleGatewayRestart();
    });
  }

  private scheduleGatewayRestart(): void {
    if (this.shutdownRequested) return;
    if (this.gatewayRestartTimer) return;

    this.gatewayRestartTimer = setTimeout(() => {
      this.gatewayRestartTimer = null;
      if (this.shutdownRequested) return;
      void this.startGateway();
    }, GATEWAY_RESTART_DELAY_MS);
  }

  private setStatus(next: OpenClawEngineStatus): void {
    this.status = {
      ...next,
      message: next.message ? next.message.slice(0, 500) : undefined,
    };
    this.emit('status', this.getStatus());
  }
}
