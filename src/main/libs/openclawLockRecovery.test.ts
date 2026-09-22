import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { type GatewayLockPayload,resolveGatewayLockDir } from './openclawGatewayLock';
import { classifyLockOwner, LockOwnerDecision, type LockRecoveryOptions,NativeLockOwnerStatus, recoverOpenClawLockOwners } from './openclawLockRecovery';
import { type WindowsProcessIdentity,WindowsProcessStatus } from './openclawWindowsProcess';

const roots: string[] = [];
const now = Date.parse('2026-09-17T04:00:00Z');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-owner-test-'));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const options: LockRecoveryOptions = {
    stateDir, configPath: path.join(stateDir, 'openclaw.json'), runtimeRoot: path.join(root, 'runtime'),
    executablePath: path.join(root, 'LobsterAI.exe'), backupDir: path.join(root, 'backup'), env: {},
  };
  fs.mkdirSync(options.backupDir); fs.mkdirSync(resolveGatewayLockDir(stateDir), { recursive: true });
  const payload: GatewayLockPayload = {
    pid: 12345, startTime: now - 120_000, createdAt: new Date(now - 60_000).toISOString(),
    role: 'sqlite-maintenance', stateDir, configPath: options.configPath, ownerId: 'old-owner',
  };
  const identity: WindowsProcessIdentity = {
    status: WindowsProcessStatus.Running, pid: payload.pid, startTime: payload.startTime, creationTime: 'exact-creation-ticks',
    executablePath: options.executablePath, args: [options.executablePath, path.join(options.runtimeRoot, 'openclaw-startup-state-migration.mjs')],
    parentPid: 555, parentAlive: false,
  };
  const lockPath = path.join(resolveGatewayLockDir(stateDir), 'gateway.state.lock');
  fs.writeFileSync(lockPath, JSON.stringify(payload));
  return { options, payload, identity, lockPath };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('lock owner decisions', () => {
  test('requires exact identity and ownership for an orphan', () => {
    const f = fixture();
    expect(classifyLockOwner(f.payload, f.identity, f.options, now)).toBe(LockOwnerDecision.Orphan);
    for (const payload of [
      { ...f.payload, startTime: undefined }, { ...f.payload, stateDir: path.join(f.options.stateDir, 'other') },
      { ...f.payload, role: 'agent-embedded' }, { ...f.payload, createdAt: new Date(now - 100).toISOString() },
    ]) expect(classifyLockOwner(payload, f.identity, f.options, now)).toBe(LockOwnerDecision.Active);
    expect(classifyLockOwner(f.payload, { ...f.identity, parentAlive: true }, f.options, now)).toBe(LockOwnerDecision.Active);
    expect(classifyLockOwner(f.payload, { ...f.identity, parentAlive: undefined }, f.options, now)).toBe(LockOwnerDecision.Active);
    expect(classifyLockOwner(f.payload, { ...f.identity, args: undefined }, f.options, now)).toBe(LockOwnerDecision.Unknown);
  });
  test('PID reuse does not require stopping the replacement process', () => {
    const f = fixture();
    expect(classifyLockOwner(f.payload, { ...f.identity, startTime: now - 1_000 }, f.options, now)).toBe(LockOwnerDecision.Reused);
    expect(classifyLockOwner({ ...f.payload, startTime: undefined }, { ...f.identity, startTime: now - 1_000 }, f.options, now)).toBe(LockOwnerDecision.Reused);
    expect(classifyLockOwner(f.payload, { pid: f.payload.pid, status: WindowsProcessStatus.Gone }, f.options, now)).toBe(LockOwnerDecision.Dead);
  });
  test('recognizes an unrelated Windows system image even if CIM withholds argv', () => {
    const f = fixture();
    expect(classifyLockOwner({ ...f.payload, startTime: undefined }, {
      ...f.identity, args: undefined, executablePath: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wbem', 'WmiPrvSE.exe'),
    }, f.options, now)).toBe(LockOwnerDecision.Unrelated);
  });
  test('protects external OpenClaw runtimes and unsupported maintenance roles', () => {
    const f = fixture();
    expect(classifyLockOwner(f.payload, { ...f.identity, args: ['node.exe', 'C:/other/openclaw.mjs', 'doctor'] }, f.options, now)).toBe(LockOwnerDecision.Active);
    expect(classifyLockOwner(f.payload, { ...f.identity, status: WindowsProcessStatus.Unknown }, f.options, now)).toBe(LockOwnerDecision.Unknown);
    expect(classifyLockOwner({ ...f.payload, role: 'skill-workshop-apply' }, f.identity, f.options, now)).toBe(LockOwnerDecision.Active);
  });
  test('requires a port for diagnosing a detached gateway', () => {
    const f = fixture();
    const gateway = { ...f.identity, args: [f.options.executablePath, path.join(f.options.runtimeRoot, 'gateway-launcher.cjs')] };
    expect(classifyLockOwner({ ...f.payload, role: undefined }, gateway, f.options, now)).toBe(LockOwnerDecision.Unknown);
    expect(classifyLockOwner({ ...f.payload, role: undefined, port: 18789 }, gateway, f.options, now)).toBe(LockOwnerDecision.Orphan);
  });
});

