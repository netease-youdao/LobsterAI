import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  cleanupStaleGatewayLocks,
  GatewayLockCleanupAction,
  type GatewayLockCleanupResult,
} from './openclawGatewayLock';
import { tryAcquireOpenClawLockCoordinator } from './openclawLockCoordinator';

const CONFIG_PATH = path.join(os.tmpdir(), 'lobsterai-lock-coordinator-state', 'openclaw.json');

// Acquires the lock the way OpenClaw v2026.8.1 acquireLockFile() does: an
// exclusive node:sqlite transaction on `<lock>.sqlite`, then the payload.
const HOLDER_SCRIPT = `
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const [lockPath, configPath] = process.argv.slice(1);
const database = new DatabaseSync(lockPath + '.sqlite');
database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ownerId: 'holder', createdAt: new Date().toISOString(), configPath }));
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`;

function startLockHolder(lockPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', HOLDER_SCRIPT, lockPath, CONFIG_PATH], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout?.on('data', (chunk) => {
      if (String(chunk).includes('ready')) resolve(child);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`lock holder exited early (code ${code}): ${stderr}`)));
  });
}

async function killLockHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

// Windows may release a dead process's file locks shortly after it exits.
async function cleanupUntilSettled(cleanup: () => GatewayLockCleanupResult[]): Promise<GatewayLockCleanupResult[]> {
  const deadline = Date.now() + 5_000;
  let results = cleanup();
  while (results[0]?.action === GatewayLockCleanupAction.KeptAliveOwner && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    results = cleanup();
  }
  return results;
}

describe('tryAcquireOpenClawLockCoordinator', () => {
  let lockDir: string;
  let holder: ChildProcess | null = null;

  beforeEach(() => {
    lockDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-sqlite-coordinator-test-')));
  });

  afterEach(async () => {
    if (holder) await killLockHolder(holder);
    holder = null;
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  test('never creates a missing companion', () => {
    const coordinatorPath = path.join(lockDir, 'gateway.state.lock.sqlite');

    expect(tryAcquireOpenClawLockCoordinator(coordinatorPath)).toBeNull();
    expect(fs.existsSync(coordinatorPath)).toBe(false);
  });

  test('is busy while the writer process lives and free after it is killed', async () => {
    const lockPath = path.join(lockDir, 'gateway.state.lock');
    holder = await startLockHolder(lockPath);

    expect(tryAcquireOpenClawLockCoordinator(`${lockPath}.sqlite`)).toBeNull();

    await killLockHolder(holder);
    const deadline = Date.now() + 5_000;
    let coordinator = tryAcquireOpenClawLockCoordinator(`${lockPath}.sqlite`);
    while (!coordinator && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      coordinator = tryAcquireOpenClawLockCoordinator(`${lockPath}.sqlite`);
    }
    expect(coordinator).not.toBeNull();
    coordinator?.release();
    // Released: the next contender acquires it again.
    const again = tryAcquireOpenClawLockCoordinator(`${lockPath}.sqlite`);
    expect(again).not.toBeNull();
    again?.release();
  });

  test('lets cleanup reclaim a killed writer lock whose PID now answers as alive', async () => {
    const lockPath = path.join(lockDir, 'gateway.state.lock');
    holder = await startLockHolder(lockPath);
    const holderPid = holder.pid;
    const cleanup = () => cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      // Stands in for a PID reused by a process nobody can inspect.
      isPidAliveFn: () => true,
      tryAcquireLockCoordinator: tryAcquireOpenClawLockCoordinator,
    });

    expect(cleanup()).toEqual([
      { lockPath, action: GatewayLockCleanupAction.KeptAliveOwner, ownerPid: holderPid },
    ]);
    expect(fs.existsSync(lockPath)).toBe(true);

    await killLockHolder(holder);

    expect(await cleanupUntilSettled(cleanup)).toEqual([
      { lockPath, action: GatewayLockCleanupAction.RemovedReusedPid, ownerPid: holderPid },
    ]);
    expect(fs.existsSync(lockPath)).toBe(false);
    // The companion stays for the next writer, as OpenClaw leaves it.
    expect(fs.existsSync(`${lockPath}.sqlite`)).toBe(true);
  });
});
