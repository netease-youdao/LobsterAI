import { execFile } from 'child_process';
import { type ChildProcessWithoutNullStreams,spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import type {
  OllamaInstallProgress,
  OllamaRunningModel,
  OllamaStatusSnapshot,
} from '../../shared/ollama';
import { OllamaClient } from './ollamaClient';

const execFileAsync = promisify(execFile);
const QUIT_RUNNING_MODELS_TIMEOUT_MS = 1500;
const QUIT_UNLOAD_MODEL_TIMEOUT_MS = 3000;

export class OllamaManager extends EventEmitter {
  private executablePath: string | null = null;
  private process: ChildProcessWithoutNullStreams | null = null;
  private status: OllamaStatusSnapshot = {
    status: 'unknown',
    checkedAt: new Date().toISOString(),
  };

  getStatus(): OllamaStatusSnapshot {
    return this.status;
  }

  async detect(): Promise<OllamaStatusSnapshot> {
    const client = new OllamaClient();
    try {
      const version = await client.version(300);
      this.setStatus({
        status: 'running',
        version: version.version,
        executablePath: this.executablePath ?? undefined,
        pid: this.process?.pid,
      });
      return this.status;
    } catch {
      // Continue with executable detection.
    }

    const executablePath = await findOllamaExecutable();
    this.executablePath = executablePath;
    this.setStatus({
      status: executablePath ? 'installed' : 'not-installed',
      executablePath: executablePath ?? undefined,
    });
    return this.status;
  }

  async start(): Promise<OllamaStatusSnapshot> {
    if (await this.isHealthy()) return this.status;

    if (!this.executablePath) {
      this.executablePath = await findOllamaExecutable();
    }
    if (!this.executablePath) {
      this.setStatus({ status: 'not-installed' });
      return this.status;
    }

    this.setStatus({ status: 'starting', executablePath: this.executablePath });
    this.process = spawn(this.executablePath, ['serve'], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.process.stdout.on('data', (chunk) => console.debug(`[Ollama] ${chunk.toString().trim()}`));
    this.process.stderr.on('data', (chunk) => console.warn(`[Ollama] ${chunk.toString().trim()}`));
    this.process.on('exit', (code, signal) => {
      console.log(`[Ollama] process exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`);
      this.process = null;
      if (this.status.status === 'running' || this.status.status === 'starting') {
        this.setStatus({ status: 'stopped', executablePath: this.executablePath ?? undefined });
      }
    });
    this.process.on('error', (error) => {
      console.warn('[Ollama] process failed:', error);
      this.setStatus({ status: 'error', error: error.message, executablePath: this.executablePath ?? undefined });
    });

    await this.waitUntilHealthy(10_000);
    return this.status;
  }

  async stop(): Promise<OllamaStatusSnapshot> {
    if (!this.process) {
      this.setStatus({ status: 'stopped', executablePath: this.executablePath ?? undefined });
      return this.status;
    }

    const child = this.process;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.process = null;
    this.setStatus({ status: 'stopped', executablePath: this.executablePath ?? undefined });
    return this.status;
  }

  async restart(): Promise<OllamaStatusSnapshot> {
    await this.stop();
    return await this.start();
  }

  async install(): Promise<OllamaStatusSnapshot> {
    const progress: OllamaInstallProgress = {
      phase: 'needs-manual',
      officialUrl: 'https://ollama.com/download',
      message: 'Install Ollama from the official download page, then return here and start the service.',
    };
    this.emit('install-progress', progress);
    await this.detect();
    return this.status;
  }

  async client(): Promise<OllamaClient> {
    if (this.status.status !== 'running') {
      await this.detect();
    }
    return new OllamaClient();
  }

  async shutdownForQuit(): Promise<OllamaStatusSnapshot> {
    await this.unloadAllRunningModels();
    return await this.stop();
  }

  async unloadAllRunningModels(): Promise<void> {
    const client = new OllamaClient();
    let runningModels: OllamaRunningModel[];
    try {
      runningModels = await client.runningModels(QUIT_RUNNING_MODELS_TIMEOUT_MS);
    } catch (error) {
      console.debug('[Ollama] skipped model unload during quit because running models could not be listed:', error);
      return;
    }

    const modelNames = Array.from(new Set(
      runningModels
        .map((model) => (model.name || model.model || '').trim())
        .filter(Boolean),
    ));
    if (modelNames.length === 0) return;

    console.log(`[Ollama] unloading ${modelNames.length} model(s) during app quit`);
    const results = await Promise.allSettled(
      modelNames.map(async (modelName) => {
        await client.unloadModel(modelName, QUIT_UNLOAD_MODEL_TIMEOUT_MS);
      }),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.warn(`[Ollama] failed to unload model ${modelNames[index]} during quit:`, result.reason);
      }
    });
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const version = await new OllamaClient().version(300);
      this.setStatus({
        status: 'running',
        version: version.version,
        executablePath: this.executablePath ?? undefined,
        pid: this.process?.pid,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async waitUntilHealthy(timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.isHealthy()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.setStatus({
      status: 'error',
      executablePath: this.executablePath ?? undefined,
      error: 'Ollama did not become ready before timeout',
    });
  }

  private setStatus(patch: Omit<Partial<OllamaStatusSnapshot>, 'checkedAt'> & { status: OllamaStatusSnapshot['status'] }): void {
    this.status = {
      ...this.status,
      ...patch,
      checkedAt: new Date().toISOString(),
    };
    this.emit('status', this.status);
  }
}

export async function findOllamaExecutable(): Promise<string | null> {
  const envPath = process.env.OLLAMA_BIN?.trim();
  if (envPath && fs.existsSync(envPath)) return envPath;

  for (const candidate of getKnownOllamaExecutablePaths()) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const command = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(command, ['ollama'], { timeout: 1000 });
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

function getKnownOllamaExecutablePaths(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Ollama.app/Contents/Resources/ollama',
      '/Applications/Ollama.app/Contents/MacOS/Ollama',
      '/opt/homebrew/bin/ollama',
      '/usr/local/bin/ollama',
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe'),
      path.join(localAppData, 'Ollama', 'ollama.exe'),
    ];
  }
  return [
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
  ];
}
