import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  cleanupStaleGatewayLocks,
  GatewayLockCleanupAction,
  openClawRuntimeHoldsLockCoordinators,
  parseGatewayLockPayload,
  resolveGatewayLockDir,
  resolveGatewayLockPathForConfig,
} from './openclawGatewayLock';
import {
  expectOpenClawSourceContains,
  getCurrentOpenClawVersion,
  isOpenClawSourceAvailable,
} from './openclawPatches/patchTestUtils';

const CONFIG_PATH = path.join(os.tmpdir(), 'lobsterai-lock-test-state', 'openclaw.json');

const expectedHash = (configPath: string): string =>
  crypto.createHash('sha256').update(path.resolve(configPath.trim())).digest('hex').slice(0, 8);

describe('resolveGatewayLockPathForConfig', () => {
  test('uses the v2026.8.1 state-local lock directory', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const suffix = uid != null ? `openclaw-${uid}` : 'openclaw';
    const stateDir = path.dirname(CONFIG_PATH);

    expect(resolveGatewayLockDir(stateDir)).toBe(path.join(path.resolve(stateDir), 'tmp', suffix));
  });

  test('replicates the OpenClaw lock file name (sha256 of resolved config path)', () => {
    const lockPath = resolveGatewayLockPathForConfig(CONFIG_PATH, '/locks');
    expect(path.basename(lockPath)).toBe(`gateway.${expectedHash(CONFIG_PATH)}.lock`);
  });

  test('trims the config path before hashing, matching resolveUserPath', () => {
    const padded = `  ${CONFIG_PATH}  `;
    expect(resolveGatewayLockPathForConfig(padded, '/locks')).toBe(
      resolveGatewayLockPathForConfig(CONFIG_PATH, '/locks'),
    );
  });
});

describe('parseGatewayLockPayload', () => {
  test('accepts a valid payload', () => {
    const parsed = parseGatewayLockPayload(
      JSON.stringify({ pid: 1234, createdAt: '2026-08-05T07:40:47.280Z', configPath: CONFIG_PATH }),
    );
    expect(parsed).toEqual({ pid: 1234, createdAt: '2026-08-05T07:40:47.280Z', configPath: CONFIG_PATH });
  });

  test.each([
    ['empty file', ''],
    ['truncated json', '{"pid": 123'],
    ['missing pid', JSON.stringify({ configPath: CONFIG_PATH })],
    ['non-integer pid', JSON.stringify({ pid: 'abc' })],
    ['non-positive pid', JSON.stringify({ pid: 0 })],
  ])('rejects %s', (_label, raw) => {
    expect(parseGatewayLockPayload(raw)).toBeNull();
  });
});

