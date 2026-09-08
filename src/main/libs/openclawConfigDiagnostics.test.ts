import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DiagnosticPathKind, inspectOpenClawConfigLock, logOpenClawConfigLockDiagnostics } from './openclawConfigDiagnostics';

let tempDir: string;
let configPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-lock-diagnostics-'));
  configPath = path.join(tempDir, 'openclaw.json');
  fs.writeFileSync(configPath, '{"apiKey":"must-not-be-logged"}');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('read-only config lock diagnostics', () => {
  test('reports a live owner and reclaim metadata without reading config contents', () => {
    const payload = JSON.stringify({ pid: process.pid, createdAt: '2026-09-08T00:00:00Z', startTime: 1234, secret: 'private' });
    fs.writeFileSync(`${configPath}.lock`, payload);
    fs.mkdirSync(`${configPath}.lock.reclaim`);
    const snapshot = inspectOpenClawConfigLock(configPath);
    expect(snapshot.lock).toMatchObject({
      kind: DiagnosticPathKind.File, ownerPid: process.pid, ownerAlive: true,
      ownerIsApp: true, ownerStartTime: 1234, ownerCreatedAt: '2026-09-08T00:00:00.000Z',
    });
    expect(snapshot.reclaim.kind).toBe(DiagnosticPathKind.Directory);
    expect(JSON.stringify(snapshot)).not.toMatch(/must-not-be-logged|private/);
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(payload);
    expect(fs.existsSync(`${configPath}.lock.reclaim`)).toBe(true);
  });

  test('distinguishes dead and permission-protected owners without removing either lock', () => {
    fs.writeFileSync(`${configPath}.lock`, JSON.stringify({ pid: 1234567 }));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
    expect(inspectOpenClawConfigLock(configPath).lock).toMatchObject({ ownerAlive: false });
    kill.mockImplementation(() => { throw Object.assign(new Error(), { code: 'EPERM' }); });
    expect(inspectOpenClawConfigLock(configPath).lock).toMatchObject({ ownerAlive: true });
    expect(fs.existsSync(`${configPath}.lock`)).toBe(true);
  });

  test.each(['', '{partial', 'x'.repeat(5_000)])('retains malformed or oversized locks', payload => {
    fs.writeFileSync(`${configPath}.lock`, payload);
    expect(inspectOpenClawConfigLock(configPath).lock).toMatchObject({ payloadReadable: false });
    expect(fs.readFileSync(`${configPath}.lock`, 'utf8')).toBe(payload);
  });

  test('skips routine logging without a lock but records missing locks on failure', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logOpenClawConfigLockDiagnostics(configPath, 'managed-write', true);
    expect(log).not.toHaveBeenCalled();
    logOpenClawConfigLockDiagnostics(configPath, 'migration-failure');
    expect(log).toHaveBeenCalledWith(expect.stringContaining(DiagnosticPathKind.Missing));
  });
});
