/**
 * Unit tests for imPairingStore.ts
 *
 * The pairing store manages the OpenClaw SDK-compatible JSON files that record:
 *   - Pending pairing requests  (credentials/<channel>-pairing.json)
 *   - Approved sender allow-lists (credentials/<channel>-allowFrom.json,
 *                                   or <channel>-<accountId>-allowFrom.json
 *                                   for account-scoped entries)
 *
 * All four exported functions are tested against a real (temporary) filesystem
 * directory that is created fresh for each test group and removed on teardown.
 *
 * Functions under test:
 *   - listPairingRequests    – returns pending requests, filters expired ones
 *   - readAllowFromStore     – returns the approved sender list
 *   - approvePairingCode     – moves a request to allowFrom by code
 *   - rejectPairingRequest   – removes a request without adding to allowFrom
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  listPairingRequests,
  readAllowFromStore,
  approvePairingCode,
  rejectPairingRequest,
} = require('../dist-electron/main/im/imPairingStore.js');

// ── test helpers ─────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-pairing-test-'));
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function credentialsDir(stateDir) {
  return path.join(stateDir, 'credentials');
}

function writePairingFile(stateDir, channel, requests) {
  const dir = credentialsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${channel}-pairing.json`);
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, requests }, null, 2), 'utf-8');
}

function writeAllowFromFile(stateDir, channel, allowFrom, accountId) {
  const dir = credentialsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = accountId && accountId !== 'default' ? `-${accountId}` : '';
  const filePath = path.join(dir, `${channel}${suffix}-allowFrom.json`);
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, allowFrom }, null, 2), 'utf-8');
}

function readAllowFromFile(stateDir, channel, accountId) {
  const suffix = accountId && accountId !== 'default' ? `-${accountId}` : '';
  const filePath = path.join(credentialsDir(stateDir), `${channel}${suffix}-allowFrom.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')).allowFrom;
  } catch {
    return [];
  }
}

function readPairingFile(stateDir, channel) {
  const filePath = path.join(credentialsDir(stateDir), `${channel}-pairing.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')).requests;
  } catch {
    return [];
  }
}

/** ISO timestamp for a date offset by `deltaMs` from now. */
function isoTimestamp(deltaMs = 0) {
  return new Date(Date.now() + deltaMs).toISOString();
}

const HOUR_MS = 3600 * 1000;

// ── listPairingRequests ───────────────────────────────────────────────────────

test('listPairingRequests returns empty array when credentials dir does not exist', () => {
  const stateDir = makeTmpDir();
  try {
    const result = listPairingRequests('dingtalk', stateDir);
    assert.deepEqual(result, []);
  } finally {
    cleanupDir(stateDir);
  }
});

test('listPairingRequests returns empty array when pairing file is absent', () => {
  const stateDir = makeTmpDir();
  try {
    fs.mkdirSync(credentialsDir(stateDir), { recursive: true });
    const result = listPairingRequests('dingtalk', stateDir);
    assert.deepEqual(result, []);
  } finally {
    cleanupDir(stateDir);
  }
});

test('listPairingRequests returns a fresh pending request', () => {
  const stateDir = makeTmpDir();
  try {
    const request = {
      id: 'user:alice',
      code: 'ABC123',
      createdAt: isoTimestamp(-30 * 60 * 1000), // 30 minutes ago → still valid
      lastSeenAt: isoTimestamp(-30 * 60 * 1000),
    };
    writePairingFile(stateDir, 'dingtalk', [request]);
    const result = listPairingRequests('dingtalk', stateDir);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'user:alice');
    assert.equal(result[0].code, 'ABC123');
  } finally {
    cleanupDir(stateDir);
  }
});

test('listPairingRequests filters out expired requests (older than 1 hour)', () => {
  const stateDir = makeTmpDir();
  try {
    const expired = {
      id: 'user:bob',
      code: 'EXP001',
      createdAt: isoTimestamp(-(HOUR_MS + 1)), // just over 1 hour ago → expired
      lastSeenAt: isoTimestamp(-(HOUR_MS + 1)),
    };
    writePairingFile(stateDir, 'dingtalk', [expired]);
    const result = listPairingRequests('dingtalk', stateDir);
    assert.deepEqual(result, []);
  } finally {
    cleanupDir(stateDir);
  }
});