describe('cleanupStaleGatewayLocks', () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-lock-test-')));
  });

  afterEach(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  const ownLockPath = () => resolveGatewayLockPathForConfig(CONFIG_PATH, lockDir);
  const ownStateLockPath = () => path.join(lockDir, 'gateway.state.lock');

  test('returns empty when the lock directory does not exist', () => {
    const missingDir = path.join(lockDir, 'nope');
    expect(cleanupStaleGatewayLocks({ configPath: CONFIG_PATH, lockDir: missingDir })).toEqual([]);
  });

  test('removes our lock when the payload is empty (poisoned by TerminateProcess)', () => {
    fs.writeFileSync(ownLockPath(), '');
    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => true,
    });
    expect(results).toEqual([
      { lockPath: ownLockPath(), action: GatewayLockCleanupAction.RemovedUnreadable },
    ]);
    expect(fs.existsSync(ownLockPath())).toBe(false);
  });

  test('removes our lock when the payload is corrupted', () => {
    fs.writeFileSync(ownLockPath(), '{"pid": 118');
    const results = cleanupStaleGatewayLocks({ configPath: CONFIG_PATH, lockDir });
    expect(results[0]?.action).toBe(GatewayLockCleanupAction.RemovedUnreadable);
    expect(fs.existsSync(ownLockPath())).toBe(false);
  });

  test('uses an explicit state directory when the config lives elsewhere', () => {
    const stateDir = path.join(lockDir, 'state-tree');
    const configPath = path.join(lockDir, 'custom-config', 'openclaw.json');
    const stateLockPath = path.join(resolveGatewayLockDir(stateDir), 'gateway.state.lock');
    fs.mkdirSync(path.dirname(stateLockPath), { recursive: true });
    fs.writeFileSync(stateLockPath, '');

    const results = cleanupStaleGatewayLocks({ configPath, stateDir });

    expect(results).toEqual([
      { lockPath: stateLockPath, action: GatewayLockCleanupAction.RemovedUnreadable },
    ]);
    expect(fs.existsSync(stateLockPath)).toBe(false);
  });

  test('removes the state lock when the payload is empty', () => {
    fs.writeFileSync(ownStateLockPath(), '');
    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => true,
    });
    expect(results).toEqual([
      { lockPath: ownStateLockPath(), action: GatewayLockCleanupAction.RemovedUnreadable },
    ]);
    expect(fs.existsSync(ownStateLockPath())).toBe(false);
  });

  test('removes our lock when the owner pid is dead', () => {
    fs.writeFileSync(ownLockPath(), JSON.stringify({ pid: 11848, createdAt: 'x', configPath: CONFIG_PATH }));
    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => false,
    });
    expect(results).toEqual([
      { lockPath: ownLockPath(), action: GatewayLockCleanupAction.RemovedDeadOwner, ownerPid: 11848 },
    ]);
    expect(fs.existsSync(ownLockPath())).toBe(false);
  });

  test('removes the state lock when the owner pid is dead', () => {
    fs.writeFileSync(ownStateLockPath(), JSON.stringify({ pid: 11849, configPath: CONFIG_PATH }));
    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => false,
    });
    expect(results).toEqual([
      { lockPath: ownStateLockPath(), action: GatewayLockCleanupAction.RemovedDeadOwner, ownerPid: 11849 },
    ]);
    expect(fs.existsSync(ownStateLockPath())).toBe(false);
  });

  test('never touches a lock whose owner pid is alive', () => {
    fs.writeFileSync(ownLockPath(), JSON.stringify({ pid: process.pid, configPath: CONFIG_PATH }));
    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => true,
    });
    expect(results).toEqual([
      { lockPath: ownLockPath(), action: GatewayLockCleanupAction.KeptAliveOwner, ownerPid: process.pid },
    ]);
    expect(fs.existsSync(ownLockPath())).toBe(true);
  });

  test('removes an other-hash lock whose payload points at our config with a dead owner', () => {
    const strayPath = path.join(lockDir, 'gateway.deadbeef.lock');
    fs.writeFileSync(strayPath, JSON.stringify({ pid: 4242, configPath: CONFIG_PATH }));
    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => false,
    });
    expect(results).toEqual([
      { lockPath: strayPath, action: GatewayLockCleanupAction.RemovedDeadOwner, ownerPid: 4242 },
    ]);
    expect(fs.existsSync(strayPath)).toBe(false);
  });

  test('leaves foreign locks alone (different config path or unreadable non-matching hash)', () => {
    const foreignReadable = path.join(lockDir, 'gateway.00000001.lock');
    fs.writeFileSync(foreignReadable, JSON.stringify({ pid: 999999, configPath: '/somewhere/else.json' }));
    const foreignUnreadable = path.join(lockDir, 'gateway.00000002.lock');
    fs.writeFileSync(foreignUnreadable, '');
    const unrelatedFile = path.join(lockDir, 'notes.txt');
    fs.writeFileSync(unrelatedFile, 'keep me');

    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => false,
    });
    expect(results).toEqual([]);
    expect(fs.existsSync(foreignReadable)).toBe(true);
    expect(fs.existsSync(foreignUnreadable)).toBe(true);
    expect(fs.existsSync(unrelatedFile)).toBe(true);
  });
});

