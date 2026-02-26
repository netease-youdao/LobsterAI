/**
 * Skill Services Manager - Manages background services for skills
 */

import { execSync, spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { cpRecursiveSync } from './fsCompat';

/**
 * Resolve the user's login shell PATH on macOS/Linux.
 * Packaged Electron apps on macOS don't inherit the user's shell profile,
 * so node/npm won't be in PATH unless we resolve it explicitly.
 */
function resolveUserShellPath(): string | null {
  if (process.platform === 'win32') return null;

  try {
    const shell = process.env.SHELL || '/bin/bash';
    // Use login-interactive shell to source profile, then print PATH
    const result = execSync(`${shell} -ilc 'echo __PATH__=$PATH'`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env },
    });
    const match = result.match(/__PATH__=(.+)/);
    return match ? match[1].trim() : null;
  } catch (error) {
    console.warn('[SkillServices] Failed to resolve user shell PATH:', error);
    return null;
  }
}

/**
 * Build an environment for spawning skill service scripts.
 * Merges the user's shell PATH with the current process environment.
 */
function buildSkillServiceEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };

  if (app.isPackaged) {
    if (!env.HOME) {
      env.HOME = app.getPath('home');
    }

    const userPath = resolveUserShellPath();
    if (userPath) {
      env.PATH = userPath;
      console.log('[SkillServices] Resolved user shell PATH for skill services');
    } else {
      // Fallback: append common node installation paths
      const commonPaths = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        `${env.HOME}/.nvm/current/bin`,
        `${env.HOME}/.volta/bin`,
        `${env.HOME}/.fnm/current/bin`,
      ];
      env.PATH = [env.PATH, ...commonPaths].filter(Boolean).join(':');
      console.log('[SkillServices] Using fallback PATH for skill services');
    }
  }

  // Expose Electron executable so skill scripts can run JS with ELECTRON_RUN_AS_NODE
  // even when system Node.js is not installed.
  env.LOBSTERAI_ELECTRON_PATH = process.execPath;

  return env;
}

export class SkillServiceManager {
  private webSearchPid: number | null = null;
  private skillEnv: Record<string, string | undefined> | null = null;

  private hasWebSearchRuntimeScriptSupport(skillPath: string): boolean {
    const startServerScript = path.join(skillPath, 'scripts', 'start-server.sh');
    const searchScript = path.join(skillPath, 'scripts', 'search.sh');
    if (!fs.existsSync(startServerScript)) {
      return false;
    }
    if (!fs.existsSync(searchScript)) {
      return false;
    }
    try {
      const startScript = fs.readFileSync(startServerScript, 'utf-8');
      const searchScriptContent = fs.readFileSync(searchScript, 'utf-8');
      return startScript.includes('WEB_SEARCH_FORCE_REPAIR')
        && startScript.includes('detect_healthy_bridge_server')
        && searchScriptContent.includes('ACTIVE_SERVER_URL')
        && searchScriptContent.includes('try_switch_to_local_server');
    } catch {
      return false;
    }
  }

  private isWebSearchRuntimeHealthy(skillPath: string): boolean {
    const requiredPaths = [
      path.join(skillPath, 'scripts', 'start-server.sh'),
      path.join(skillPath, 'scripts', 'search.sh'),
      path.join(skillPath, 'dist', 'server', 'index.js'),
      path.join(skillPath, 'node_modules', 'iconv-lite', 'encodings', 'index.js'),
    ];
    return requiredPaths.every(requiredPath => fs.existsSync(requiredPath))
      && this.hasWebSearchRuntimeScriptSupport(skillPath);
  }

  private hasCommand(command: string, env: NodeJS.ProcessEnv): boolean {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(checker, [command], { stdio: 'ignore', env });
    return result.status === 0;
  }

  private repairWebSearchRuntimeFromBundled(skillPath: string): void {
    if (!app.isPackaged) return;

    const candidates = [
      path.join(process.resourcesPath, 'SKILLs', 'web-search'),
      path.join(app.getAppPath(), 'SKILLs', 'web-search'),
    ];

    const bundledPath = candidates.find(candidate => candidate !== skillPath && fs.existsSync(candidate));
    if (!bundledPath) {
      return;
    }

    try {
      cpRecursiveSync(bundledPath, skillPath, {
        force: true,
      });
      console.log('[SkillServices] Repaired web-search runtime from bundled resources');
    } catch (error) {
      console.warn('[SkillServices] Failed to repair web-search runtime from bundled resources:', error);
    }
  }