test('listPairingRequests returns only non-expired requests from a mixed list', () => {
  const stateDir = makeTmpDir();
  try {
    const valid = {
      id: 'user:charlie',
      code: 'VAL001',
      createdAt: isoTimestamp(-10 * 60 * 1000), // 10 minutes ago
      lastSeenAt: isoTimestamp(-10 * 60 * 1000),
    };
    const expired = {
      id: 'user:dave',
      code: 'EXP002',
      createdAt: isoTimestamp(-2 * HOUR_MS), // 2 hours ago
      lastSeenAt: isoTimestamp(-2 * HOUR_MS),
    };
    writePairingFile(stateDir, 'dingtalk', [valid, expired]);
    const result = listPairingRequests('dingtalk', stateDir);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'user:charlie');
  } finally {
    cleanupDir(stateDir);
  }
});

test('listPairingRequests filters out requests with an invalid createdAt date', () => {
  const stateDir = makeTmpDir();
  try {
    const badDate = {
      id: 'user:eve',
      code: 'BAD001',
      createdAt: 'not-a-date',
      lastSeenAt: isoTimestamp(),
    };
    writePairingFile(stateDir, 'dingtalk', [badDate]);
    const result = listPairingRequests('dingtalk', stateDir);
    assert.deepEqual(result, []);
  } finally {
    cleanupDir(stateDir);
  }
});

// ── readAllowFromStore ────────────────────────────────────────────────────────

test('readAllowFromStore returns empty array when credentials dir does not exist', () => {
  const stateDir = makeTmpDir();
  try {
    const result = readAllowFromStore('telegram', stateDir);
    assert.deepEqual(result, []);
  } finally {
    cleanupDir(stateDir);
  }
});

test('readAllowFromStore returns empty array when allowFrom file is absent', () => {
  const stateDir = makeTmpDir();
  try {
    fs.mkdirSync(credentialsDir(stateDir), { recursive: true });
    const result = readAllowFromStore('telegram', stateDir);
    assert.deepEqual(result, []);
  } finally {
    cleanupDir(stateDir);
  }
});

test('readAllowFromStore returns the stored allowFrom list', () => {
  const stateDir = makeTmpDir();
  try {
    writeAllowFromFile(stateDir, 'telegram', ['user:alice', 'user:bob']);
    const result = readAllowFromStore('telegram', stateDir);
    assert.deepEqual(result, ['user:alice', 'user:bob']);
  } finally {
    cleanupDir(stateDir);
  }
});

// ── approvePairingCode ────────────────────────────────────────────────────────

test('approvePairingCode returns null for an unknown code', () => {
  const stateDir = makeTmpDir();
  try {
    const request = {
      id: 'user:frank',
      code: 'REAL01',
      createdAt: isoTimestamp(-5 * 60 * 1000),
      lastSeenAt: isoTimestamp(-5 * 60 * 1000),
    };
    writePairingFile(stateDir, 'feishu', [request]);
    const result = approvePairingCode('feishu', 'WRONG1', stateDir);
    assert.equal(result, null);
  } finally {
    cleanupDir(stateDir);
  }
});

test('approvePairingCode returns null when pairing file does not exist', () => {
  const stateDir = makeTmpDir();
  try {
    const result = approvePairingCode('feishu', 'ANY000', stateDir);
    assert.equal(result, null);
  } finally {
    cleanupDir(stateDir);
  }
});

test('approvePairingCode removes the request from the pairing file', () => {
  const stateDir = makeTmpDir();
  try {
    const request = {
      id: 'user:grace',
      code: 'APVL01',
      createdAt: isoTimestamp(-1 * 60 * 1000),
      lastSeenAt: isoTimestamp(-1 * 60 * 1000),
    };
    writePairingFile(stateDir, 'dingtalk', [request]);
    approvePairingCode('dingtalk', 'APVL01', stateDir);
    const remaining = readPairingFile(stateDir, 'dingtalk');
    assert.equal(remaining.length, 0);
  } finally {
    cleanupDir(stateDir);
  }
});

