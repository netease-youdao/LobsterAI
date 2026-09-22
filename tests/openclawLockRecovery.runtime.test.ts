// LOBSTERAI_TEST_LOCK_RECOVERY=1 OPENCLAW_LOCK_RECOVERY_SOURCE=<patched v2026.8.1> npm test -- openclawLockRecovery.runtime
import { type ChildProcess,execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { runOpenClawCompatibilityRepair, runOpenClawDoctorRepair } from '../src/main/libs/openclawCompatibilityRepair';
import { resolveGatewayLockDir, resolveGatewayLockPathForConfig } from '../src/main/libs/openclawGatewayLock';
import { inspectWindowsProcess, stopVerifiedWindowsProcess, WindowsProcessStatus } from '../src/main/libs/openclawWindowsProcess';
import { OpenClawRepairPhase } from '../src/shared/openclawEngine/repair';

const enabled = process.platform === 'win32' && process.env.LOBSTERAI_TEST_LOCK_RECOVERY === '1';
const roots: string[] = [];
const runtimeRoot = path.resolve('vendor/openclaw-runtime/win-x64');
const fixtureEntry = path.join(runtimeRoot, 'openclawLockOwner.fixture.mjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-lock-runtime-')); roots.push(root);
  const stateDir = path.join(root, 'state'); const backupDir = path.join(root, 'backup');
  fs.mkdirSync(stateDir); fs.mkdirSync(backupDir); fs.mkdirSync(path.join(root, 'temp'));
  const configPath = path.join(stateDir, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: 'local', auth: { mode: 'token', token: 'fixture-token' } },
    agents: { defaults: { workspace: path.join(stateDir, 'workspace-main'), heartbeat: { every: '0m' } }, entries: { main: {} } }, plugins: { enabled: false } }));
  const env = { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1', OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_HOME: root, HOME: root, USERPROFILE: root,
    APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'local'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
    LOBSTERAI_LOCK_FIXTURE_READY: path.join(root, 'ready.json'), OPENCLAW_SERVICE_REPAIR_POLICY: 'external' };
  delete env.VITEST; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  return { stateDir, configPath, backupDir, runtimeRoot, env, electronNodeRuntimePath: process.execPath };
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.kill('SIGKILL'); await closed;
}