  private resolveNodeRuntime(
    env: NodeJS.ProcessEnv
  ): { command: string; args: string[]; extraEnv?: NodeJS.ProcessEnv } {
    if (!app.isPackaged && this.hasCommand('node', env)) {
      return { command: 'node', args: [] };
    }

    return {
      command: process.execPath,
      args: [],
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }

  private ensureWebSearchRuntimeReady(skillPath: string): void {
    if (this.isWebSearchRuntimeHealthy(skillPath)) {
      return;
    }

    this.repairWebSearchRuntimeFromBundled(skillPath);
    if (this.isWebSearchRuntimeHealthy(skillPath)) {
      return;
    }

    const nodeModules = path.join(skillPath, 'node_modules');
    const distDir = path.join(skillPath, 'dist');
    const env = this.skillEnv as NodeJS.ProcessEnv ?? process.env;
    const npmAvailable = this.hasCommand('npm', env);

    const shouldInstallDeps = !fs.existsSync(nodeModules) || !this.isWebSearchRuntimeHealthy(skillPath);
    if (shouldInstallDeps) {
      if (!npmAvailable) {
        throw new Error('Web-search runtime is incomplete and npm is not available to repair it');
      }
      console.log('[SkillServices] Installing/reparing web-search dependencies...');
      execSync('npm install', { cwd: skillPath, stdio: 'ignore', env });
    }

    if (!fs.existsSync(distDir)) {
      if (!npmAvailable) {
        throw new Error('Web-search dist files are missing and npm is not available to rebuild them');
      }
      console.log('[SkillServices] Compiling web-search TypeScript...');
      execSync('npm run build', { cwd: skillPath, stdio: 'ignore', env });
    }

    if (!this.isWebSearchRuntimeHealthy(skillPath)) {
      throw new Error('Web-search runtime is still unhealthy after attempted repair');
    }
  }

  /**
   * Start all skill services
   */
  async startAll(): Promise<void> {
    console.log('[SkillServices] Starting skill services...');

    // Resolve environment once for all service spawns
    this.skillEnv = buildSkillServiceEnv();

    try {
      await this.startWebSearchService();
    } catch (error) {
      console.error('[SkillServices] Error starting services:', error);
    }
  }

  /**
   * Stop all skill services
   */
  async stopAll(): Promise<void> {
    console.log('[SkillServices] Stopping skill services...');

    try {
      await this.stopWebSearchService();
    } catch (error) {
      console.error('[SkillServices] Error stopping services:', error);
    }
  }

  /**
   * Start Web Search Bridge Server
   */
  async startWebSearchService(): Promise<void> {
    try {
      const skillPath = this.getWebSearchPath();
      if (!skillPath) {
        console.log('[SkillServices] Web Search skill not found, skipping');
        return;
      }

      // Check if already running
      if (this.isWebSearchServiceRunning()) {
        console.log('[SkillServices] Web Search service already running');
        return;
      }

      console.log('[SkillServices] Starting Web Search Bridge Server...');

      await this.startWebSearchServiceProcess(skillPath);

      // Wait a moment for the server to start
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check if server started successfully
      const pidFile = path.join(skillPath, '.server.pid');
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
        this.webSearchPid = pid;
        console.log(`[SkillServices] Web Search Bridge Server started (PID: ${pid})`);
      } else {
        console.warn('[SkillServices] Web Search Bridge Server may not have started correctly');
      }
    } catch (error) {
      console.error('[SkillServices] Failed to start Web Search service:', error);
    }
  }