test('approvePairingCode adds the request id to the default allowFrom', () => {
  const stateDir = makeTmpDir();
  try {
    const request = {
      id: 'user:heidi',
      code: 'APVL02',
      createdAt: isoTimestamp(-2 * 60 * 1000),
      lastSeenAt: isoTimestamp(-2 * 60 * 1000),
    };
    writePairingFile(stateDir, 'dingtalk', [request]);
    approvePairingCode('dingtalk', 'APVL02', stateDir);
    const allowed = readAllowFromFile(stateDir, 'dingtalk');
    assert.ok(allowed.includes('user:heidi'));
  } finally {
    cleanupDir(stateDir);
  }
});

test('approvePairingCode returns the approved request object', () => {
  const stateDir = makeTmpDir();
  try {
    const request = {
      id: 'user:ivan',
      code: 'APVL03',
      createdAt: isoTimestamp(-3 * 60 * 1000),
      lastSeenAt: isoTimestamp(-3 * 60 * 1000),
    };
    writePairingFile(stateDir, 'dingtalk', [request]);
    const result = approvePairingCode('dingtalk', 'APVL03', stateDir);
    assert.equal(result.id, 'user:ivan');
    assert.equal(result.code, 'APVL03');
  } finally {
    cleanupDir(stateDir);
  }
});

test('approvePairingCode is case-insensitive for the code lookup (lowercased input)', () => {
  const stateDir = makeTmpDir();
  try {
    const request = {
      id: 'user:judy',
      code: 'MIX123',
      createdAt: isoTimestamp(-1 * 60 * 1000),
      lastSeenAt: isoTimestamp(-1 * 60 * 1000),
    };
    writePairingFile(stateDir, 'dingtalk', [request]);
    // Codes are stored upper-case; caller may pass lower-case
    const result = approvePairingCode('dingtalk', 'mix123', stateDir);
    assert.equal(result.id, 'user:judy');
  } finally {
    cleanupDir(stateDir);
  }
});

test('approvePairingCode does not add a duplicate entry to allowFrom', () => {
  const stateDir = makeTmpDir();
  try {
    // Pre-populate allowFrom with the same user id
    writeAllowFromFile(stateDir, 'dingtalk', ['user:ken']);
    const request = {
      id: 'user:ken',
      code: 'DUPL01',
      createdAt: isoTimestamp(-1 * 60 * 1000),
      lastSeenAt: isoTimestamp(-1 * 60 * 1000),
    };
    writePairingFile(stateDir, 'dingtalk', [request]);
    approvePairingCode('dingtalk', 'DUPL01', stateDir);
    const allowed = readAllowFromFile(stateDir, 'dingtalk');
    assert.equal(allowed.filter((id) => id === 'user:ken').length, 1);
  } finally {
    cleanupDir(stateDir);
  }
});

test('approvePairingCode writes to account-scoped allowFrom when meta.accountId is set', () => {
  const stateDir = makeTmpDir();
  try {
    const request = {
      id: 'user:lena',
      code: 'ACCT01',
      createdAt: isoTimestamp(-1 * 60 * 1000),
      lastSeenAt: isoTimestamp(-1 * 60 * 1000),
      meta: { accountId: 'acct-42' },
    };
    writePairingFile(stateDir, 'dingtalk', [request]);
    approvePairingCode('dingtalk', 'ACCT01', stateDir);
    // Should appear in the account-scoped file, not the default
    const defaultAllowed = readAllowFromFile(stateDir, 'dingtalk');
    const accountAllowed = readAllowFromFile(stateDir, 'dingtalk', 'acct-42');
    assert.ok(!defaultAllowed.includes('user:lena'), 'should NOT be in default allowFrom');
    assert.ok(accountAllowed.includes('user:lena'), 'should be in account-scoped allowFrom');
  } finally {
    cleanupDir(stateDir);
  }
});

test('approvePairingCode only removes the matched request, leaving others intact', () => {
  const stateDir = makeTmpDir();
  try {
    const r1 = {
      id: 'user:mike',
      code: 'KEEP01',
      createdAt: isoTimestamp(-5 * 60 * 1000),
      lastSeenAt: isoTimestamp(-5 * 60 * 1000),
    };
    const r2 = {
      id: 'user:nina',
      code: 'RMVE01',
      createdAt: isoTimestamp(-5 * 60 * 1000),
      lastSeenAt: isoTimestamp(-5 * 60 * 1000),
    };
    writePairingFile(stateDir, 'dingtalk', [r1, r2]);
    approvePairingCode('dingtalk', 'RMVE01', stateDir);
    const remaining = readPairingFile(stateDir, 'dingtalk');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].code, 'KEEP01');
  } finally {
    cleanupDir(stateDir);
  }
});