describe('cleanupStaleGatewayLocks with a lock coordinator probe', () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-lock-coordinator-test-')));
  });

  afterEach(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  const ownStateLockPath = () => path.join(lockDir, 'gateway.state.lock');
  const writeCurrentLock = (lockPath: string, pid = 5464) => {
    const raw = JSON.stringify({ pid, ownerId: 'owner-1', createdAt: '2026-09-26T07:35:40.000Z', configPath: CONFIG_PATH });
    fs.writeFileSync(lockPath, raw);
    return raw;
  };
  const freeCoordinator = () => {
    const acquired: string[] = [];
    let releases = 0;
    return {
      acquired,
      releases: () => releases,
      probe: (coordinatorPath: string) => {
        acquired.push(coordinatorPath);
        return { release: () => { releases += 1; } };
      },
    };
  };

  test('reclaims a lock whose PID is alive but whose writer released its coordinator', () => {
    writeCurrentLock(ownStateLockPath());
    const coordinator = freeCoordinator();

    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => true,
      tryAcquireLockCoordinator: coordinator.probe,
    });

    expect(results).toEqual([
      { lockPath: ownStateLockPath(), action: GatewayLockCleanupAction.RemovedReusedPid, ownerPid: 5464 },
    ]);
    expect(fs.existsSync(ownStateLockPath())).toBe(false);
    expect(coordinator.acquired).toEqual([`${ownStateLockPath()}.sqlite`]);
    expect(coordinator.releases()).toBe(1);
  });

  test('keeps the lock while its writer still holds the coordinator', () => {
    writeCurrentLock(ownStateLockPath());

    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => true,
      tryAcquireLockCoordinator: () => null,
    });

    expect(results).toEqual([
      { lockPath: ownStateLockPath(), action: GatewayLockCleanupAction.KeptAliveOwner, ownerPid: 5464 },
    ]);
    expect(fs.existsSync(ownStateLockPath())).toBe(true);
  });

  test('keeps pre-v2026.8.1 payloads without ownerId, whose writers held no coordinator', () => {
    fs.writeFileSync(ownStateLockPath(), JSON.stringify({ pid: 5464, createdAt: '2026-06-01T00:00:00.000Z', configPath: CONFIG_PATH }));
    const coordinator = freeCoordinator();

    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => true,
      tryAcquireLockCoordinator: coordinator.probe,
    });

    expect(results[0]?.action).toBe(GatewayLockCleanupAction.KeptAliveOwner);
    expect(fs.existsSync(ownStateLockPath())).toBe(true);
    expect(coordinator.acquired).toEqual([]);
  });

  test('keeps live-PID locks when no coordinator probe is configured', () => {
    writeCurrentLock(ownStateLockPath());

    const results = cleanupStaleGatewayLocks({ configPath: CONFIG_PATH, lockDir, isPidAliveFn: () => true });

    expect(results[0]?.action).toBe(GatewayLockCleanupAction.KeptAliveOwner);
    expect(fs.existsSync(ownStateLockPath())).toBe(true);
  });

  test('keeps a lock that a new writer replaced before the coordinator was acquired', () => {
    writeCurrentLock(ownStateLockPath());
    const replacement = JSON.stringify({ pid: 7777, ownerId: 'owner-2', createdAt: '2026-09-27T07:48:49.000Z', configPath: CONFIG_PATH });
    let releases = 0;

    const results = cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => true,
      tryAcquireLockCoordinator: () => {
        fs.writeFileSync(ownStateLockPath(), replacement);
        return { release: () => { releases += 1; } };
      },
    });

    expect(results[0]?.action).toBe(GatewayLockCleanupAction.KeptAliveOwner);
    expect(fs.readFileSync(ownStateLockPath(), 'utf8')).toBe(replacement);
    expect(releases).toBe(1);
  });

  test('checks each lock against its own companion coordinator', () => {
    const configLockPath = resolveGatewayLockPathForConfig(CONFIG_PATH, lockDir);
    writeCurrentLock(configLockPath);
    writeCurrentLock(ownStateLockPath());
    const coordinator = freeCoordinator();

    cleanupStaleGatewayLocks({
      configPath: CONFIG_PATH,
      lockDir,
      isPidAliveFn: () => true,
      tryAcquireLockCoordinator: coordinator.probe,
    });

    expect([...coordinator.acquired].sort()).toEqual([`${configLockPath}.sqlite`, `${ownStateLockPath()}.sqlite`].sort());
    expect(fs.existsSync(configLockPath)).toBe(false);
    expect(fs.existsSync(ownStateLockPath())).toBe(false);
  });
});

describe('openClawRuntimeHoldsLockCoordinators', () => {
  test.each([
    ['2026.8.1', true],
    ['v2026.8.1', true],
    [' 2026.8.1 ', true],
    ['2026.6.1', false],
    ['2026.9.7', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('%j -> %s', (version, expected) => {
    expect(openClawRuntimeHoldsLockCoordinators(version)).toBe(expected);
  });

  test('covers the pinned OpenClaw runtime', () => {
    // After an OpenClaw upgrade, confirm its gateway still holds `<lock>.sqlite`
    // for the lock's lifetime before listing the version. Upstream main dropped
    // the companions (#157413); without them reused-PID locks need another proof.
    expect(openClawRuntimeHoldsLockCoordinators(getCurrentOpenClawVersion())).toBe(true);
  });

  test.skipIf(!isOpenClawSourceAvailable())('matches the pinned OpenClaw lock protocol', () => {
    expectOpenClawSourceContains([{
      file: 'src/infra/gateway-lock.ts',
      snippets: [
        'coordinator = tryAcquireExclusiveSqliteCoordinator(`${lockPath}.sqlite`);',
        'ownerId: opts.ownerId,',
        'coordinator.release();',
      ],
    }]);
  });
});