  private async startWebSearchServiceProcess(skillPath: string): Promise<void> {
    const pidFile = path.join(skillPath, '.server.pid');
    const logFile = path.join(skillPath, '.server.log');
    const serverEntry = path.join(skillPath, 'dist', 'server', 'index.js');
    this.ensureWebSearchRuntimeReady(skillPath);
    const baseEnv = this.skillEnv as NodeJS.ProcessEnv ?? process.env;
    const runtime = this.resolveNodeRuntime(baseEnv);
    const env = {
      ...baseEnv,
      ...(runtime.extraEnv ?? {}),
      LOBSTERAI_ELECTRON_PATH: process.execPath,
    };

    // Node/Electron validates stdio streams synchronously. Use fd to avoid
    // races where createWriteStream has not opened the file descriptor yet.
    const logFd = fs.openSync(logFile, 'a');
    let child;
    try {
      child = spawn(runtime.command, [...runtime.args, serverEntry], {
        cwd: skillPath,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env,
      });
    } finally {
      fs.closeSync(logFd);
    }

    fs.writeFileSync(pidFile, child.pid!.toString());
    child.unref();

    const runtimeLabel = runtime.command === process.execPath ? 'electron-node' : 'node';
    console.log(`[SkillServices] Web Search Bridge Server starting (PID: ${child.pid}, runtime: ${runtimeLabel})`);
    console.log(`[SkillServices] Logs: ${logFile}`);
  }

  /**
   * Stop Web Search Bridge Server
   */
  async stopWebSearchService(): Promise<void> {
    try {
      const skillPath = this.getWebSearchPath();
      if (!skillPath) {
        return;
      }

      if (!this.isWebSearchServiceRunning()) {
        console.log('[SkillServices] Web Search service not running');
        return;
      }

      console.log('[SkillServices] Stopping Web Search Bridge Server...');

      if (this.webSearchPid) {
        try {
          process.kill(this.webSearchPid, 'SIGTERM');
        } catch (error) {
          console.warn('[SkillServices] Failed to kill process:', error);
        }
      }

      const pidFile = path.join(skillPath, '.server.pid');
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }

      // Wait for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log('[SkillServices] Web Search Bridge Server stopped');
      this.webSearchPid = null;
    } catch (error) {
      console.error('[SkillServices] Failed to stop Web Search service:', error);
    }
  }

  /**
   * Check if Web Search service is running
   */
  isWebSearchServiceRunning(): boolean {
    if (this.webSearchPid === null) {
      // Try to read PID from file
      const skillPath = this.getWebSearchPath();
      if (!skillPath) {
        return false;
      }

      const pidFile = path.join(skillPath, '.server.pid');
      if (fs.existsSync(pidFile)) {
        try {
          const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
          this.webSearchPid = pid;
        } catch (error) {
          return false;
        }
      } else {
        return false;
      }
    }

    // Check if process is actually running
    try {
      process.kill(this.webSearchPid, 0); // Signal 0 checks if process exists
      return true;
    } catch (error) {
      this.webSearchPid = null;
      return false;
    }
  }

  /**
   * Get Web Search skill path
   */
  private getWebSearchPath(): string | null {
    const candidates: string[] = [];

    if (app.isPackaged) {
      // Prefer userData for packaged apps so scripts run from a real filesystem path.
      candidates.push(path.join(app.getPath('userData'), 'SKILLs', 'web-search'));
      candidates.push(path.join(process.resourcesPath, 'SKILLs', 'web-search'));
      candidates.push(path.join(app.getAppPath(), 'SKILLs', 'web-search'));
    } else {
      // In development, __dirname is dist-electron/, so we need to go up one level to get to project root
      const projectRoot = path.resolve(__dirname, '..');
      candidates.push(path.join(projectRoot, 'SKILLs', 'web-search'));
      candidates.push(path.join(app.getAppPath(), 'SKILLs', 'web-search'));
    }

    return candidates.find(skillPath => fs.existsSync(skillPath)) ?? null;
  }

  /**
   * Get service status
   */
  getStatus(): { webSearch: boolean } {
    return {
      webSearch: this.isWebSearchServiceRunning()
    };
  }

  /**
   * Health check for Web Search service
   */
  async checkWebSearchHealth(): Promise<boolean> {
    try {
      const response = await fetch('http://127.0.0.1:8923/api/health', {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }
}

// Singleton instance
let serviceManager: SkillServiceManager | null = null;

export function getSkillServiceManager(): SkillServiceManager {
  if (!serviceManager) {
    serviceManager = new SkillServiceManager();
  }
  return serviceManager;
}