// ── rejectPairingRequest ──────────────────────────────────────────────────────

test('rejectPairingRequest returns null for an unknown code', () => {
  const stateDir = makeTmpDir();
  try {
    const request = {
      id: 'user:oscar',
      code: 'REAL02',
      createdAt: isoTimestamp(-5 * 60 * 1000),
      lastSeenAt: isoTimestamp(-5 * 60 * 1000),
    };
    writePairingFile(stateDir, 'telegram', [request]);
    const result = rejectPairingRequest('telegram', 'NOPE00', stateDir);
    assert.equal(result, null);
  } finally {
    cleanupDir(stateDir);
  }
});

test('rejectPairingRequest returns null when pairing file does not exist', () => {
  const stateDir = makeTmpDir();
  try {
    const result = rejectPairingRequest('telegram', 'ANY000', stateDir);
    assert.equal(result, null);
  } finally {
    cleanupDir(stateDir);
  }
});

test('rejectPairingRequest removes the request from the pairing file', () => {
  const stateDir = makeTmpDir();
  try {
    const request = {
      id: 'user:pat',
      code: 'RJCT01',
      createdAt: isoTimestamp(-2 * 60 * 1000),
      lastSeenAt: isoTimestamp(-2 * 60 * 1000),
    };
    writePairingFile(stateDir, 'telegram', [request]);
    rejectPairingRequest('telegram', 'RJCT01', stateDir);
    const remaining = readPairingFile(stateDir, 'telegram');
    assert.equal(remaining.length, 0);
  } finally {
    cleanupDir(stateDir);
  }
});

test('rejectPairingRequest returns the rejected request object', () => {
  const stateDir = makeTmpDir();
  try {
    const request = {
      id: 'user:quinn',
      code: 'RJCT02',
      createdAt: isoTimestamp(-2 * 60 * 1000),
      lastSeenAt: isoTimestamp(-2 * 60 * 1000),
    };
    writePairingFile(stateDir, 'telegram', [request]);
    const result = rejectPairingRequest('telegram', 'RJCT02', stateDir);
    assert.equal(result.id, 'user:quinn');
    assert.equal(result.code, 'RJCT02');
  } finally {
    cleanupDir(stateDir);
  }
});

test('rejectPairingRequest does NOT add the user to allowFrom', () => {
  const stateDir = makeTmpDir();
  try {
    const request = {
      id: 'user:rita',
      code: 'RJCT03',
      createdAt: isoTimestamp(-1 * 60 * 1000),
      lastSeenAt: isoTimestamp(-1 * 60 * 1000),
    };
    writePairingFile(stateDir, 'telegram', [request]);
    rejectPairingRequest('telegram', 'RJCT03', stateDir);
    const allowed = readAllowFromFile(stateDir, 'telegram');
    assert.ok(!allowed.includes('user:rita'), 'rejected user must not appear in allowFrom');
  } finally {
    cleanupDir(stateDir);
  }
});

test('rejectPairingRequest only removes the matched request, leaving others intact', () => {
  const stateDir = makeTmpDir();
  try {
    const r1 = {
      id: 'user:sam',
      code: 'STAY01',
      createdAt: isoTimestamp(-5 * 60 * 1000),
      lastSeenAt: isoTimestamp(-5 * 60 * 1000),
    };
    const r2 = {
      id: 'user:tara',
      code: 'RJCT04',
      createdAt: isoTimestamp(-5 * 60 * 1000),
      lastSeenAt: isoTimestamp(-5 * 60 * 1000),
    };
    writePairingFile(stateDir, 'telegram', [r1, r2]);
    rejectPairingRequest('telegram', 'RJCT04', stateDir);
    const remaining = readPairingFile(stateDir, 'telegram');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].code, 'STAY01');
  } finally {
    cleanupDir(stateDir);
  }
});