test('a reused PID is rechecked by native acquisition and never terminated', async () => {
  const f = fixture();
  const stop = vi.fn();
  const release = vi.fn(async () => {});
  const replacement = { ...f.identity, startTime: now - 1_000 };
  const inspect = vi.fn(async () => replacement);
  const result = await recoverOpenClawLockOwners(f.options, {
    platform: 'win32', now: () => now, inspect, stop,
    acquireLock: async ({ inspectOwner }) => {
      expect(await inspectOwner!(f.payload)).toBe(NativeLockOwnerStatus.Dead);
      // A new, live owner substituted while waiting for the native coordinator
      // must not inherit the earlier stale decision for the same PID.
      expect(await inspectOwner!({ ...f.payload, startTime: replacement.startTime,
        createdAt: new Date(now).toISOString(), ownerId: 'new-owner' })).toBe(NativeLockOwnerStatus.Alive);
      return { release };
    },
  });
  expect(result.success).toBe(true); expect(stop).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  expect(inspect).toHaveBeenCalledTimes(3);
});

test.each([LockOwnerDecision.Unknown, LockOwnerDecision.Active])('a %s owner prevents all mutation', async (decision) => {
  const f = fixture();
  const original = fs.readFileSync(f.lockPath, 'utf8');
  const acquireLock = vi.fn(); const stop = vi.fn();
  const identity = decision === LockOwnerDecision.Unknown ? { ...f.identity, status: WindowsProcessStatus.Unknown }
    : { ...f.identity, parentAlive: true };
  const result = await recoverOpenClawLockOwners(f.options, { platform: 'win32', now: () => now, inspect: async () => identity, stop, acquireLock });
  expect(result.success).toBe(false); expect(result.error).toContain(decision);
  expect(stop).not.toHaveBeenCalled(); expect(acquireLock).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.lockPath, 'utf8')).toBe(original);
});

test('a verified orphan must exit before native lease acquisition', async () => {
  const f = fixture(); const events: string[] = [];
  let gone = false;
  const result = await recoverOpenClawLockOwners(f.options, {
    platform: 'win32', now: () => now,
    inspect: async () => gone ? { pid: f.payload.pid, status: WindowsProcessStatus.Gone } : f.identity,
    stop: async value => { expect(value.creationTime).toBe(f.identity.creationTime); events.push('stop'); gone = true; return { pid: value.pid, status: WindowsProcessStatus.Stopped }; },
    acquireLock: async ({ inspectOwner }) => { events.push('acquire'); expect(await inspectOwner!(f.payload)).toBe(NativeLockOwnerStatus.Dead); return { release: async () => { events.push('release'); } }; },
  });
  expect(result.success).toBe(true); expect(events).toEqual(['stop', 'acquire', 'release']);
});

test('healthy detached gateways are preserved', async () => {
  const f = fixture();
  fs.writeFileSync(f.lockPath, JSON.stringify({ ...f.payload, role: 'gateway', port: 18789 }));
  const stop = vi.fn(); const acquireLock = vi.fn();
  const result = await recoverOpenClawLockOwners(f.options, { platform: 'win32', now: () => now, stop, acquireLock,
    inspect: async () => ({ ...f.identity, args: [f.options.executablePath, path.join(f.options.runtimeRoot, 'gateway-launcher.cjs')] }), healthy: async () => true });
  expect(result.success).toBe(false); expect(result.error).toContain('healthy'); expect(stop).not.toHaveBeenCalled();
});

test('changed process identity or unconfirmed exit does not advance repair', async () => {
  const f = fixture(); const stop = vi.fn(); const acquireLock = vi.fn();
  let calls = 0;
  const result = await recoverOpenClawLockOwners(f.options, { platform: 'win32', now: () => now, stop, acquireLock,
    inspect: async () => ++calls === 1 ? f.identity : { ...f.identity, creationTime: 'replacement' } });
  expect(result.success).toBe(false); expect(stop).not.toHaveBeenCalled(); expect(acquireLock).not.toHaveBeenCalled();
  const second = await recoverOpenClawLockOwners(f.options, { platform: 'win32', now: () => now, acquireLock,
    inspect: async () => f.identity, stop: async () => ({ pid: f.payload.pid, status: WindowsProcessStatus.Unknown, reason: 'denied' }) });
  expect(second.success).toBe(false); expect(second.error).toContain('confirm'); expect(acquireLock).not.toHaveBeenCalled();
});

test('native coordinator contention is preserved and argv is omitted from diagnostics', async () => {
  const f = fixture();
  const result = await recoverOpenClawLockOwners(f.options, { platform: 'win32', now: () => now,
    inspect: async () => ({ ...f.identity, startTime: now - 1_000, args: ['secret-token'] }),
    acquireLock: async () => { throw new Error('another OpenClaw process owns gateway-lifecycle'); } });
  expect(result.success).toBe(false); expect(result.error).toContain('gateway-lifecycle'); expect(fs.existsSync(f.lockPath)).toBe(true);
  expect(fs.readFileSync(path.join(f.options.backupDir, 'lock-owner-diagnostics.json'), 'utf8')).not.toContain('secret-token');
});