describe.skipIf(!enabled)('real Windows lock-owner repair', () => {
  beforeAll(async () => {
    const source = process.env.OPENCLAW_LOCK_RECOVERY_SOURCE;
    if (!source) throw new Error('OPENCLAW_LOCK_RECOVERY_SOURCE must identify the patched source.');
    const require = createRequire(import.meta.url);
    await require('../scripts/bundle-openclaw-startup-migration.cjs').bundleOpenClawStartupMigration(runtimeRoot, source,
      path.resolve('tests/helpers/openclawLockOwner.fixture.mjs'));
  }, 60_000);
  afterAll(() => {
    fs.rmSync(fixtureEntry, { force: true });
    if (process.env.LOBSTERAI_LOCK_RECOVERY_RECORD) {
      fs.writeFileSync(process.env.LOBSTERAI_LOCK_RECOVERY_RECORD, JSON.stringify({ roots }, null, 2));
    } else {
      for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  test('retains an unrelated live PID while repairing both old locks and running the existing stages twice', async () => {
    const params = fixture();
    const command = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Keep the unrelated process alive beyond both Doctor deadlines; otherwise
    // a slow Windows run can mistake the fixture's scheduled exit for a repair kill.
    const child = spawn(command, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 900'], { windowsHide: true, stdio: 'ignore' });
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      const locks = resolveGatewayLockDir(params.stateDir); fs.mkdirSync(locks, { recursive: true });
      // This is the field shape: live PID, no creation identity, maintenance role.
      const payload = { pid: child.pid, ownerId: 'stale-owner', role: 'sqlite-maintenance',
        stateDir: params.stateDir, configPath: params.configPath, createdAt: new Date().toISOString() };
      const lockPaths = [path.join(locks, 'gateway.state.lock'), resolveGatewayLockPathForConfig(params.configPath, locks)];
      for (const file of lockPaths) fs.writeFileSync(file, JSON.stringify(payload));
      const recovered = await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.LockRecovery });
      expect(recovered.changes.filter(change => change.includes('Reclaimed'))).toHaveLength(2);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(lockPaths.every(file => !fs.existsSync(file))).toBe(true);
      for (let attempt = 0; attempt < 2; attempt++) {
        const backupDir = path.join(params.backupDir, `pass-${attempt}`); fs.mkdirSync(backupDir);
        const options = { ...params, backupDir };
        await runOpenClawCompatibilityRepair({ ...options, phase: OpenClawRepairPhase.LockRecovery });
        await runOpenClawCompatibilityRepair({ ...options, phase: OpenClawRepairPhase.Snapshot });
        await runOpenClawDoctorRepair(options);
        await runOpenClawCompatibilityRepair({ ...options, phase: OpenClawRepairPhase.Recovery });
        await runOpenClawCompatibilityRepair({ ...options, phase: OpenClawRepairPhase.Plugins });
      }
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally { await stopChild(child); }
  }, 720_000);

  test('a real active maintenance owner keeps its lease and is never stopped', async () => {
    const params = fixture();
    const child = spawn(process.execPath, ['--import', pathToFileURL(fixtureEntry).href, path.join(runtimeRoot, 'openclaw-startup-state-migration.mjs')], {
      cwd: runtimeRoot, env: params.env, windowsHide: true, stdio: 'ignore',
    });
    try {
      await expect.poll(() => fs.existsSync(params.env.LOBSTERAI_LOCK_FIXTURE_READY), { timeout: 30_000 }).toBe(true);
      const lockPath = path.join(resolveGatewayLockDir(params.stateDir), 'gateway.state.lock');
      const raw = fs.readFileSync(lockPath, 'utf8');
      await expect(runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.LockRecovery })).rejects.toThrow('active');
      expect(fs.readFileSync(lockPath, 'utf8')).toBe(raw); expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(fs.existsSync(path.join(params.backupDir, 'original'))).toBe(false);
      // Even misleading file metadata cannot bypass a live native SQLite owner.
      const identity = await inspectWindowsProcess(child.pid!);
      expect(identity.status).toBe(WindowsProcessStatus.Running);
      const stale = JSON.stringify({ ...JSON.parse(raw), startTime: identity.startTime! + 1 });
      const locks = [lockPath, resolveGatewayLockPathForConfig(params.configPath, resolveGatewayLockDir(params.stateDir))];
      for (const file of locks) fs.writeFileSync(file, stale);
      await expect(runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.LockRecovery }))
        .rejects.toThrow('failed to acquire gateway state ownership');
      for (const file of locks) expect(fs.readFileSync(file, 'utf8')).toBe(stale);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(fs.existsSync(path.join(params.backupDir, 'original'))).toBe(false);
    } finally { await stopChild(child); }
  }, 180_000);

  test('terminates an identity-verified orphan holding the native SQLite lease and recovers it', async () => {
    const params = fixture();
    const parent = path.join(path.dirname(params.stateDir), 'parent.cjs');
    fs.writeFileSync(parent, "const fs=require('fs'); const {spawn}=require('child_process'); const args=JSON.parse(process.argv[2]); const out=fs.openSync(process.env.LOBSTERAI_LOCK_FIXTURE_READY+'.log','a'); const c=spawn(process.execPath,args,{env:process.env,stdio:['ignore',out,out],windowsHide:true,detached:true}); const t=setInterval(()=>{if(fs.existsSync(process.env.LOBSTERAI_LOCK_FIXTURE_READY)){clearInterval(t);c.unref();}},100); c.on('error',e=>{console.error(e);process.exit(1);}); c.on('exit',code=>{clearInterval(t);process.exitCode=code;});");
    await promisify(execFile)(process.execPath, [parent, JSON.stringify(['--import', pathToFileURL(fixtureEntry).href, path.join(runtimeRoot, 'openclaw-startup-state-migration.mjs')])],
      { env: params.env, windowsHide: true, timeout: 90_000 });
    await expect.poll(() => fs.existsSync(params.env.LOBSTERAI_LOCK_FIXTURE_READY), { timeout: 30_000 }).toBe(true);
    const { pid } = JSON.parse(fs.readFileSync(params.env.LOBSTERAI_LOCK_FIXTURE_READY, 'utf8'));
    const identity = await inspectWindowsProcess(pid);
    try {
      expect(identity.status).toBe(WindowsProcessStatus.Running); expect(identity.parentAlive).toBe(false);
      // A mismatched creation identity must never terminate even this test process.
      const denied = await stopVerifiedWindowsProcess({ ...identity, creationTime: '1' });
      expect(denied.status).toBe(WindowsProcessStatus.Unknown); expect(() => process.kill(pid, 0)).not.toThrow();
      const lockPath = path.join(resolveGatewayLockDir(params.stateDir), 'gateway.state.lock');
      const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      expect(payload.startTime).toBe(identity.startTime);
      // Exercise the real protection window without forging timestamps.
      await expect.poll(() => Date.now() - Date.parse(payload.createdAt), { timeout: 35_000, interval: 500 }).toBeGreaterThan(30_000);
      const result = await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.LockRecovery });
      expect(result.changes.some(change => change.includes(`Stopped verified orphan OpenClaw process ${pid}`))).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow(); expect(fs.existsSync(lockPath)).toBe(false);
      await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Snapshot });
      await runOpenClawDoctorRepair(params);
      await runOpenClawCompatibilityRepair({ ...params, phase: OpenClawRepairPhase.Recovery });
    } finally {
      // Only the test-created process with its captured creation identity.
      if (identity.status === WindowsProcessStatus.Running) await stopVerifiedWindowsProcess(identity);
    }
  }, 360_000);
});
